import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeOpenCode2Model(value) {
  if (!value) return undefined
  if (typeof value === "string") {
    const input = value.trim()
    const split = input.indexOf("/")
    if (split <= 0 || split === input.length - 1) return undefined
    return Object.freeze({ providerID: input.slice(0, split), modelID: input.slice(split + 1) })
  }
  if (typeof value !== "object") return undefined
  const providerID = text(value.providerID)
  const modelID = text(value.modelID) || text(value.id)
  if (!providerID || !modelID) return undefined
  return Object.freeze({ providerID, modelID })
}

export function openCode2PromptInput(request) {
  const sessionID = text(request?.sessionID)
  const promptText = typeof request?.text === "string" ? request.text : ""
  if (!sessionID) throw new TypeError("OpenCode 2 prompt requires a session ID")
  if (!promptText.trim()) throw new TypeError("OpenCode 2 prompt requires text")

  const body = {
    parts: [{ type: "text", text: promptText }],
  }
  if (request?.noReply === true) body.noReply = true
  const agent = text(request?.agent)
  if (agent) body.agent = agent
  const model = normalizeOpenCode2Model(request?.model)
  if (model) body.model = model

  return Object.freeze({
    path: Object.freeze({ id: sessionID }),
    body: Object.freeze(body),
  })
}

export function createOpenCode2Adapter(ctx, options = {}) {
  const capabilities = inspectOpenCode2Context(ctx)
  if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event.subscribe capability is unavailable")
  if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session.prompt capability is unavailable")

  const subscribe = ctx.event.subscribe.bind(ctx.event)
  const host = createOpenCode2HostContract({
    directory: options.directory,
    subscribe,
    sendPrompt: async (request) => await ctx.session.prompt(openCode2PromptInput(request)),
    onEvent: options.onEvent,
    onError: options.onError,
  })

  return Object.freeze({
    start: () => host.start(),
    prompt: (input) => host.prompt(input),
    dispose: (reason) => host.dispose(reason),
    runtimeManager: host.runtimeManager,
    host,
  })
}
