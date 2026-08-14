import assert from "node:assert/strict"
import { createOpenCode2HostContract } from "../src/source/opencode2/host-contract.js"

let listener
let unsubscribeCalls = 0
const prompts = []
const commands = []
const events = []
const host = createOpenCode2HostContract({
  directory: "/project",
  subscribe: async (callback) => {
    listener = callback
    return { unsubscribe: async () => { unsubscribeCalls += 1 } }
  },
  sendPrompt: async (request) => {
    prompts.push(request)
    return { accepted: true }
  },
  sendCommand: async (request) => {
    commands.push(request)
    return { accepted: true, kind: "command" }
  },
  onEvent: async (event, runtime) => events.push({ event, runtime }),
})

await assert.rejects(host.prompt({ sessionID: "ses_a", text: "early" }), /not started/)
await assert.rejects(host.command({ sessionID: "ses_a", id: "review" }), /not started/)
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

const commandResult = await host.command({ sessionID: "ses_a", id: "/review", arguments: "--quick" })
assert.deepEqual(commandResult, { accepted: true, kind: "command" })
assert.equal(commands.length, 1)
assert.equal(commands[0].sessionID, "ses_a")
assert.equal(commands[0].id, "review")
assert.equal(commands[0].arguments, "--quick")
assert.equal(commands[0].runtime, runtime)

await assert.rejects(host.prompt({ sessionID: "", text: "missing" }), /session ID/)
await assert.rejects(host.prompt({ sessionID: "ses_a", text: "   " }), /requires text/)
await assert.rejects(host.command({ sessionID: "", id: "review" }), /session ID/)
await assert.rejects(host.command({ sessionID: "ses_a", id: "" }), /requires an ID/)

const promptOnly = createOpenCode2HostContract({
  subscribe: async (_callback) => ({ unsubscribe: async () => {} }),
  sendPrompt: async () => ({ accepted: true }),
})
await promptOnly.start()
await assert.rejects(promptOnly.command({ sessionID: "ses_a", id: "review" }), /session\.command capability is unavailable/)
await promptOnly.dispose()

await listener({
  directory: "/project",
  payload: { type: "server.instance.disposed", properties: { directory: "/project" } },
})
assert.equal(host.isHostDisposed(), true)
assert.deepEqual(host.runtimeManager.entries(), [])
assert.ok(events.some(({ event }) => event.kind === "server" && event.action === "disposed"))
await assert.rejects(host.prompt({ sessionID: "ses_a", text: "late" }), /unavailable/)
await assert.rejects(host.command({ sessionID: "ses_a", id: "review" }), /unavailable/)

assert.equal(await host.dispose(), true)
assert.equal(await host.dispose(), false)
assert.equal(unsubscribeCalls, 1)
console.log("OpenCode 2 host contract passed")
