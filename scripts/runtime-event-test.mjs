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
    directory: "/workspace",
    payload: {
      type: "session.next.step.started",
      properties: {
        sessionID: "ses_v2",
        assistantMessageID: "msg_v2",
        agent: "build",
        model: { providerID: "canary", modelID: "canary" },
      },
    },
  }),
  {
    kind: "session",
    action: "step-started",
    sessionID: "ses_v2",
    directory: "/workspace",
    messageID: "msg_v2",
    agent: "build",
    model: { providerID: "canary", modelID: "canary" },
  },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    directory: "/workspace",
    payload: {
      type: "session.next.step.ended",
      properties: { sessionID: "ses_v2", assistantMessageID: "msg_v2", finish: "stop" },
    },
  }),
  {
    kind: "session",
    action: "step-ended",
    sessionID: "ses_v2",
    directory: "/workspace",
    messageID: "msg_v2",
    finish: "stop",
  },
)

const v2Failure = { name: "UnknownError", data: { message: "provider failed" } }
assert.deepEqual(
  normalizeOpenCodeEvent({
    directory: "/workspace",
    payload: {
      type: "session.next.step.failed",
      properties: { sessionID: "ses_v2", assistantMessageID: "msg_v2", error: v2Failure },
    },
  }),
  {
    kind: "session",
    action: "step-failed",
    sessionID: "ses_v2",
    directory: "/workspace",
    messageID: "msg_v2",
    error: v2Failure,
  },
)

assert.deepEqual(
  normalizeOpenCodeEvent({
    directory: "/workspace",
    payload: {
      type: "session.next.compaction.ended",
      properties: { sessionID: "ses_v2", messageID: "msg_compact", reason: "manual" },
    },
  }),
  {
    kind: "session",
    action: "compacted",
    sessionID: "ses_v2",
    directory: "/workspace",
    messageID: "msg_compact",
    reason: "manual",
  },
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
