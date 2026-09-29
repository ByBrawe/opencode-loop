import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNativeLoopRuntime } from "../src/source/opencode2/native-runtime.js"
import { normalizeOpenCode2NativeEvent } from "../src/source/opencode2/events.js"
import { createOpenCode2EventBridge } from "../src/source/opencode2/event-bridge.js"
import { readState } from "../src/source/core/state.js"

let cases = 0
async function fixture(extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-native-"))
  const scope = { directory, sessionID: "ses-native-test" }
  let clock = 10_000
  const prompts = [], compacts = [], shells = [], commands = [], hooks = [], timers = []
  const runtime = createNativeLoopRuntime({
    directory, now: () => clock,
    prompt: async (request) => { if (request.resume !== false) prompts.push(request); return { id: request.id } },
    compact: async (request) => { compacts.push(request); return { id: request.id } },
    shell: async (request) => { shells.push(request); return { id: request.id, status: "running" } },
    command: async (request) => { commands.push(request) },
    wait: async () => {},
    runShellCommand: async (command) => { hooks.push(command); return { code: 0, stdout: "ok", stderr: "" } },
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer },
    clearTimer: (timer) => { timer.cancelled = true },
    ...extra,
  })
  const event = (kind, action, data = {}) => runtime.onEvent({ ...scope, kind, action, ...data })
  return {
    runtime, scope, directory, prompts, compacts, shells, commands, hooks, timers, event,
    add: (args) => event("command", "executed", { name: "loop", arguments: args }),
    control: (name, args = "") => event("command", "executed", { name, arguments: args }),
    wake: () => runtime.wake(scope),
    state: () => readState(directory, scope.sessionID),
    complete: async (index = prompts.length - 1) => {
      await event("inbox", "delivered", { inboxID: prompts[index].id })
      await event("session", "status", { status: "busy" })
      return event("session", "idle")
    },
    tick: async (ms) => { clock += ms; const timer = timers.find((entry) => !entry.cancelled); assert.ok(timer, "expected a timer"); timer.cancelled = true; return timer.fn() },
    close: async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}
async function test(name, run, extra) {
  const f = await fixture(extra)
  try { await run(f); cases++; console.log(`ok ${cases}: ${name}`) }
  finally { await f.close() }
}

await test("one durable prompt under concurrent idle notifications", async (f) => {
  assert.equal((await f.add("0s keep working --max-runs 2")).accepted, true)
  await Promise.all(Array.from({ length: 12 }, () => f.wake()))
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].delivery, "queue")
  assert.equal(f.prompts[0].metadata.opencode_loop_v2, true)
  await f.event("session", "idle")
  assert.equal(f.prompts.length, 1, "an unrelated terminal cannot finish an undelivered inbox")
  await f.complete()
  assert.equal(f.prompts.length, 2)
  await f.complete()
  const job = (await f.state()).jobs[0]
  assert.equal(job.runCount, 2)
  assert.equal(job.enabled, false)
  assert.equal(job.v2Run, undefined)
})

for (const order of ["compaction-first", "execution-first"]) {
  await test(`compaction barrier: ${order}`, async (f) => {
    await f.add('0s continue --max-runs 2 --verify "node verify.js"')
    await f.wake()
    await f.event("inbox", "delivered", { inboxID: f.prompts[0].id })
    await f.event("compaction", "started")
    await f.event("message", "updated", { role: "user", messageID: "core-marker" })
    const first = order === "compaction-first" ? ["compaction", "ended"] : ["session", "idle"]
    const second = order === "compaction-first" ? ["session", "idle"] : ["compaction", "ended"]
    await f.event(...first)
    assert.equal(f.prompts.length, 1)
    assert.equal(f.hooks.length, 0)
    await f.event(...second)
    assert.equal(f.hooks.length, 1)
    assert.equal(f.prompts.length, 2)
  })
}

await test("rejected or uncertain admission never charges a run or spins", async (f) => {
  await f.add("0s task --max-runs 1")
  await f.wake()
  const job = (await f.state()).jobs[0]
  assert.equal(job.runCount, 0)
  assert.equal(job.enabled, true)
  assert.equal(job.paused, true)
  assert.equal(job.pauseReason, "admission-uncertain")
  assert.ok(job.v2Run.id, "retain the identity of a potentially admitted request")
  await f.event("session", "idle")
  assert.equal((await f.state()).jobs[0].failureCount, 1)
}, { prompt: async () => { throw new Error("lost response") } })

await test("confirmed pending cancellation refunds only the unexecuted run", async (f) => {
  await f.add("0s task --max-runs 1")
  await f.wake()
  await f.control("loop-pause")
  await f.event("inbox", "cancelled", { inboxID: f.prompts[0].id })
  const job = (await f.state()).jobs[0]
  assert.equal(job.runCount, 0)
  assert.equal(job.enabled, true)
  assert.equal(job.paused, true)
  assert.equal(job.v2Run, undefined)
  await f.control("loop-resume")
  await f.wake()
  assert.equal(f.prompts.length, 2)
})

await test("foreground admission suppresses verification and continuation", async (f) => {
  await f.add('0s task --max-runs 1 --verify "node verify.js"')
  await f.wake()
  await f.event("inbox", "delivered", { inboxID: f.prompts[0].id })
  await f.event("foreground", "admitted")
  await f.event("session", "idle")
  assert.equal(f.hooks.length, 0)
  assert.equal(f.prompts.length, 1)
})

await test("soft timeout cannot abort native compaction", async (f) => {
  await f.add("0s task --max-runs 2 --timeout 10ms")
  await f.wake()
  await f.event("inbox", "delivered", { inboxID: f.prompts[0].id })
  await f.event("compaction", "started")
  await f.tick(11)
  assert.equal((await f.state()).jobs[0].pauseReason, "timeout-waiting-for-host-boundary")
  await f.event("compaction", "ended")
  await f.event("session", "idle")
  assert.equal(f.prompts.length, 1)
})

await test("prompt and include files use the native prompt", async (f) => {
  await writeFile(path.join(f.directory, "instructions.md"), "UNIQUE_NATIVE_INSTRUCTIONS")
  await writeFile(path.join(f.directory, "progress.md"), "UNIQUE_NATIVE_CONTEXT")
  await f.add("0s task --prompt-file instructions.md --include-file progress.md --max-runs 1")
  await f.wake()
  assert.match(f.prompts[0].text, /UNIQUE_NATIVE_INSTRUCTIONS/)
  assert.match(f.prompts[0].text, /UNIQUE_NATIVE_CONTEXT/)
})

await test("watch baseline does not trigger until the file changes", async (f) => {
  await writeFile(path.join(f.directory, "progress.md"), "initial")
  await f.add("--watch progress.md task --max-runs 1")
  await f.wake()
  assert.equal(f.prompts.length, 0)
  await writeFile(path.join(f.directory, "progress.md"), "changed and longer")
  await f.tick(1000)
  assert.equal(f.prompts.length, 1)
})

await test("control state is not --until completion evidence", async (f) => {
  await f.add("0s task --until UNIQUE_COMPLETION_MARKER --max-runs 1")
  await f.wake()
  assert.equal(f.prompts.length, 1)
})

await test("stop-file is enforced before a future interval is due", async (f) => {
  await f.add("1h task --no-now --stop-file STOP")
  await writeFile(path.join(f.directory, "STOP"), "stop")
  await f.tick(1000)
  const job = (await f.state()).jobs[0]
  assert.equal(job.enabled, false)
  assert.equal(job.pauseReason, "stop-file")
  assert.equal(f.prompts.length, 0)
})

await test("maximum runtime is enforced without waiting for the next interval", async (f) => {
  await f.add("1h task --no-now --max-runtime 5s")
  await f.tick(5001)
  assert.equal((await f.state()).jobs[0].pauseReason, "max-runtime")
  assert.equal(f.prompts.length, 0)
})

await test("preflight failure does not consume a run", async (f) => {
  await f.add('0s task --preflight "node check.js" --max-runs 1')
  await f.wake()
  const job = (await f.state()).jobs[0]
  assert.equal(job.runCount, 0)
  assert.equal(job.pauseReason, "preflight-failed")
  assert.equal(f.prompts.length, 0)
}, { runShellCommand: async () => ({ code: 3, stdout: "", stderr: "not ready" }) })

await test("native slash command dispatch uses OpenCode 2 command and arguments fields", async (f) => {
  await f.add("0s --command /review --staged --max-runs 1")
  await f.wake()
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].command, "review")
  assert.equal(f.commands[0].arguments, "--staged")
  assert.equal("name" in f.commands[0], false)
  assert.equal("text" in f.commands[0], false)
})

await test("safe guard covers verification commands too", async (f) => {
  await f.add('0s task --safe --verify "git reset --hard" --max-runs 1')
  await f.wake()
  await f.complete()
  assert.equal(f.hooks.length, 0)
  assert.equal((await f.state()).jobs[0].pauseReason, "verification-failed")
})

await test("dry-run never invokes preflight, shell, or the native model", async (f) => {
  await f.add('0s --shell echo preview --dry-run --preflight "echo preflight" --git-checkpoint')
  const out = await f.wake()
  assert.equal(out.dryRun, true)
  assert.equal(f.prompts.length + f.shells.length + f.hooks.length, 0)
  assert.equal((await f.state()).jobs[0].runCount, 0)
})

await test("compaction cadence does not charge a logical run", async (f) => {
  await f.add("0s task --max-runs 2 --compact-every 1")
  await f.wake()
  await f.complete()
  assert.equal(f.compacts.length, 1)
  assert.equal((await f.state()).jobs[0].runCount, 1)
  await f.event("compaction", "started")
  await f.event("compaction", "ended")
  await f.event("session", "idle")
  assert.equal(f.prompts.length, 2)
  assert.equal((await f.state()).jobs[0].runCount, 2)
})

await test("a failed delivered execution is paused and can be explicitly resumed", async (f) => {
  await f.add("0s task --max-runs 3")
  await f.wake()
  await f.event("inbox", "delivered", { inboxID: f.prompts[0].id })
  await f.event("session", "error", { reason: "execution-failed" })
  assert.equal((await f.state()).jobs[0].paused, true)
  assert.equal((await f.state()).jobs[0].v2Run, undefined)
  await f.control("loop-resume")
  await f.wake()
  assert.equal(f.prompts.length, 2)
})

await test("branch failure cannot run on the wrong branch", async (f) => {
  await f.add("0s task --branch native-loop-test --max-runs 1")
  await f.wake()
  assert.equal(f.prompts.length, 0)
  assert.equal((await f.state()).jobs[0].pauseReason, "branch-unavailable")
})

{
  let resolveBuild, started
  const building = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { resolveBuild = resolve })
  await test("foreground admission during file preparation prevents dispatch", async (f) => {
    await f.add("0s task --max-runs 1")
    const pending = f.wake()
    await building
    await f.event("foreground", "admitted")
    resolveBuild()
    await pending
    assert.equal(f.prompts.length, 0)
    assert.equal((await f.state()).jobs[0].runCount, 0)
  }, { workspace: { untilReached: async () => false, buildPrompt: async () => { started(); await gate; return "prepared" }, createCheckpoint: async () => {} } })
}

{
  const raw = { id: "event-native-duplicate", type: "session.inbox.delivered", location: { directory: "/workspace" }, data: { sessionID: "ses-native", inboxID: "msg-native" } }
  assert.equal(normalizeOpenCode2NativeEvent(raw).inboxID, "msg-native")
  let count = 0
  const bridge = createOpenCode2EventBridge({ directory: "/workspace", onEvent: async () => { count++ } })
  await bridge.dispatch(raw)
  await bridge.dispatch(raw)
  assert.equal(count, 1)
  await bridge.dispose()
  cases++
  console.log(`ok ${cases}: duplicate native event IDs are processed once`)
}
console.log(`Native OpenCode 2 safety: ${cases} scenarios passed`)
