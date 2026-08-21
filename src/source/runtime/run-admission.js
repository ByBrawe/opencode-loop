import path from "node:path"
import { now as defaultNow } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { pathExists as defaultPathExists, writeState as defaultWriteState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog, runShellCommand as defaultRunShellCommand, notifyJob as defaultNotifyJob } from "../core/process.js"
import { toast as defaultToast } from "../opencode/host.js"
import { dangerousShell as defaultDangerousShell } from "./job-workspace.js"

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`createRunAdmissionRuntime requires ${label}`)
  return value
}

export function createRunAdmissionRuntime(options = {}) {
  const untilReached = requireFunction(options.untilReached, "untilReached")
  const scheduleDueWork = requireFunction(options.scheduleDueWork, "scheduleDueWork")

  const now = typeof options.now === "function" ? options.now : defaultNow
  const pathExists = typeof options.pathExists === "function" ? options.pathExists : defaultPathExists
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const runShellCommand = typeof options.runShellCommand === "function" ? options.runShellCommand : defaultRunShellCommand
  const notifyJob = typeof options.notifyJob === "function" ? options.notifyJob : defaultNotifyJob
  const toast = typeof options.toast === "function" ? options.toast : defaultToast
  const dangerousShell = typeof options.dangerousShell === "function" ? options.dangerousShell : defaultDangerousShell

  function dueJobs(state, force = false) {
    const current = now()
    const due = (state.jobs || []).filter((job) => {
      if (isGoalJob(job) && ["completed", "blocked", "cleared"].includes(job.goalStatus)) return false
      if (!job.enabled || job.paused) return false
      if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return false
      if (job.maxRuntimeMs > 0 && current - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) return true
      if (Number(job.runNowRequestedAt || 0) > 0) return true
      if (force) return true
      if (job.watchPaths?.length) return job.watchTriggered === true
      return job.intervalMs === 0 || !job.lastRunAt || current - job.lastRunAt >= job.intervalMs
    })
    return due.sort((a, b) => Number(Number(b.runNowRequestedAt || 0) > 0) - Number(Number(a.runNowRequestedAt || 0) > 0))
  }

  async function reschedule(directory, client, sessionID) {
    await scheduleDueWork(directory, client, sessionID)
  }

  async function stopAndRemove(directory, client, sessionID, state, job, reason, message, logEvent) {
    state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
    await writeState(directory, sessionID, state)
    await notifyJob(directory, job, reason)
    await toast(client, message, "success")
    if (logEvent) await appendLoopLog(directory, logEvent, { sessionID, job: job.name || job.id })
    await reschedule(directory, client, sessionID)
    return { admitted: false, reason }
  }

  async function admitJob(directory, client, sessionID, state, job) {
    const runNowRequested = Number(job.runNowRequestedAt || 0) > 0

    if (job.maxRuntimeMs > 0 && now() - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) {
      return await stopAndRemove(
        directory,
        client,
        sessionID,
        state,
        job,
        "max_runtime_reached",
        `Loop stopped by --max-runtime: ${job.name || job.id}`,
        "max-runtime",
      )
    }

    if (job.stopFile && await pathExists(path.resolve(directory, job.stopFile))) {
      return await stopAndRemove(
        directory,
        client,
        sessionID,
        state,
        job,
        "stop_file",
        "Loop stopped by --stop-file: " + job.stopFile,
      )
    }

    if (await untilReached(directory, job)) {
      return await stopAndRemove(
        directory,
        client,
        sessionID,
        state,
        job,
        "until_reached",
        `Loop stopped by --until: ${job.until}`,
      )
    }

    if (job.preflightCommand) {
      if (job.safe && dangerousShell(job.preflightCommand)) {
        if (runNowRequested) delete job.runNowRequestedAt
        job.paused = true
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_blocked")
        await toast(client, "Preflight blocked in safe mode and loop paused: " + job.preflightCommand, "error")
        await reschedule(directory, client, sessionID)
        return { admitted: false, reason: "preflight_blocked" }
      }

      const preflight = await runShellCommand(job.preflightCommand, directory, job.timeoutMs || 300_000)
      await appendLoopLog(directory, "preflight", {
        sessionID,
        job: job.name || job.id,
        command: job.preflightCommand,
        code: preflight.code,
      })
      if (preflight.code !== 0) {
        if (runNowRequested) delete job.runNowRequestedAt
        job.paused = true
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPreflightFailure = (job.preflightCommand + "\nexit=" + preflight.code + "\n" + preflight.stdout + "\n" + preflight.stderr).slice(0, 4000)
        state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_failed")
        await toast(client, "Preflight failed and loop paused: " + job.preflightCommand, "warning")
        await reschedule(directory, client, sessionID)
        return { admitted: false, reason: "preflight_failed" }
      }
    }

    return { admitted: true, job, runNowRequested }
  }

  return { dueJobs, admitJob }
}
