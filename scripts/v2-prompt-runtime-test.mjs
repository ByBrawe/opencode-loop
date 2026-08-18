import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCode2PromptRuntime } from "../src/source/opencode2/prompt-runtime.js"
import { formatOpenCode2LoopStatus } from "../src/source/opencode2/status.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-prompt-"))
const sessionID = "ses_v2_prompt_runtime"
const prompts = []
const runtime = createOpenCode2PromptRuntime({ prompt: async (request) => { prompts.push(request) } })

async function readState() {
  const file = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { jobs: [] }
    throw error
  }
}

try {
  const added = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --max-runs 2 --ask-never continue the current task" })
  assert.equal(added.accepted, true)
  let state = await readState()
  assert.equal(state.jobs.length, 1)
  assert.equal(state.jobs[0].runCount, 0)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, true)
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].text.includes("AUTONOMOUS OPENCODE LOOP ITERATION"))
  assert.ok(prompts[0].text.includes("continue the current task"))
  assert.ok(prompts[0].text.includes("Do not ask the user questions"))
  state = await readState()
  assert.equal(state.jobs[0].runCount, 1)
  assert.equal(state.jobs[0].enabled, true)

  const paused = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-pause", sessionID, directory, arguments: "" })
  assert.equal(paused.count, 1)
  state = await readState()
  assert.equal(state.jobs[0].paused, true)
  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, false)
  assert.equal(prompts.length, 1)

  const resumed = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-resume", sessionID, directory, arguments: "" })
  assert.equal(resumed.count, 1)
  state = await readState()
  assert.equal(state.jobs[0].paused, false)
  assert.equal(state.jobs[0].lastRunAt, 0)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, true)
  state = await readState()
  assert.equal(state.jobs[0].runCount, 2)
  assert.equal(state.jobs[0].enabled, false)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, false)
  assert.equal(prompts.length, 2)

  const status = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-status", sessionID, directory, arguments: "" })
  assert.equal(status.accepted, true)
  assert.equal(prompts.length, 3)
  assert.equal(prompts[2].noReply, true)
  assert.match(prompts[2].text, /^OpenCode loop status:/)
  assert.match(prompts[2].text, /runs=2/)
  assert.match(prompts[2].text, /continue the current task/)

  const interval = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "5m --name later --multi do this later" })
  assert.equal(interval.accepted, true)
  assert.equal(interval.job.intervalMs, 300_000)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal((await readState()).jobs.length, 2)

  const intervalRemoved = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-stop", sessionID, directory, arguments: "later" })
  assert.equal(intervalRemoved.count, 1)
  assert.equal((await readState()).jobs.length, 1)

  const command = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --command /review" })
  assert.equal(command.accepted, false)
  assert.ok(command.blockers.includes("command-capability"))
  assert.equal((await readState()).jobs.length, 1)

  const named = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --name keep --multi keep working" })
  assert.equal(named.accepted, true)
  assert.equal((await readState()).jobs.length, 2)

  const removed = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-stop", sessionID, directory, arguments: "keep" })
  assert.equal(removed.count, 1)
  assert.equal((await readState()).jobs.length, 1)

  const cleared = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-clear", sessionID, directory, arguments: "missing-target-is-ignored" })
  assert.equal(cleared.count, 1)
  assert.equal(cleared.target, "all")
  assert.equal((await readState()).jobs.length, 0)

  const emptyStatus = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-status", sessionID, directory, arguments: "" })
  assert.equal(emptyStatus.accepted, true)
  assert.equal(prompts.at(-1).noReply, true)
  assert.equal(prompts.at(-1).text, "OpenCode loop status:\nNo active loop jobs.")

  console.log("OpenCode 2 prompt runtime contract passed")
} finally {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
}

{
  const current = Date.parse("2026-08-18T00:00:00.000Z")
  const status = formatOpenCode2LoopStatus({
    jobs: [{
      id: "job_no_now",
      name: "delayed",
      action: "wait before the first run",
      kind: "prompt",
      intervalMs: 1_000,
      immediate: false,
      createdAt: new Date(current).toISOString(),
      lastRunAt: 0,
      runCount: 0,
      failureCount: 0,
      noOverlap: true,
    }],
  }, current)
  assert.match(status.text, /due in 1s/)
}

{
  const delayedDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-no-now-"))
  const delayedSessionID = "ses_v2_no_now"
  const delayedPrompts = []
  const scheduled = []
  let clock = Date.now()
  const delayedRuntime = createOpenCode2PromptRuntime({
    prompt: async (request) => { delayedPrompts.push(request) },
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      scheduled.push(handle)
      return handle
    },
    clearTimer: () => {},
  })
  const delayedFile = path.join(delayedDirectory, ".opencode", "opencode-loop", `${delayedSessionID}.json`)

  try {
    const added = await delayedRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop",
      sessionID: delayedSessionID,
      directory: delayedDirectory,
      arguments: "1s --no-now --max-runs 1 wait before the first run",
    })
    assert.equal(added.accepted, true)
    assert.equal(added.job.immediate, false)

    let state = JSON.parse(await readFile(delayedFile, "utf8"))
    const createdAt = Date.parse(state.jobs[0].createdAt)
    assert.ok(Number.isFinite(createdAt))
    assert.ok(scheduled.some((timer) => timer.ms > 0), "--no-now must schedule a future first run")

    clock = createdAt + 999
    const earlyIdle = await delayedRuntime.onEvent({ kind: "session", action: "idle", sessionID: delayedSessionID, directory: delayedDirectory })
    assert.equal(earlyIdle.dispatched, false)
    assert.equal(delayedPrompts.length, 0, "--no-now must not dispatch before createdAt + interval")

    clock = createdAt + 1_001
    const dueIdle = await delayedRuntime.onEvent({ kind: "session", action: "idle", sessionID: delayedSessionID, directory: delayedDirectory })
    assert.equal(dueIdle.dispatched, true)
    assert.equal(delayedPrompts.length, 1)
    state = JSON.parse(await readFile(delayedFile, "utf8"))
    assert.equal(state.jobs[0].runCount, 1)
    assert.equal(state.jobs[0].enabled, false)
  } finally {
    await delayedRuntime.dispose()
    await rm(delayedDirectory, { recursive: true, force: true })
  }
}

{
  const nowDirectory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-run-now-"))
  const nowSessionID = "ses_v2_run_now"
  const nowPrompts = []
  const clock = Date.parse("2026-08-18T00:00:00.000Z")
  const nowRuntime = createOpenCode2PromptRuntime({
    prompt: async (request) => { nowPrompts.push(request) },
    now: () => clock,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })
  const nowFile = path.join(nowDirectory, ".opencode", "opencode-loop", `${nowSessionID}.json`)

  try {
    await nowRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop",
      sessionID: nowSessionID,
      directory: nowDirectory,
      arguments: "0s --name first --multi --max-runs 1 first naturally due job",
    })
    await nowRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop",
      sessionID: nowSessionID,
      directory: nowDirectory,
      arguments: "10m --no-now --name second --multi --max-runs 1 second forced job",
    })
    const paused = await nowRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop-pause",
      sessionID: nowSessionID,
      directory: nowDirectory,
      arguments: "second",
    })
    assert.equal(paused.count, 1)

    const missing = await nowRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop-now",
      sessionID: nowSessionID,
      directory: nowDirectory,
      arguments: "missing",
    })
    assert.equal(missing.count, 0)

    const requested = await nowRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop-now",
      sessionID: nowSessionID,
      directory: nowDirectory,
      arguments: "second",
    })
    assert.equal(requested.count, 1)
    assert.equal(requested.target, "second")

    let state = JSON.parse(await readFile(nowFile, "utf8"))
    const first = state.jobs.find((job) => job.name === "first")
    const second = state.jobs.find((job) => job.name === "second")
    assert.equal(first.runNowRequestedAt, undefined)
    assert.equal(second.paused, false)
    assert.equal(second.runNowRequestedAt, clock)
    const status = formatOpenCode2LoopStatus(state, clock)
    assert.match(status.text, /second forced job[^\n]*due in every idle[^\n]*run-now/)

    const forcedIdle = await nowRuntime.onEvent({ kind: "session", action: "idle", sessionID: nowSessionID, directory: nowDirectory })
    assert.equal(forcedIdle.dispatched, true)
    assert.match(nowPrompts[0].text, /second forced job/)
    state = JSON.parse(await readFile(nowFile, "utf8"))
    assert.equal(state.jobs.find((job) => job.name === "second").runNowRequestedAt, undefined)
    assert.equal(state.jobs.find((job) => job.name === "second").runCount, 1)
    assert.equal(state.jobs.find((job) => job.name === "first").runCount, 0)

    const naturalIdle = await nowRuntime.onEvent({ kind: "session", action: "idle", sessionID: nowSessionID, directory: nowDirectory })
    assert.equal(naturalIdle.dispatched, true)
    assert.match(nowPrompts[1].text, /first naturally due job/)
  } finally {
    await nowRuntime.dispose()
    await rm(nowDirectory, { recursive: true, force: true })
  }
}

console.log("OpenCode 2 --no-now and loop-now contracts passed")
