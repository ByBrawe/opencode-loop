import assert from "node:assert/strict"
import { createOpenCode2EventBridge } from "../src/source/opencode2/event-bridge.js"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seen = []
let subscribeArgs = -1
let cleanupCalls = 0

async function* stream() {
  yield {
    directory: "/project",
    payload: {
      type: "session.created",
      properties: { info: { id: "ses_stream", directory: "/project" } },
    },
  }
}

const bridge = createOpenCode2EventBridge({
  directory: "/project",
  onEvent: async (event) => seen.push(event),
})

await bridge.attach(async (...args) => {
  subscribeArgs = args.length
  return { stream: stream(), dispose: async () => { cleanupCalls += 1 } }
})

for (let attempt = 0; attempt < 50 && seen.length === 0; attempt++) await delay(5)
assert.equal(subscribeArgs, 0)
assert.equal(seen[0]?.action, "created")
assert.ok(bridge.runtimeManager.peek("ses_stream"))

assert.equal(await bridge.dispose(), true)
assert.equal(cleanupCalls, 1)
assert.equal(bridge.runtimeManager.peek("ses_stream"), undefined)

console.log("OpenCode 2 event stream contract passed")
