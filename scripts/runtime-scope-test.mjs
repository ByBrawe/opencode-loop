import assert from "node:assert/strict"
import { createRuntimeScope } from "../src/source/runtime/scope.js"

const scope = createRuntimeScope()
const events = []
scope.track(() => events.push("first"))
const release = scope.track(() => events.push("released"))
scope.track(() => events.push("last"))
assert.equal(release(), true)

let calls = 0
const guarded = scope.guard(() => ++calls)
assert.equal(guarded(), 1)
assert.equal(scope.dispose("done"), true)
assert.deepEqual(events, ["last", "first"])
assert.equal(scope.signal.aborted, true)
assert.equal(scope.isActive(), false)
assert.equal(scope.dispose(), false)
assert.equal(guarded(), undefined)
assert.equal(calls, 1)

scope.track(() => events.push("late"))
assert.deepEqual(events, ["last", "first", "late"])

console.log("OpenCode runtime scope test passed")
