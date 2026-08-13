import { createRuntimeScope } from "./scope.js"
import { createRuntimeTimers } from "./timers.js"

export function createRuntimeHeartbeat({
  manager,
  timerAPI = globalThis,
  intervalMs = 2_500,
  onSession = async () => {},
  onError = () => {},
} = {}) {
  if (!manager || typeof manager.entries !== "function" || typeof manager.pruneStale !== "function") {
    throw new TypeError("runtime heartbeat requires a session manager")
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError("runtime heartbeat requires a non-negative intervalMs")

  const scope = createRuntimeScope()
  const timers = createRuntimeTimers(scope, timerAPI)
  const running = new Set()
  let timer

  async function visit(entry) {
    const runtime = entry?.runtime
    if (!runtime?.scope?.isActive?.() || running.has(runtime)) return false
    running.add(runtime)
    try {
      await onSession(entry)
      return true
    } finally {
      running.delete(runtime)
    }
  }

  async function tick(at) {
    if (!scope.isActive()) return { removed: [], visited: 0 }
    const removed = manager.pruneStale(at)
    const results = await Promise.all(manager.entries().map(visit))
    return { removed, visited: results.filter(Boolean).length }
  }

  function start() {
    if (!scope.isActive() || timer) return false
    timer = timers.interval(() => {
      Promise.resolve(tick()).catch((error) => onError(error))
    }, intervalMs, { ref: false })
    return Boolean(timer)
  }

  function stop() {
    if (!timer) return false
    const current = timer
    timer = undefined
    return current.cancel()
  }

  function dispose(reason) {
    if (!scope.isActive()) return false
    stop()
    return scope.dispose(reason)
  }

  return Object.freeze({ tick, start, stop, dispose, signal: scope.signal })
}
