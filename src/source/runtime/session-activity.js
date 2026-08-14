import { now } from "../core/args.js"
import { sdkCall } from "../opencode/sdk.js"
import { updateSessionExecutionContext, deleteSessionExecutionContext } from "../opencode/session-context.js"

export const activeToolCalls = new Map()
export const sessionParents = new Map()
export const sessionStatuses = new Map()
export const sessionStatusSeenAt = new Map()

export function hasActiveToolCalls(sessionID) {
  return (activeToolCalls.get(sessionID)?.size || 0) > 0
}

export function markToolCallActive(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID) || new Set()
  calls.add(callID)
  activeToolCalls.set(sessionID, calls)
  sessionStatuses.set(sessionID, "busy")
  sessionStatusSeenAt.set(sessionID, now())
}

export function markToolCallFinished(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID)
  if (!calls) return
  calls.delete(callID)
  if (!calls.size) activeToolCalls.delete(sessionID)
}

export function updateSessionRelationship(info, removed = false) {
  const sessionID = info?.id
  if (typeof sessionID !== "string") return
  if (removed || typeof info?.parentID !== "string") sessionParents.delete(sessionID)
  else sessionParents.set(sessionID, info.parentID)
  if (!removed) updateSessionExecutionContext(info)
  else deleteSessionExecutionContext(sessionID)
}

export function updateSessionRelationshipFromEvent(event) {
  if (!["session.created", "session.updated", "session.deleted"].includes(event?.type)) return
  updateSessionRelationship(event?.properties?.info, event.type === "session.deleted")
}

export function isDescendantSession(sessionID, ancestorID) {
  const visited = new Set()
  let current = sessionID
  while (sessionParents.has(current) && !visited.has(current)) {
    visited.add(current)
    current = sessionParents.get(current)
    if (current === ancestorID) return true
  }
  return false
}

export function hasBusyDescendant(sessionID) {
  for (const childID of sessionParents.keys()) {
    if (!isDescendantSession(childID, sessionID)) continue
    const status = sessionStatuses.get(childID)
    if (status === "busy" || status === "retry" || hasActiveToolCalls(childID)) return true
  }
  return false
}

export async function refreshSessionRelationships(client, directory) {
  if (!client?.session?.list) return
  try {
    const sessions = await sdkCall(
      client.session.list.bind(client.session),
      { query: { directory } },
      { directory },
      {},
    )
    if (Array.isArray(sessions)) for (const info of sessions) updateSessionRelationship(info)
  } catch {}
}

export function updateToolActivityFromEvent(event) {
  const props = event?.properties || {}
  if (event?.type === "message.part.updated") {
    const part = props.part
    if (part?.type !== "tool") return
    const sessionID = part.sessionID || props.sessionID
    if (["pending", "running"].includes(part.state?.status)) {
      markToolCallActive({ sessionID, callID: part.callID })
    }
    if (["completed", "error"].includes(part.state?.status)) {
      // Task/subagent hooks have used the part id as their hook call id in some
      // OpenCode versions, while normal tools use part.callID. Clear either.
      const identifiers = [...new Set([part.callID, part.id].filter((value) => typeof value === "string"))]
      for (const callID of identifiers) markToolCallFinished({ sessionID, callID })
    }
    return
  }

  const started = ["session.next.shell.started", "session.next.tool.called"].includes(event?.type)
  const finished = ["session.next.shell.ended", "session.next.tool.success", "session.next.tool.failed"].includes(event?.type)
  if (started) markToolCallActive(props)
  if (finished) markToolCallFinished(props)
}

export function clearSessionActivity(sessionID) {
  activeToolCalls.delete(sessionID)
  sessionParents.delete(sessionID)
  sessionStatuses.delete(sessionID)
  sessionStatusSeenAt.delete(sessionID)
  deleteSessionExecutionContext(sessionID)
}
