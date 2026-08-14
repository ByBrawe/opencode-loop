import assert from "node:assert/strict"
import {
  clearCommandLifecycle,
  commandArgsText,
  commandName,
  consumeHandled,
  forgetHandledCommandEvent,
  hasHandledCommandEvent,
  isLoopCommandName,
  isPreset,
  markHandled,
  markHandledCommandEvent,
} from "../src/source/opencode/commands.js"

assert.equal(commandName(undefined), "")
assert.equal(commandName(42), "42")
assert.equal(isPreset("loop-dev"), true)
assert.equal(isPreset("loop-status"), false)
assert.equal(isLoopCommandName("loop-status"), true)
assert.equal(isLoopCommandName("loop-goal-complete"), true)
assert.equal(isLoopCommandName("other-command"), false)
assert.equal(commandArgsText(["one", { text: "two" }, 3]), "one two 3")
assert.equal(commandArgsText({ arguments: { value: "nested" } }), "nested")

markHandled("session-a", "loop-status", "  repeated   args ")
assert.equal(consumeHandled("session-a", "loop-status", "repeated args"), true)
assert.equal(consumeHandled("session-a", "loop-status", "repeated args"), false)

markHandled("session-b", "loop-now", "job")
markHandled("session-b", "loop-now", "job")
assert.equal(consumeHandled("session-b", "loop-now", "job"), true)
assert.equal(consumeHandled("session-b", "loop-now", "job"), true)
assert.equal(consumeHandled("session-b", "loop-now", "job"), false)

assert.equal(hasHandledCommandEvent("session-c", "message-1"), false)
markHandledCommandEvent("session-c", "message-1")
assert.equal(hasHandledCommandEvent("session-c", "message-1"), true)
forgetHandledCommandEvent("session-c", "message-1")
assert.equal(hasHandledCommandEvent("session-c", "message-1"), false)

markHandled("session-d", "loop-status", "")
markHandledCommandEvent("session-d", "message-2")
clearCommandLifecycle("session-d")
assert.equal(consumeHandled("session-d", "loop-status", ""), false)
assert.equal(hasHandledCommandEvent("session-d", "message-2"), false)

console.log("OpenCode command lifecycle test passed")
