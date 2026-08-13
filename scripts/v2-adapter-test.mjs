import assert from "node:assert/strict"

let adapter
try {
  adapter = await import("../src/source/opencode2/experimental.js")
} catch (error) {
  const unsupported = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || String(error?.message || error).includes("/v2/promise")
  if (!unsupported) throw error
  console.log("OpenCode Loop V2 adapter contract skipped: installed plugin package has no V2 Promise export")
  process.exit(0)
}

const { default: plugin, V2_PLUGIN_ID, createV2AdapterRuntime, detectV2Capabilities, missingLoopV2Capabilities } = adapter
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
