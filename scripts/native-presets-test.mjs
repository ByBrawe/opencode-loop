import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/source/opencode2/native-plugin.js"
import { parseLoopArgs } from "../src/source/core/args.js"
import { presetDefaults } from "../src/source/core/jobs.js"
import { normalizeLoopScheduleArgs } from "../src/source/core/schedule-syntax.js"
import { readState } from "../src/source/core/state.js"

const PRESETS = ["loop-dev", "loop-testfix", "loop-progress", "loop-safe-dev", "loop-command", "loop-cmd", "loop-prompt", "loop-ask", "loop-shell"]
const SESSION = "ses_native_presets"
async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "loop-native-presets-"))
  const directory = path.join(temp, "project with spaces")
  await mkdir(directory)
  const commands = new Map(), prompts = [], shellCalls = []
  let dispose
  try {
    dispose = await plugin.setup({
      location: { directory }, options: {}, app: { version: "2.0.18" },
      session: {
        get: async ({ sessionID }) => sessionID === SESSION ? { id: SESSION, location: { directory } } : null,
        hook: async () => {},
        prompt: async request => { prompts.push(request); return { id: request.id || "msg_ack" } },
        command: async () => { throw new Error("a deferred/dry-run preset must not execute a slash command") },
        wait: async () => {},
        shell: async request => { shellCalls.push(request); return { id: request.id, status: "exited", exit: 0 } },
      },
      command: { transform: async edit => edit({ add(definition) {
        assert.equal(commands.has(definition.name), false, `duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
      } }) },
      event: { subscribe() { return (async function* () {})() } },
    })
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error }
  return {
    temp, directory, commands, prompts, shellCalls,
    async execute(name, text = "") {
      assert.ok(commands.has(name), `native command missing: ${name}`)
      return commands.get(name).execute({ sessionID: SESSION, prompt: { text } })
    },
    state: () => readState(directory, SESSION),
    async dispose() { await dispose(); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
  }
}
const fields = ["name", "action", "kind", "intervalMs", "immediate", "safe", "askNever", "noOverlap", "checkpointOnly", "gitCheckpoint", "batch", "progressFile", "verifyCommand", "testCommand", "maxRuns", "dryRun"]
for (const name of PRESETS) {
  test(`native ${name} preserves the shared V1 preset parser contract`, async () => {
    const host = await fixture()
    try {
      const action = ["loop-command", "loop-cmd"].includes(name) ? "/review project"
        : name === "loop-shell" ? "npm test"
        : ["loop-prompt", "loop-ask"].includes(name) ? "did you run tests and tsc --noEmit?" : ""
      const text = `every 1h --dry-run --max-runs 2 ${action}`.trim()
      const normalized = normalizeLoopScheduleArgs(text, presetDefaults(name))
      assert.equal(normalized.ok, true, normalized.error)
      const expected = parseLoopArgs(normalized.args, normalized.defaults)
      assert.equal(expected.ok, true, expected.error)
      const response = await host.execute(name, text)
      assert.equal(response.accepted, true)
      const state = await host.state()
      assert.equal(state.jobs.length, 1)
      for (const field of fields) assert.deepEqual(state.jobs[0][field], expected.job[field], `${name}: ${field}`)
      assert.equal(state.jobs[0].intervalMs, 3600000, "explicit duration cannot remain part of the task text")
      assert.equal(state.jobs[0].immediate, false)
      assert.equal(state.jobs[0].scheduleMode, normalized.scheduleMode)
      assert.equal(state.jobs[0].scheduleSyntax, normalized.scheduleSyntax)
      assert.equal(state.jobs[0].runCount, 0, "deferred presets must not dispatch on registration")
      assert.deepEqual(host.prompts, [])
      assert.deepEqual(host.shellCalls, [])
    } finally { await host.dispose() }
  })
}

test("native preset arguments need no duration token and retain leading flags", async () => {
  const host = await fixture()
  try {
    const output = await host.execute("loop-shell", "--no-now --dry-run npm test")
    assert.equal(output.job.action, "npm test")
    assert.equal(output.job.kind, "shell")
    assert.equal(output.job.immediate, false)
  } finally { await host.dispose() }
})

test("an immediate native development preset enters the existing dry-run safety path", async () => {
  const host = await fixture()
  try {
    await host.execute("loop-dev", "--dry-run")
    const job = (await host.state()).jobs[0]
    assert.equal(job.name, "dev")
    assert.equal(job.paused, true)
    assert.equal(job.pauseReason, "dry-run")
    assert.equal(job.runCount, 0)
    assert.deepEqual(host.prompts, [])
  } finally { await host.dispose() }
})

test("zero-delay deferred shell preset uses Loop-managed local execution without an unrelated model turn", async () => {
  const host = await fixture()
  try {
    const marker = path.join(host.directory, "shell-ran.txt")
    const script = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('shell-ran.txt','ok')"`
    await host.execute("loop-shell", `0s ${script} --max-runs 1`)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (await host.state()).jobs[0]?.runCount !== 1) await new Promise(resolve => setTimeout(resolve, 10))
    while (Date.now() < deadline) {
      try { if ((await readFile(marker, "utf8")) === "ok") break } catch {}
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal((await host.state()).jobs[0].runCount, 1)
    assert.equal(await readFile(marker, "utf8"), "ok")
    assert.equal(host.shellCalls.length, 0, "V2 must not call undocumented session.shell")
    assert.deepEqual(host.prompts, [])
  } finally { await host.dispose() }
})

test("native compaction rejects its preset before job persistence because V2 exposes no manual compaction action", async () => {
  const host = await fixture()
  try {
    await assert.rejects(host.execute("loop-compact", "--dry-run"), /native compaction capability/)
    assert.deepEqual((await host.state()).jobs, [])
  } finally { await host.dispose() }
})

test("native loop-init creates progress without a model turn or a Loop job", async () => {
  const host = await fixture()
  try {
    const response = await host.execute("loop-init")
    assert.equal(response.created, true)
    assert.match(await readFile(path.join(host.directory, "progress.md"), "utf8"), /^# Progress\n/)
    assert.deepEqual((await host.state()).jobs, [])
    assert.equal(host.prompts.length, 1)
    assert.equal(host.prompts[0].resume, false)
  } finally { await host.dispose() }
})

test("native loop-init preserves existing bytes, including concurrent initialization", async () => {
  const host = await fixture()
  try {
    const results = await Promise.all([host.execute("loop-init"), host.execute("loop-init")])
    assert.equal(results.filter(result => result.created).length, 1)
    const file = path.join(host.directory, "progress.md")
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0, 255, 65])
    await writeFile(file, original)
    assert.equal((await host.execute("loop-init")).created, false)
    assert.deepEqual(await readFile(file), original)
    await mkdir(path.join(host.directory, "notes"))
    assert.equal((await host.execute("loop-init", "notes/custom progress.md")).created, true)
  } finally { await host.dispose() }
})

test("native loop-init rejects traversal, control-plane paths and symlink escapes", async () => {
  const host = await fixture()
  try {
    for (const target of ["../outside.md", ".", ".git/HEAD", ".opencode/opencode-loop/forged.json"]) {
      await assert.rejects(host.execute("loop-init", target), /inside the project|control-plane/)
    }
    const outside = path.join(host.temp, "outside")
    await mkdir(outside)
    await symlink(outside, path.join(host.directory, "escape"), process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(host.execute("loop-init", "escape/progress.md"), /inside the project/)
    await assert.rejects(readFile(path.join(outside, "progress.md")), { code: "ENOENT" })
    assert.deepEqual(host.prompts, [])
    assert.deepEqual((await host.state()).jobs, [])
  } finally { await host.dispose() }
})


const schedules = [
  { text: "continue the project --dry-run", action: "continue the project", interval: 0, immediate: true, mode: "idle", syntax: "idle-shorthand", maxRuns: 0 },
  { text: "idle continue --dry-run", action: "continue", interval: 0, immediate: true, mode: "idle", syntax: "idle", maxRuns: 0 },
  { text: "every 1h continue --dry-run", action: "continue", interval: 3600000, immediate: false, mode: "interval", syntax: "every", maxRuns: 0 },
  { text: "after 1h continue --now --max-runs 9 --dry-run", action: "continue", interval: 3600000, immediate: false, mode: "once", syntax: "after", maxRuns: 1 },
  { text: "in 1h continue --dry-run", action: "continue", interval: 3600000, immediate: false, mode: "once", syntax: "after", maxRuns: 1 },
  { text: "1h continue --dry-run", action: "continue", interval: 3600000, immediate: true, mode: "interval", syntax: "legacy", maxRuns: 0 },
  { text: "1h --no-now continue --dry-run", action: "continue", interval: 3600000, immediate: false, mode: "interval", syntax: "legacy", maxRuns: 0 },
  { text: "every 1h --now continue --dry-run", action: "continue", interval: 3600000, immediate: true, mode: "interval", syntax: "every", maxRuns: 0 },
  { text: "--safe --ask-never continue --dry-run", action: "continue", interval: 0, immediate: true, mode: "idle", syntax: "idle-shorthand", maxRuns: 0 },
]
for (const example of schedules) {
  test(`native schedule grammar: ${example.text}`, async () => {
    const host = await fixture()
    try {
      await host.execute("loop", example.text)
      const job = (await host.state()).jobs[0]
      assert.equal(job.action, example.action)
      assert.equal(job.intervalMs, example.interval)
      assert.equal(job.immediate, example.immediate)
      assert.equal(job.maxRuns, example.maxRuns)
      assert.equal(job.scheduleMode, example.mode)
      assert.equal(job.scheduleSyntax, example.syntax)
      assert.equal(job.runCount, 0)
      assert.deepEqual(host.prompts, [])
      assert.deepEqual(host.shellCalls, [])
    } finally { await host.dispose() }
  })
}

test("invalid native schedules and unsupported Goal overlap are rejected before persistence", async () => {
  const host = await fixture()
  try {
    for (const text of ["every later continue", "after later continue", "in later continue", "0s --allow-goal-overlap continue"]) {
      await assert.rejects(host.execute("loop", text), /Invalid.*schedule|Goal.*reservation/)
      assert.deepEqual((await host.state()).jobs, [])
    }
    assert.deepEqual(host.prompts, [])
  } finally { await host.dispose() }
})

for (const example of [
  { args: "", verify: "npm test", action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test" },
  { args: "npm run check", verify: "npm run check", action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm run check" },
  { args: '--verify "npm run lint"', verify: "npm run lint", action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm run lint" },
  { args: 'fix parser tests --verify "npm run lint"', verify: "npm run lint", action: "fix parser tests" },
]) {
  test(`native testfix command semantics: ${example.args || "default"}`, async () => {
    const host = await fixture()
    try {
      await host.execute("loop-testfix", `every 1h --dry-run ${example.args}`)
      const job = (await host.state()).jobs[0]
      assert.equal(job.verifyCommand, example.verify)
      assert.equal(job.action, example.action)
      assert.equal(job.intervalMs, 3600000)
      assert.equal(job.immediate, false)
      assert.equal(job.safe, true)
      assert.equal(job.askNever, true)
      assert.deepEqual(host.prompts, [])
    } finally { await host.dispose() }
  })
}
