import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { diagnose } from "./desktop-command-diagnostics.mjs"

test("Windows Desktop native catalog probe checks both commands but never returns credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "loop-desktop-diagnostic-"))
  const workspace = path.join(home, "project with spaces")
  const desktopWorkspace = path.join(home, "desktop parent project")
  const cfg = path.join(home, ".config", "opencode")
  const state = path.join(home, ".local", "state", "opencode")
  const calls = []
  const password = "private-diagnostic-password"
  const server = createServer((req, res) => {
    calls.push({ url: req.url, directory: req.headers["x-opencode-directory"], auth: req.headers.authorization })
    res.setHeader("Content-Type", "application/json")
    if (req.url === "/api/info") return res.end(JSON.stringify({ pid: process.pid, version: "2.0.22" }))
    if (req.url === "/api/command") {
      const native = req.headers["x-opencode-directory"] === desktopWorkspace
        ? [{ name: "init" }] : [{ name: "loop" }, { name: "goal" }, { name: "loop-help" }]
      return res.end(JSON.stringify(native))
    }
    res.writeHead(404).end("{}")
  })
  try {
    await mkdir(cfg, { recursive: true })
    await mkdir(state, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await mkdir(desktopWorkspace, { recursive: true })
    await writeFile(path.join(cfg, "opencode.json"), JSON.stringify({
      plugins: ["@bybrawe/opencode-loop@0.6.6", "@bybrawe/opencode-goal@1.3.47"],
      secrets: password,
    }))
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = "http://127.0.0.1:" + server.address().port
    await writeFile(path.join(state, "service.json"), JSON.stringify({
      url, pid: process.pid, version: "2.0.22", password,
    }))
    const result = await diagnose({ home, workspace, env: {} })
    assert.equal(result.service.status, "ready")
    assert.deepEqual(result.service.commands, { loop: true, goal: true, count: 3 })
    assert.deepEqual(result.config.pins.loop, ["@bybrawe/opencode-loop@0.6.6"])
    assert.deepEqual(result.config.pins.goal, ["@bybrawe/opencode-goal@1.3.47"])
    assert.ok(calls.every((c) => c.directory === workspace))
    assert.ok(calls.every((c) => c.auth === "Basic " + Buffer.from("opencode:" + password).toString("base64")))
    assert.ok(!JSON.stringify(result).includes(password), "no secret may appear in diagnostic output")
    const beforeCompare = calls.length
    const compared = await diagnose({ home, workspace, compareWorkspace: desktopWorkspace, env: {} })
    assert.equal(compared.comparison.workspace, desktopWorkspace)
    assert.equal(compared.comparison.status, "ready")
    assert.deepEqual(compared.comparison.commands, { loop: false, goal: false, count: 1 })
    assert.equal(compared.comparison.matchesPrimary, false, "Desktop parent and terminal child must be comparable")
    assert.ok(calls.slice(beforeCompare).some((entry) =>
      entry.url === "/api/command" && entry.directory === desktopWorkspace &&
      entry.auth === "Basic " + Buffer.from("opencode:" + password).toString("base64")
    ), "comparison must use the same authorized local server and the requested Desktop project location")
    assert.ok(!JSON.stringify(compared).includes(password), "comparison never exposes credentials")
    const same = await diagnose({ home, workspace, compareWorkspace: workspace, env: {} })
    assert.equal(same.comparison, undefined, "identical workspace needs no redundant catalog probe")
    const bad = await diagnose({
      home, workspace, env: {}, server: "https://example.com", fetchImpl: () => { throw new Error("must not contact remote") },
    })
    assert.equal(bad.service.status, "refused-nonlocal-or-invalid-url")
    await writeFile(path.join(state, "service.json"), JSON.stringify({ url, pid: process.pid + 5, password }))
    const stale = await diagnose({ home, workspace, env: {} })
    assert.equal(stale.service.status, "stale-service-registration")
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})

test("installer desktop diagnosis is read-only and does not invoke Loop or Goal installers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "loop-desktop-installer-"))
  try {
    const installer = fileURLToPath(new URL("./install-with-goals.mjs", import.meta.url))
    const result = spawnSync(process.execPath, [installer, "--desktop-diagnostics", "--workspace", home, "--json"], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, OPENCODE_CONFIG_DIR: path.join(home, "no-config"), XDG_STATE_HOME: path.join(home, "no-state") },
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.service.status, "registration-not-found")
    assert.equal(report.workspace, home)
    assert.equal(await readFile(path.join(home, "no-config", "opencode.json"), "utf8").then(() => true, () => false), false)
    assert.ok(!result.stdout.includes("Installed/updated"), "installer must not run in diagnosis mode")
  } finally { await rm(home, { recursive: true, force: true }) }
})
