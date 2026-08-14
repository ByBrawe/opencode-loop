import assert from "node:assert/strict"

import OpenCode2LoopExperimental, { OPENCODE2_PLUGIN_ID } from "../src/source/opencode2/plugin.js"
import { missingOpenCode2Contract, openCode2Contract } from "../src/source/opencode2/contract.js"

const completeContext = {
  command: { transform: async () => ({ dispose: async () => {} }) },
  session: {
    hook: async () => ({ dispose: async () => {} }),
    prompt: async () => {},
  },
  tool: {
    transform: async () => ({ dispose: async () => {} }),
    hook: async () => ({ dispose: async () => {} }),
  },
  event: { subscribe: async () => {} },
}

assert.equal(OPENCODE2_PLUGIN_ID, "bybrawe.opencode-loop.v2")
assert.equal(OpenCode2LoopExperimental.id, OPENCODE2_PLUGIN_ID)
assert.deepEqual(openCode2Contract(completeContext), {
  command: true,
  session: true,
  prompt: true,
  tools: true,
  toolHooks: true,
  events: true,
})
assert.deepEqual(missingOpenCode2Contract(completeContext), [])
await OpenCode2LoopExperimental.setup(completeContext)

const incompleteContext = {
  command: { transform: async () => {} },
  session: { hook: async () => {} },
  tool: { transform: async () => {} },
  event: {},
}

assert.deepEqual(missingOpenCode2Contract(incompleteContext), ["prompt", "toolHooks", "events"])
await assert.rejects(
  () => OpenCode2LoopExperimental.setup(incompleteContext),
  /V2 host contract unavailable: prompt, toolHooks, events/,
)

console.log("OpenCode Loop V2 contract test passed")
