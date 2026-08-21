import { now as defaultNow } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { writeState as defaultWriteState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog, runShellCommand as defaultRunShellCommand, notifyJob as defaultNotifyJob } from "../core/process.js"
import { toast as defaultToast } from "../opencode/host.js"
import { writeGoalReport as defaultWriteGoalReport } from "./goal-runtime.js"
import { dangerousShell as defaultDangerousShell } from "./job-workspace.js"

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`createRunFinalizationRuntime requires ${label}`)
  return value
}

export function createRunFinalizationRuntime(options = {}) {
  const runGoalChecks = requireFunction(options.runGoalChecks, "runGoalChecks")
  const applyGoalNoProgressGuard = requireFunction(options.applyGoalNoProgressGuard, "applyGoalNoProgressGuard")
  const createCheckpoint = requireFunction(options.createCheckpoint, "createCheckpoint")
  const scheduleDueWork = requireFunction(options.scheduleDueWork, "scheduleDueWork")

  const now = typeof options.now === "function" ? options.now : defaultNow
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const runShellCommand = typeof options.runShellCommand === "function" ? options.runShellCommand : defaultRunShellCommand
  const notifyJob = typeof options.notifyJob === "function" ? options.notifyJob : defaultNotifyJob
  const toast = typeof options.toast === "function" ? options.toast : defaultToast
  const writeGoalReport = typeof options.writeGoalReport === "function" ? options.writeGoalReport : defaultWriteGoalReport
  const dangerousShell = typeof options.dangerousShell === "function" ? options.dangerousShell : defaultDangerousShell

  async function finalizeJob(directory, client, sessionID, state, job, previousJob) {
    if (job.verifyCommand) {
      const verify = await runShellCommand(job.verifyCommand, directory, job.timeoutMs || 300_000)
      job.lastVerifyAt = now()
      job.lastVerifyCode = verify.code
      if (verify.code === 0) {
        job.failureCount = 0
        job.lastVerifyFailure = ""
        await toast(client, "Loop verify passed: " + job.verifyCommand, "success")
      } else {
        job.failureCount = (job.failureCount || 0) + 1
        job.lastVerifyFailure = (job.verifyCommand + "\nexit=" + verify.code + "\n" + verify.stdout + "\n" + verify.stderr).slice(0, 4000)
        await toast(client, "Loop verify failed: " + job.verifyCommand, "warning")
        if (job.pauseOnVerifyFail || (job.maxFailures > 0 && job.failureCount >= job.maxFailures)) {
          job.paused = true
          await notifyJob(directory, job, "verify_failed")
        }
      }
      await appendLoopLog(directory, "verify", {
        sessionID,
        job: job.name || job.id,
        command: job.verifyCommand,
        code: verify.code,
        failures: job.failureCount || 0,
      })
    }

    if (job.postrunCommand) {
      if (job.safe && dangerousShell(job.postrunCommand)) {
        await appendLoopLog(directory, "postrun-blocked", {
          sessionID,
          job: job.name || job.id,
          command: job.postrunCommand,
        })
      } else {
        const postrun = await runShellCommand(job.postrunCommand, directory, job.timeoutMs || 300_000)
        job.lastPostrunCode = postrun.code
        job.lastPostrunAt = now()
        if (postrun.code !== 0) {
          job.failureCount = (job.failureCount || 0) + 1
          job.lastPostrunFailure = (job.postrunCommand + "\nexit=" + postrun.code + "\n" + postrun.stdout + "\n" + postrun.stderr).slice(0, 4000)
          if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
            job.paused = true
            await notifyJob(directory, job, "postrun_failed")
          }
        }
        await appendLoopLog(directory, "postrun", {
          sessionID,
          job: job.name || job.id,
          command: job.postrunCommand,
          code: postrun.code,
        })
      }
    }

    if (isGoalJob(job)) {
      job = await runGoalChecks(directory, sessionID, job, client)
      job = await applyGoalNoProgressGuard(directory, client, sessionID, job, previousJob)
    }

    state.jobs = (state.jobs || [])
      .map((candidate) => candidate.id === job.id ? job : candidate)
      .filter((candidate) => candidate.enabled !== false || isGoalJob(candidate))
    await writeState(directory, sessionID, state)
    if (isGoalJob(job)) await writeGoalReport(directory, sessionID, job)
    await createCheckpoint(directory, sessionID, job, client)
    await scheduleDueWork(directory, client, sessionID)
    return job
  }

  return { finalizeJob }
}
