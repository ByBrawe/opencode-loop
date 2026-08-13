import { sdkCall } from "./sdk.js"

const LOCAL_COMMAND_AGENT = "opencode-loop-local"
const sessionExecutionContexts = new Map()

export function normalizedModelRef(model) {
  if (typeof model === "string") {
    const separator = model.indexOf("/")
    if (separator > 0) return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    return undefined
  }
  const providerID = model?.providerID
  const modelID = model?.modelID || model?.id
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

export function updateSessionExecutionContext(info) {
  const sessionID = info?.sessionID || info?.id
  if (typeof sessionID !== "string") return
  const previous = sessionExecutionContexts.get(sessionID) || {}
  const candidateAgent = info?.agent || (info?.role === "assistant" ? info?.mode : undefined)
  const agent = typeof candidateAgent === "string" && candidateAgent !== LOCAL_COMMAND_AGENT
    ? candidateAgent
    : previous.agent
  const model = normalizedModelRef(info?.model) || normalizedModelRef(info) || previous.model
  sessionExecutionContexts.set(sessionID, { agent, model })
}

export async function captureSessionExecutionContext(client, sessionID) {
  if (client?.session?.get) {
    try {
      const info = await sdkCall(
        client.session.get.bind(client.session),
        { path: { id: sessionID } },
        { path: { sessionID } },
        { sessionID },
      )
      updateSessionExecutionContext(info)
    } catch {}
  }
  const context = sessionExecutionContexts.get(sessionID) || {}
  const normalized = { agent: context.agent || "build", model: context.model }
  sessionExecutionContexts.set(sessionID, normalized)
  return normalized
}

export function getSessionExecutionContext(sessionID) { return sessionExecutionContexts.get(sessionID) }
export function setSessionExecutionContext(sessionID, context) { sessionExecutionContexts.set(sessionID, context); return context }
export function deleteSessionExecutionContext(sessionID) { sessionExecutionContexts.delete(sessionID) }
