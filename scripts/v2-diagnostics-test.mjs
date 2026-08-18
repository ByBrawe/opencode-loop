import assert from "node:assert/strict"
import { createOpenCode2DiagnosticsRuntime, OPENCODE_LOOP_V2_HELP_TEXT } from "../src/source/opencode2/diagnostics.js"

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
  runtimeVersion: "v-test",
  runtimePlatform: "test-platform",
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

const help = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-help", sessionID: "ses", directory: "/work" })
assert.equal(help.handled, true)
assert.equal(help.accepted, true)
assert.equal(reads.length, 1, "loop-help must not read or mutate Loop state")
assert.equal(prompts.length, 2)
assert.equal(prompts[1].noReply, true)
assert.equal(prompts[1].text, OPENCODE_LOOP_V2_HELP_TEXT)
assert.match(prompts[1].text, /^OpenCode Loop V2 experimental help:/)
assert.match(prompts[1].text, /\/loop-status/)
assert.match(prompts[1].text, /\/loop-export/)
assert.match(prompts[1].text, /\/loop-doctor/)
assert.match(prompts[1].text, /does not yet claim full stable-plugin parity/)
assert.doesNotMatch(prompts[1].text, /\/loop-goal/)
assert.doesNotMatch(prompts[1].text, /--verify/)

const doctor = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-doctor", sessionID: "ses", directory: "/work" })
assert.equal(doctor.handled, true)
assert.equal(doctor.accepted, true)
assert.equal(reads.length, 2, "loop-doctor may read state but must not mutate it")
assert.equal(prompts.length, 3)
assert.equal(prompts[2].noReply, true)
assert.match(prompts[2].text, /^OpenCode Loop V2 doctor:/)
assert.match(prompts[2].text, /- plugin: bybrawe\.opencode-loop\.v2\.experimental/)
assert.match(prompts[2].text, /- project directory: \/work/)
assert.match(prompts[2].text, /- state directory:/)
assert.match(prompts[2].text, /- active jobs: 1/)
assert.match(prompts[2].text, /- node: v-test/)
assert.match(prompts[2].text, /- platform: test-platform/)
assert.match(prompts[2].text, /- full stable parity: not claimed/)
assert.match(prompts[2].text, /- smoke test: \/loop 0s --max-runs 1/)

assert.throws(() => createOpenCode2DiagnosticsRuntime({}), /requires prompt\(\)/)

console.log("OpenCode 2 diagnostics contract passed")
