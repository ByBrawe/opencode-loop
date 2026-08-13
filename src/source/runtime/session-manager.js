import { DEFAULT_SESSION_STALE_MS, createSessionRegistry } from "./session-registry.js"
import { createRuntimeScope } from "./scope.js"
import { createRuntimeTimers } from "./timers.js"

function createSessionRuntime(sessionID, timerAPI) {
  const scope = createRuntimeScope()
  return Object.freeze({
    sessionID,
    scope,
    timers: createRuntimeTimers(scope, timerAPI),
    dispose: (reason) => scope.dispose(reason),
  })
}

export function createSessionRuntimeManager({
  now = Date.now,
  staleAfterMs = DEFAULT_SESSION_STALE_MS,
  timerAPI = globalThis,
} = {}) {
  const registry = createSessionRegistry({ now, staleAfterMs })
  let disposed = false

  function observeExternal(sessionID) {
    if (disposed) throw new Error("session runtime manager is disposed")
    const current = registry.peek(sessionID)
    const runtime = current?.runtime?.scope?.isActive?.()
      ? current.runtime
      : createSessionRuntime(String(sessionID || "").trim(), timerAPI)
    registry.observeExternal(sessionID, runtime)
    return runtime
  }

  function peek(sessionID) {
    return registry.peek(sessionID)?.runtime
  }

  function entries() {
    return registry.entries()
  }

  function remove(sessionID, { expectedRuntime, reason } = {}) {
    const current = registry.peek(sessionID)
    if (!current) return false
    if (expectedRuntime !== undefined && current.runtime !== expectedRuntime) return false
    if (!registry.remove(sessionID, current.runtime)) return false
    current.runtime.dispose(reason)
    return true
  }

  function pruneStale(at = now()) {
    const before = new Map(registry.entries().map((entry) => [entry.sessionID, entry.runtime]))
    const removed = registry.pruneStale(at)
    const errors = []
    for (const sessionID of removed) {
      try {
        before.get(sessionID)?.dispose("stale-session")
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "stale session cleanup failed")
    return removed
  }

  function dispose(reason) {
    if (disposed) return false
    disposed = true
    const errors = []
    for (const entry of registry.entries()) {
      registry.remove(entry.sessionID, entry.runtime)
      try {
        entry.runtime.dispose(reason)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "session runtime manager cleanup failed")
    return true
  }

  return Object.freeze({
    observeExternal,
    peek,
    entries,
    remove,
    pruneStale,
    dispose,
  })
}
