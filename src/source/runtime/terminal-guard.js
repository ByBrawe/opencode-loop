import { isCompletionBoundedContinuation, isContinuationShorthand, isTerminalNoWorkReply, isWaitingUserReply } from "../core/continuation.js"
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
  // Plain continuation remains intentionally infinite for ordinary work and
  // even ordinary "done" replies. We only inspect it for an explicit
  // waiting-user dependency so a blocked autonomous loop does not poll forever.
  const completionBounded = isCompletionBoundedContinuation(job?.action)
  const continuation = completionBounded || isContinuationShorthand(job?.action)
  if (job?.scheduleMode !== "idle" || !continuation) {
    return { job, terminal: false, pausedNow: false, waitingUser: false, waitingUserPausedNow: false }
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
  const waitingUser = isWaitingUserReply(text)
  if (waitingUser) {
    if (job.terminalNoWorkCount) job.terminalNoWorkCount = 0
    job.waitingUserCount = (job.waitingUserCount || 0) + 1
    job.lastWaitingUserAt = Date.now()
    job.lastWaitingUserSummary = text.slice(0, 1000)
    const threshold = Math.max(2, Number(options.waitingUserThreshold) || 2)
    const waitingUserPausedNow = job.waitingUserCount >= threshold && !job.paused
    if (waitingUserPausedNow) {
      job.paused = true
      job.lastFailureReason = "waiting_user"
    }
    return { job, terminal: false, pausedNow: false, waitingUser: true, waitingUserPausedNow, text }
  }

  if (job.waitingUserCount) job.waitingUserCount = 0

  // A normal completion/no-work reply still cannot stop plain /loop devam et.
  if (!completionBounded) {
    return { job, terminal: false, pausedNow: false, waitingUser: false, waitingUserPausedNow: false, text }
  }

  const terminal = isTerminalNoWorkReply(text)
  if (!terminal) {
    if (job.terminalNoWorkCount) job.terminalNoWorkCount = 0
    return { job, terminal: false, pausedNow: false, waitingUser: false, waitingUserPausedNow: false, text }
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
  return { job, terminal: true, pausedNow, waitingUser: false, waitingUserPausedNow: false, text }
}
