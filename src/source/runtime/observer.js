import { normalizeOpenCodeEvent } from "./events.js"

export function observeRuntimeEvent(manager, input) {
  const event = normalizeOpenCodeEvent(input)
  if (!event || !manager) return event

  try {
    if (event.kind === "server" && event.action === "disposed") {
      manager.dispose?.("server-disposed")
      return event
    }

    if (!event.sessionID) return event
    if (event.kind === "session" && event.action === "deleted") {
      manager.remove?.(event.sessionID, { reason: "session-deleted" })
      return event
    }

    manager.observeExternal?.(event.sessionID)
  } catch {}

  return event
}
