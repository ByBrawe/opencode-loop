import assert from "node:assert/strict"
import { createSessionRuntimeManager } from "../src/source/runtime/session-manager.js"

let clock = 1000
const cleared = []
const timerAPI = {
  setTimeout(callback) { return { callback } },
  clearTimeout(handle) { cleared.push(handle) },
  setInterval(callback) { return { callback } },
  clearInterval(handle) { cleared.push(handle) },
}
const manager = createSessionRuntimeManager({ now: () => clock, staleAfterMs: 100, timerAPI })

const first = manager.observeExternal("ses_a")
assert.equal(manager.entries()[0].seenAt, 1000)
clock = 1050
assert.equal(manager.peek("ses_a"), first)
assert.equal(manager.entries()[0].seenAt, 1000, "reads must not refresh external activity")
assert.equal(manager.observeExternal("ses_a"), first)
assert.equal(manager.entries()[0].seenAt, 1050)

first.dispose("replace")
clock = 1060
const second = manager.observeExternal("ses_a")
assert.notEqual(second, first)
assert.equal(manager.remove("ses_a", { expectedRuntime: first }), false)
assert.equal(manager.peek("ses_a"), second)

let calls = 0
const pending = second.timers.interval(() => ++calls, 10)
clock = 1159
assert.deepEqual(manager.pruneStale(), [])
clock = 1160
assert.deepEqual(manager.pruneStale(), ["ses_a"])
assert.equal(manager.peek("ses_a"), undefined)
assert.ok(cleared.includes(pending.handle))
pending.handle.callback()
assert.equal(calls, 0)

const third = manager.observeExternal("ses_a")
assert.notEqual(third, second)
assert.equal(manager.remove("ses_a", { expectedRuntime: third, reason: "done" }), true)
assert.equal(third.scope.isActive(), false)
assert.equal(manager.dispose(), true)
assert.equal(manager.dispose(), false)
assert.throws(() => manager.observeExternal("ses_b"), /disposed/)

console.log("OpenCode session runtime manager test passed")
