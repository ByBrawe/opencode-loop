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
async function* emptyEvents() {}

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
      return { stream: emptyEvents() }
    },
  },
  session: {
    prompt: async () => ({}),
  },
}

const setupResult = await plugin.setup(currentContext)
assert.equal(setupResult, undefined)
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
  sessionPrompt: true,
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
assert.deepEqual(currentStatus.hostBlockers, [])
assert.deepEqual(currentStatus.blockers, ["runtime.adapter"])
assert.equal(currentStatus.hostReady, true)
assert.equal(currentStatus.implementationReady, false)
assert.equal(currentStatus.ready, false)
assert.equal(currentStatus.commandSource, "file-definitions")

let missingEventFailed = false
try {
  await plugin.setup({ session: { prompt: async () => ({}) } })
} catch (error) {
  missingEventFailed = /event subscription is unavailable/.test(String(error))
}
assert.equal(missingEventFailed, true)

let missingPromptFailed = false
try {
  await plugin.setup({ event: { subscribe: async () => ({ stream: emptyEvents() }) } })
} catch (error) {
  missingPromptFailed = /session prompt is unavailable/.test(String(error))
}
assert.equal(missingPromptFailed, true)

console.log("OpenCode 2 plugin sentinel contract passed")
