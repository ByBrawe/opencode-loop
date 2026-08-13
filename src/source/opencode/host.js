import { sdkErrorMessage, sdkCall } from "./sdk.js"
import { normalizedModelRef, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./session-context.js"

const SERVICE = "opencode-loop"

export function fireSdk(client, label, method, ...argsList) {
  const pending = Promise.resolve().then(() => sdkCall(method, ...argsList))
  void pending.catch((error) => {
    log(client, "warn", `${label} failed`, { error: sdkErrorMessage(error) }).catch(() => {})
  })
  return pending
}

export async function executeTuiCommand(client, command) {
  if (!client?.tui?.executeCommand) throw new Error("client.tui.executeCommand is not available")
  return await sdkCall(
    client.tui.executeCommand.bind(client.tui),
    { body: { command } },
    { command },
  )
}

export function compactTuiCommandName(command = "compact") {
  const normalized = String(command || "compact").replace(/^\/+/, "").trim().toLowerCase()
  if (normalized === "compact" || normalized === "summarize") return "session_compact"
  return undefined
}

export async function readRecentSessionMessages(client, sessionID, directory, limit = 20) {
  if (!client?.session?.messages) return undefined
  const query = { limit }
  if (directory) query.directory = directory
  try {
    const messages = await sdkCall(
      client.session.messages.bind(client.session),
      { path: { id: sessionID }, query },
      { path: { sessionID }, query },
      { sessionID, ...query },
    )
    return Array.isArray(messages) ? messages : undefined
  } catch {
    return undefined
  }
}

export function orderedSessionMessages(messages) {
  return (messages || [])
    .map((message, index) => {
      const info = message?.info || message || {}
      const created = Number(info?.time?.created || 0)
      return { message, index, created: Number.isFinite(created) ? created : 0 }
    })
    .sort((a, b) => a.created - b.created || a.index - b.index)
    .map((entry) => entry.message)
}

export async function activeRunCompletionFromMessages(directory, client, sessionID, active) {
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  if (!messages) return "unknown"
  const tail = orderedSessionMessages(messages).at(-1)
  const info = tail?.info || tail
  if (!info || info.role !== "assistant") return "incomplete"
  const completed = Number(info?.time?.completed || 0)
  const created = Number(info?.time?.created || 0)
  if (!Number.isFinite(completed) || completed <= 0) return "incomplete"
  const startedAt = Number(active?.startedAt || 0)
  if (startedAt > 0 && completed < startedAt && (!Number.isFinite(created) || created < startedAt)) return "incomplete"
  return "completed"
}

export async function resolveCompactionModel(directory, client, sessionID, preferredModel) {
  const preferred = normalizedModelRef(preferredModel)
  if (preferred) return preferred
  const cached = normalizedModelRef(getSessionExecutionContext(sessionID)?.model)
  if (cached) return cached
  const captured = await captureSessionExecutionContext(client, sessionID)
  const capturedModel = normalizedModelRef(captured?.model)
  if (capturedModel) return capturedModel
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  for (const message of orderedSessionMessages(messages).reverse()) {
    const info = message?.info || message
    const model = normalizedModelRef(info?.model) || normalizedModelRef(info)
    if (!model) continue
    const previous = getSessionExecutionContext(sessionID) || {}
    setSessionExecutionContext(sessionID, { ...previous, model })
    return model
  }
  return undefined
}

export async function compactSession(directory, client, sessionID, preferredModel) {
  // Prefer the native TUI command when a TUI is present. Headless/server hosts
  // fall back to session.summarize, whose current API requires an explicit
  // provider/model pair.
  for (const command of ["session.compact", "session_compact"]) {
    try {
      await executeTuiCommand(client, command)
      return true
    } catch (error) {
      await log(client, "warn", `tui ${command} failed`, { error: sdkErrorMessage(error) })
    }
  }
  try {
    if (!client?.session?.summarize) throw new Error("client.session.summarize is not available")
    const model = await resolveCompactionModel(directory, client, sessionID, preferredModel)
    if (!model) throw new Error("could not resolve a provider/model for session.summarize")
    const body = { providerID: model.providerID, modelID: model.modelID, auto: false }
    await sdkCall(
      client.session.summarize.bind(client.session),
      { path: { id: sessionID }, body },
      { path: { sessionID }, body },
      { sessionID, ...body },
    )
    return true
  } catch (error) {
    await log(client, "warn", "session.summarize fallback failed", { error: sdkErrorMessage(error) })
  }
  await toast(client, "Could not run /compact from loop. Check OpenCode version and active session model.", "error")
  return false
}

export async function log(client, level, message, extra) {
  try {
    await sdkCall(
      client.app.log.bind(client.app),
      { body: extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra } },
      extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra },
    )
  } catch {}
}

export async function toast(client, message, variant = "info") {
  try { await sdkCall(client.tui.showToast.bind(client.tui), { body: { message, variant } }, { message, variant }) } catch {}
}
