export const DEFAULT_SESSION_STALE_MS = 12 * 60 * 60 * 1000

function sessionKey(sessionID) {
  return String(sessionID || "").trim()
}

export function createSessionRegistry({ now = Date.now, staleAfterMs = DEFAULT_SESSION_STALE_MS } = {}) {
  if (typeof now !== "function") throw new TypeError("session registry requires a clock function")
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError("session registry requires a non-negative staleAfterMs")

  const sessions = new Map()

  function observeExternal(sessionID, runtime) {
    const key = sessionKey(sessionID)
    if (!key) throw new TypeError("session registry requires a session ID")
    const seenAt = Number(now())
    if (!Number.isFinite(seenAt)) throw new TypeError("session registry clock must return a finite number")
    const entry = Object.freeze({ sessionID: key, runtime, seenAt })
    sessions.set(key, entry)
    return entry
  }

  function peek(sessionID) {
    return sessions.get(sessionKey(sessionID))
  }

  function remove(sessionID, expectedRuntime) {
    const key = sessionKey(sessionID)
    const current = sessions.get(key)
    if (!current) return false
    if (arguments.length > 1 && current.runtime !== expectedRuntime) return false
    return sessions.delete(key)
  }

  function pruneStale(at = now()) {
    const timestamp = Number(at)
    if (!Number.isFinite(timestamp)) throw new TypeError("session registry prune time must be finite")
    const removed = []
    for (const [key, entry] of sessions) {
      if (timestamp - entry.seenAt < staleAfterMs) continue
      sessions.delete(key)
      removed.push(key)
    }
    return removed
  }

  function entries() {
    return [...sessions.values()]
  }

  return Object.freeze({
    observeExternal,
    peek,
    remove,
    pruneStale,
    entries,
  })
}
