import assert from "node:assert/strict"
import { createGoalSteeringRuntime } from "../src/source/runtime/goal-steering.js"

function goal(id = "goal-1") {
  return {
    id,
    name: "goal",
    kind: "goal",
    action: "keep working",
    enabled: true,
    paused: false,
    goalStatus: "active",
  }
}

function userEvent(sessionID = "ses-steering", messageID = "user-steering") {
  return {
    type: "message.updated",
    properties: {
      info: { id: messageID, sessionID, role: "user", time: { created: 1000 } },
    },
  }
}

function assistantEvent(sessionID = "ses-steering", parentID = "user-steering") {
  return {
    type: "message.updated",
    properties: {
      info: { id: "assistant-steering", parentID, sessionID, role: "assistant", time: { created: 1100 } },
    },
  }
}

{
  const originalGoal = goal()
  const state = { jobs: [structuredClone(originalGoal)] }
  let activeRun = { jobId: originalGoal.id, job: structuredClone(originalGoal), startedAt: 900 }
  let aborts = 0
  let clears = 0
  const logs = []
  const client = { session: { abort: async () => { aborts += 1 } } }
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => activeRun,
    clearActiveRun: () => { clears += 1; activeRun = undefined },
    readState: async () => structuredClone(state),
    appendLoopLog: async (_directory, type, detail) => logs.push({ type, detail }),
    fireSdk: async (_client, _label, method) => await method(),
    isLoopOwnedUserMessage: () => false,
    now: () => 1000,
  })

  const result = await runtime.handleUserMessage("/workspace", client, { sessionID: "ses-steering", messageID: "user-steering" })
  assert.equal(result.handled, true)
  assert.equal(result.preempted, true)
  assert.equal(aborts, 1, "chat.message steering should abort only the active Goal turn before the new prompt dispatches")
  assert.equal(clears, 1, "the aborted Goal run must no longer be finalized as a completed loop run")
  assert.equal(runtime.shouldSuppressIdle("ses-steering"), true, "abort-generated idle must be suppressed while steering is queued")
  assert.deepEqual(state.jobs[0], originalGoal, "normal steering must not pause or rewrite the Goal contract")
  assert.equal(logs.at(-1)?.type, "goal-user-steering")
  assert.equal(logs.at(-1)?.detail?.preempted, true)

  const duplicate = await runtime.handleEvent("/workspace", client, userEvent())
  assert.equal(duplicate.duplicate, true, "message.updated must not abort a steering message already handled by chat.message")
  assert.equal(aborts, 1)
  assert.equal(clears, 1)

  await runtime.handleEvent("/workspace", client, assistantEvent())
  assert.equal(runtime.shouldSuppressIdle("ses-steering"), false, "matching steering assistant turn should release idle suppression")
}

{
  const currentGoal = goal()
  let aborts = 0
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => undefined,
    clearActiveRun: () => assert.fail("no active run should be cleared"),
    readState: async () => ({ jobs: [structuredClone(currentGoal)] }),
    appendLoopLog: async () => {},
    fireSdk: async () => { aborts += 1 },
    isLoopOwnedUserMessage: () => false,
    now: () => 2000,
  })
  const result = await runtime.handleUserMessage("/workspace", { session: { abort: async () => {} } }, { sessionID: "ses-idle", messageID: "user-idle" })
  assert.equal(result.handled, true)
  assert.equal(result.preempted, false)
  assert.equal(aborts, 0, "an idle Goal should let the foreground user turn start normally")
  assert.equal(runtime.shouldSuppressIdle("ses-idle"), false)
}

{
  const currentGoal = goal()
  const ordinary = { id: "loop-1", kind: "prompt", enabled: true, paused: false }
  let aborts = 0
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => ({ jobId: ordinary.id, job: ordinary, startedAt: 1 }),
    clearActiveRun: () => assert.fail("ordinary Loop work must not be preempted by Goal steering logic"),
    readState: async () => ({ jobs: [structuredClone(currentGoal), ordinary] }),
    appendLoopLog: async () => {},
    fireSdk: async () => { aborts += 1 },
    isLoopOwnedUserMessage: () => false,
    now: () => 3000,
  })
  const result = await runtime.handleUserMessage("/workspace", { session: { abort: async () => {} } }, { sessionID: "ses-ordinary", messageID: "user-ordinary" })
  assert.equal(result.handled, true)
  assert.equal(result.preempted, false)
  assert.equal(aborts, 0)
}

{
  let reads = 0
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => undefined,
    clearActiveRun: () => {},
    readState: async () => { reads += 1; return { jobs: [goal()] } },
    appendLoopLog: async () => {},
    isLoopOwnedUserMessage: () => true,
  })
  const result = await runtime.handleUserMessage("/workspace", { session: {} }, { sessionID: "ses-owned", messageID: "owned-message" })
  assert.equal(result.loopOwned, true)
  assert.equal(reads, 0, "Loop-owned synthetic user messages must not be mistaken for human steering")
}

{
  let clock = 4000
  const currentGoal = goal()
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => ({ jobId: currentGoal.id, job: currentGoal, startedAt: 1 }),
    clearActiveRun: () => {},
    readState: async () => ({ jobs: [structuredClone(currentGoal)] }),
    appendLoopLog: async () => {},
    fireSdk: async (_client, _label, method) => await method(),
    isLoopOwnedUserMessage: () => false,
    now: () => clock,
    suppressionMs: 100,
  })
  await runtime.handleUserMessage("/workspace", { session: { abort: async () => {} } }, { sessionID: "ses-expire", messageID: "user-expire" })
  assert.equal(runtime.shouldSuppressIdle("ses-expire"), true)
  clock += 101
  assert.equal(runtime.shouldSuppressIdle("ses-expire"), false, "lost steering must not suppress autonomous continuation forever")
}

console.log("Goal steering runtime tests passed")
