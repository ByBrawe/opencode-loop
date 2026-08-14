import assert from "node:assert/strict"
import path from "node:path"
import { createLoopCommandHandlers } from "../src/source/opencode/loop-commands.js"

function loopJob(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: "prompt",
    intervalMs: 10_000,
    lastRunAt: 5_000,
    action: `Work on ${id}`,
    paused: false,
    enabled: true,
    runCount: 0,
    failureCount: 0,
    ...overrides,
  }
}

function harness(initialStates = {}, overrides = {}) {
  const states = new Map(Object.entries(initialStates).map(([key, value]) => [key, structuredClone(value)]))
  const writes = []
  const removed = []
  const cleared = []
  const cancelled = []
  const watchdogs = []
  const due = []
  const forcedRuns = []
  const toasts = []
  const messages = []
  const logs = []
  const fileWrites = []
  const existingPaths = new Set(overrides.existingPaths || [])

  const handlers = createLoopCommandHandlers({
    clearActiveRun: (sessionID) => cleared.push(sessionID),
    cancelDueWork: (sessionID) => cancelled.push(sessionID),
    stopWatchdog: (sessionID) => watchdogs.push(sessionID),
    scheduleDueWork: async (...args) => { due.push(args) },
    maybeRunDueJobs: async (...args) => { forcedRuns.push(args) },
    toast: async (...args) => { toasts.push(args) },
    say: async (...args) => { messages.push(args) },
    now: overrides.now || (() => 10_000),
    readState: async (_directory, sessionID) => structuredClone(states.get(sessionID) || { jobs: [] }),
    writeState: async (_directory, sessionID, state) => {
      const copy = structuredClone(state)
      states.set(sessionID, copy)
      writes.push({ sessionID, state: copy })
    },
    removeState: async (...args) => { removed.push(args); states.delete(args[1]) },
    pathExists: async (target) => existingPaths.has(target),
    appendLoopLog: async (...args) => { logs.push(args) },
    readFile: overrides.readFile || (async () => { throw new Error("missing") }),
    writeFile: async (...args) => { fileWrites.push(args) },
    runtimeVersion: "v-test",
    runtimePlatform: "test-platform",
  })

  return {
    handlers,
    states,
    writes,
    removed,
    cleared,
    cancelled,
    watchdogs,
    due,
    forcedRuns,
    toasts,
    messages,
    logs,
    fileWrites,
  }
}

assert.throws(() => createLoopCommandHandlers({}), /clearActiveRun/)
assert.throws(() => createLoopCommandHandlers({ clearActiveRun() {} }), /cancelDueWork/)

{
  const sessionID = "stop-all"
  const h = harness({ [sessionID]: { jobs: [loopJob("a")] } })
  const client = {}
  await h.handlers.stopLoop("/work", client, sessionID, "all")
  assert.deepEqual(h.removed, [["/work", sessionID]])
  assert.deepEqual(h.cleared, [sessionID])
  assert.deepEqual(h.cancelled, [sessionID])
  assert.deepEqual(h.watchdogs, [sessionID])
  assert.equal(h.due.length, 0)
  assert.deepEqual(h.toasts, [[client, "All loops stopped for this session.", "success"]])
}

{
  const sessionID = "stop-empty"
  const h = harness({ [sessionID]: { jobs: [loopJob("a")] } })
  await h.handlers.stopLoop("/work", {}, sessionID, "")
  assert.equal(h.removed.length, 1, "empty stop target keeps existing stop-all semantics")
}

{
  const sessionID = "stop-one"
  const client = {}
  const h = harness({ [sessionID]: { jobs: [loopJob("a"), loopJob("b")] } })
  await h.handlers.stopLoop("/work", client, sessionID, "a")
  assert.deepEqual(h.states.get(sessionID).jobs.map((job) => job.id), ["b"])
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.toasts, [[client, "Stopped 1 loop(s).", "success"]])
  assert.equal(h.removed.length, 0)
}

{
  const sessionID = "update"
  const client = {}
  const h = harness({ [sessionID]: { jobs: [loopJob("a"), loopJob("b")] } })
  await h.handlers.updateJobState("/work", client, sessionID, "b", (job) => ({ ...job, paused: true, marker: "yes" }), "Paused")
  const jobs = h.states.get(sessionID).jobs
  assert.equal(jobs[0].paused, false)
  assert.equal(jobs[1].paused, true)
  assert.equal(jobs[1].marker, "yes")
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.toasts, [[client, "Paused: 1 loop(s).", "success"]])
}

{
  const sessionID = "update-missing"
  const client = {}
  const h = harness({ [sessionID]: { jobs: [loopJob("a")] } })
  await h.handlers.updateJobState("/work", client, sessionID, "missing", (job) => ({ ...job, paused: true }), "Paused")
  assert.deepEqual(h.toasts, [[client, "Paused: 0 loop(s).", "warning"]])
  assert.equal(h.due.length, 1, "state updates keep rescheduling even when no job matches")
}

{
  const sessionID = "status"
  const client = { id: "client" }
  const h = harness({
    [sessionID]: {
      jobs: [
        loopJob("dev", { safe: true, askNever: true, noOverlap: true, runCount: 3, failureCount: 1 }),
        loopJob("goal", { kind: "goal", intervalMs: 0, lastRunAt: 0, goalStatus: "blocked", paused: true, checkpointOnly: true, gitCheckpoint: true }),
      ],
    },
  })
  await h.handlers.statusLoop("/work", client, sessionID)
  assert.deepEqual(h.toasts, [[client, "2 loop job(s).", "info"]])
  assert.equal(h.messages.length, 1)
  const text = h.messages[0][2]
  assert.match(text, /OpenCode loop status:/)
  assert.match(text, /1\. dev \(dev\): dev: 10s \[prompt\] -> Work on dev/)
  assert.match(text, /runs=3 \| failures=1 \| due in 5s/)
  assert.match(text, /active,safe,ask-never,no-overlap/)
  assert.match(text, /goal:blocked,paused,checkpoint-only,git-checkpoint/)
}

{
  const sessionID = "status-empty"
  const h = harness({ [sessionID]: { jobs: [] } })
  await h.handlers.statusLoop("/work", {}, sessionID)
  assert.deepEqual(h.toasts, [[{}, "No active loop jobs.", "warning"]])
  assert.match(h.messages[0][2], /No active loop jobs\./)
}

{
  const lines = Array.from({ length: 82 }, (_, index) => `line-${index + 1}`).join("\n")
  const h = harness({}, { readFile: async () => lines })
  await h.handlers.logsLoop("/project", {}, "logs")
  const text = h.messages[0][2]
  assert.doesNotMatch(text, /line-1\n/)
  assert.doesNotMatch(text, /line-2\n/)
  assert.match(text, /line-3/)
  assert.match(text, /line-82/)
}

{
  const h = harness()
  await h.handlers.logsLoop("/project", {}, "missing-logs")
  assert.equal(h.messages[0][2], "OpenCode loop logs:\nNo loop log found.")
}

{
  const h = harness()
  await h.handlers.helpLoop({}, "help")
  const text = h.messages[0][2]
  assert.match(text, /OpenCode Loop help:/)
  assert.match(text, /\/loop-goal finish the feature/)
  assert.match(text, /\/loop-doctor \| \/loop-init \| \/loop-export/)
}

{
  const sessionID = "now"
  const client = {}
  const h = harness({ [sessionID]: { jobs: [loopJob("a", { paused: true, lastRunAt: 999 }), loopJob("b", { paused: true, lastRunAt: 888 })] } })
  await h.handlers.runNow("/work", client, sessionID, "b")
  const jobs = h.states.get(sessionID).jobs
  assert.equal(jobs[0].lastRunAt, 999)
  assert.equal(jobs[0].paused, true)
  assert.equal(jobs[1].lastRunAt, 0)
  assert.equal(jobs[1].paused, false)
  assert.deepEqual(h.toasts, [[client, "Marked 1 loop job(s) due now.", "success"]])
  assert.deepEqual(h.forcedRuns, [["/work", client, sessionID, { force: true }]])
}

{
  const sessionID = "now-missing"
  const h = harness({ [sessionID]: { jobs: [loopJob("a")] } })
  await h.handlers.runNow("/work", {}, sessionID, "missing")
  assert.deepEqual(h.toasts, [[{}, "Marked 0 loop job(s) due now.", "warning"]])
  assert.equal(h.forcedRuns.length, 1, "run-now retains force scan even when no target matches")
}

{
  const sessionID = "doctor"
  const h = harness({ [sessionID]: { jobs: [loopJob("a"), loopJob("b")] } })
  await h.handlers.doctorLoop("/repo", {}, sessionID)
  const text = h.messages[0][2]
  assert.match(text, /OpenCode Loop doctor:/)
  assert.match(text, /- plugin: opencode-loop/)
  assert.match(text, /- project directory: \/repo/)
  assert.match(text, /- active jobs: 2/)
  assert.match(text, /- node: v-test/)
  assert.match(text, /- platform: test-platform/)
  assert.match(text, /experimental goal smoke test/)
}

{
  const sessionID = "init"
  const client = {}
  const h = harness()
  await h.handlers.initLoop("/repo", client, sessionID, "notes.md")
  assert.equal(h.fileWrites.length, 1)
  assert.equal(h.fileWrites[0][0], path.resolve("/repo", "notes.md"))
  assert.match(h.fileWrites[0][1], /^# Progress/)
  assert.equal(h.fileWrites[0][2], "utf8")
  assert.deepEqual(h.toasts, [[client, "Created notes.md.", "success"]])
  assert.deepEqual(h.logs, [["/repo", "init", { sessionID, file: "notes.md" }]])
}

{
  const target = path.resolve("/repo", "progress.md")
  const client = {}
  const h = harness({}, { existingPaths: [target] })
  await h.handlers.initLoop("/repo", client, "init-existing", "")
  assert.equal(h.fileWrites.length, 0)
  assert.deepEqual(h.toasts, [[client, "progress.md already exists.", "warning"]])
  assert.equal(h.logs.length, 0)
}

{
  const sessionID = "export"
  const h = harness({ [sessionID]: { version: 1, jobs: [loopJob("a")] } })
  await h.handlers.exportLoop("/repo", {}, sessionID)
  const text = h.messages[0][2]
  assert.match(text, /OpenCode loop state export:/)
  assert.match(text, /```json/)
  assert.match(text, /"id": "a"/)
}

console.log("loop command handler tests passed")
