import assert from "node:assert/strict"
import { createOpenCode2DiagnosticsRuntime } from "../src/source/opencode2/diagnostics.js"

const prompts = []
const reads = []
const state = {
  version: 1,
  jobs: [{ id: "job_export", name: "exported", runCount: 2, paused: false }],
}
const runtime = createOpenCode2DiagnosticsRuntime({
  prompt: async (request) => { prompts.push(request) },
  readState: async (directory, sessionID) => {
    reads.push([directory, sessionID])
    return structuredClone(state)
  },
})

const unrelated = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-status", sessionID: "ses", directory: "/work" })
assert.equal(unrelated.handled, false)
assert.equal(prompts.length, 0)

const missing = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-export", sessionID: "ses" })
assert.equal(missing.handled, false)
assert.equal(missing.reason, "missing-scope")
assert.equal(prompts.length, 0)

const exported = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-export", sessionID: "ses", directory: "/work" })
assert.equal(exported.handled, true)
assert.equal(exported.accepted, true)
assert.deepEqual(reads, [["/work", "ses"]])
assert.equal(prompts.length, 1)
assert.equal(prompts[0].sessionID, "ses")
assert.equal(prompts[0].noReply, true)
assert.match(prompts[0].text, /^OpenCode loop state export:\n```json\n/)
assert.match(prompts[0].text, /"name": "exported"/)
assert.match(prompts[0].text, /"runCount": 2/)
assert.match(prompts[0].text, /\n```$/)

assert.throws(() => createOpenCode2DiagnosticsRuntime({}), /requires prompt\(\)/)

console.log("OpenCode 2 diagnostics contract passed")
