import assert from "node:assert/strict"
import { createOpenCode2EventBridge } from "../src/source/opencode2/event-bridge.js"

const seen = []
let listener
let unsubscribeCalls = 0

const bridge = createOpenCode2EventBridge({
  directory: "/project",
  onEvent: async (event, runtime) => seen.push({ event, runtime }),
})

await bridge.attach(async (callback) => {
  listener = callback
  return { unsubscribe: async () => { unsubscribeCalls += 1 } }
})

await listener({
  directory: "/project",
  payload: { type: "session.created", properties: { info: { id: "ses_a", directory: "/project" } } },
})
const first = bridge.runtimeManager.peek("ses_a")
assert.ok(first)
assert.equal(first.scope.isActive(), true)

await listener({
  directory: "/project",
  payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
})
assert.equal(bridge.runtimeManager.peek("ses_a"), first)

await listener({
  directory: "/project",
  payload: { type: "session.created", properties: { info: { id: "ses_b", directory: "/project" } } },
})
const second = bridge.runtimeManager.peek("ses_b")
assert.ok(second)
assert.notEqual(second, first)

await listener({
  directory: "/other-project",
  payload: { type: "session.status", properties: { sessionID: "ses_other", status: { type: "busy" } } },
})
assert.equal(bridge.runtimeManager.peek("ses_other"), undefined)

await listener({
  directory: "/project",
  payload: { type: "session.deleted", properties: { info: { id: "ses_a", directory: "/project" } } },
})
assert.equal(bridge.runtimeManager.peek("ses_a"), undefined)
assert.equal(first.scope.isActive(), false)
assert.equal(second.scope.isActive(), true)

await listener({
  directory: "/project",
  payload: { type: "server.instance.disposed", properties: { directory: "/project" } },
})
assert.equal(second.scope.isActive(), false)
assert.deepEqual(bridge.runtimeManager.entries(), [])

const seenCount = seen.length
await listener({
  directory: "/project",
  payload: { type: "session.status", properties: { sessionID: "ses_late", status: { type: "busy" } } },
})
assert.equal(seen.length, seenCount)

assert.equal(await bridge.dispose(), true)
assert.equal(await bridge.dispose(), false)
assert.equal(unsubscribeCalls, 1)

console.log("OpenCode 2 event bridge lifecycle passed")
