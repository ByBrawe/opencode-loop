import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"

function promptRequest(request) {
  return {
    sessionID: request.sessionID,
    text: request.text,
  }
}

function commandRequest(request) {
  const value = {
    sessionID: request.sessionID,
    command: request.command,
  }
  if (request.arguments !== undefined) value.arguments = request.arguments
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

  const host = createOpenCode2HostContract({
    directory: options.directory,
    subscribe: () => ctx.event.subscribe(),
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
