const UNAVAILABLE = "OpenCode Loop\n! Server Loop status unavailable"

// No local filesystem imports: this controller is equally safe against local
// and remote servers, and it keeps exactly one request in flight per mounted
// panel instead of one per host event.
export function createLoopStatusController(options) {
  const pollMs = Math.max(250, options.pollMs ?? 2000)
  const timeoutMs = Math.max(10, options.timeoutMs ?? 5000)
  let selected
  let version = 0
  let closed = false
  let dirty = false
  let timer
  let active

  const clearTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const show = (text) => {
    if (!closed) options.publish(text)
  }

  function refresh() {
    if (closed || !selected) return Promise.resolve()
    if (active?.version === version) {
      dirty = true
      return active.task
    }
    clearTimer()
    const snapshot = selected
    const generation = version
    const abort = new AbortController()
    let deadline
    let rejectAbort
    const cancelled = new Promise((_resolve, reject) => {
      rejectAbort = () => reject(new Error("Loop status request cancelled"))
      abort.signal.addEventListener("abort", rejectAbort, { once: true })
    })

    const task = Promise.resolve().then(async () => {
      // select()/dispose() may already have run before this microtask starts.
      if (closed || generation !== version) abort.abort()
      deadline = setTimeout(() => abort.abort(), timeoutMs)
      deadline.unref?.()
      try {
        const payload = await Promise.race([
          Promise.resolve().then(() => {
            if (abort.signal.aborted) throw new Error("Loop status request cancelled")
            return options.read({ sessionID: snapshot.sessionID }, { location: snapshot.location, signal: abort.signal })
          }),
          cancelled,
        ])
        if (closed || generation !== version || abort.signal.aborted) return
        const value = payload
        if (
          !value ||
          value.schemaVersion !== 1 ||
          value.sessionID !== snapshot.sessionID ||
          value.directory !== snapshot.location.directory ||
          typeof value.text !== "string" ||
          value.text.length > 4096
        ) {
          throw new Error("Mismatched Loop status response")
        }
        show(value.text)
      } catch {
        if (!closed && generation === version) show(UNAVAILABLE)
      } finally {
        clearTimeout(deadline)
        if (rejectAbort) abort.signal.removeEventListener("abort", rejectAbort)
        if (active?.version === generation) active = undefined
        if (!closed && generation === version) {
          timer = setTimeout(() => {
            timer = undefined
            void refresh()
          }, dirty ? 100 : pollMs)
          timer.unref?.()
          dirty = false
        }
      }
    })

    active = { version: generation, abort, task }
    return task
  }

  function select(sessionID, location) {
    if (closed) return Promise.resolve()
    const valid =
      typeof sessionID === "string" &&
      sessionID.length > 0 &&
      sessionID.length <= 256 &&
      typeof location?.directory === "string" &&
      location.directory.length > 0 &&
      (location.workspaceID === undefined || typeof location.workspaceID === "string")
    const next = valid
      ? {
          sessionID,
          location: {
            directory: location.directory,
            ...(location.workspaceID !== undefined ? { workspaceID: location.workspaceID } : {}),
          },
          key: JSON.stringify([sessionID, location.directory, location.workspaceID]),
        }
      : undefined
    if (next && next.key === selected?.key) return active?.task ?? Promise.resolve()
    version++
    active?.abort.abort()
    active = undefined
    clearTimer()
    dirty = false
    selected = next
    show(next ? "OpenCode Loop\nLoading server status..." : "OpenCode Loop\n! Session location unavailable")
    return refresh()
  }

  function invalidate(sessionID) {
    if (!selected || (sessionID && sessionID !== selected.sessionID)) return
    // A busy event stream must not open a parallel RPC or reset the timeout.
    if (active?.version === version) {
      dirty = true
      return
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, 100)
      timer.unref?.()
    }
  }

  function dispose() {
    if (closed) return
    closed = true
    version++
    clearTimer()
    active?.abort.abort()
    active = undefined
    selected = undefined
  }

  return { select, refresh, invalidate, dispose }
}

export default createLoopStatusController