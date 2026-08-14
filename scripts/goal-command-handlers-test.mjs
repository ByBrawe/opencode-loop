import assert from "node:assert/strict"
import { createGoalCommandHandlers } from "../src/source/opencode/goal-commands.js"

function goal(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: "goal",
    goalStatus: "active",
    enabled: true,
    paused: false,
    action: `Goal ${id}`,
    runCount: 0,
    noProgressCount: 0,
    ...overrides,
  }
}

function harness(initialStates = {}) {
  const states = new Map(Object.entries(initialStates).map(([key, value]) => [key, structuredClone(value)]))
  const writes = []
  const due = []
  const idle = []
  const toasts = []
  const messages = []
  const addLoopCalls = []
  const completeCalls = []
  const blockedCalls = []

  const handlers = createGoalCommandHandlers({
    addLoop: async (...args) => { addLoopCalls.push(args); return "added" },
    scheduleDueWork: async (...args) => { due.push(args) },
    scheduleIdleWork: (...args) => { idle.push(args) },
    toast: async (...args) => { toasts.push(args) },
    say: async (...args) => { messages.push(args) },
    readState: async (_directory, sessionID) => structuredClone(states.get(sessionID) || { jobs: [] }),
    writeState: async (_directory, sessionID, state) => {
      const copy = structuredClone(state)
      states.set(sessionID, copy)
      writes.push({ sessionID, state: copy })
    },
    setGoalComplete: async (...args) => { completeCalls.push(args); return { ok: true, message: "completed" } },
    setGoalBlocked: async (...args) => { blockedCalls.push(args); return { ok: true, message: "blocked" } },
  })

  return { handlers, states, writes, due, idle, toasts, messages, addLoopCalls, completeCalls, blockedCalls }
}

assert.throws(() => createGoalCommandHandlers({}), /addLoop/)
assert.throws(() => createGoalCommandHandlers({ addLoop() {} }), /scheduleDueWork/)

{
  const sessionID = "status"
  const h = harness({
    [sessionID]: {
      jobs: [
        { id: "regular", kind: "prompt" },
        goal("g1", {
          name: "feature",
          action: "Ship feature",
          runCount: 2,
          goalChecks: ["npm test", "npm run check"],
          goalAcceptance: ["works"],
          goalProgress: [{ summary: "patched" }],
          maxNoProgress: 3,
          noProgressCount: 1,
          goalCompletionRejectedReason: "not yet",
        }),
        goal("g2", { goalStatus: "blocked", paused: true, action: "Fix blocker" }),
      ],
    },
  })
  await h.handlers.statusGoal("/work", { id: "client" }, sessionID)
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.toasts, [[{ id: "client" }, "2 experimental goal(s).", "info"]])
  assert.equal(h.messages.length, 1)
  const text = h.messages[0][2]
  assert.match(text, /OpenCode Loop experimental goal status:/)
  assert.match(text, /1\. g1 \(feature\): active \| turns=2 \| objective=Ship feature/)
  assert.match(text, /checks=2/)
  assert.match(text, /acceptance=1/)
  assert.match(text, /progress=1/)
  assert.match(text, /no-progress=1\/3/)
  assert.match(text, /completion-rejected/)
  assert.match(text, /2\. g2: paused/)
}

{
  const sessionID = "empty-status"
  const h = harness({ [sessionID]: { jobs: [{ id: "regular", kind: "prompt" }] } })
  await h.handlers.statusGoal("/work", {}, sessionID)
  assert.deepEqual(h.toasts, [[{}, "No experimental goal jobs.", "warning"]])
  assert.match(h.messages[0][2], /No experimental goal jobs\./)
}

{
  const sessionID = "pause"
  const client = {}
  const h = harness({
    [sessionID]: {
      jobs: [goal("g1"), goal("g2"), { id: "regular", kind: "prompt", paused: false }],
    },
  })
  await h.handlers.pauseGoal("/work", client, sessionID, "g1")
  const jobs = h.states.get(sessionID).jobs
  assert.equal(jobs[0].paused, true)
  assert.equal(jobs[1].paused, false)
  assert.equal(jobs[2].paused, false)
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.toasts, [[client, "Paused 1 experimental goal(s).", "success"]])
}

{
  const sessionID = "resume"
  const client = {}
  const h = harness({
    [sessionID]: {
      jobs: [goal("g1", {
        goalStatus: "blocked",
        enabled: false,
        paused: true,
        lastRunAt: 99,
        noProgressCount: 3,
        goalNoProgressReason: "stalled",
        goalInterruptedReason: "interrupted",
      })],
    },
  })
  await h.handlers.resumeGoal("/work", client, sessionID, "g1")
  const resumed = h.states.get(sessionID).jobs[0]
  assert.equal(resumed.goalStatus, "active")
  assert.equal(resumed.enabled, true)
  assert.equal(resumed.paused, false)
  assert.equal(resumed.lastRunAt, 0)
  assert.equal(resumed.noProgressCount, 0)
  assert.equal(resumed.goalNoProgressReason, "")
  assert.equal(resumed.goalInterruptedReason, "")
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.idle, [["/work", client, sessionID]])
  assert.deepEqual(h.toasts, [[client, "Resumed 1 experimental goal(s).", "success"]])
}

{
  const sessionID = "resume-missing"
  const client = {}
  const h = harness({ [sessionID]: { jobs: [goal("g1")] } })
  await h.handlers.resumeGoal("/work", client, sessionID, "missing")
  assert.equal(h.due.length, 0)
  assert.equal(h.idle.length, 0)
  assert.deepEqual(h.toasts, [[client, "Resumed 0 experimental goal(s).", "warning"]])
}

{
  const sessionID = "clear"
  const client = {}
  const h = harness({
    [sessionID]: {
      jobs: [goal("g1"), { id: "regular", kind: "prompt" }, goal("g2")],
    },
  })
  await h.handlers.clearGoal("/work", client, sessionID, "")
  assert.deepEqual(h.states.get(sessionID).jobs.map((job) => job.id), ["regular"])
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.toasts, [[client, "Cleared 2 experimental goal(s).", "success"]])
}

{
  const sessionID = "clear-one"
  const h = harness({ [sessionID]: { jobs: [goal("g1"), goal("g2")] } })
  await h.handlers.clearGoal("/work", {}, sessionID, "g1")
  assert.deepEqual(h.states.get(sessionID).jobs.map((job) => job.id), ["g2"])
}

{
  const h = harness()
  const client = {}
  await h.handlers.completeGoalCommand("/work", client, "complete", " shipped ")
  assert.deepEqual(h.completeCalls, [["/work", "complete", {
    summary: "shipped",
    evidence: "Marked complete by /loop-goal-done.",
    manual: true,
  }]])
  assert.deepEqual(h.toasts, [[client, "completed", "success"]])

  await h.handlers.completeGoalCommand("/work", client, "complete-default", "")
  assert.equal(h.completeCalls[1][2].summary, "Goal manually marked complete.")
}

{
  const h = harness()
  const client = {}
  await h.handlers.blockGoalCommand("/work", client, "blocked", " need token ")
  assert.deepEqual(h.blockedCalls, [["/work", "blocked", {
    reason: "need token",
    needed: "User input or manual intervention.",
  }]])
  assert.deepEqual(h.toasts, [[client, "blocked", "warning"]])
}

{
  const h = harness()
  const client = {}
  const result = await h.handlers.addGoal("/repo", client, "create", "finish the feature")
  assert.equal(result, "added")
  assert.equal(h.addLoopCalls.length, 1)
  assert.equal(h.addLoopCalls[0][0], "/repo")
  assert.equal(h.addLoopCalls[0][1], client)
  assert.equal(h.addLoopCalls[0][2], "create")
  assert.equal(h.addLoopCalls[0][3], "finish the feature")
  assert.deepEqual(h.addLoopCalls[0][4], {
    intervalMs: 0,
    kind: "goal",
    name: "goal",
    immediate: true,
    safe: true,
    askNever: true,
    noOverlap: true,
    goalStatus: "active",
  })
}

{
  const sessionID = "subcommands"
  const h = harness({ [sessionID]: { jobs: [goal("g1", { paused: false })] } })
  await h.handlers.addGoal("/work", {}, sessionID, "pause g1")
  assert.equal(h.states.get(sessionID).jobs[0].paused, true)

  await h.handlers.addGoal("/work", {}, sessionID, "completed final summary")
  assert.equal(h.completeCalls.at(-1)[2].summary, "final summary")

  await h.handlers.addGoal("/work", {}, sessionID, "block waiting on user")
  assert.equal(h.blockedCalls.at(-1)[2].reason, "waiting on user")
}

console.log("goal command handler tests passed")
