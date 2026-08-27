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

function settledAssistantCompletion(value) {
  return value === "completed" || value === "empty"
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
    let attempted = false
    for (const args of argsList) {
      attempted = true
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
    return attempted ? { type: "unknown", source: "sdk-error" } : undefined
  }

  async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
    if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
    if (!options.requireIdle && !options.forceStale) return true

    const completion = options.forceStale
      ? await activeRunCompletionFromMessages(directory, client, sessionID, active)
      : undefined
    if (settledAssistantCompletion(completion)) return true
    if (!options.requireIdle) return completion === "unknown" && staleActiveRun(sessionID)

    const cached = sessionStatuses.get(sessionID)
    const seenAt = sessionStatusSeenAt.get(sessionID) || 0
    const cachedIdleAfterRun = cached === "idle" && seenAt > (active.startedAt || 0)
    const live = await readLiveSessionStatus(client, sessionID, directory)
    if (live?.type === "idle") return true
    if (live?.type === "unknown" && cachedIdleAfterRun) {
      // A concrete idle observed after this active run is sufficient to finalize
      // that run even if a later status read fails. This does not authorize a
      // new prompt by itself; admission applies its own current status policy.
      return true
    }
    if (live?.type) {
      if (live.type === "busy" && options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
      return false
    }

    if (options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
    return cachedIdleAfterRun
  }

  async function recoverCompletedTailWithoutActiveRun(directory, client, sessionID, liveType, seenAt) {
    if (activeRuns.has(sessionID)) return false
    if (liveType !== "busy") return false
    if (!seenAt || now() - seenAt < sessionStatusCacheMs) return false
    const completion = await activeRunCompletionFromMessages(directory, client, sessionID, { startedAt: 0 })
    if (!settledAssistantCompletion(completion)) return false
    markSessionStatus(sessionID, "idle")
    await appendLoopLog(directory, "status-message-idle-recovery", {
      sessionID,
      staleStatus: liveType,
      statusSeenAt: seenAt,
      staleForMs: Math.max(0, now() - seenAt),
    })
    return true
  }

  async function sessionStatusType(client, sessionID, directory, options = {}) {
    if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) {
      markSessionStatus(sessionID, "busy")
      return "busy"
    }

    const cached = sessionStatuses.get(sessionID)
    const seenAt = sessionStatusSeenAt.get(sessionID) || 0
    if (cached === "idle") return cached
    if (cached && now() - seenAt < sessionStatusCacheMs) return cached

    const live = await readLiveSessionStatus(client, sessionID, directory)
    if (live?.type === "unknown") {
      const conservative = cached === "retry" ? "retry" : "busy"
      markSessionStatus(sessionID, conservative)
      return conservative
    }
    if (live?.type) {
      if (await recoverCompletedTailWithoutActiveRun(directory, client, sessionID, live.type, seenAt)) return "idle"

      if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false) {
        const active = activeRuns.get(sessionID)
        if (active) {
          const completion = await activeRunCompletionFromMessages(directory, client, sessionID, active)
          if (settledAssistantCompletion(completion) || (live.type === "busy" && completion === "unknown" && staleActiveRun(sessionID))) {
            markSessionStatus(sessionID, "idle")
            const logDetails = {
              sessionID,
              job: active.job?.name || active.jobId,
              startedAt: active.startedAt,
              ...(completion === "completed" ? {} : { staleStatus: live.type }),
            }
            const recoveryEvent = completion === "empty"
              ? "status-message-empty-recovery"
              : completion === "completed"
                ? "status-message-complete-recovery"
                : "status-stale-recovery"
            await appendLoopLog(directory, recoveryEvent, logDetails)
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
    activeRunCompletion: activeRunCompletionFromMessages,
    sessionStatusType,
    sessionIsIdle,
  }
}
