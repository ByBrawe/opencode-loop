import { DEFAULT_SESSION_STALE_MS, createSessionRegistry } from "./session-registry.js"
import { createRuntimeScope } from "./scope.js"
import { createRuntimeTimers } from "./timers.js"

function defaultRuntimeFactory({ sessionID, timerAPI }) {
  const scope = createRuntimeScope()
  return Object.freeze({
    sessionID,
    scope,
    timers: createRuntimeTimers(scope, timerAPI),
    dispose: (reason) => scope.dispose(reason),
  })
}

function validateRuntime(runtime, sessionID) {
  if (!runtime || runtime.sessionID !== sessionID) throw new TypeError("session runtime factory must preserve the session ID")
  if (typeof runtime?.scope?.isActive !== "function") throw new TypeError("session runtime factory must provide an active scope")
  if (typeof runtime.dispose !== "function") throw new TypeError("session runtime factory must provide dispose()")
  return runtime
}

export function createSessionRuntimeManager({
  now = Date.now,
  staleAfterMs = DEFAULT_SESSION_STALE_MS,
  timerAPI = globalThis,
  runtimeFactory = defaultRuntimeFactory,
} = {}) {
  if (typeof runtimeFactory !== "function") throw new TypeError("session runtime manager requires a runtime factory")
  const registry = createSessionRegistry({ now, staleAfterMs })
  let disposed = false

  function observeExternal(sessionID) {
    if (disposed) throw new Error("session runtime manager is disposed")
    const key = String(sessionID || "").trim()
    if (!key) throw new TypeError("session runtime manager requires a session ID")
    const current = registry.peek(key)
    const runtime = current?.runtime?.scope?.isActive?.()
      ? current.runtime
      : validateRuntime(runtimeFactory({ sessionID: key, timerAPI }), key)
    registry.observeExternal(key, runtime)
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
