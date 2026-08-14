import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCode2PromptRuntime } from "../src/source/opencode2/prompt-runtime.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-interval-"))
let clock = 1_000
let nextTimerID = 1
const timers = new Map()
const prompts = []
const errors = []

function setTimer(callback, delay) {
  const handle = {
    id: nextTimerID++,
    unref() {},
  }
  timers.set(handle.id, { handle, callback, delay, dueAt: clock + delay })
  return handle
}

function clearTimer(handle) {
  timers.delete(handle?.id)
}

async function fireEarliestTimer() {
  const timer = [...timers.values()].sort((a, b) => a.dueAt - b.dueAt)[0]
  assert.ok(timer, "expected a scheduled timer")
  clock = timer.dueAt
  timers.delete(timer.handle.id)
  return await timer.callback()
}

async function readState(sessionID) {
  const file = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { jobs: [] }
    throw error
  }
}

const runtime = createOpenCode2PromptRuntime({
  prompt: async (request) => { prompts.push({ ...request, at: clock }) },
  now: () => clock,
  setTimer,
  clearTimer,
  onError: (error) => { errors.push(error) },
})

try {
  const sessionID = "ses_interval"
  const added = await runtime.onEvent({
    kind: "command",
    action: "executed",
    name: "loop",
    sessionID,
    directory,
    arguments: "5s --max-runs 3 interval work",
  })
  assert.equal(added.accepted, true)
  assert.equal(added.job.intervalMs, 5_000)
  assert.equal(runtime.scheduledCount(), 0, "first interval run waits for an idle event")

  const statusIdle = await runtime.onEvent({ kind: "session", action: "status", status: "idle", sessionID, directory })
  assert.equal(statusIdle.dispatched, false, "status=idle records readiness but must not duplicate session.idle dispatch")
  assert.equal(prompts.length, 0)

  const first = await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })
  assert.equal(first.dispatched, true)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].at, 1_000)
  assert.equal(runtime.scheduledCount(), 1)
  assert.equal(timers.size, 1)
  assert.equal([...timers.values()][0].delay, 5_000)

  let state = await readState(sessionID)
  assert.equal(state.jobs[0].runCount, 1)
  assert.equal(state.jobs[0].lastRunAt, 1_000)
  assert.equal(state.jobs[0].enabled, true)

  await runtime.onEvent({ kind: "session", action: "status", status: "busy", sessionID, directory })
  const busyTimer = await fireEarliestTimer()
  assert.equal(busyTimer.dispatched, false)
  assert.equal(busyTimer.reason, "not-idle")
  assert.equal(prompts.length, 1, "due timer must never prompt while session is known busy")
  assert.equal(runtime.scheduledCount(), 0, "due work waits for the next idle event instead of spinning timers")

  const second = await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })
  assert.equal(second.dispatched, true)
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].at, 6_000)
  assert.equal(runtime.scheduledCount(), 1)

  const secondStatusIdle = await runtime.onEvent({ kind: "session", action: "status", status: "idle", sessionID, directory })
  assert.equal(secondStatusIdle.dispatched, false)
  assert.equal(prompts.length, 2)

  const idleTimer = await fireEarliestTimer()
  assert.equal(idleTimer.dispatched, true, "timer may dispatch once the session is already known idle")
  assert.equal(prompts.length, 3)
  assert.equal(prompts[2].at, 11_000)
  assert.equal(runtime.scheduledCount(), 0)

  state = await readState(sessionID)
  assert.equal(state.jobs[0].runCount, 3)
  assert.equal(state.jobs[0].enabled, false)
  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, false)
  assert.equal(prompts.length, 3)

  const pauseSession = "ses_pause"
  await runtime.onEvent({
    kind: "command",
    action: "executed",
    name: "loop",
    sessionID: pauseSession,
    directory,
    arguments: "4s --max-runs 2 pause work",
  })
  await runtime.onEvent({ kind: "session", action: "idle", sessionID: pauseSession, directory })
  assert.equal(runtime.scheduledCount(), 1)
  assert.equal(timers.size, 1)

  const paused = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-pause", sessionID: pauseSession, directory, arguments: "" })
  assert.equal(paused.count, 1)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal(timers.size, 0)

  const resumed = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-resume", sessionID: pauseSession, directory, arguments: "" })
  assert.equal(resumed.count, 1)
  assert.equal((await readState(pauseSession)).jobs[0].lastRunAt, 0)
  assert.equal(runtime.scheduledCount(), 0, "resume makes the job immediately due but still idle-gated")
  const resumedRun = await runtime.onEvent({ kind: "session", action: "idle", sessionID: pauseSession, directory })
  assert.equal(resumedRun.dispatched, true)
  assert.equal((await readState(pauseSession)).jobs[0].enabled, false)

  const cleanupSession = "ses_cleanup"
  await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID: cleanupSession, directory, arguments: "10s cleanup work" })
  await runtime.onEvent({ kind: "session", action: "idle", sessionID: cleanupSession, directory })
  assert.equal(runtime.scheduledCount(), 1)
  const stopped = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-stop", sessionID: cleanupSession, directory, arguments: "all" })
  assert.equal(stopped.count, 1)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal(timers.size, 0)

  const deletedSession = "ses_deleted"
  await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID: deletedSession, directory, arguments: "8s delete work" })
  await runtime.onEvent({ kind: "session", action: "idle", sessionID: deletedSession, directory })
  assert.equal(runtime.scheduledCount(), 1)
  const deleted = await runtime.onEvent({ kind: "session", action: "deleted", sessionID: deletedSession, directory })
  assert.equal(deleted.disposedScope, true)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal(timers.size, 0)

  const disposeSession = "ses_dispose"
  await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID: disposeSession, directory, arguments: "9s dispose work" })
  await runtime.onEvent({ kind: "session", action: "idle", sessionID: disposeSession, directory })
  assert.equal(runtime.scheduledCount(), 1)
  assert.equal(await runtime.dispose(), true)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal(timers.size, 0)
  assert.equal(await runtime.dispose(), false)
  assert.deepEqual(errors, [])

  console.log("OpenCode 2 idle-safe interval runtime tests passed")
} finally {
  await runtime.dispose().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
