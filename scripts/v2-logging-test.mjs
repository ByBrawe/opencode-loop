import assert from "node:assert/strict"
import { createOpenCode2LogRuntime } from "../src/source/opencode2/logging.js"

const records = []
const runtime = createOpenCode2LogRuntime({
  appendLoopLog: async (...args) => { records.push(args) },
})

assert.equal(await runtime.record({ kind: "message", action: "updated", sessionID: "ses", directory: "/work" }, { handled: false }), false)
assert.equal(records.length, 0)

assert.equal(await runtime.record(
  { kind: "command", action: "executed", name: "loop", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, job: { id: "job_a", name: "alpha" } },
), true)
assert.deepEqual(records[0], ["/work", "add", { sessionID: "ses", v2: true, job: "alpha" }])

await runtime.record(
  { kind: "command", action: "executed", name: "loop-now", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "alpha", count: 1 },
)
await runtime.record(
  { kind: "command", action: "executed", name: "loop-pause", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "alpha", count: 1 },
)
await runtime.record(
  { kind: "command", action: "executed", name: "loop-resume", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "alpha", count: 1 },
)
await runtime.record(
  { kind: "command", action: "executed", name: "loop-remove", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "alpha", count: 1 },
)
await runtime.record(
  { kind: "command", action: "executed", name: "loop-clear", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "all", count: 1 },
)
await runtime.record(
  { kind: "session", action: "idle", sessionID: "ses", directory: "/work" },
  { handled: true, dispatched: true, kind: "prompt", job: { id: "job_a", name: "alpha", runCount: 2 } },
)

assert.deepEqual(records.map((entry) => entry[1]), ["add", "run-now", "pause", "resume", "remove", "clear", "run"])
assert.deepEqual(records.at(-1), ["/work", "run", { sessionID: "ses", v2: true, job: "alpha", kind: "prompt", runs: 2 }])

const beforeRejected = records.length
await runtime.record(
  { kind: "command", action: "executed", name: "loop", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: false, reason: "unsupported" },
)
assert.equal(records.length, beforeRejected, "rejected commands must not create success logs")

const failing = createOpenCode2LogRuntime({ appendLoopLog: async () => { throw new Error("disk unavailable") } })
assert.equal(await failing.record(
  { kind: "command", action: "executed", name: "loop-now", sessionID: "ses", directory: "/work" },
  { handled: true, accepted: true, target: "all", count: 1 },
), false, "logging failures must never fail the Loop runtime")

console.log("OpenCode 2 logging contract passed")
