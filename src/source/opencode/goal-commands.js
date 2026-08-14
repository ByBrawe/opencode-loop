import { DEFAULT_GOAL_MAX_NO_PROGRESS, splitFirst } from "../core/args.js"
import { isGoalJob, matchJob, goalStatusText } from "../core/jobs.js"
import { readState as defaultReadState, writeState as defaultWriteState } from "../core/state.js"
import { setGoalComplete as defaultSetGoalComplete, setGoalBlocked as defaultSetGoalBlocked } from "../runtime/goal-runtime.js"

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createGoalCommandHandlers requires ${name}`)
  return value
}

export function createGoalCommandHandlers(options = {}) {
  const addLoop = requireFunction(options.addLoop, "addLoop")
  const scheduleDueWork = requireFunction(options.scheduleDueWork, "scheduleDueWork")
  const scheduleIdleWork = requireFunction(options.scheduleIdleWork, "scheduleIdleWork")
  const toast = requireFunction(options.toast, "toast")
  const say = requireFunction(options.say, "say")
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const setGoalComplete = typeof options.setGoalComplete === "function" ? options.setGoalComplete : defaultSetGoalComplete
  const setGoalBlocked = typeof options.setGoalBlocked === "function" ? options.setGoalBlocked : defaultSetGoalBlocked

  async function statusGoal(directory, client, sessionID) {
    const state = await readState(directory, sessionID)
    const goals = (state.jobs || []).filter(isGoalJob)
    const lines = goals.length ? goals.map((job, index) => {
      const status = goalStatusText(job)
      const checks = job.goalChecks?.length ? ` | checks=${job.goalChecks.length}` : ""
      const acceptance = job.goalAcceptance?.length ? ` | acceptance=${job.goalAcceptance.length}` : ""
      const progress = job.goalProgress?.length ? ` | progress=${job.goalProgress.length}` : ""
      const noProgress = (job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0 ? ` | no-progress=${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}` : ""
      const rejected = job.goalCompletionRejectedReason ? " | completion-rejected" : ""
      return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${status} | turns=${job.runCount || 0} | objective=${String(job.action || job.goalFile || "").slice(0, 220)}${checks}${acceptance}${progress}${noProgress}${rejected}`
    }) : ["No experimental goal jobs."]
    await toast(client, goals.length ? `${goals.length} experimental goal(s).` : "No experimental goal jobs.", goals.length ? "info" : "warning")
    await say(client, sessionID, "OpenCode Loop experimental goal status:\n" + lines.join("\n"))
  }

  async function pauseGoal(directory, client, sessionID, args) {
    const target = String(args || "").trim() || "goal"
    const state = await readState(directory, sessionID)
    let count = 0
    state.jobs = (state.jobs || []).map((job, index) => isGoalJob(job) && matchJob(job, target, index) ? (count++, { ...job, paused: true }) : job)
    await writeState(directory, sessionID, state)
    await scheduleDueWork(directory, client, sessionID)
    await toast(client, `Paused ${count} experimental goal(s).`, count ? "success" : "warning")
  }

  async function resumeGoal(directory, client, sessionID, args) {
    const target = String(args || "").trim() || "goal"
    const state = await readState(directory, sessionID)
    let count = 0
    state.jobs = (state.jobs || []).map((job, index) => {
      if (!isGoalJob(job) || !matchJob(job, target, index)) return job
      count++
      return { ...job, paused: false, enabled: true, goalStatus: job.goalStatus === "blocked" ? "active" : (job.goalStatus || "active"), lastRunAt: 0, noProgressCount: 0, goalNoProgressReason: "", goalInterruptedReason: "" }
    })
    await writeState(directory, sessionID, state)
    await toast(client, `Resumed ${count} experimental goal(s).`, count ? "success" : "warning")
    if (count) {
      await scheduleDueWork(directory, client, sessionID)
      scheduleIdleWork(directory, client, sessionID)
    }
  }

  async function clearGoal(directory, client, sessionID, args) {
    const target = String(args || "").trim()
    const state = await readState(directory, sessionID)
    const before = state.jobs.length
    state.jobs = (state.jobs || []).filter((job, index) => !isGoalJob(job) || (target && !matchJob(job, target, index)))
    await writeState(directory, sessionID, state)
    await scheduleDueWork(directory, client, sessionID)
    await toast(client, `Cleared ${before - state.jobs.length} experimental goal(s).`, before !== state.jobs.length ? "success" : "warning")
  }

  async function completeGoalCommand(directory, client, sessionID, args) {
    const result = await setGoalComplete(directory, sessionID, { summary: String(args || "").trim() || "Goal manually marked complete.", evidence: "Marked complete by /loop-goal-done.", manual: true })
    await toast(client, result.message, result.ok ? "success" : "warning")
  }

  async function blockGoalCommand(directory, client, sessionID, args) {
    const result = await setGoalBlocked(directory, sessionID, { reason: String(args || "").trim() || "Goal manually marked blocked.", needed: "User input or manual intervention." })
    await toast(client, result.message, "warning")
  }

  async function addGoal(directory, client, sessionID, args) {
    const text = String(args || "").trim()
    const [maybeCommand, rest] = splitFirst(text)
    const sub = maybeCommand.toLowerCase()
    if (!text || sub === "status") return await statusGoal(directory, client, sessionID)
    if (sub === "pause") return await pauseGoal(directory, client, sessionID, rest)
    if (sub === "resume") return await resumeGoal(directory, client, sessionID, rest)
    if (["clear", "remove", "stop"].includes(sub)) return await clearGoal(directory, client, sessionID, rest)
    if (["done", "complete", "completed"].includes(sub)) return await completeGoalCommand(directory, client, sessionID, rest)
    if (["blocked", "block"].includes(sub)) return await blockGoalCommand(directory, client, sessionID, rest)
    return await addLoop(directory, client, sessionID, text, { intervalMs: 0, kind: "goal", name: "goal", immediate: true, safe: true, askNever: true, noOverlap: true, goalStatus: "active" })
  }

  return {
    addGoal,
    statusGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    completeGoalCommand,
    blockGoalCommand,
  }
}
