import assert from "node:assert/strict"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(plugin.id, "bybrawe.opencode-loop.v2.experimental")
assert.equal(typeof plugin.setup, "function")

let transforms = 0
let registered
await plugin.setup({
  command: {
    transform: async (callback) => {
      transforms += 1
      registered = callback
      return { dispose: async () => {} }
    },
  },
})
assert.equal(transforms, 1)
assert.equal(typeof registered, "function")

let missingCapabilityFailed = false
try {
  await plugin.setup({ command: {} })
} catch (error) {
  missingCapabilityFailed = /command\.transform capability is unavailable/.test(String(error))
}
assert.equal(missingCapabilityFailed, true)

console.log("OpenCode 2 plugin sentinel contract passed")
