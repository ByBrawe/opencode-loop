import { parseLoopArgs } from "../core/args.js"
import { actionKind, decoratePrompt, matchJob } from "../core/jobs.js"
import { readState, removeState, writeState } from "../core/state.js"

export const OPENCODE_LOOP_V2_PROMPT_RUNTIME = "prompt-zero-interval"
export const OPENCODE_LOOP_V2_PROMPT_PREFIX = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly."

function directoryFrom(event) {
  return typeof event?.directory === "string" && event.directory.trim() ? event.directory : undefined
}

function unsupportedPromptJob(job) {
  const blockers = []
  if (Number(job?.intervalMs || 0) !== 0) blockers.push("interval")
  if (actionKind(job?.action, job) !== "prompt") blockers.push("kind")
  if (!String(job?.action || "").trim()) blockers.push("action")
  if (job?.watchPaths?.length) blockers.push("watch")
  if (job?.promptFile) blockers.push("prompt-file")
  if (job?.includeFiles?.length) blockers.push("include-file")
  if (job?.verifyCommand) blockers.push("verify")
  if (job?.preflightCommand) blockers.push("preflight")
  if (job?.postrunCommand) blockers.push("postrun")
  if (job?.notifyCommand) blockers.push("notify")
  if (job?.branch) blockers.push("branch")
  if (job?.compactEveryRuns > 0 || job?.compactEveryMs > 0) blockers.push("compact-every")
  if (job?.gitCheckpoint || job?.checkpointOnly) blockers.push("checkpoint")
  if (job?.timeoutMs > 0) blockers.push("timeout")
  if (job?.maxRuntimeMs > 0) blockers.push("max-runtime")
  if (job?.maxFailures > 0) blockers.push("max-failures")
  if (job?.until) blockers.push("until")
  if (job?.stopFile) blockers.push("stop-file")
  return blockers
}

function jobName(job) {
  return String(job?.name || "default")
}

function promptText(job) {
  return `${OPENCODE_LOOP_V2_PROMPT_PREFIX}\n\n${decoratePrompt(job)}`
}

function commandTarget(event, fallback = "all") {
  return String(event?.arguments || "").trim() || fallback
}

export function createOpenCode2PromptRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 prompt runtime requires prompt()")

  async function addPromptLoop(event) {
    const directory = directoryFrom(event)
    const sessionID = String(event?.sessionID || "").trim()
    if (!directory || !sessionID) return { handled: false, reason: "missing-scope" }

    const parsed = parseLoopArgs(event.arguments || "")
    if (!parsed.ok) return { handled: true, accepted: false, reason: "parse", error: parsed.error }

    const blockers = unsupportedPromptJob(parsed.job)
    if (blockers.length) return { handled: true, accepted: false, reason: "unsupported", blockers }

    parsed.job.name = jobName(parsed.job)
    const state = await readState(directory, sessionID)
    const jobs = Array.isArray(state.jobs) ? state.jobs : []
    if (!parsed.job.multi) {
      state.jobs = jobs.filter((job) => jobName(job) !== parsed.job.name)
    } else {
      state.jobs = jobs
    }
    state.jobs.push(parsed.job)
    await writeState(directory, sessionID, state)
    return { handled: true, accepted: true, job: parsed.job }
  }

  async function updatePromptLoops(event, updater) {
    const directory = directoryFrom(event)
    const sessionID = String(event?.sessionID || "").trim()
    if (!directory || !sessionID) return { handled: false, reason: "missing-scope" }

    const target = commandTarget(event)
    const state = await readState(directory, sessionID)
    let count = 0
    state.jobs = (state.jobs || []).map((job, index) => {
      if (!matchJob(job, target, index)) return job
      count += 1
      return updater(job)
    })
    await writeState(directory, sessionID, state)
    return { handled: true, accepted: true, count, target }
  }

  async function stopPromptLoops(event, forcedTarget) {
    const directory = directoryFrom(event)
    const sessionID = String(event?.sessionID || "").trim()
    if (!directory || !sessionID) return { handled: false, reason: "missing-scope" }

    const target = forcedTarget || commandTarget(event)
    if (target.toLowerCase() === "all") {
      const state = await readState(directory, sessionID)
      const count = (state.jobs || []).length
      await removeState(directory, sessionID)
      return { handled: true, accepted: true, count, target }
    }

    const state = await readState(directory, sessionID)
    const before = (state.jobs || []).length
    state.jobs = (state.jobs || []).filter((job, index) => !matchJob(job, target, index))
    await writeState(directory, sessionID, state)
    return { handled: true, accepted: true, count: before - state.jobs.length, target }
  }

  async function runIdlePrompt(event) {
    const directory = directoryFrom(event)
    const sessionID = String(event?.sessionID || "").trim()
    if (!directory || !sessionID) return { handled: false, reason: "missing-scope" }

    const state = await readState(directory, sessionID)
    const job = (state.jobs || []).find((candidate) => {
      if (!candidate?.enabled || candidate?.paused) return false
      if (unsupportedPromptJob(candidate).length) return false
      return !(candidate.maxRuns > 0 && (candidate.runCount || 0) >= candidate.maxRuns)
    })
    if (!job) return { handled: true, dispatched: false }

    job.lastRunAt = Date.now()
    job.runCount = (job.runCount || 0) + 1
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns) job.enabled = false
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)

    const text = promptText(job)
    await options.prompt({ sessionID, text })
    return { handled: true, dispatched: true, job, text }
  }

  async function onEvent(event) {
    if (event?.kind === "command" && event?.action === "executed") {
      if (event?.name === "loop") return addPromptLoop(event)
      if (event?.name === "loop-pause") return updatePromptLoops(event, (job) => ({ ...job, paused: true }))
      if (event?.name === "loop-resume") return updatePromptLoops(event, (job) => ({ ...job, paused: false, lastRunAt: 0 }))
      if (["loop-stop", "loop-remove"].includes(event?.name)) return stopPromptLoops(event)
      if (event?.name === "loop-clear") return stopPromptLoops(event, "all")
    }
    if (event?.kind === "session" && event?.action === "idle") {
      return runIdlePrompt(event)
    }
    return { handled: false }
  }

  return Object.freeze({ onEvent, addPromptLoop, updatePromptLoops, stopPromptLoops, runIdlePrompt })
}
