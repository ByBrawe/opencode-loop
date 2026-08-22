import assert from "node:assert/strict"
import {
  dueJobs,
  inferredScheduleMode,
  jobDueAt,
  jobIsDue,
  nextDueDelay,
  scheduleDescription,
  scheduleState,
} from "../src/source/runtime/schedule-policy.js"

const current = 1_000_000
const base = {
  id: "job",
  enabled: true,
  paused: false,
  maxRuns: 0,
  runCount: 0,
  intervalMs: 0,
  immediate: true,
  lastRunAt: 0,
  createdAt: new Date(current - 10_000).toISOString(),
}

{
  const job = { ...base, scheduleMode: "idle" }
  assert.equal(inferredScheduleMode(job), "idle")
  assert.equal(jobDueAt(job, current), current)
  assert.equal(jobIsDue(job, current), true)
  assert.equal(scheduleDescription(job), "every idle")
  assert.equal(scheduleState(job, current), "waiting for idle")
}

{
  const job = {
    ...base,
    scheduleMode: "interval",
    intervalMs: 300_000,
    immediate: false,
    createdAt: new Date(current).toISOString(),
  }
  assert.equal(jobDueAt(job, current), current + 300_000)
  assert.equal(jobIsDue(job, current), false)
  assert.equal(scheduleDescription(job), "every 5m, first after 5m")
  assert.equal(scheduleState(job, current), "due in 5m")
}

{
  const job = {
    ...base,
    scheduleMode: "interval",
    intervalMs: 300_000,
    immediate: true,
  }
  assert.equal(jobDueAt(job, current), current)
  assert.equal(scheduleDescription(job), "every 5m, starts on next idle")
}

{
  const job = {
    ...base,
    scheduleMode: "once",
    intervalMs: 300_000,
    immediate: false,
    maxRuns: 1,
    createdAt: new Date(current).toISOString(),
  }
  assert.equal(inferredScheduleMode(job), "once")
  assert.equal(scheduleDescription(job), "once after 5m")
  assert.equal(jobIsDue(job, current + 299_999), false)
  assert.equal(jobIsDue(job, current + 300_000), true)
  const completed = { ...job, runCount: 1 }
  assert.equal(jobDueAt(completed, current + 300_000), Infinity)
}

{
  const watch = { ...base, watchPaths: ["progress.md"], watchTriggered: false }
  assert.equal(inferredScheduleMode(watch), "watch")
  assert.equal(jobDueAt(watch, current), Infinity)
  assert.equal(jobDueAt({ ...watch, watchTriggered: true }, current), current)
}

{
  const expired = {
    ...base,
    intervalMs: 3_600_000,
    immediate: false,
    maxRuntimeMs: 5_000,
    createdAt: new Date(current - 6_000).toISOString(),
  }
  assert.equal(jobDueAt(expired, current), current, "expired max-runtime must wake admission so it can remove the job")
}

{
  const dueNow = { ...base, id: "normal" }
  const targeted = { ...base, id: "targeted", runNowRequestedAt: current }
  const state = { jobs: [dueNow, targeted] }
  assert.deepEqual(dueJobs(state, current).map((job) => job.id), ["targeted", "normal"])
  assert.equal(nextDueDelay(state, current), 0)
}

{
  const delayed = {
    ...base,
    intervalMs: 60_000,
    immediate: false,
    createdAt: new Date(current).toISOString(),
  }
  assert.equal(nextDueDelay({ jobs: [delayed] }, current), 60_000)
  assert.equal(jobIsDue({ ...delayed, paused: true }, current + 60_000), false)
  assert.equal(jobIsDue({ ...delayed, enabled: false }, current + 60_000), false)
}

console.log("schedule policy tests passed")
