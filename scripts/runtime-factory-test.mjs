import assert from "node:assert/strict"
import { createSessionRuntimeManager } from "../src/source/runtime/session-manager.js"

const calls = []
const timerAPI = {}
const manager = createSessionRuntimeManager({
  timerAPI,
  runtimeFactory({ sessionID, timerAPI: injectedTimerAPI }) {
    let active = true
    const runtime = {
      sessionID,
      scope: { isActive: () => active },
      dispose() {
        active = false
        return true
      },
    }
    calls.push({ sessionID, injectedTimerAPI, runtime })
    return runtime
  },
})

assert.throws(() => manager.observeExternal("   "), /session ID/)
assert.equal(calls.length, 0)
const first = manager.observeExternal("  ses_custom  ")
assert.equal(first.sessionID, "ses_custom")
assert.equal(calls[0].injectedTimerAPI, timerAPI)
assert.equal(manager.observeExternal("ses_custom"), first)
assert.equal(calls.length, 1)
first.dispose()
const second = manager.observeExternal("ses_custom")
assert.notEqual(second, first)
assert.equal(calls.length, 2)
assert.equal(manager.dispose(), true)

console.log("OpenCode runtime factory test passed")
