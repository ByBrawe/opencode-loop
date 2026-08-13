import assert from "node:assert/strict"
import { normalizeOpenCodeEvent } from "../src/source/runtime/events.js"

assert.deepEqual(
  normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: "ses_idle" } }),
  { kind: "session", action: "idle", sessionID: "ses_idle", directory: undefined },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    directory: "/workspace",
    payload: { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } },
  }),
  { kind: "session", action: "status", sessionID: "ses_busy", directory: "/workspace", status: "busy" },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    type: "session.created",
    properties: { info: { id: "ses_child", directory: "/project", parentID: "ses_parent" } },
  }),
  { kind: "session", action: "created", sessionID: "ses_child", directory: "/project", parentID: "ses_parent" },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    directory: "/workspace",
    payload: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_done",
          sessionID: "ses_message",
          role: "assistant",
          time: { created: 10, completed: 20 },
          finish: "stop",
        },
      },
    },
  }),
  {
    kind: "message",
    action: "updated",
    sessionID: "ses_message",
    directory: "/workspace",
    messageID: "msg_done",
    role: "assistant",
    completedAt: 20,
    finish: "stop",
  },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    type: "command.executed",
    properties: { name: "loop-status", sessionID: "ses_command", arguments: "--json", messageID: "msg_command" },
  }),
  {
    kind: "command",
    action: "executed",
    sessionID: "ses_command",
    directory: undefined,
    name: "loop-status",
    arguments: "--json",
    messageID: "msg_command",
  },
)

assert.deepEqual(
  normalizeOpenCodeEvent({ type: "server.instance.disposed", properties: { directory: "/old" } }),
  { kind: "server", action: "disposed", directory: "/old" },
)

assert.equal(normalizeOpenCodeEvent({ type: "session.idle", properties: {} }), undefined)
assert.equal(normalizeOpenCodeEvent({ payload: { properties: {} } }), undefined)
assert.equal(normalizeOpenCodeEvent({ type: "file.edited", properties: { file: "x.txt" } }), undefined)

console.log("OpenCode runtime event normalization test passed")
