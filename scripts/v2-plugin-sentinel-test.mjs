import assert from "node:assert/strict"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"
import {
  OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS,
  inspectOpenCode2CommandDraft,
  inspectOpenCode2Context,
  openCode2LoopRuntimeStatus,
} from "../src/source/opencode2/capabilities.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(plugin.id, "bybrawe.opencode-loop.v2.experimental")
assert.equal(typeof plugin.setup, "function")
assert.deepEqual(OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS, [
  "command.update",
  "session.events",
  "session.prompt",
])

let transforms = 0
let registered
const currentContext = {
  command: {
    transform: async (callback) => {
      transforms += 1
      registered = callback
      return { dispose: async () => {} }
    },
  },
}
await plugin.setup(currentContext)
assert.equal(transforms, 1)
assert.equal(typeof registered, "function")

const currentDraft = {
  list: () => [],
  get: () => undefined,
  update: () => {},
  remove: () => {},
}
await registered(currentDraft)

assert.deepEqual(inspectOpenCode2Context(currentContext), {
  commandTransform: true,
  sessionEvents: false,
  sessionPrompt: false,
})
assert.deepEqual(inspectOpenCode2CommandDraft(currentDraft), {
  list: true,
  get: true,
  update: true,
  remove: true,
  add: false,
})
assert.deepEqual(openCode2LoopRuntimeStatus(currentContext, currentDraft).blockers, [
  "session.events",
  "session.prompt",
])
assert.equal(openCode2LoopRuntimeStatus(currentContext, currentDraft).ready, false)

const futureContext = {
  command: { transform: async () => ({ dispose: async () => {} }) },
  event: { subscribe: async () => ({ dispose: async () => {} }) },
  session: { prompt: async () => ({}) },
}
assert.deepEqual(openCode2LoopRuntimeStatus(futureContext, currentDraft).blockers, [])
assert.equal(openCode2LoopRuntimeStatus(futureContext, currentDraft).ready, true)

const missingUpdateDraft = {
  list: () => [],
  get: () => undefined,
  remove: () => {},
  add: () => {},
}
assert.deepEqual(openCode2LoopRuntimeStatus(futureContext, missingUpdateDraft).blockers, ["command.update"])

let missingCapabilityFailed = false
try {
  await plugin.setup({ command: {} })
} catch (error) {
  missingCapabilityFailed = /command\.transform capability is unavailable/.test(String(error))
}
assert.equal(missingCapabilityFailed, true)

console.log("OpenCode 2 plugin sentinel contract passed")
