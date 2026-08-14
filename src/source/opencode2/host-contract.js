import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_HOST_CONTRACT = "experimental"

export function createOpenCode2HostContract(options = {}) {
  const bridge = createOpenCode2EventBridge({
    directory: options.directory,
    onEvent: options.onEvent,
    onError: options.onError,
  })
  let started = false
  let disposed = false

  async function start() {
    if (disposed) throw new Error("OpenCode 2 host contract is disposed")
    if (started) return false
    if (typeof options.subscribe !== "function") throw new TypeError("subscribe must be a function")
    if (typeof options.sendPrompt !== "function") throw new TypeError("sendPrompt must be a function")
    await bridge.attach(options.subscribe)
    started = true
    return true
  }

  async function prompt(input) {
    if (disposed) throw new Error("OpenCode 2 host contract is disposed")
    if (!started) throw new Error("OpenCode 2 host contract is not started")
    return await options.sendPrompt(input)
  }

  async function dispose(reason = "host-contract-disposed") {
    if (disposed) return false
    disposed = true
    await bridge.dispose(reason)
    return true
  }

  return Object.freeze({
    start,
    prompt,
    dispose,
    runtimeManager: bridge.runtimeManager,
    isStarted: () => started,
    isDisposed: () => disposed,
  })
}
