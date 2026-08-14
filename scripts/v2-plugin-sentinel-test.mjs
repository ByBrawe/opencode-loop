import assert from "node:assert/strict"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"
import {
  OPENCODE_LOOP_V2_COMMAND_SOURCE,
  OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
  OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED,
  OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS,
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

let listener
let subscriptions = 0
const currentContext = {
  event: {
    subscribe: async (callback) => {
      subscriptions += 1
      listener = callback
      return { unsubscribe: async () => {} }
    },
  },
  session: {
    prompt: async () => ({ accepted: true }),
  },
}

const setupResult = await plugin.setup(currentContext)
assert.equal(setupResult, undefined)
assert.equal(subscriptions, 1)
assert.equal(typeof listener, "function")
assert.deepEqual(inspectOpenCode2Context(currentContext), {
  commandTransform: false,
  eventSubscribe: true,
  sessionHook: false,
  sessionPrompt: true,
  toolTransform: false,
  toolHook: false,
})

const status = openCode2LoopRuntimeStatus(currentContext)
assert.equal(status.hostReady, true)
assert.equal(status.implementationReady, false)
assert.equal(status.ready, false)
assert.deepEqual(status.blockers, ["runtime.adapter"])
assert.equal(status.commandSource, "file-definitions")

await listener({
  directory: "/project",
  payload: {
    type: "server.instance.disposed",
    properties: { directory: "/project" },
  },
})

console.log("OpenCode 2 plugin sentinel contract passed")
