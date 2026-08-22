import assert from "node:assert/strict"
import { clearSessionActivity } from "../src/source/runtime/session-activity.js"
import { createSessionStatusRuntime } from "../src/source/runtime/session-status.js"

const activeRuns = new Map()
const logs = []
let clock = 100_000
let completion = "completed"

const runtime = createSessionStatusRuntime({
  activeRuns,
  now: () => clock,
  sessionStatusCacheMs: 0,
  appendLoopLog: async (...args) => logs.push(args),
  activeRunCompletionFromMessages: async () => completion,
})

const busyClient = {
  session: {
    status: async () => ({ data: { session: { type: "busy" } } }),
  },
}

try {
  runtime.markSessionStatus("session", "busy", clock - 2_000)
  assert.equal(await runtime.sessionStatusType(busyClient, "session", "/repo"), "idle")
  assert.equal(logs.at(-1)[1], "status-message-idle-recovery")
  assert.equal(logs.at(-1)[2].staleStatus, "busy")

  runtime.clearSessionStatus("session")
  completion = "incomplete"
  clock += 5_000
  assert.equal(await runtime.sessionStatusType(busyClient, "session", "/repo"), "busy", "an unfinished tail must never be force-recovered")

  runtime.clearSessionStatus("session")
  completion = "unknown"
  clock += 5_000
  assert.equal(await runtime.sessionStatusType(busyClient, "session", "/repo"), "busy", "unknown tail completion must remain conservative")

  console.log("session status idle recovery tests passed")
} finally {
  activeRuns.clear()
  clearSessionActivity("session")
}
