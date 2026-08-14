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
assert.deepEqual(OPENCODE_LOOP_V2_HOST_REQUIREMENTS, ["event.subscribe", "session.prompt"])
assert.deepEqual(OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS, ["event.subscribe", "session.prompt", "runtime.adapter"])

let transforms = 0
let registered
let subscriptions = 0
let unsubscribes = 0
const currentContext = {
  command: {
    transform: async (callback) => {
      transforms += 1
      registered = callback
    },
  },
  event: {
    subscribe: async () => {
      subscriptions += 1
      return {
        stream: {
          async *[Symbol.asyncIterator]() {},
        },
        unsubscribe: async () => { unsubscribes += 1 },
      }
    },
  },
}
const setupResult = await plugin.setup(currentContext)
assert.equal(typeof setupResult, "function")
assert.equal(transforms, 1)
assert.equal(subscriptions, 1)
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
  eventSubscribe: true,
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
assert.deepEqual(currentStatus.hostBlockers, ["session.prompt"])
assert.deepEqual(currentStatus.blockers, ["session.prompt", "runtime.adapter"])
assert.equal(currentStatus.hostReady, false)
assert.equal(currentStatus.implementationReady, false)
assert.equal(currentStatus.ready, false)
assert.equal(currentStatus.commandSource, "file-definitions")

await setupResult()
assert.equal(unsubscribes, 1)

const futureContext = {
  command: { transform: async () => {} },
  event: { subscribe: async () => {} },
  session: { prompt: async () => ({}) },
}
const futureStatus = openCode2LoopRuntimeStatus(futureContext, currentDraft)
assert.deepEqual(futureStatus.hostBlockers, [])
assert.deepEqual(futureStatus.blockers, ["runtime.adapter"])
assert.equal(futureStatus.hostReady, true)
assert.equal(futureStatus.implementationReady, false)
assert.equal(futureStatus.ready, false)

let missingCapabilityFailed = false
try {
  await plugin.setup({})
} catch (error) {
  missingCapabilityFailed = /command\.transform capability is unavailable/.test(String(error))
}
assert.equal(missingCapabilityFailed, true)

console.log("OpenCode 2 plugin sentinel contract passed")
