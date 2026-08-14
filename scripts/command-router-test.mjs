import assert from "node:assert/strict"
import { createCommandRouter } from "../src/source/opencode/command-router.js"
import { clearCommandLifecycle } from "../src/source/opencode/commands.js"

const HANDLER_NAMES = [
  "addGoal",
  "statusGoal",
  "pauseGoal",
  "resumeGoal",
  "clearGoal",
  "completeGoalCommand",
  "blockGoalCommand",
  "addLoop",
  "stopLoop",
  "statusLoop",
  "logsLoop",
  "helpLoop",
  "runNow",
  "updateJobState",
  "doctorLoop",
  "initLoop",
  "exportLoop",
]

function harness() {
  const calls = []
  const remembered = []
  const captured = []
  const guarded = []
  const handlers = Object.fromEntries(HANDLER_NAMES.map((name) => [name, async (...args) => {
    calls.push({ name, args })
  }]))
  const router = createCommandRouter({
    rememberSession: (...args) => remembered.push(args),
    captureSessionExecutionContext: async (...args) => { captured.push(args) },
    guardLoopOwnedUserMessage: (...args) => guarded.push(args),
    handlers,
  })
  return { router, calls, remembered, captured, guarded }
}

assert.throws(() => createCommandRouter({}), /rememberSession/)
assert.throws(() => createCommandRouter({ rememberSession() {}, handlers: {} }), /handlers\.addGoal/)

{
  const sessionID = "router-before"
  clearCommandLifecycle(sessionID)
  const h = harness()
  const output = {}
  const client = { id: "client" }
  const result = await h.router("/work", client, { sessionID, command: "loop-status", arguments: "" }, undefined, undefined, output)
  assert.equal(result, true)
  assert.equal(output.noReply, true)
  assert.deepEqual(h.calls.map((item) => item.name), ["statusLoop"])
  assert.deepEqual(h.calls[0].args, ["/work", client, sessionID])
  assert.equal(h.remembered.length, 1)
  assert.deepEqual(h.remembered[0], ["/work", client, sessionID])
  assert.equal(h.captured.length, 1)
  assert.deepEqual(h.captured[0], [client, sessionID])
  assert.deepEqual(h.guarded, [[sessionID]])

  const eventResult = await h.router("/work", client, { sessionID, name: "loop-status", arguments: "", messageID: "msg-1" }, undefined, undefined, undefined, "event")
  assert.equal(eventResult, true)
  assert.equal(h.calls.length, 1, "matching command.executed event must not run the handler twice")
  assert.equal(h.remembered.length, 2)
  assert.equal(h.captured.length, 2)
  assert.equal(h.guarded.length, 1, "consumed compatibility event must return before user-message guarding")
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-event"
  clearCommandLifecycle(sessionID)
  const h = harness()
  const client = {}
  const event = { sessionID, name: "loop-help", arguments: "", messageID: "evt-1" }
  assert.equal(await h.router("/work", client, event, undefined, undefined, undefined, "event"), true)
  assert.deepEqual(h.calls.map((item) => item.name), ["helpLoop"])
  assert.deepEqual(h.calls[0].args, [client, sessionID])
  assert.deepEqual(h.guarded, [[sessionID]])

  assert.equal(await h.router("/work", client, event, undefined, undefined, undefined, "event"), true)
  assert.equal(h.calls.length, 1, "same event message ID must be idempotent")
  assert.equal(h.guarded.length, 1)
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-preset"
  clearCommandLifecycle(sessionID)
  const h = harness()
  assert.equal(await h.router("/repo", {}, { sessionID, command: "loop-shell", arguments: "10m npm test" }), true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].name, "addLoop")
  assert.equal(h.calls[0].args[0], "/repo")
  assert.equal(h.calls[0].args[2], sessionID)
  assert.equal(h.calls[0].args[3], "10m npm test")
  assert.equal(h.calls[0].args[4].kind, "shell")
  assert.equal(h.calls[0].args[4].name, "shell")
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-state"
  clearCommandLifecycle(sessionID)
  const h = harness()
  assert.equal(await h.router("/work", {}, { sessionID, command: "loop-pause", arguments: "dev" }), true)
  let call = h.calls.at(-1)
  assert.equal(call.name, "updateJobState")
  assert.equal(call.args[3], "dev")
  assert.equal(call.args[5], "Paused")
  assert.deepEqual(call.args[4]({ paused: false, lastRunAt: 99, keep: true }), { paused: true, lastRunAt: 99, keep: true })

  assert.equal(await h.router("/work", {}, { sessionID, command: "loop-resume", arguments: "dev" }), true)
  call = h.calls.at(-1)
  assert.equal(call.name, "updateJobState")
  assert.equal(call.args[5], "Resumed")
  assert.deepEqual(call.args[4]({ paused: true, lastRunAt: 99, keep: true }), { paused: false, lastRunAt: 0, keep: true })

  assert.equal(await h.router("/work", {}, { sessionID, command: "loop-clear", arguments: "ignored" }), true)
  call = h.calls.at(-1)
  assert.equal(call.name, "stopLoop")
  assert.equal(call.args[3], "all")
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-aliases"
  clearCommandLifecycle(sessionID)
  const h = harness()
  assert.equal(await h.router("/work", {}, { sessionID, command: "loop-goal-complete", arguments: "ship it" }), true)
  assert.equal(h.calls.at(-1).name, "completeGoalCommand")
  assert.equal(h.calls.at(-1).args[3], "ship it")
  assert.equal(await h.router("/work", {}, { sessionID, command: "loop-remove", arguments: "dev" }), true)
  assert.equal(h.calls.at(-1).name, "stopLoop")
  assert.equal(h.calls.at(-1).args[3], "dev")
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-unknown-before"
  clearCommandLifecycle(sessionID)
  const h = harness()
  const output = {}
  assert.equal(await h.router("/work", {}, { sessionID, command: "not-loop", arguments: "x" }, undefined, undefined, output), false)
  assert.equal(await h.router("/work", {}, { sessionID, command: "not-loop", arguments: "x" }, undefined, undefined, output), false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.captured.length, 0)
  assert.equal(h.guarded.length, 0)
  assert.equal(output.noReply, undefined)
  clearCommandLifecycle(sessionID)
}

{
  const sessionID = "router-unknown-event"
  clearCommandLifecycle(sessionID)
  const h = harness()
  const event = { sessionID, name: "not-loop", arguments: "x", messageID: "unknown-1" }
  assert.equal(await h.router("/work", {}, event, undefined, undefined, undefined, "event"), false)
  assert.equal(await h.router("/work", {}, event, undefined, undefined, undefined, "event"), false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.captured.length, 0)
  assert.equal(h.guarded.length, 0)
  clearCommandLifecycle(sessionID)
}

{
  const h = harness()
  assert.equal(await h.router("/work", {}, { command: "loop-status" }), false)
  assert.equal(await h.router("/work", {}, { sessionID: "missing-name" }), false)
  assert.equal(h.remembered.length, 0)
  assert.equal(h.calls.length, 0)
}

console.log("command router tests passed")
