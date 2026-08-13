import assert from "node:assert/strict"
import { createSessionRuntimeManager } from "../src/source/runtime/session-manager.js"
import { createSessionRegistry } from "../src/source/runtime/session-registry.js"

let clock = 1000
const registry = createSessionRegistry({ now: () => clock, staleAfterMs: 100 })
const first = {}
const second = {}

registry.observeExternal("ses_a", first)
clock = 1050
assert.equal(registry.peek("ses_a").seenAt, 1000)
assert.equal(registry.entries()[0].seenAt, 1000)
assert.deepEqual(registry.pruneStale(), [])

registry.observeExternal("ses_a", first)
assert.equal(registry.peek("ses_a").seenAt, 1050)
clock = 1060
registry.observeExternal("ses_a", second)
assert.equal(registry.remove("ses_a", first), false)
assert.equal(registry.peek("ses_a").runtime, second)

clock = 1159
assert.deepEqual(registry.pruneStale(), [])
clock = 1160
assert.deepEqual(registry.pruneStale(), ["ses_a"])
assert.equal(registry.peek("ses_a"), undefined)

{
  const factoryCalls = []
  const timerAPI = {}
  const manager = createSessionRuntimeManager({
    timerAPI,
    runtimeFactory({ sessionID, timerAPI: injectedTimerAPI }) {
      let active = true
      const runtime = {
        sessionID,
        scope: { isActive: () => active },
        dispose() { active = false; return true },
      }
      factoryCalls.push({ injectedTimerAPI, runtime })
      return runtime
    },
  })

  assert.throws(() => manager.observeExternal("   "), /session ID/)
  assert.equal(factoryCalls.length, 0)
  const runtime = manager.observeExternal("  ses_custom  ")
  assert.equal(runtime.sessionID, "ses_custom")
  assert.equal(factoryCalls[0].injectedTimerAPI, timerAPI)
  assert.equal(manager.observeExternal("ses_custom"), runtime)
  assert.equal(factoryCalls.length, 1)
  runtime.dispose()
  assert.notEqual(manager.observeExternal("ses_custom"), runtime)
  assert.equal(factoryCalls.length, 2)
  assert.equal(manager.dispose(), true)
}

console.log("OpenCode runtime contract test passed")
