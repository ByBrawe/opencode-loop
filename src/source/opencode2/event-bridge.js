import { normalizeOpenCodeEvent } from "../runtime/events.js"
import { createSessionRuntimeManager } from "../runtime/session-manager.js"

function cleanupRegistration(registration) {
  if (typeof registration === "function") return registration
  if (!registration || typeof registration !== "object") return undefined
  for (const key of ["dispose", "unsubscribe", "close"]) {
    if (typeof registration[key] === "function") return registration[key].bind(registration)
  }
  return undefined
}

function sameDirectory(expected, actual) {
  if (!expected || !actual) return true
  return String(expected) === String(actual)
}

export function createOpenCode2EventBridge({
  directory,
  onEvent = async () => {},
  onError = () => {},
  runtimeManager = createSessionRuntimeManager(),
} = {}) {
  if (typeof onEvent !== "function") throw new TypeError("OpenCode 2 event bridge requires onEvent to be a function")
  if (typeof onError !== "function") throw new TypeError("OpenCode 2 event bridge requires onError to be a function")

  let registration
  let attached = false
  let stopped = false
  let disposed = false
  let managerDisposed = false
  let queue = Promise.resolve()

  function disposeManager(reason) {
    if (managerDisposed) return false
    managerDisposed = true
    return runtimeManager.dispose(reason)
  }

  async function process(raw) {
    if (stopped) return undefined
    const event = normalizeOpenCodeEvent(raw)
    if (!event || !sameDirectory(directory, event.directory)) return undefined

    const runtime = event.sessionID ? runtimeManager.observeExternal(event.sessionID) : undefined
    await onEvent(event, runtime)

    if (event.kind === "session" && event.action === "deleted") {
      runtimeManager.remove(event.sessionID, { expectedRuntime: runtime, reason: "session-deleted" })
    }

    if (event.kind === "server" && event.action === "disposed") {
      stopped = true
      disposeManager("server-disposed")
    }

    return event
  }

  function dispatch(raw) {
    if (stopped) return Promise.resolve(undefined)
    const result = queue.then(() => process(raw))
    queue = result.catch(() => undefined)
    return result
  }

  async function attach(subscribe) {
    if (disposed) throw new Error("OpenCode 2 event bridge is disposed")
    if (attached) throw new Error("OpenCode 2 event bridge is already attached")
    if (typeof subscribe !== "function") throw new TypeError("OpenCode 2 event bridge requires an event subscribe function")
    attached = true
    registration = await subscribe((raw) => {
      const pending = dispatch(raw)
      pending.catch((error) => {
        try { onError(error) } catch {}
      })
      return pending.catch(() => undefined)
    })
    return registration
  }

  async function dispose(reason = "bridge-disposed") {
    if (disposed) return false
    disposed = true
    stopped = true
    await queue.catch(() => undefined)

    const cleanup = cleanupRegistration(registration)
    registration = undefined
    if (cleanup) await cleanup()
    disposeManager(reason)
    return true
  }

  return Object.freeze({
    attach,
    dispatch,
    dispose,
    runtimeManager,
    isAttached: () => attached,
    isDisposed: () => disposed,
  })
}
