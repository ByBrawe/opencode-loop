import assert from "node:assert/strict"
import { normalizeLoopScheduleArgs } from "../src/source/core/schedule-syntax.js"

{
  const result = normalizeLoopScheduleArgs("continue the project")
  assert.equal(result.ok, true)
  assert.equal(result.args, "continue the project")
  assert.equal(result.defaults.intervalMs, 0)
  assert.equal(result.defaults.immediate, true)
  assert.equal(result.scheduleMode, "idle")
  assert.equal(result.scheduleSyntax, "idle-shorthand")
}

{
  const result = normalizeLoopScheduleArgs("--safe --ask-never continue the project")
  assert.equal(result.ok, true)
  assert.equal(result.defaults.intervalMs, 0)
  assert.equal(result.args, "--safe --ask-never continue the project")
}

{
  const result = normalizeLoopScheduleArgs("idle continue forever")
  assert.equal(result.args, "continue forever")
  assert.equal(result.defaults.intervalMs, 0)
  assert.equal(result.defaults.immediate, true)
  assert.equal(result.scheduleMode, "idle")
}

{
  const result = normalizeLoopScheduleArgs("every 5m continue forever")
  assert.equal(result.args, "continue forever")
  assert.equal(result.defaults.intervalMs, 300_000)
  assert.equal(result.defaults.immediate, false)
  assert.equal(result.scheduleMode, "interval")
  assert.equal(result.scheduleSyntax, "every")
}

{
  const result = normalizeLoopScheduleArgs("after 5m continue once")
  assert.equal(result.args, "continue once")
  assert.equal(result.defaults.intervalMs, 300_000)
  assert.equal(result.defaults.immediate, false)
  assert.equal(result.defaults.maxRuns, 1)
  assert.equal(result.scheduleMode, "once")
}

{
  const result = normalizeLoopScheduleArgs("in 30s ping once")
  assert.equal(result.args, "ping once")
  assert.equal(result.defaults.intervalMs, 30_000)
  assert.equal(result.defaults.maxRuns, 1)
  assert.equal(result.scheduleSyntax, "after")
}

{
  const result = normalizeLoopScheduleArgs("5m continue legacy")
  assert.equal(result.args, "5m continue legacy")
  assert.equal(result.scheduleMode, "interval")
  assert.equal(result.scheduleSyntax, "legacy")
}

{
  const result = normalizeLoopScheduleArgs("--allow-goal-overlap continue")
  assert.equal(result.args, "continue")
  assert.equal(result.allowGoalOverlap, true)
  assert.equal(result.scheduleMode, "idle")
}

{
  const result = normalizeLoopScheduleArgs("every nope continue")
  assert.equal(result.ok, false)
  assert.match(result.error, /Invalid every schedule/)
}

console.log("schedule syntax tests passed")
