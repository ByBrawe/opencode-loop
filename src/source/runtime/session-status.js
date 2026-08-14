import { now as defaultNow } from "../core/args.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { sdkData, sdkError } from "../opencode/sdk.js"
import { activeRunCompletionFromMessages as defaultActiveRunCompletionFromMessages } from "../opencode/host.js"
import {
  sessionParents,
  sessionStatuses,
  sessionStatusSeenAt,
  hasActiveToolCalls,
  isDescendantSession,
  hasBusyDescendant,
} from "./session-activity.js"

const DEFAULT_STALE_ACTIVE_RECOVERY_MS = 45_000
const DEFAULT_SESSION_STATUS_CACHE_MS = 1_500

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function createSessionStatusRuntime(options = {}) {
  const activeRuns = options.activeRuns
  if (!(activeRuns instanceof Map)) throw new TypeError("createSessionStatusRuntime requires activeRuns Map")
  const now = typeof options.now === "function" ? options.now : defaultNow
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const activeRunCompletionFromMessages = typeof options.activeRunCompletionFromMessages === "function"
    ? options.activeRunCompletionFromMessages
    : defaultActiveRunCompletionFromMessages
  const staleActiveRecoveryMs = positiveNumber(options.staleActiveRecoveryMs, DEFAULT_STALE_ACTIVE_RECOVERY_MS)
  const sessionStatusCacheMs = nonNegativeNumber(options.sessionStatusCacheMs, DEFAULT_SESSION_STATUS_CACHE_MS)

  function markSessionStatus(sessionID, type, observedAt = now()) {
    if (typeof sessionID !== "string" || typeof type !== "string") return false
    sessionStatuses.set(sessionID, type)
    sessionStatusSeenAt.set(sessionID, observedAt)
    return true
  }

  function clearSessionStatus(sessionID) {
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
  }

  function updateSessionStatusFromEvent(event) {
    const sessionID = event?.properties?.sessionID
    if (typeof sessionID !== "string") return undefined
    if (event?.type === "session.idle") {
      markSessionStatus(sessionID, "idle")
      return { sessionID, idle: true }
    }
    if (event?.type === "session.status") {
      const status = event?.properties?.status
      const type = status && typeof status === "object" ? status.type : undefined
      if (typeof type === "string") markSessionStatus(sessionID, type)
      return { sessionID, idle: type === "idle" }
    }
    return undefined
  }

  function staleActiveRun(sessionID) {
    const active = activeRuns.get(sessionID)
    if (!active) return false
    const age = now() - (active.startedAt || 0)
    const configured = Number(active.job?.staleActiveRecoveryMs || active.job?.activeRecoveryMs || 0)
    const threshold = Number.isFinite(configured) && configured > 0 ? configured : staleActiveRecoveryMs
    return age >= threshold
  }

  async function readLiveSessionStatus(client, sessionID, directory) {
    const statusMethod = client?.session?.status
    if (typeof statusMethod !== "function") return undefined
    const argsList = []
    if (directory) argsList.push({ query: { directory } }, { directory }, { workspace: directory })
    argsList.push({})
    for (const args of argsList) {
      try {
        const result = await statusMethod.call(client.session, args)
        const error = sdkError(result)
        if (error) continue
        const data = sdkData(result)
        if (!data || typeof data !== "object" || Array.isArray(data)) continue
        const observedAt = now()
        for (const [observedSessionID, observedStatus] of Object.entries(data)) {
          const observedType = observedStatus && typeof observedStatus === "object" ? observedStatus.type : undefined
          if (typeof observedType !== "string") continue
          markSessionStatus(observedSessionID, observedType, observedAt)
        }
        // OpenCode's status list contains active sessions; idle sessions are
        // normally omitted. Clear a completed descendant that was previously busy.
        for (const childID of sessionParents.keys()) {
          if (!isDescendantSession(childID, sessionID) || data[childID]) continue
          markSessionStatus(childID, "idle", observedAt)
        }
        if (hasBusyDescendant(sessionID)) return { type: "busy", source: "descendant" }
        const status = data?.[sessionID]
        const type = status && typeof status === "object" ? status.type : undefined
        if (typeof type === "string") return { type, source: "sdk" }
        return { type: "idle", source: "sdk" }
      } catch {}
    }
    return undefined
  }

  async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
    if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
    if (!options.requireIdle && !options.forceStale) return true

    const completion = options.forceStale
      ? await activeRunCompletionFromMessages(directory, client, sessionID, active)
      : undefined
    if (completion === "completed") return true
    if (!options.requireIdle) return completion === "unknown" && staleActiveRun(sessionID)

    const live = await readLiveSessionStatus(client, sessionID, directory)
    if (live?.type === "idle") return true
    if (live?.type) {
      if ((live.type === "busy" || live.type === "retry") && options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
      return false
    }

    if (options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
    const cached = sessionStatuses.get(sessionID)
    const seenAt = sessionStatusSeenAt.get(sessionID) || 0
    return cached === "idle" && seenAt > (active.startedAt || 0)
  }

  async function sessionStatusType(client, sessionID, directory, options = {}) {
    // OpenCode can briefly report an idle session while a long-running tool or
    // subtask is still executing. Tool lifecycle hooks are the more specific
    // signal here, so never enqueue another turn until every active call ends.
    if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) {
      markSessionStatus(sessionID, "busy")
      return "busy"
    }

    const cached = sessionStatuses.get(sessionID)
    const seenAt = sessionStatusSeenAt.get(sessionID) || 0

    // Idle is safe to trust until OpenCode tells us otherwise. Busy/retry is only
    // trusted briefly: OpenCode custom commands such as /loop-status create their
    // own short assistant turn, and some TUI builds do not always emit the final
    // idle event after that turn. If we cache busy forever, due loop work can get
    // stuck at "due in every idle" until the user types another command.
    if (cached === "idle") return cached
    if (cached && now() - seenAt < sessionStatusCacheMs) return cached

    const live = await readLiveSessionStatus(client, sessionID, directory)
    if (live?.type) {
      // Some OpenCode 1.15.x TUI builds can leave session.status at busy after a
      // plugin-injected turn until the next user command touches the session.
      // When the only reason we still think the session is busy is our own stale
      // active-run guard, recover instead of waiting for another manual command.
      if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false) {
        const active = activeRuns.get(sessionID)
        if (active) {
          const completion = await activeRunCompletionFromMessages(directory, client, sessionID, active)
          if (completion === "completed" || (completion === "unknown" && staleActiveRun(sessionID))) {
            markSessionStatus(sessionID, "idle")
            await appendLoopLog(directory, completion === "completed" ? "status-message-complete-recovery" : "status-stale-recovery", {
              sessionID,
              job: active.job?.name || active.jobId,
              startedAt: active.startedAt,
            })
            return "idle"
          }
        }
      }
      markSessionStatus(sessionID, live.type)
      return live.type
    }

    const fallback = activeRuns.has(sessionID) && !staleActiveRun(sessionID) ? "busy" : "idle"
    markSessionStatus(sessionID, fallback)
    return fallback
  }

  async function sessionIsIdle(client, sessionID, directory, options = {}) {
    return await sessionStatusType(client, sessionID, directory, options) === "idle"
  }

  return {
    markSessionStatus,
    clearSessionStatus,
    updateSessionStatusFromEvent,
    staleActiveRun,
    canFinalizeActiveRun,
    readLiveSessionStatus,
    sessionStatusType,
    sessionIsIdle,
  }
}
