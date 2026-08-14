function record(value) {
  return value && typeof value === "object" ? value : undefined
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function envelope(input) {
  const outer = record(input)
  if (!outer) return undefined
  const payload = record(outer.payload)
  if (payload && text(payload.type)) {
    return { directory: text(outer.directory), event: payload }
  }
  const wrappedEvent = record(outer.event)
  if (wrappedEvent && text(wrappedEvent.type)) {
    return { directory: text(outer.directory), event: wrappedEvent }
  }
  if (!text(outer.type)) return undefined
  return { directory: undefined, event: outer }
}

function freezeEvent(value) {
  return Object.freeze(value)
}

export function normalizeOpenCodeEvent(input) {
  const parsed = envelope(input)
  if (!parsed) return undefined

  const { directory, event } = parsed
  const properties = record(event.properties) || {}

  if (event.type === "session.status") {
    const sessionID = text(properties.sessionID)
    const status = text(record(properties.status)?.type)
    if (!sessionID || !status) return undefined
    return freezeEvent({ kind: "session", action: "status", sessionID, directory, status })
  }

  if (event.type === "session.idle" || event.type === "session.compacted") {
    const sessionID = text(properties.sessionID)
    if (!sessionID) return undefined
    return freezeEvent({
      kind: "session",
      action: event.type === "session.idle" ? "idle" : "compacted",
      sessionID,
      directory,
    })
  }

  if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
    const info = record(properties.info)
    const sessionID = text(info?.id)
    if (!sessionID) return undefined
    return freezeEvent({
      kind: "session",
      action: event.type.slice("session.".length),
      sessionID,
      directory: directory || text(info?.directory),
      parentID: text(info?.parentID),
    })
  }

  if (event.type === "session.error") {
    const sessionID = text(properties.sessionID)
    if (!sessionID) return undefined
    return freezeEvent({ kind: "session", action: "error", sessionID, directory })
  }

  if (event.type === "message.updated") {
    const info = record(properties.info)
    const sessionID = text(info?.sessionID)
    const messageID = text(info?.id)
    const role = text(info?.role)
    if (!sessionID || !messageID || !role) return undefined
    const time = record(info?.time)
    return freezeEvent({
      kind: "message",
      action: "updated",
      sessionID,
      directory,
      messageID,
      role,
      completedAt: Number.isFinite(time?.completed) ? time.completed : undefined,
      finish: text(info?.finish),
    })
  }

  if (event.type === "command.executed") {
    const sessionID = text(properties.sessionID)
    const name = text(properties.name)
    if (!sessionID || !name) return undefined
    return freezeEvent({
      kind: "command",
      action: "executed",
      sessionID,
      directory,
      name,
      arguments: typeof properties.arguments === "string" ? properties.arguments : "",
      messageID: text(properties.messageID),
    })
  }

  if (event.type === "server.instance.disposed") {
    const disposedDirectory = directory || text(properties.directory)
    if (!disposedDirectory) return undefined
    return freezeEvent({ kind: "server", action: "disposed", directory: disposedDirectory })
  }

  return undefined
}
