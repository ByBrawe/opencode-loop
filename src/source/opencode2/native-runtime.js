import { randomUUID } from "node:crypto"
import { parseLoopArgs, splitFirst } from "../core/args.js"
import { actionKind, matchJob } from "../core/jobs.js"
import { readState, writeState, removeState } from "../core/state.js"
import { appendLoopLog } from "../core/process.js"
import { formatOpenCode2LoopStatus } from "./status.js"
import { createNativeJobPolicy } from "./native-policy.js"

const PREFIX = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Work directly on the configured task."
const result = (detail = {}) => ({ handled: true, dispatched: false, ...detail })
const id = () => `msg_loop_${randomUUID().replaceAll("-", "")}`

// This runtime uses native durable inbox admission. It never calls session.abort.
export function createNativeLoopRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("Native Loop requires prompt()")
  const now = options.now || Date.now
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const policy = createNativeJobPolicy({ ...options, now })
  const scopes = new Map()
  let disposed = false

  function scopeFor(event) {
    const sessionID = String(event?.sessionID || "").trim()
    const directory = String(event?.directory || options.directory || "").trim()
    if (!sessionID || !directory) return undefined
    const key = `${directory}\u0000${sessionID}`
    if (!scopes.has(key)) scopes.set(key, { key, sessionID, directory, epoch: 0, busy: false, queue: Promise.resolve() })
    return scopes.get(key)
  }
  const current = (scope) => !disposed && !scope.deleted
  const read = (scope) => readState(scope.directory, scope.sessionID)
  const save = (scope, state) => writeState(scope.directory, scope.sessionID, state)
  const report = (error) => { try { options.onError?.(error) } catch {} }
  function enqueue(scope, task) {
    const pending = scope.queue.catch(() => {}).then(() => current(scope) ? task() : result({ reason: "disposed" }))
    scope.queue = pending.catch(report)
    return pending
  }
  function clear(scope, field) {
    if (scope[field] !== undefined) clearTimer(scope[field])
    delete scope[field]
  }
  function eligible(job) {
    return job.enabled !== false && !job.paused && !(job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns)
  }
  function dueAt(job) {
    if (job.runNowRequestedAt > 0) return now()
    if (job.watchPaths?.length && !job.watchTriggered) return Infinity
    if (job.lastRunAt > 0) return job.lastRunAt + Math.max(0, job.intervalMs || 0)
    return job.immediate === false ? Date.parse(job.createdAt) + Math.max(0, job.intervalMs || 0) : now()
  }
  function blocked(job) {
    const kind = actionKind(job.action, job)
    if (kind === "goal") return ["Use the native @bybrawe/opencode-goal /goal workflow; legacy Loop Goal state is not silently converted."]
    if (!["prompt", "command", "compact", "shell"].includes(kind)) return ["unsupported action kind"]
    if (kind === "command" && (typeof options.command !== "function" || typeof options.wait !== "function")) return ["native command and wait capabilities are required"]
    if ((kind === "compact" || job.compactEveryRuns > 0 || job.compactEveryMs > 0) && typeof options.compact !== "function") return ["native compaction capability is required"]
    if (kind === "shell" && typeof options.shell !== "function") return ["native shell capability is required"]
    if (job.noOverlap === false) return ["Native V2 sessions are serialized; remove --allow-overlap."]
    return []
  }

  async function schedule(scope) {
    clear(scope, "timer")
    if (!current(scope) || scope.busy || scope.active || scope.compaction) return
    const state = await read(scope)
    if (!current(scope) || scope.busy || scope.active || scope.compaction) return
    let delay = Infinity
    for (const job of state.jobs || []) {
      if (!eligible(job) || job.v2Run || blocked(job).length) continue
      if (job.watchPaths?.length || job.stopFile || job.until) delay = Math.min(delay, 1000)
      const due = dueAt(job)
      if (due > now()) delay = Math.min(delay, due - now())
      if (job.maxRuntimeMs > 0) delay = Math.min(delay, Math.max(1, Date.parse(job.createdAt) + job.maxRuntimeMs - now()))
    }
    if (!Number.isFinite(delay)) return
    scope.timer = setTimer(() => {
      delete scope.timer
      return enqueue(scope, () => advance(scope)).catch(report)
    }, Math.max(1, Math.min(delay, 2_147_483_647)))
    scope.timer?.unref?.()
  }

  async function note(scope, name, detail = {}) {
    await appendLoopLog(scope.directory, `v2-native-${name}`, { sessionID: scope.sessionID, ...detail })
  }

  async function pauseActive(scope, reason, failed = true) {
    clear(scope, "deadline")
    const state = await read(scope)
    for (const job of state.jobs || []) {
      if (scope.active ? job.id !== scope.active.jobID : !eligible(job)) continue
      policy.pause(job, reason, failed)
    }
    await save(scope, state)
    await cancelPending(scope, state)
    await note(scope, "paused", { reason })
    return result({ reason })
  }

  async function cancelPending(scope, state) {
    const run = scope.active
    if (!run || run.delivered || !["prompt", "command"].includes(run.kind) || !run.inboxID || typeof options.cancel !== "function") return false
    let cancelled = false
    try { cancelled = (await options.cancel({ sessionID: scope.sessionID, inboxID: run.inboxID })) === true } catch (error) { report(error) }
    if (!cancelled) return false
    const job = (state.jobs || []).find((entry) => entry.id === run.jobID)
    if (job?.v2Run?.id === run.id) {
      // Refund only a proven undelivered cancellation, not an interrupted model turn.
      Object.assign(job, run.previous)
      delete job.v2Run
      await save(scope, state)
    }
    if (scope.active === run) delete scope.active
    clear(scope, "deadline")
    return true
  }

  async function finish(scope) {
    const run = scope.active
    if (!run || scope.compaction) return result({ reason: "no-terminal-boundary" })
    if ((run.kind === "prompt" && !run.delivered) || (run.kind === "command" && !run.commandFinished) || (run.kind === "shell" && !run.shellFinished) || (["compact", "cadence"].includes(run.kind) && !run.compactFinished)) {
      return result({ reason: "awaiting-owned-completion" })
    }
    clear(scope, "deadline")
    const state = await read(scope)
    const job = (state.jobs || []).find((entry) => entry.id === run.jobID)
    if (job?.v2Run?.id === run.id) {
      if (["compact", "cadence"].includes(run.kind)) {
        job.lastCompactAt = now()
        job.lastCompactRunCount = job.runCount || 0
      } else if (!job.paused && !run.foreground) {
        await policy.finish(scope, job, () => current(scope) && scope.active === run && !run.foreground)
      }
      delete job.v2Run
      job.lastCompletedAt = now()
      await save(scope, state)
      if (job.paused || job.enabled === false) await policy.notify(scope, job, job.pauseReason || "completed")
    }
    if (scope.active === run) delete scope.active
    await note(scope, "completed", { jobID: run.jobID, kind: run.kind, foreground: Boolean(run.foreground) })
    return advance(scope)
  }

  async function dispatch(scope, state, job, kind) {
    const epoch = scope.epoch
    const isCurrent = () => current(scope) && scope.epoch === epoch && !scope.busy && !scope.compaction
    let request
    if (kind === "prompt") request = { sessionID: scope.sessionID, id: id(), text: `${PREFIX}\n\n${await policy.buildPrompt(scope.directory, job)}`, delivery: "queue", metadata: { opencode_loop_v2: true, opencode_loop_job: job.id } }
    else if (kind === "compact" || kind === "cadence") request = { sessionID: scope.sessionID, id: id() }
    else if (kind === "shell") request = { sessionID: scope.sessionID, command: String(job.action).replace(/^[!$]\s*/, "") }
    else {
      const [name, text] = splitFirst(String(job.action).replace(/^\/+/, ""))
      request = { sessionID: scope.sessionID, name, ...(text ? { text } : {}), delivery: "queue" }
    }
    if (!isCurrent()) return result({ reason: "foreground-or-compaction" })
    if (job.dryRun) {
      policy.pause(job, "dry-run")
      await save(scope, state)
      return result({ dryRun: true, request })
    }
    if (kind === "shell" && job.safe) {
      const { dangerousShell } = await import("../runtime/job-workspace.js")
      if (dangerousShell(request.command)) {
        policy.pause(job, "unsafe-shell", true)
        await save(scope, state)
        return result({ reason: "unsafe-shell" })
      }
    }
    const run = {
      id: request.id || id(), jobID: job.id, kind, createdAt: now(), delivered: false,
      previous: { runCount: job.runCount || 0, lastRunAt: job.lastRunAt || 0, enabled: job.enabled },
    }
    job.v2Run = { id: run.id, kind, status: "admitting", createdAt: run.createdAt }
    await save(scope, state)
    job = state.jobs.find((entry) => entry.id === run.jobID)
    if (!isCurrent() || !job || !eligible(job)) {
      if (job?.v2Run?.id === run.id) { delete job.v2Run; await save(scope, state) }
      return result({ reason: "admission-withdrawn" })
    }
    scope.active = run
    clear(scope, "timer")
    try {
      let response
      if (kind === "prompt") response = await options.prompt(request)
      else if (kind === "compact" || kind === "cadence") response = await options.compact(request)
      else if (kind === "shell") response = await options.shell(request)
      else response = await options.command(request)
      if (response?.error || response?.accepted === false) throw new Error(String(response.error?.message || response.error || "Native admission rejected"))
      run.inboxID = response?.id || response?.data?.id || request.id
      run.shellID = kind === "shell" ? (response?.id || response?.shell?.id) : undefined
      if (kind !== "cadence") {
        job.runCount = (job.runCount || 0) + 1
        job.lastRunAt = now()
        if (job.maxRuns > 0 && job.runCount >= job.maxRuns) job.enabled = false
      }
      delete job.runNowRequestedAt
      job.watchTriggered = false
      job.v2Run = { ...job.v2Run, status: "admitted", inboxID: run.inboxID, shellID: run.shellID }
      await save(scope, state)
      await note(scope, "admitted", { jobID: job.id, kind, inboxID: run.inboxID, runCount: job.runCount })
      if (current(scope) && job.timeoutMs > 0) {
        scope.deadline = setTimer(() => enqueue(scope, () => scope.active === run ? pauseActive(scope, "timeout-waiting-for-host-boundary") : result()).catch(report), Math.min(job.timeoutMs, 2_147_483_647))
        scope.deadline?.unref?.()
      }
      if (kind === "command") {
        Promise.resolve().then(() => options.wait({ sessionID: scope.sessionID })).then(
          () => enqueue(scope, async () => { if (scope.active !== run) return result(); run.commandFinished = true; return finish(scope) }),
          () => enqueue(scope, () => pauseActive(scope, "command-failed")),
        ).catch(report)
      }
      if (kind === "shell" && response?.status && response.status !== "running") {
        run.shellFinished = true
        if (response.status !== "exited" || Number(response.exit || 0) !== 0) return pauseActive(scope, "shell-failed")
        return finish(scope)
      }
      return result({ dispatched: true, job, kind, request })
    } catch (error) {
      // A lost response may follow a successful host admission. Preserve its ID
      // and pause instead of charging a run or blindly creating another input.
      policy.pause(job, "admission-uncertain", true)
      job.lastError = error instanceof Error ? error.message : String(error)
      await save(scope, state)
      await note(scope, "admission-failed", { jobID: job.id, message: job.lastError })
      return result({ reason: "admission-uncertain", error: job.lastError })
    }
  }

  async function advance(scope) {
    if (!current(scope) || scope.busy || scope.compaction || scope.active) return result({ reason: "host-not-idle" })
    const epoch = scope.epoch
    const state = await read(scope)
    for (const job of state.jobs || []) {
      if (!eligible(job)) continue
      if (job.v2Run) {
        policy.pause(job, "restart-requires-review")
        await save(scope, state)
        return result({ reason: "restart-requires-review" })
      }
      if (blocked(job).length) continue
      if (job.watchPaths?.length && await policy.watchChanged(scope.directory, job)) job.watchTriggered = true
      const safe = () => current(scope) && !scope.busy && !scope.compaction && !scope.active && scope.epoch === epoch
      if (!safe()) return result({ reason: "foreground-or-compaction" })
      // Stop conditions apply even when a future timer or watch is not due.
      if (dueAt(job) > now()) continue
      if (!await policy.prepare(scope, job, safe)) {
        if (job.paused || job.enabled === false) { await save(scope, state); await policy.notify(scope, job, job.pauseReason) }
        return result({ reason: job.pauseReason || "foreground-or-compaction" })
      }
      const kind = actionKind(job.action, job)
      const cadence = kind !== "compact" && job.runCount > 0 && (
        (job.compactEveryRuns > 0 && job.runCount - (job.lastCompactRunCount || 0) >= job.compactEveryRuns) ||
        (job.compactEveryMs > 0 && now() - (job.lastCompactAt || Date.parse(job.createdAt)) >= job.compactEveryMs)
      )
      return dispatch(scope, state, job, cadence ? "cadence" : kind)
    }
    await schedule(scope)
    return result()
  }

  async function command(scope, event) {
    const state = await read(scope)
    const target = String(event.arguments || "").trim() || "all"
    if (event.name === "loop") {
      const parsed = parseLoopArgs(event.arguments || "")
      if (!parsed.ok) return result({ accepted: false, error: parsed.error })
      const blockers = blocked(parsed.job)
      if (blockers.length) return result({ accepted: false, reason: "unsupported", blockers, error: blockers.join(" ") })
      const job = parsed.job
      job.name = String(job.name || "default")
      job.createdAt = new Date(now()).toISOString()
      job.lastRunAt = 0
      if (job.watchPaths?.length) job.watchSnapshot = await policy.snapshotPaths(scope.directory, job.watchPaths)
      const jobs = state.jobs || []
      if (!job.multi && jobs.some((other) => (other.name || "default") === job.name && other.v2Run)) return result({ accepted: false, error: "Pause/stop the existing in-flight job before replacing it." })
      state.jobs = job.multi ? jobs : jobs.filter((other) => (other.name || "default") !== job.name)
      state.jobs.push(job)
      await save(scope, state)
      await schedule(scope)
      return result({ accepted: true, job })
    }
    if (event.name === "loop-status" || event.name === "loop-export") {
      const status = formatOpenCode2LoopStatus(state, now())
      const text = event.name === "loop-export" ? JSON.stringify(state, null, 2) : status.text
      await options.prompt({ sessionID: scope.sessionID, text, resume: false, metadata: { opencode_loop_v2: true } })
      return result({ accepted: true, status })
    }
    if (!["loop-now", "loop-pause", "loop-resume", "loop-stop", "loop-remove", "loop-clear"].includes(event.name)) return { handled: false }
    const matches = (job, index) => event.name === "loop-clear" || matchJob(job, target, index)
    let count = 0
    for (const [index, job] of (state.jobs || []).entries()) {
      if (!matches(job, index)) continue
      count++
      if (["loop-pause", "loop-stop", "loop-remove", "loop-clear"].includes(event.name)) {
        policy.pause(job, "user-paused")
      } else if (!job.v2Run) {
        job.paused = false
        delete job.pauseReason
        if (event.name === "loop-now" || event.name === "loop-resume") job.runNowRequestedAt = Math.max(1, now())
      }
    }
    await save(scope, state)
    if (state.jobs.some((job) => job.id === scope.active?.jobID && job.paused)) await cancelPending(scope, state)
    if (["loop-stop", "loop-remove", "loop-clear"].includes(event.name)) {
      state.jobs = state.jobs.filter((job, index) => !matches(job, index))
      if (!state.jobs.length) await removeState(scope.directory, scope.sessionID)
      else await save(scope, state)
    }
    await schedule(scope)
    return result({ accepted: true, count, target })
  }

  async function onEvent(event) {
    if (disposed) return result({ reason: "disposed" })
    if (event?.kind === "server" && event.action === "disposed") { await dispose(); return result({ disposed: true }) }
    const scope = scopeFor(event)
    if (!scope) return { handled: false }
    // Hooks update these gates synchronously, even while file/host work awaits.
    if (event.kind === "foreground") {
      scope.epoch++
      scope.busy = true
      if (scope.active) scope.active.foreground = true
      clear(scope, "timer")
      return result({ reason: "foreground-admission" })
    }
    if (event.kind === "compaction" && event.action === "started") {
      scope.compaction ||= { ended: false, terminal: false }
      scope.busy = true
      clear(scope, "timer")
      return result({ reason: "compacting" })
    }
    if (event.kind === "session" && event.action === "status" && ["busy", "retry"].includes(event.status)) {
      scope.busy = true
      clear(scope, "timer")
      return result()
    }
    if (event.kind === "session" && event.action === "deleted") {
      scope.deleted = true
      clear(scope, "timer"); clear(scope, "deadline")
      scopes.delete(scope.key)
      return result({ disposedScope: true })
    }
    return enqueue(scope, async () => {
      if (event.kind === "command" && event.action === "executed") return command(scope, event)
      if (event.kind === "inbox") {
        if (scope.active?.inboxID === event.inboxID || scope.active?.id === event.inboxID) {
          if (event.action === "delivered") scope.active.delivered = true
          if (event.action === "cancelled") return pauseActive(scope, "inbox-cancelled", false)
        }
        return result()
      }
      if (event.kind === "shell" && event.action === "ended" && scope.active?.shellID === event.shellID) {
        scope.active.shellFinished = true
        scope.busy = false
        if (event.status !== "exited" || event.code !== 0) return pauseActive(scope, "shell-failed")
        return finish(scope)
      }
      if ((event.kind === "session" && ["error", "failed", "interrupted"].includes(event.action)) || (event.kind === "compaction" && event.action === "failed")) {
        delete scope.compaction
        scope.busy = false
        return pauseActive(scope, event.reason || `${event.kind}-${event.action}`)
      }
      if (event.kind === "compaction" && event.action === "ended") {
        scope.compaction ||= { ended: false, terminal: false }
        scope.compaction.ended = true
        if (["compact", "cadence"].includes(scope.active?.kind)) scope.active.compactFinished = true
        if (!scope.compaction.terminal) return result({ reason: "awaiting-execution-terminal" })
      } else if (event.kind === "session" && event.action === "idle") {
        if (scope.compaction) { scope.compaction.terminal = true; if (!scope.compaction.ended) return result({ reason: "awaiting-compaction-end" }) }
      } else if (event.kind === "session" && event.action === "status" && event.status === "idle") {
        if (scope.active || scope.compaction) return result({ reason: "awaiting-execution-terminal" })
      } else return { handled: false }
      delete scope.compaction
      scope.busy = false
      return scope.active ? finish(scope) : advance(scope)
    })
  }

  async function wake(event) {
    const scope = scopeFor(event)
    return scope ? enqueue(scope, () => advance(scope)) : { handled: false }
  }
  async function dispose() {
    if (disposed) return false
    disposed = true
    for (const scope of scopes.values()) { clear(scope, "timer"); clear(scope, "deadline") }
    await Promise.allSettled([...scopes.values()].map((scope) => scope.queue))
    scopes.clear()
    return true
  }
  return Object.freeze({ onEvent, wake, dispose, scheduledCount: () => [...scopes.values()].filter((scope) => scope.timer !== undefined).length })
}
