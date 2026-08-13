function createOwnedTimer(scope, callback, delay, repeat, api, ref) {
  if (!scope?.isActive?.()) return undefined
  let active = true
  let release
  let handle

  const invoke = scope.guard((...args) => {
    if (!active) return
    if (!repeat) {
      active = false
      release?.()
    }
    callback(...args)
  })

  handle = repeat ? api.setInterval(invoke, delay) : api.setTimeout(invoke, delay)
  release = scope.track(() => {
    if (repeat) api.clearInterval(handle)
    else api.clearTimeout(handle)
  })
  if (!ref) handle?.unref?.()

  return Object.freeze({
    handle,
    cancel() {
      if (!active) return false
      active = false
      if (repeat) api.clearInterval(handle)
      else api.clearTimeout(handle)
      release()
      return true
    },
  })
}

export function createRuntimeTimers(scope, api = globalThis) {
  return Object.freeze({
    timeout(callback, delay, options = {}) {
      return createOwnedTimer(scope, callback, delay, false, api, options.ref !== false)
    },
    interval(callback, delay, options = {}) {
      return createOwnedTimer(scope, callback, delay, true, api, options.ref !== false)
    },
  })
}
