import assert from "node:assert/strict"
import { createRuntimeScope } from "../src/source/runtime/scope.js"
import { createRuntimeTimers } from "../src/source/runtime/timers.js"

const scope = createRuntimeScope()
const events = []
scope.track(() => events.push("first"))
const release = scope.track(() => events.push("released"))
scope.track(() => events.push("last"))
assert.equal(release(), true)

let calls = 0
const guarded = scope.guard(() => ++calls)
assert.equal(guarded(), 1)

const cleared = []
const api = {
  setTimeout(callback) { return { callback } },
  clearTimeout(handle) { cleared.push(handle) },
  setInterval(callback) { return { callback } },
  clearInterval(handle) { cleared.push(handle) },
}
const timers = createRuntimeTimers(scope, api)
const repeating = timers.interval(() => ++calls, 1)
repeating.handle.callback()
assert.equal(calls, 2)
assert.equal(repeating.cancel(), true)
repeating.handle.callback()
assert.equal(calls, 2)
const pending = timers.interval(() => ++calls, 1)

assert.equal(scope.dispose("done"), true)
assert.deepEqual(events, ["last", "first"])
assert.equal(scope.signal.aborted, true)
assert.equal(scope.isActive(), false)
pending.handle.callback()
assert.equal(calls, 2)
assert.ok(cleared.includes(pending.handle))
assert.equal(timers.timeout(() => {}, 1), undefined)
assert.equal(scope.dispose(), false)
assert.equal(guarded(), undefined)

scope.track(() => events.push("late"))
assert.deepEqual(events, ["last", "first", "late"])

console.log("OpenCode runtime scope test passed")
