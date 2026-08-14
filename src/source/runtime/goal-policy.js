import { DEFAULT_GOAL_MAX_NO_PROGRESS, now as defaultNow } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { goalMadeMeaningfulProgress } from "./goal-runtime.js"

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createGoalExecutionPolicy requires ${name}`)
  return value
}

export function createGoalExecutionPolicy(options = {}) {
  const runShellCommand = requireFunction(options.runShellCommand, "runShellCommand")
  const dangerousShell = requireFunction(options.dangerousShell, "dangerousShell")
  const toast = requireFunction(options.toast, "toast")
  const now = typeof options.now === "function" ? options.now : defaultNow
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog

  async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob) {
    if (!isGoalJob(job) || ["completed", "blocked"].includes(job.goalStatus) || job.paused || job.enabled === false) return job
    const limit = Number(job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS)
    if (!Number.isFinite(limit) || limit <= 0) return job
    if (goalMadeMeaningfulProgress(beforeJob, job)) {
      job.noProgressCount = 0
      job.lastProgressAt = now()
      return job
    }
    job.noProgressCount = (job.noProgressCount || 0) + 1
    job.lastNoProgressAt = now()
    await appendLoopLog(directory, "goal-no-progress", { sessionID, job: job.name || job.id, count: job.noProgressCount, limit })
    if (job.noProgressCount >= limit) {
      job.paused = true
      job.goalNoProgressPausedAt = now()
      job.goalNoProgressReason = `Paused after ${job.noProgressCount} turn(s) without recorded progress. Resume with /loop-goal-resume after adjusting the goal or evidence.`
      await toast(client, job.goalNoProgressReason, "warning")
      await appendLoopLog(directory, "goal-no-progress-paused", { sessionID, job: job.name || job.id, count: job.noProgressCount, limit })
    }
    return job
  }

  async function runGoalChecks(directory, sessionID, job, client) {
    if (!isGoalJob(job) || !job.goalChecks?.length || ["completed", "blocked"].includes(job.goalStatus)) return job
    const results = []
    for (const command of job.goalChecks) {
      if (job.safe && dangerousShell(command)) {
        results.push({ command, code: -1, output: "Blocked dangerous command in safe mode." })
        continue
      }
      const result = await runShellCommand(command, directory, job.timeoutMs || 300_000)
      results.push({ command, code: result.code, output: (result.stdout + "\n" + result.stderr).slice(0, 1200) })
    }
    job.lastGoalCheckAt = now()
    job.lastGoalChecks = results
    const allPassed = results.length > 0 && results.every((item) => item.code === 0)
    if (allPassed) {
      job.goalChecksPassedAt = now()
      job.failureCount = 0
      await toast(client, "Goal checks passed.", "success")
      if (job.goalCompleteWhenChecksPass) {
        job.goalStatus = "completed"
        job.enabled = false
        job.paused = true
        job.goalCompletedAt = now()
        job.goalSummary = job.goalSummary || "All configured goal checks passed."
        job.goalEvidence = results.map((item) => `${item.command}: exit ${item.code}`).join("\n")
        await appendLoopLog(directory, "goal-auto-complete", { sessionID, job: job.name || job.id })
      }
    } else {
      job.failureCount = (job.failureCount || 0) + 1
      job.lastVerifyFailure = results.map((item) => `${item.command}\nexit=${item.code}\n${item.output}`).join("\n\n").slice(0, 4000)
      await toast(client, "Goal checks still failing; goal will continue on next idle turn.", "warning")
    }
    await appendLoopLog(directory, "goal-checks", { sessionID, job: job.name || job.id, results: results.map((item) => ({ command: item.command, code: item.code })) })
    return job
  }

  return { runGoalChecks, applyGoalNoProgressGuard }
}
