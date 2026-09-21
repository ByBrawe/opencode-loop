import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"

function promptRequest(request) {
  const value = {
    sessionID: request.sessionID,
  }
  if (request.noReply === true) {
    // beta hosts understood noReply+parts; OpenCode 2.0.11 uses the ordinary
    // prompt shape and resume=false for a durable non-running message.
    value.noReply = true
    value.parts = [{ type: "text", text: request.text }]
    value.text = request.text
    value.resume = false
  } else {
    value.text = request.text
  }
  if (request.agent !== undefined) value.agent = request.agent
  if (request.model !== undefined) value.model = request.model
  return value
}

function commandRequest(request) {
  const value = {
    sessionID: request.sessionID,
    // OpenCode 2.0.11 calls this field name; earlier beta clients called it command.
    name: request.command,
    command: request.command,
  }
  if (request.arguments !== undefined) {
    value.arguments = request.arguments
    value.text = request.arguments
  }
  if (request.agent !== undefined) value.agent = request.agent
  if (request.model !== undefined) value.model = request.model
  if (request.delivery !== undefined) value.delivery = request.delivery
  if (request.resume !== undefined) value.resume = request.resume
  return value
}

export function createOpenCode2RuntimeAdapter(ctx, options = {}) {
  const capabilities = inspectOpenCode2Context(ctx)
  if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event.subscribe capability is unavailable")
  if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session.prompt capability is unavailable")

  const subscribe = options.eventSubscribeStyle === "stream"
    ? () => ctx.event.subscribe()
    : ctx.event.subscribe.bind(ctx.event)

  const host = createOpenCode2HostContract({
    directory: options.directory,
    subscribe,
    sendPrompt: (request) => ctx.session.prompt(promptRequest(request)),
    sendCommand: capabilities.sessionCommand ? (request) => ctx.session.command(commandRequest(request)) : undefined,
    onEvent: options.onEvent,
    onError: options.onError,
  })

  return Object.freeze({
    start: () => host.start(),
    prompt: (request) => host.prompt(request),
    command: (request) => host.command(request),
    dispose: (reason = "runtime-adapter-disposed") => host.dispose(reason),
    runtimeManager: host.runtimeManager,
    isStarted: host.isStarted,
    isDisposed: host.isDisposed,
    isHostDisposed: host.isHostDisposed,
  })
}
