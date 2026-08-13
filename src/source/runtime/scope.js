export function createRuntimeScope() {
  const controller = new AbortController()
  const cleanups = new Set()
  let disposed = false

  function track(cleanup) {
    if (typeof cleanup !== "function") throw new TypeError("runtime scope cleanup must be a function")
    if (disposed) {
      cleanup()
      return () => false
    }

    const entry = { cleanup }
    cleanups.add(entry)
    let tracked = true
    return () => {
      if (!tracked) return false
      tracked = false
      return cleanups.delete(entry)
    }
  }

  function guard(callback) {
    if (typeof callback !== "function") throw new TypeError("runtime scope guard requires a function")
    return function (...args) {
      if (disposed) return undefined
      return callback.apply(this, args)
    }
  }

  function dispose(reason) {
    if (disposed) return false
    disposed = true
    controller.abort(reason)

    const errors = []
    for (const entry of [...cleanups].reverse()) {
      cleanups.delete(entry)
      try {
        entry.cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "runtime scope cleanup failed")
    return true
  }

  return Object.freeze({
    signal: controller.signal,
    isActive: () => !disposed,
    track,
    guard,
    dispose,
  })
}
