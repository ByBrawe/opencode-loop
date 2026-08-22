const DEFAULT_DEFERRAL_LOG_THROTTLE_MS = 30_000

export function createSchedulerDiagnostics(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : async () => {}
  const configured = Number(options.throttleMs)
  const throttleMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_DEFERRAL_LOG_THROTTLE_MS
  const lastLogged = new Map()

  async function logDeferral(directory, sessionID, reason, extra = {}) {
    const key = `${sessionID || "unknown"}:${reason || "deferred"}:${extra.source || "runtime"}`
    const current = now()
    const previous = Number(lastLogged.get(key) || 0)
    if (previous > 0 && current - previous < throttleMs) return false
    lastLogged.set(key, current)
    await appendLoopLog(directory, "deferred", {
      sessionID,
      reason,
      ...extra,
    })
    return true
  }

  function clearSession(sessionID) {
    const prefix = `${sessionID || "unknown"}:`
    for (const key of lastLogged.keys()) if (key.startsWith(prefix)) lastLogged.delete(key)
  }

  return { logDeferral, clearSession }
}
