import assert from "node:assert/strict"
import { createGoalSteeringRuntime } from "../src/source/runtime/goal-steering.js"

const sessionID = "ses-compaction-safety"
const goal = { id: "goal-1", name: "goal", kind: "goal", enabled: true, paused: false, goalStatus: "active" }
function fixture(abortHook) {
  let active = { jobId: goal.id, job: { ...goal } }
  let aborts = 0
  let clears = 0
  let reads = 0
  const client = { session: { abort: async () => { aborts++; await abortHook?.(() => { active = { jobId: "replacement", job: { ...goal } } }) } } }
  const runtime = createGoalSteeringRuntime({
    getActiveRun: () => active,
    clearActiveRun: () => { clears++; active = undefined },
    readState: async () => { reads++; return { jobs: [{ ...goal }] } },
    appendLoopLog: async () => {},
    fireSdk: async (_client, _label, method) => method(),
    now: () => 1000,
  })
  return { runtime, client, counts: () => ({ aborts, clears, reads }), active: () => active }
}
let cases = 0
for (const type of ["message.created", "message.updated"]) {
  for (const parts of [undefined, [], [{ type: "compaction", auto: true }], [{ type: "text", synthetic: true, text: "Continue" }], [{ type: "text", text: "Persisted user message" }]]) {
    const f = fixture()
    const event = { type, properties: { info: { id: "msg-core", role: "user", sessionID }, ...(parts ? { parts } : {}) } }
    const result = await f.runtime.handleEvent("/workspace", f.client, event)
    assert.equal(result.handled, false)
    assert.deepEqual(f.counts(), { aborts: 0, clears: 0, reads: 0 })
    assert.equal(f.runtime.shouldSuppressIdle(sessionID), false)
    cases++
  }
}
{
  const f = fixture()
  await f.runtime.handleEvent("/workspace", f.client, { type: "message.updated", properties: { info: { role: "user", sessionID, id: "msg-real" } } })
  const result = await f.runtime.handleUserMessage("/workspace", f.client, { sessionID, messageID: "msg-real" })
  assert.equal(result.preempted, true, "untrusted event must not consume the later trusted admission")
  assert.equal(f.counts().aborts, 1)
  cases++
}
{
  const f = fixture()
  f.runtime.setCompacting(sessionID)
  const result = await f.runtime.handleUserMessage("/workspace", f.client, { sessionID, messageID: "msg-during-summary" })
  assert.equal(result.preempted, false)
  assert.equal(f.counts().aborts, 0)
  assert.equal(f.runtime.shouldSuppressIdle(sessionID), false)
  f.runtime.setCompacting(sessionID, false)
  assert.equal((await f.runtime.handleUserMessage("/workspace", f.client, { sessionID, messageID: "msg-after-summary" })).preempted, true)
  cases++
}
{
  const f = fixture((replace) => replace())
  await f.runtime.handleUserMessage("/workspace", f.client, { sessionID, messageID: "msg-race" })
  assert.equal(f.counts().aborts, 1)
  assert.equal(f.counts().clears, 0, "the old abort must not clear a replacement run")
  assert.equal(f.active().jobId, "replacement")
  cases++
}
{
  const f = fixture()
  f.runtime.setCompacting(sessionID)
  f.runtime.clearSession(sessionID)
  assert.equal((await f.runtime.handleUserMessage("/workspace", f.client, { sessionID, messageID: "msg-after-delete" })).preempted, true)
  cases++
}
console.log(`Goal compaction safety: ${cases} scenarios passed`)
