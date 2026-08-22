import { isCompletionBoundedContinuation, isTerminalNoWorkReply } from "../core/continuation.js"
import { orderedSessionMessages, readRecentSessionMessages } from "../opencode/host.js"

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const fromParts = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
  if (fromParts) return fromParts
  const info = message?.info || message || {}
  for (const value of [info.text, info.content, info.summary]) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

export async function applyTerminalContinuationGuard(directory, client, sessionID, job, options = {}) {
  // `/loop devam et` is intentionally infinite. The guard is only for an
  // explicit completion-bounded request such as "bitene kadar" / "until done".
  if (job?.scheduleMode !== "idle" || !isCompletionBoundedContinuation(job?.action)) {
    return { job, terminal: false, pausedNow: false }
  }

  const messages = await readRecentSessionMessages(client, sessionID, directory, options.messageLimit || 8)
  if (!messages) return { job, terminal: false, pausedNow: false }
  const tail = orderedSessionMessages(messages).at(-1)
  const info = tail?.info || tail || {}
  if (info.role !== "assistant") return { job, terminal: false, pausedNow: false }
  const completed = Number(info?.time?.completed || 0)
  const created = Number(info?.time?.created || 0)
  const runStarted = Number(job?.lastRunAt || 0)
  if (!Number.isFinite(completed) || completed <= 0) return { job, terminal: false, pausedNow: false }
  if (runStarted > 0 && completed < runStarted && (!Number.isFinite(created) || created < runStarted)) {
    return { job, terminal: false, pausedNow: false }
  }

  const text = messageText(tail)
  const terminal = isTerminalNoWorkReply(text)
  if (!terminal) {
    if (job.terminalNoWorkCount) job.terminalNoWorkCount = 0
    return { job, terminal: false, pausedNow: false, text }
  }

  job.terminalNoWorkCount = (job.terminalNoWorkCount || 0) + 1
  job.lastTerminalNoWorkAt = Date.now()
  job.lastTerminalNoWorkSummary = text.slice(0, 1000)
  const threshold = Math.max(2, Number(options.threshold) || 2)
  const pausedNow = job.terminalNoWorkCount >= threshold && !job.paused
  if (pausedNow) {
    job.paused = true
    job.lastFailureReason = "terminal_no_work"
  }
  return { job, terminal: true, pausedNow, text }
}
