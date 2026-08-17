import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_HOST_CONTRACT = "experimental"

function normalizePrompt(input) {
  const sessionID = String(input?.sessionID || "").trim()
  const text = String(input?.text || "")
  if (!sessionID) throw new TypeError("prompt requires a session ID")
  if (!text.trim()) throw new TypeError("prompt requires text")
  return Object.freeze({
    sessionID,
    text,
    agent: input?.agent,
    model: input?.model,
    noReply: input?.noReply === true,
  })
}

function normalizeCommand(input) {
  const sessionID = String(input?.sessionID || "").trim()
  const command = String(input?.command || "").trim().replace(/^\/+/, "")
  if (!sessionID) throw new TypeError("command requires a session ID")
  if (!command) throw new TypeError("command requires a command name")
  return Object.freeze({
    sessionID,
    command,
    arguments: input?.arguments === undefined ? undefined : String(input.arguments),
    agent: input?.agent,
    model: input?.model,
    delivery: input?.delivery,
    resume: input?.resume,
  })
}

export function createOpenCode2HostContract(options = {}) {
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : async () => {}
  let started = false
  let disposed = false
  let hostDisposed = false

  const bridge = createOpenCode2EventBridge({
    directory: options.directory,
    onError: options.onError,
    onEvent: async (event, runtime) => {
      if (event.kind === "server" && event.action === "disposed") hostDisposed = true
      await onEvent(event, runtime)
    },
  })

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
    if (disposed || hostDisposed) throw new Error("OpenCode 2 host contract is unavailable")
    if (!started) throw new Error("OpenCode 2 host contract is not started")
    const request = normalizePrompt(input)
    const runtime = bridge.runtimeManager.observeExternal(request.sessionID)
    return await options.sendPrompt(Object.freeze({ ...request, runtime }))
  }

  async function command(input) {
    if (disposed || hostDisposed) throw new Error("OpenCode 2 host contract is unavailable")
    if (!started) throw new Error("OpenCode 2 host contract is not started")
    if (typeof options.sendCommand !== "function") throw new Error("OpenCode 2 session.command capability is unavailable")
    const request = normalizeCommand(input)
    const runtime = bridge.runtimeManager.observeExternal(request.sessionID)
    return await options.sendCommand(Object.freeze({ ...request, runtime }))
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
    command,
    dispose,
    runtimeManager: bridge.runtimeManager,
    isStarted: () => started,
    isDisposed: () => disposed,
    isHostDisposed: () => hostDisposed,
  })
}
