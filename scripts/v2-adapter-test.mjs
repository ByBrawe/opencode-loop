import assert from "node:assert/strict"
import plugin, { V2_PLUGIN_ID, createV2AdapterRuntime, detectV2Capabilities, missingLoopV2Capabilities } from "../src/source/opencode2/experimental.js"

assert.equal(plugin.id, V2_PLUGIN_ID)
assert.equal(typeof plugin.setup, "function")

const capabilities = detectV2Capabilities({
  command: { transform() {} },
  session: { prompt() {}, hook() {}, wait() {} },
})
assert.deepEqual(missingLoopV2Capabilities(capabilities), [])

const runtime = createV2AdapterRuntime()
const observed = runtime.observe({ sessionID: "ses_probe" })
assert.equal(observed.sessionID, "ses_probe")
assert.equal(runtime.peek("ses_probe"), observed)
assert.equal(runtime.dispose("test"), true)

console.log("OpenCode Loop V2 adapter contract test passed")
