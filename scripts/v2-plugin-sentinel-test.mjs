import assert from "node:assert/strict"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"
import {
  OPENCODE_LOOP_V2_COMMAND_SOURCE,
  OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
  OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED,
  OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS,
  inspectOpenCode2CommandDraft,
  inspectOpenCode2Context,
  openCode2LoopRuntimeStatus,
} from "../src/source/opencode2/capabilities.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(plugin.id, "bybrawe.opencode-loop.v2.experimental")
assert.equal(typeof plugin.setup, "function")
assert.equal(OPENCODE_LOOP_V2_COMMAND_SOURCE, "file-definitions")
assert.equal(OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED, false)
assert.deepEqual(OPENCODE_LOOP_V2_HOST_REQUIREMENTS, ["event.subscribe", "session.prompt", "tool.transform"])
assert.deepEqual(OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS, ["event.subscribe", "session.prompt", "tool.transform", "runtime.adapter"])

let transforms = 0
let registered
const currentContext = {
  command: {
    transform: async (callback) => {
      transforms += 1
      registered = callback
    },
  },
}
const cleanup = await plugin.setup(currentContext)
assert.equal(transforms, 1)
assert.equal(typeof registered, "function")
assert.equal(typeof cleanup, "function")

const currentDraft = {
  list: () => [],
  get: () => undefined,
  update: () => {},
  remove: () => {},
}
await registered(currentDraft)

assert.deepEqual(inspectOpenCode2Context(currentContext), {
  commandTransform: true,
  eventSubscribe: false,
  sessionHook: false,
  sessionPrompt: false,
  toolTransform: false,
  toolHook: false,
})
assert.deepEqual(inspectOpenCode2CommandDraft(currentDraft), {
  list: true,
  get: true,
  update: true,
  remove: true,
})

const currentStatus = openCode2LoopRuntimeStatus(currentContext, currentDraft)
assert.deepEqual(currentStatus.hostBlockers, ["event.subscribe", "session.prompt", "tool.transform"])
assert.deepEqual(currentStatus.blockers, ["event.subscribe", "session.prompt", "tool.transform", "runtime.adapter"])
assert.equal(currentStatus.hostReady, false)
assert.equal(currentStatus.implementationReady, false)
assert.equal(currentStatus.ready, false)

const futureContext = {
  event: { subscribe: async () => {} },
  session: { prompt: async () => ({}) },
  tool: { transform: async () => {} },
}
const futureStatus = openCode2LoopRuntimeStatus(futureContext, currentDraft)
assert.deepEqual(futureStatus.hostBlockers, [])
assert.deepEqual(futureStatus.blockers, ["runtime.adapter"])
assert.equal(futureStatus.hostReady, true)
assert.equal(futureStatus.ready, false)

await cleanup()
const minimalCleanup = await plugin.setup({})
assert.equal(typeof minimalCleanup, "function")
await minimalCleanup()

console.log("OpenCode 2 plugin sentinel contract passed")
