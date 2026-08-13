import assert from "node:assert/strict"
import plugin, { V2_PLUGIN_ID, detectV2Capabilities, missingLoopV2Capabilities } from "../src/source/opencode2/experimental.js"

assert.equal(plugin.id, V2_PLUGIN_ID)
assert.equal(typeof plugin.setup, "function")

const partial = detectV2Capabilities({ command: { transform: async () => {} } })
assert.equal(partial.commandTransform, true)
assert.equal(partial.sessionPrompt, false)
assert.ok(missingLoopV2Capabilities(partial).includes("sessionPrompt"))

let name = ""
let draft = {}
const ctx = {
  command: {
    transform: async (apply) => {
      await apply({
        update(nextName, edit) {
          name = nextName
          draft = {}
          edit(draft)
        },
      })
    },
  },
  session: { prompt: async () => {}, hook: async () => {}, wait: async () => {} },
  event: { subscribe: async () => {} },
  tool: { transform: async () => {} },
}

assert.deepEqual(missingLoopV2Capabilities(detectV2Capabilities(ctx)), [])
await plugin.setup(ctx)
assert.equal(name, "loop-v2-status")
assert.match(draft.description, /OpenCode Loop V2/i)
assert.match(draft.template, /sessionPrompt=yes/)

console.log("OpenCode Loop V2 adapter contract test passed")
