import { promises as fs } from "node:fs"
import path from "node:path"
import { now as defaultNow, durationToText } from "../core/args.js"
import { jobLabel, matchJob, isGoalJob, goalStatusText } from "../core/jobs.js"
import { stateDir, pathExists as defaultPathExists, readState as defaultReadState, writeState as defaultWriteState, removeState as defaultRemoveState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"

const SERVICE = "opencode-loop"
const DEFAULT_PROGRESS_MD = `# Progress

## Current Goal
Describe the current project goal here.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, and follow-up work as TODOs.
- Run tests, lint, or build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and pick the next safe improvement.

## Completed
- [x] Created progress.md.

## Backlog Ideas
- [ ] Add more project-specific tasks here.

## Blocked
- None.
`

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createLoopCommandHandlers requires ${name}`)
  return value
}

export function createLoopCommandHandlers(options = {}) {
  const clearActiveRun = requireFunction(options.clearActiveRun, "clearActiveRun")
  const cancelDueWork = requireFunction(options.cancelDueWork, "cancelDueWork")
  const stopWatchdog = requireFunction(options.stopWatchdog, "stopWatchdog")
  const scheduleDueWork = requireFunction(options.scheduleDueWork, "scheduleDueWork")
  const maybeRunDueJobs = requireFunction(options.maybeRunDueJobs, "maybeRunDueJobs")
  const toast = requireFunction(options.toast, "toast")
  const say = requireFunction(options.say, "say")
  const now = typeof options.now === "function" ? options.now : defaultNow
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const removeState = typeof options.removeState === "function" ? options.removeState : defaultRemoveState
  const pathExists = typeof options.pathExists === "function" ? options.pathExists : defaultPathExists
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const readFile = typeof options.readFile === "function" ? options.readFile : (...args) => fs.readFile(...args)
  const writeFile = typeof options.writeFile === "function" ? options.writeFile : (...args) => fs.writeFile(...args)
  const runtimeVersion = options.runtimeVersion || process.version
  const runtimePlatform = options.runtimePlatform || process.platform

  async function stopLoop(directory, client, sessionID, args) {
    const target = String(args || "").trim()
    if (!target || target.toLowerCase() === "all") {
      await removeState(directory, sessionID)
      clearActiveRun(sessionID)
      cancelDueWork(sessionID)
      stopWatchdog(sessionID)
      await toast(client, "All loops stopped for this session.", "success")
      return
    }
    const state = await readState(directory, sessionID)
    const before = state.jobs.length
    state.jobs = state.jobs.filter((job, index) => !matchJob(job, target, index))
    await writeState(directory, sessionID, state)
    await scheduleDueWork(directory, client, sessionID)
    await toast(client, `Stopped ${before - state.jobs.length} loop(s).`, "success")
  }

  async function updateJobState(directory, client, sessionID, args, updater, message) {
    const target = String(args || "").trim() || "all"
    const state = await readState(directory, sessionID)
    let count = 0
    state.jobs = (state.jobs || []).map((job, index) => matchJob(job, target, index) ? (count++, updater(job)) : job)
    await writeState(directory, sessionID, state)
    await scheduleDueWork(directory, client, sessionID)
    await toast(client, `${message}: ${count} loop(s).`, count ? "success" : "warning")
  }

  async function statusLoop(directory, client, sessionID) {
    const state = await readState(directory, sessionID)
    const jobs = state.jobs || []
    const lines = jobs.length ? jobs.map((job, index) => {
      const dueIn = Number(job.runNowRequestedAt || 0) > 0 ? 0 : Math.max(0, job.intervalMs - (now() - (job.lastRunAt || 0)))
      const flags = [isGoalJob(job) ? `goal:${goalStatusText(job)}` : undefined, job.paused ? "paused" : "active", Number(job.runNowRequestedAt || 0) > 0 ? "run-now" : undefined, job.safe ? "safe" : undefined, job.askNever ? "ask-never" : undefined, job.noOverlap ? "no-overlap" : undefined, job.checkpointOnly ? "checkpoint-only" : undefined, job.gitCheckpoint ? "git-checkpoint" : undefined].filter(Boolean).join(",")
      return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${jobLabel(job)} | runs=${job.runCount || 0} | failures=${job.failureCount || 0} | due in ${durationToText(dueIn)} | ${flags}`
    }) : ["No active loop jobs."]
    await toast(client, jobs.length ? `${jobs.length} loop job(s).` : "No active loop jobs.", jobs.length ? "info" : "warning")
    await say(client, sessionID, "OpenCode loop status:\n" + lines.join("\n"))
  }

  async function logsLoop(directory, client, sessionID) {
    let text = "No loop log found."
    try { text = (await readFile(path.join(stateDir(directory), "loop.log"), "utf8")).trim().split(/\r?\n/).slice(-80).join("\n") || text } catch {}
    await say(client, sessionID, "OpenCode loop logs:\n" + text)
  }

  async function helpLoop(client, sessionID) {
    await say(client, sessionID, [
      "OpenCode Loop help:",
      "/loop 0s <prompt>                                Claude Code style auto-continue",
      "/loop 5m --ask-never --safe <prompt>              interval autonomous prompt loop",
      "/loop-command 200m /compact                       OpenCode slash-command loop, waits for idle",
      "/loop-ask 1h did you run tests and tsc --noEmit?   scheduled question/check prompt",
      "/loop-shell 10m npm test                           shell loop, waits for idle",
      "/loop-goal finish the feature and keep tests green  experimental persistent goal mode",
      "/loop-goal --check \"npm run build\" --check \"npm test\" --complete-when-checks-pass ship it",
      "/loop-goal status | pause | resume | clear          manage experimental goals",
      "/loop 200m --command /compact                     same as command loop",
      "/loop 0s --verify \"npm test\" <prompt>            verify after each assistant turn",
      "/loop 0s --prompt-file loop-prompt.md             load prompt from a file",
      "/loop 0s --max-runtime 6h --max-failures 3 <task> stop safely after limits",
      "/loop-doctor | /loop-init | /loop-export",
    ].join("\n"))
  }

  async function runNow(directory, client, sessionID, args) {
    const target = String(args || "").trim() || "all"
    const state = await readState(directory, sessionID)
    const requestedAt = Math.max(1, Number(now()) || Date.now())
    let count = 0
    for (const [index, job] of (state.jobs || []).entries()) {
      if (!matchJob(job, target, index)) continue
      job.lastRunAt = 0
      job.paused = false
      job.runNowRequestedAt = requestedAt
      count += 1
    }
    await writeState(directory, sessionID, state)
    await toast(client, `Marked ${count} loop job(s) due now.`, count ? "success" : "warning")
    if (count) await maybeRunDueJobs(directory, client, sessionID)
  }

  async function doctorLoop(directory, client, sessionID) {
    const state = await readState(directory, sessionID)
    await say(client, sessionID, [
      "OpenCode Loop doctor:",
      `- plugin: ${SERVICE}`,
      `- project directory: ${directory}`,
      `- state directory: ${stateDir(directory)}`,
      `- active jobs: ${(state.jobs || []).length}`,
      `- node: ${runtimeVersion}`,
      `- platform: ${runtimePlatform}`,
      "- smoke test: /loop 0s --max-runs 1 --dry-run continue from progress.md",
      "- experimental goal smoke test: /loop-goal --dry-run finish the current task and verify it",
    ].join("\n"))
  }

  async function initLoop(directory, client, sessionID, args) {
    const target = String(args || "").trim() || "progress.md"
    const full = path.resolve(directory, target)
    if (await pathExists(full)) { await toast(client, `${target} already exists.`, "warning"); return }
    await writeFile(full, DEFAULT_PROGRESS_MD, "utf8")
    await toast(client, `Created ${target}.`, "success")
    await appendLoopLog(directory, "init", { sessionID, file: target })
  }

  async function exportLoop(directory, client, sessionID) {
    const state = await readState(directory, sessionID)
    await say(client, sessionID, "OpenCode loop state export:\n```json\n" + JSON.stringify(state, null, 2) + "\n```")
  }

  return {
    stopLoop,
    updateJobState,
    statusLoop,
    logsLoop,
    helpLoop,
    runNow,
    doctorLoop,
    initLoop,
    exportLoop,
  }
}
