// Output of native read-only commands is for the human, never for future model input.
export const DISPLAY_METADATA_KEY = "opencode_loop_display_only"
export const DISPLAY_START = "[OpenCode Loop display-only report]"
export const DISPLAY_END = "[End OpenCode Loop display-only report]"
const DISPLAY_BLOCK = /\[OpenCode Loop display-only report\][\s\S]*?\[End OpenCode Loop display-only report\]/g

export function withoutLoopDisplayReports(messages) {
  if (!Array.isArray(messages)) return messages
  let changed = false
  const output = []
  for (const message of messages) {
    if (message?.role !== "user") { output.push(message); continue }
    if (message.metadata?.[DISPLAY_METADATA_KEY] === true) { changed = true; continue }
    if (!Array.isArray(message.content)) { output.push(message); continue }
    let altered = false
    const content = message.content.flatMap((part) => {
      if (part?.type !== "text" || typeof part.text !== "string") return [part]
      const text = part.text.replace(DISPLAY_BLOCK, "")
      if (text === part.text) return [part]
      altered = true
      return text.trim() ? [{ ...part, text }] : []
    })
    if (!altered) { output.push(message); continue }
    changed = true
    if (content.length) output.push({ ...message, content })
  }
  return changed ? output : messages
}

export function filterLoopDisplayHook(event, title = false) {
  if (!Array.isArray(event?.messages)) return
  const clean = withoutLoopDisplayReports(event.messages)
  if (clean === event.messages) return
  event.messages = clean
  if (title && !clean.some((message) => Array.isArray(message.content) &&
    message.content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim()))) {
    event.result = ""
  }
}
