import { parseOpenCode2LoopCommandText } from "./commands.js"

function record(value) {
  return value && typeof value === "object" ? value : undefined
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function directoryFrom(raw) {
  return text(record(raw?.location)?.directory)
}

function sessionIDFrom(raw) {
  const data = record(raw?.data)
  return text(data?.sessionID)
}

export function normalizeOpenCode2NativeEvent(raw) {
  const type = text(raw?.type)
  if (!type) return undefined

  const data = record(raw?.data) || {}
  const directory = directoryFrom(raw)
  const sessionID = sessionIDFrom(raw)

  if (type === "session.inbox.enqueued") {
    const item = record(data.item)
    const payload = record(item?.payload)
    const parsed = item?.type === "user" ? parseOpenCode2LoopCommandText(payload?.text) : undefined
    if (!sessionID || !parsed) return undefined
    return Object.freeze({
      kind: "command",
      action: "executed",
      sessionID,
      directory,
      name: parsed.name,
      arguments: parsed.arguments,
    })
  }

  if (type === "session.execution.started") {
    if (!sessionID) return undefined
    return Object.freeze({ kind: "session", action: "status", sessionID, directory, status: "busy" })
  }

  if (type === "session.execution.succeeded") {
    if (!sessionID) return undefined
    return Object.freeze({ kind: "session", action: "idle", sessionID, directory })
  }

  if (type === "session.created") {
    if (!sessionID) return undefined
    return Object.freeze({ kind: "session", action: "created", sessionID, directory: directory || text(record(data.location)?.directory) })
  }

  if (type === "session.deleted") {
    if (!sessionID) return undefined
    return Object.freeze({ kind: "session", action: "deleted", sessionID, directory })
  }

  return undefined
}
