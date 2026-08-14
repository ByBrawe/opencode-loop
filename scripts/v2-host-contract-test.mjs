import assert from "node:assert/strict"
import { createOpenCode2HostContract } from "../src/source/opencode2/host-contract.js"

let listener
const prompts = []
const host = createOpenCode2HostContract({
  directory: "/project",
  subscribe: async (callback) => {
    listener = callback
    return { unsubscribe: async () => {} }
  },
  sendPrompt: async (request) => {
    prompts.push(request)
    return { accepted: true }
  },
})

assert.equal(await host.start(), true)
assert.equal(await host.start(), false)
assert.equal(typeof listener, "function")

await listener({
  directory: "/project",
  payload: { type: "session.created", properties: { info: { id: "ses_a", directory: "/project" } } },
})
const runtime = host.runtimeManager.peek("ses_a")
assert.ok(runtime)

const result = await host.prompt({ sessionID: "ses_a", text: "continue" })
assert.deepEqual(result, { accepted: true })
assert.equal(prompts.length, 1)
assert.equal(prompts[0].sessionID, "ses_a")
assert.equal(prompts[0].text, "continue")
assert.equal(prompts[0].runtime, runtime)

assert.equal(await host.dispose(), true)
assert.equal(await host.dispose(), false)
console.log("OpenCode 2 host contract passed")
