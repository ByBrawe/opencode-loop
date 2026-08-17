import { normalizeOpenCodeEvent } from "../runtime/events.js"
import { createSessionRuntimeManager } from "../runtime/session-manager.js"
import { normalizeOpenCode2NativeEvent } from "./events.js"

function cleanupRegistration(registration) {
  if (typeof registration === "function") return registration
  if (!registration || typeof registration !== "object") return undefined
  for (const key of ["dispose", "unsubscribe", "close"]) {
    if (typeof registration[key] === "function") return registration[key].bind(registration)
  }
  return undefined
}

function eventStream(registration) {
  const stream = registration?.stream ?? registration
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new TypeError("OpenCode 2 event subscribe must return an async event stream")
  }
  return stream
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
  let iterator
  let iteratorClosed = false
  let pump
  let attached = false
  let stopped = false
  let disposed = false
  let managerDisposed = false
  let queue = Promise.resolve()
  const sessionDirectories = new Map()

  function report(error) {
    try { onError(error) } catch {}
  }

  function disposeManager(reason) {
    if (managerDisposed) return false
    managerDisposed = true
    return runtimeManager.dispose(reason)
  }

  async function closeIterator() {
    if (iteratorClosed) return false
    iteratorClosed = true
    const current = iterator
    iterator = undefined
    if (typeof current?.return === "function") await current.return()
    return Boolean(current)
  }

  function normalize(raw) {
    const current = normalizeOpenCode2NativeEvent(raw) || normalizeOpenCodeEvent(raw)
    if (!current) return undefined
    const sessionID = current.sessionID
    const rememberedDirectory = sessionID ? sessionDirectories.get(sessionID) : undefined
    const eventDirectory = current.directory || rememberedDirectory || directory
    const event = eventDirectory === current.directory
      ? current
      : Object.freeze({ ...current, directory: eventDirectory })
    if (sessionID && event.directory) sessionDirectories.set(sessionID, event.directory)
    return event
  }

  async function process(raw) {
    if (stopped) return undefined
    const event = normalize(raw)
    if (!event || !sameDirectory(directory, event.directory)) return undefined

    const runtime = event.sessionID ? runtimeManager.observeExternal(event.sessionID) : undefined
    await onEvent(event, runtime)

    if (event.kind === "session" && event.action === "deleted") {
      sessionDirectories.delete(event.sessionID)
      runtimeManager.remove(event.sessionID, { expectedRuntime: runtime, reason: "session-deleted" })
    }

    if (event.kind === "server" && event.action === "disposed") {
      stopped = true
      sessionDirectories.clear()
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

  function callback(raw) {
    const pending = dispatch(raw)
    pending.catch(report)
    return pending.catch(() => undefined)
  }

  async function consume(stream) {
    const current = stream[Symbol.asyncIterator]()
    iterator = current
    iteratorClosed = false
    try {
      while (!stopped) {
        const next = await current.next()
        if (next?.done) break
        await dispatch(next?.value)
      }
    } catch (error) {
      if (!stopped) report(error)
    } finally {
      if (stopped && !iteratorClosed) await closeIterator().catch(() => undefined)
      if (iterator === current) iterator = undefined
    }
  }

  async function attach(subscribe) {
    if (disposed) throw new Error("OpenCode 2 event bridge is disposed")
    if (attached) throw new Error("OpenCode 2 event bridge is already attached")
    if (typeof subscribe !== "function") throw new TypeError("OpenCode 2 event bridge requires an event subscribe function")

    if (subscribe.length > 0) {
      registration = await subscribe(callback)
      attached = true
      return registration
    }

    registration = await subscribe()
    const stream = eventStream(registration)
    attached = true
    pump = consume(stream)
    return registration
  }

  async function dispose(reason = "bridge-disposed") {
    if (disposed) return false
    disposed = true
    stopped = true
    await closeIterator().catch(() => undefined)
    await pump?.catch(() => undefined)
    await queue.catch(() => undefined)

    const cleanup = cleanupRegistration(registration)
    registration = undefined
    if (cleanup) await cleanup()
    sessionDirectories.clear()
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
