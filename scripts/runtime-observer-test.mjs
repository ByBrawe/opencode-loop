import assert from "node:assert/strict"
import { observeRuntimeEvent } from "../src/source/runtime/observer.js"

const calls = []
const manager = {
  observeExternal(sessionID) { calls.push(["observe", sessionID]) },
  remove(sessionID, options) { calls.push(["remove", sessionID, options?.reason]) },
  dispose(reason) { calls.push(["dispose", reason]) },
}

const created = observeRuntimeEvent(manager, {
  event: { type: "session.created", properties: { info: { id: "ses_v1", directory: "/project" } } },
})
assert.equal(created?.action, "created")
assert.equal(created?.sessionID, "ses_v1")

const message = observeRuntimeEvent(manager, {
  directory: "/project",
  payload: {
    type: "message.updated",
    properties: { info: { id: "msg_1", sessionID: "ses_v2", role: "assistant" } },
  },
})
assert.equal(message?.kind, "message")
assert.equal(message?.sessionID, "ses_v2")

observeRuntimeEvent(manager, {
  event: { type: "command.executed", properties: { sessionID: "ses_v1", name: "loop-status" } },
})
observeRuntimeEvent(manager, {
  event: { type: "session.deleted", properties: { info: { id: "ses_v1" } } },
})
observeRuntimeEvent(manager, {
  directory: "/project",
  payload: { type: "server.instance.disposed", properties: {} },
})

assert.deepEqual(calls, [
  ["observe", "ses_v1"],
  ["observe", "ses_v2"],
  ["observe", "ses_v1"],
  ["remove", "ses_v1", "session-deleted"],
  ["dispose", "server-disposed"],
])
assert.equal(observeRuntimeEvent(manager, { event: { type: "unknown", properties: {} } }), undefined)

const throwingManager = {
  observeExternal() { throw new Error("observer failure") },
}
assert.doesNotThrow(() => observeRuntimeEvent(throwingManager, {
  event: { type: "session.idle", properties: { sessionID: "ses_safe" } },
}))

console.log("OpenCode runtime observer test passed")
