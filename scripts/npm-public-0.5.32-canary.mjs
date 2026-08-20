import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_JOB !== "test" || process.platform !== "linux") {
  console.log("Public npm 0.5.32 canary skipped outside the Ubuntu CI test job")
  process.exit(0)
}

const loopVersion = "0.5.32"
const goalVersion = "1.3.24"
const loopSpec = `@bybrawe/opencode-loop@${loopVersion}`

function runNpm(args, cwd, env = {}) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm")
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  return spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  })
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim()
}

const exact = runNpm(["view", loopSpec, "version", "--registry=https://registry.npmjs.org"], process.cwd())
assert.equal(exact.status, 0, output(exact) || exact.error?.message)
assert.equal(exact.stdout.trim(), loopVersion)

const latest = runNpm(["view", "@bybrawe/opencode-loop@latest", "version", "--registry=https://registry.npmjs.org"], process.cwd())
assert.equal(latest.status, 0, output(latest) || latest.error?.message)
assert.equal(latest.stdout.trim(), loopVersion)

const root = mkdtempSync(path.join(os.tmpdir(), "opencode-loop-public-canary-"))
const config = path.join(root, "config")
try {
  const install = runNpm(
    ["exec", "--yes", `--package=${loopSpec}`, "--", "opencode-loop", "--with-goals", "--without-loop-goals"],
    root,
    { OPENCODE_CONFIG_DIR: config },
  )
  assert.equal(install.status, 0, output(install) || install.error?.message)

  const commands = readdirSync(path.join(config, "commands"))
  assert.ok(commands.includes("loop.md"), "public Loop installer must keep normal /loop commands")
  assert.ok(commands.includes("goal.md"), "combined installer must install the dedicated /goal command")
  assert.equal(
    commands.some((name) => name === "loop-goal.md" || (name.startsWith("loop-goal-") && name.endsWith(".md"))),
    false,
    "--without-loop-goals must remove the packaged legacy Loop Goal command surface",
  )

  const agent = readFileSync(path.join(config, "agents", "opencode-loop-local.md"), "utf8")
  assert.match(agent, /^mode:\s*subagent$/m)
  assert.match(agent, /^hidden:\s*true$/m)

  const configText = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
    .flatMap((name) => {
      try { return [readFileSync(path.join(config, name), "utf8")] } catch { return [] }
    })
    .join("\n")
  assert.match(configText, new RegExp(`@bybrawe/opencode-goal@${goalVersion.replaceAll(".", "\\.")}`))

  console.log(`Public npm ${loopSpec} + @bybrawe/opencode-goal@${goalVersion} combined installer canary passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
