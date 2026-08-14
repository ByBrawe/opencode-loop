import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"
import { createOpenCode2PromptRuntime } from "./prompt-runtime.js"

function promptRequest(request) {
  return {
    sessionID: request.sessionID,
    text: request.text,
  }
}

export function createOpenCode2RuntimeAdapter(ctx, options = {}) {
  const capabilities = inspectOpenCode2Context(ctx)
  if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event.subscribe capability is unavailable")
  if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session.prompt capability is unavailable")

  let host
  const promptRuntime = createOpenCode2PromptRuntime({
    prompt: (request) => host.prompt(request),
  })
  const externalOnEvent = typeof options.onEvent === "function" ? options.onEvent : undefined

  host = createOpenCode2HostContract({
    directory: options.directory,
    subscribe: () => ctx.event.subscribe(),
    sendPrompt: (request) => ctx.session.prompt(promptRequest(request)),
    onEvent: async (event, runtime) => {
      await promptRuntime.onEvent(event)
      if (externalOnEvent) await externalOnEvent(event, runtime)
    },
    onError: options.onError,
  })

  return Object.freeze({
    start: () => host.start(),
    prompt: (request) => host.prompt(request),
    dispose: (reason = "runtime-adapter-disposed") => host.dispose(reason),
    promptRuntime,
    runtimeManager: host.runtimeManager,
    isStarted: host.isStarted,
    isDisposed: host.isDisposed,
    isHostDisposed: host.isHostDisposed,
  })
}
