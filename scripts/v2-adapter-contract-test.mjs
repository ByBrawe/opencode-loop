import assert from "node:assert/strict"
import {
  createOpenCode2Adapter,
  normalizeOpenCode2Model,
  openCode2PromptInput,
} from "../src/source/opencode2/adapter.js"

assert.deepEqual(normalizeOpenCode2Model("provider/model"), { providerID: "provider", modelID: "model" })
assert.deepEqual(normalizeOpenCode2Model({ providerID: "provider", id: "model" }), { providerID: "provider", modelID: "model" })
assert.equal(normalizeOpenCode2Model("invalid"), undefined)
assert.deepEqual(openCode2PromptInput({ sessionID: "ses_input", text: "continue" }), {
  path: { id: "ses_input" },
  body: { parts: [{ type: "text", text: "continue" }] },
})

let listener
let unsubscribeCalls = 0
const promptCalls = []
const seen = []
const ctx = {
  event: {
    subscribe: async (callback) => {
      listener = callback
      return { unsubscribe: async () => { unsubscribeCalls += 1 } }
    },
  },
  session: {
    prompt: async (input) => {
      promptCalls.push(input)
      return { accepted: true }
    },
  },
}

const adapter = createOpenCode2Adapter(ctx, {
  directory: "/project",
  onEvent: async (event, runtime) => seen.push({ event, runtime }),
})
assert.equal(Object.isFrozen(adapter), true)
assert.equal(await adapter.start(), true)
assert.equal(await adapter.start(), false)
assert.equal(typeof listener, "function")

await listener({
  directory: "/project",
  payload: {
    type: "session.created",
    properties: { info: { id: "ses_a", directory: "/project" } },
  },
})
const runtime = adapter.runtimeManager.peek("ses_a")
assert.ok(runtime)
assert.equal(seen[0]?.runtime, runtime)

const result = await adapter.prompt({
  sessionID: "ses_a",
  text: "continue",
  noReply: true,
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})
assert.deepEqual(result, { accepted: true })
assert.deepEqual(promptCalls, [{
  path: { id: "ses_a" },
  body: {
    parts: [{ type: "text", text: "continue" }],
    noReply: true,
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  },
}])

assert.equal(await adapter.dispose("test-complete"), true)
assert.equal(await adapter.dispose("test-complete"), false)
assert.equal(unsubscribeCalls, 1)
assert.equal(adapter.runtimeManager.peek("ses_a"), undefined)

assert.throws(() => createOpenCode2Adapter({ event: {}, session: { prompt: async () => {} } }), /event\.subscribe/)
assert.throws(() => createOpenCode2Adapter({ event: { subscribe: async () => {} }, session: {} }), /session\.prompt/)

console.log("OpenCode 2 adapter contract passed")
