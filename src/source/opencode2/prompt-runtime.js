import { parseLoopArgs, splitFirst } from "../core/args.js"
import { actionKind, decoratePrompt, matchJob } from "../core/jobs.js"
import { readState, removeState, writeState } from "../core/state.js"
import { formatOpenCode2LoopStatus } from "./status.js"

export const OPENCODE_LOOP_V2_PROMPT_RUNTIME = "prompt-zero-interval"
export const OPENCODE_LOOP_V2_INTERVAL_RUNTIME = "idle-safe-timer"
export const OPENCODE_LOOP_V2_PROMPT_PREFIX = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly."

function directoryFrom(event) {
  return typeof event?.directory === "string" && event.directory.trim() ? event.directory : undefined
}

function commandParts(action) {
  const normalized = String(action || "").trim().replace(/^\/+/, "")
  return splitFirst(normalized)
}

function unsupportedRuntimeJob(job, supportsCommand) {
  const blockers = []
  const kind = actionKind(job?.action, job)
  if (!String(job?.action || "").trim()) blockers.push("action")
  if (kind === "command") {
    if (!supportsCommand) blockers.push("command-capability")
    if (!commandParts(job?.action)[0]) blockers.push("action")
  } else if (kind !== "prompt") {
    blockers.push("kind")
  }
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
  return [...new Set(blockers)]
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

function scopeFrom(event) {
  const directory = directoryFrom(event)
  const sessionID = String(event?.sessionID || "").trim()
  if (!directory || !sessionID) return undefined
  return { directory, sessionID, key: `${directory}\u0000${sessionID}` }
}

function dueAt(job, current) {
  const intervalMs = Math.max(0, Number(job?.intervalMs || 0))
  const lastRunAt = Number(job?.lastRunAt || 0)
  if (intervalMs === 0) return current
  if (lastRunAt <= 0) {
    if (job?.immediate === false) {
      const createdAt = Date.parse(job?.createdAt || "")
      return (Number.isFinite(createdAt) ? createdAt : current) + intervalMs
    }
    return current
  }
  return lastRunAt + intervalMs
}

export function createOpenCode2PromptRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 prompt runtime requires prompt()")

  const supportsCommand = typeof options.command === "function"
  const now = typeof options.now === "function" ? options.now : Date.now
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout
  const onError = typeof options.onError === "function" ? options.onError : () => {}
  const timers = new Map()
  const idle = new Map()
  const queues = new Map()
  let disposed = false

  function report(error) {
    try { onError(error) } catch {}
  }

  function eligibleRuntimeJob(job) {
    if (!job?.enabled || job?.paused) return false
    if (unsupportedRuntimeJob(job, supportsCommand).length) return false
    return !(job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns)
  }

  function clearScopeTimer(key) {
    const current = timers.get(key)
    if (!current) return false
    timers.delete(key)
    try { clearTimer(current.handle) } catch {}
    return true
  }

  function clearScope(scope) {
    clearScopeTimer(scope.key)
    idle.delete(scope.key)
  }

  function enqueueScope(scope, task) {
    if (disposed) return Promise.resolve({ handled: false, reason: "disposed" })
    const previous = queues.get(scope.key) || Promise.resolve()
    const result = previous.catch(() => undefined).then(async () => {
      if (disposed) return { handled: false, reason: "disposed" }
      return await task()
    })
    const tail = result.catch(() => undefined)
    queues.set(scope.key, tail)
    tail.then(() => {
      if (queues.get(scope.key) === tail) queues.delete(scope.key)
    })
    return result
  }

  async function scheduleScope(scope) {
    clearScopeTimer(scope.key)
    if (disposed) return undefined

    const state = await readState(scope.directory, scope.sessionID)
    const current = now()
    let earliest
    for (const job of state.jobs || []) {
      if (!eligibleRuntimeJob(job)) continue
      const intervalMs = Math.max(0, Number(job?.intervalMs || 0))
      if (intervalMs === 0) continue
      const candidate = dueAt(job, current)
      if (candidate <= current) continue
      if (!earliest || candidate < earliest) earliest = candidate
    }
    if (!earliest) return undefined

    const delay = Math.max(0, earliest - current)
    const token = Symbol(scope.key)
    const handle = setTimer(() => {
      const pending = enqueueScope(scope, async () => {
        const currentTimer = timers.get(scope.key)
        if (!currentTimer || currentTimer.token !== token) return { handled: false, reason: "stale-timer" }
        timers.delete(scope.key)
        if (idle.get(scope.key) !== true) return { handled: true, dispatched: false, reason: "not-idle" }
        return await runDueAction(scope)
      })
      pending.catch(report)
      return pending
    }, delay)
    handle?.unref?.()
    timers.set(scope.key, { handle, token, dueAt: earliest })
    return earliest
  }

  async function dispatchJob(scope, job) {
    const kind = actionKind(job?.action, job)
    if (kind === "command") {
      const [command, argumentsText] = commandParts(job.action)
      const request = {
        sessionID: scope.sessionID,
        command,
        arguments: argumentsText || undefined,
      }
      await options.command(request)
      return { kind, request }
    }

    const text = promptText(job)
    const request = { sessionID: scope.sessionID, text }
    await options.prompt(request)
    return { kind: "prompt", request, text }
  }

  async function runDueAction(scope) {
    const state = await readState(scope.directory, scope.sessionID)
    const current = now()
    const job = (state.jobs || []).find((candidate) => eligibleRuntimeJob(candidate) && dueAt(candidate, current) <= current)
    if (!job) {
      await scheduleScope(scope)
      return { handled: true, dispatched: false }
    }

    job.lastRunAt = current
    job.runCount = (job.runCount || 0) + 1
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns) job.enabled = false
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(scope.directory, scope.sessionID, state)

    idle.set(scope.key, false)
    await scheduleScope(scope)

    const dispatched = await dispatchJob(scope, job)
    return { handled: true, dispatched: true, job, ...dispatched }
  }

  async function addPromptLoop(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    return await enqueueScope(scope, async () => {
      const parsed = parseLoopArgs(event.arguments || "")
      if (!parsed.ok) return { handled: true, accepted: false, reason: "parse", error: parsed.error }

      const blockers = unsupportedRuntimeJob(parsed.job, supportsCommand)
      if (blockers.length) return { handled: true, accepted: false, reason: "unsupported", blockers }

      parsed.job.name = jobName(parsed.job)
      const state = await readState(scope.directory, scope.sessionID)
      const jobs = Array.isArray(state.jobs) ? state.jobs : []
      if (!parsed.job.multi) {
        state.jobs = jobs.filter((job) => jobName(job) !== parsed.job.name)
      } else {
        state.jobs = jobs
      }
      state.jobs.push(parsed.job)
      await writeState(scope.directory, scope.sessionID, state)
      await scheduleScope(scope)
      return { handled: true, accepted: true, job: parsed.job }
    })
  }

  async function statusPromptLoops(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    return await enqueueScope(scope, async () => {
      const status = formatOpenCode2LoopStatus(await readState(scope.directory, scope.sessionID), now())
      const request = { sessionID: scope.sessionID, text: status.text, noReply: true }
      await options.prompt(request)
      return { handled: true, accepted: true, status, request }
    })
  }

  async function updatePromptLoops(event, updater) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    return await enqueueScope(scope, async () => {
      const target = commandTarget(event)
      const state = await readState(scope.directory, scope.sessionID)
      let count = 0
      state.jobs = (state.jobs || []).map((job, index) => {
        if (!matchJob(job, target, index)) return job
        count += 1
        return updater(job)
      })
      await writeState(scope.directory, scope.sessionID, state)
      await scheduleScope(scope)
      return { handled: true, accepted: true, count, target }
    })
  }

  async function stopPromptLoops(event, forcedTarget) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    return await enqueueScope(scope, async () => {
      const target = forcedTarget || commandTarget(event)
      if (target.toLowerCase() === "all") {
        const state = await readState(scope.directory, scope.sessionID)
        const count = (state.jobs || []).length
        await removeState(scope.directory, scope.sessionID)
        await scheduleScope(scope)
        return { handled: true, accepted: true, count, target }
      }

      const state = await readState(scope.directory, scope.sessionID)
      const before = (state.jobs || []).length
      state.jobs = (state.jobs || []).filter((job, index) => !matchJob(job, target, index))
      await writeState(scope.directory, scope.sessionID, state)
      await scheduleScope(scope)
      return { handled: true, accepted: true, count: before - state.jobs.length, target }
    })
  }

  async function runIdlePrompt(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    idle.set(scope.key, true)
    return await enqueueScope(scope, () => runDueAction(scope))
  }

  async function onEvent(event) {
    const scope = scopeFrom(event)
    if (event?.kind === "command" && event?.action === "executed") {
      if (scope) idle.set(scope.key, false)
      if (event?.name === "loop") return addPromptLoop(event)
      if (event?.name === "loop-status") return statusPromptLoops(event)
      if (event?.name === "loop-pause") return updatePromptLoops(event, (job) => ({ ...job, paused: true }))
      if (event?.name === "loop-resume") return updatePromptLoops(event, (job) => ({ ...job, paused: false, lastRunAt: 0 }))
      if (["loop-stop", "loop-remove"].includes(event?.name)) return stopPromptLoops(event)
      if (event?.name === "loop-clear") return stopPromptLoops(event, "all")
    }

    if (event?.kind === "session" && event?.action === "idle") {
      return runIdlePrompt(event)
    }
    if (event?.kind === "session" && event?.action === "status" && scope) {
      idle.set(scope.key, event.status === "idle")
      return await enqueueScope(scope, async () => {
        await scheduleScope(scope)
        return { handled: true, dispatched: false }
      })
    }
    if (event?.kind === "session" && event?.action === "deleted" && scope) {
      clearScope(scope)
      return { handled: true, disposedScope: true }
    }
    if (event?.kind === "message" && event?.action === "updated" && scope) {
      if (event.role === "user" || (event.role === "assistant" && !event.completedAt)) idle.set(scope.key, false)
      return { handled: false }
    }
    if (event?.kind === "server" && event?.action === "disposed") {
      await dispose()
      return { handled: true, disposed: true }
    }
    return { handled: false }
  }

  async function dispose() {
    if (disposed) return false
    disposed = true
    for (const { handle } of timers.values()) {
      try { clearTimer(handle) } catch {}
    }
    timers.clear()
    idle.clear()
    const pending = [...queues.values()]
    if (pending.length) await Promise.allSettled(pending)
    queues.clear()
    return true
  }

  return Object.freeze({
    onEvent,
    addPromptLoop,
    statusPromptLoops,
    updatePromptLoops,
    stopPromptLoops,
    runIdlePrompt,
    dispose,
    scheduledCount: () => timers.size,
  })
}
