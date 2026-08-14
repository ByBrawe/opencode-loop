import assert from "node:assert/strict"
import plugin, {
  OPENCODE_LOOP_V2_PLUGIN_ID,
  createOpenCode2ExperimentalHost,
  mapOpenCode2PromptRequest,
} from "../src/source/opencode2/experimental.js"
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

async function* emptyStream() {}

let subscribeCalls = 0
let cleanupCalls = 0
const promptCalls = []
const context = {
  command: { transform: async () => {} },
  event: {
    subscribe: async () => {
      subscribeCalls += 1
      return { stream: emptyStream(), dispose: async () => { cleanupCalls += 1 } }
    },
  },
  session: {
    prompt: async (request) => {
      promptCalls.push(request)
      return { id: "msg_test", sessionID: request.sessionID, prompt: request.prompt }
    },
  },
}

const host = createOpenCode2ExperimentalHost(context)
assert.equal(await host.start(), true)
assert.equal(subscribeCalls, 1)
const admitted = await host.prompt({ sessionID: "ses_test", text: "continue the project" })
assert.equal(admitted.id, "msg_test")
assert.deepEqual(promptCalls, [{
  sessionID: "ses_test",
  prompt: { text: "continue the project" },
  resume: true,
}])
assert.equal(await host.dispose(), true)
assert.equal(cleanupCalls, 1)

assert.deepEqual(mapOpenCode2PromptRequest({ sessionID: "ses_a", text: "next" }), {
  sessionID: "ses_a",
  prompt: { text: "next" },
  resume: true,
})
assert.throws(
  () => mapOpenCode2PromptRequest({ sessionID: "ses_a", text: "next", agent: "build" }),
  /does not yet support/,
)
assert.throws(
  () => mapOpenCode2PromptRequest({ sessionID: "ses_a", text: "next", noReply: true }),
  /does not yet support/,
)

let transforms = 0
let setupSubscriptions = 0
await plugin.setup({
  command: { transform: async () => { transforms += 1 } },
  event: { subscribe: async () => { setupSubscriptions += 1; return { stream: emptyStream() } } },
  session: { prompt: async () => ({}) },
})
assert.equal(transforms, 1)
assert.equal(setupSubscriptions, 1)

const currentDraft = {
  list: () => [],
  get: () => undefined,
  update: () => {},
  remove: () => {},
}
assert.deepEqual(inspectOpenCode2Context(context), {
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
const status = openCode2LoopRuntimeStatus(context, currentDraft)
assert.deepEqual(status.hostBlockers, [])
assert.deepEqual(status.blockers, ["runtime.adapter"])
assert.equal(status.hostReady, true)
assert.equal(status.implementationReady, false)
assert.equal(status.ready, false)
assert.equal(status.commandSource, "file-definitions")

await assert.rejects(
  () => plugin.setup({ event: {}, session: { prompt: async () => ({}) } }),
  /event\.subscribe capability is unavailable/,
)
await assert.rejects(
  () => plugin.setup({ event: { subscribe: async () => ({ stream: emptyStream() }) }, session: {} }),
  /session\.prompt capability is unavailable/,
)

console.log("OpenCode 2 plugin sentinel contract passed")
