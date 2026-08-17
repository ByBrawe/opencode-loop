import { now } from "../core/args.js"
import { sdkCall } from "./sdk.js"

const LOOP_OWNED_USER_MESSAGE_GUARD_MS = 10_000
const LOOP_OWNED_USER_MESSAGE_RETENTION_MS = 10 * 60_000
const loopOwnedUserMessageGuards = new Map()

export function guardLoopOwnedUserMessage(sessionID) {
  if (!sessionID) return
  const current = loopOwnedUserMessageGuards.get(sessionID) || { pending: 0, until: 0, messageIDs: new Map() }
  current.pending += 1
  current.until = Math.max(current.until || 0, now() + LOOP_OWNED_USER_MESSAGE_GUARD_MS)
  for (const [messageID, expiresAt] of current.messageIDs.entries()) if (expiresAt < now()) current.messageIDs.delete(messageID)
  loopOwnedUserMessageGuards.set(sessionID, current)
  for (const [key, entry] of loopOwnedUserMessageGuards.entries()) {
    for (const [messageID, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(messageID)
    if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0 && (entry.until || 0) < now()) loopOwnedUserMessageGuards.delete(key)
  }
}

export function loopOwnedUserMessageGuardActive(sessionID, messageID) {
  const entry = loopOwnedUserMessageGuards.get(sessionID)
  if (!entry || typeof entry !== "object") return false
  for (const [id, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(id)
  const id = typeof messageID === "string" ? messageID : ""
  if (id && entry.messageIDs.has(id)) return true
  if ((entry.pending || 0) > 0 && (entry.until || 0) >= now()) {
    // chat.message can fire before OpenCode assigns the synthetic user message
    // an ID. Treat that pre-dispatch hook as Loop-owned without consuming the
    // pending guard; message.updated will later bind and retain the real ID.
    if (!id) return true
    entry.pending -= 1
    entry.messageIDs.set(id, now() + LOOP_OWNED_USER_MESSAGE_RETENTION_MS)
    loopOwnedUserMessageGuards.set(sessionID, entry)
    return true
  }
  if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0) loopOwnedUserMessageGuards.delete(sessionID)
  return false
}

export async function say(client, sessionID, text) {
  guardLoopOwnedUserMessage(sessionID)
  try {
    await sdkCall(
      client.session.prompt.bind(client.session),
      { path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { path: { sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { sessionID, noReply: true, parts: [{ type: "text", text }] },
    )
  } catch {}
}

export function clearLoopOwnedUserMessageGuard(sessionID) {
  loopOwnedUserMessageGuards.delete(sessionID)
}
