import { now as defaultNow } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { readState as defaultReadState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { fireSdk as defaultFireSdk } from "../opencode/host.js"

const DEFAULT_STEERING_SUPPRESSION_MS = 5 * 60_000

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`createGoalSteeringRuntime requires ${label}`)
  return value
}

function messageInfo(event) {
  if (!["message.updated", "message.created"].includes(String(event?.type || ""))) return undefined
  const props = event?.properties || {}
  return props.info || props.message || props
}

function userMessageFromEvent(event) {
  const info = messageInfo(event)
  if (!info || info.role !== "user") return undefined
  const props = event?.properties || {}
  const sessionID = info.sessionID || props.sessionID
  if (typeof sessionID !== "string" || !sessionID) return undefined
  const messageID = typeof (info.id || props.messageID) === "string" ? (info.id || props.messageID) : ""
  return { sessionID, messageID }
}

function assistantMessageFromEvent(event) {
  const info = messageInfo(event)
  if (!info || info.role !== "assistant") return undefined
  const props = event?.properties || {}
  const sessionID = info.sessionID || props.sessionID
  if (typeof sessionID !== "string" || !sessionID) return undefined
  const parentID = typeof (info.parentID || props.parentID) === "string" ? (info.parentID || props.parentID) : ""
  const createdAt = Number(info?.time?.created || 0)
  return { sessionID, parentID, createdAt: Number.isFinite(createdAt) ? createdAt : 0 }
}

function activeGoalJobs(state) {
  return (state?.jobs || []).filter((job) => {
    if (!isGoalJob(job)) return false
    if (job.paused || job.enabled === false) return false
    return !["completed", "blocked", "cleared"].includes(job.goalStatus)
  })
}

export function createGoalSteeringRuntime(options = {}) {
  const getActiveRun = requireFunction(options.getActiveRun, "getActiveRun")
  const clearActiveRun = requireFunction(options.clearActiveRun, "clearActiveRun")
  const isLoopOwnedUserMessage = typeof options.isLoopOwnedUserMessage === "function" ? options.isLoopOwnedUserMessage : () => false
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const fireSdk = typeof options.fireSdk === "function" ? options.fireSdk : defaultFireSdk
  const now = typeof options.now === "function" ? options.now : defaultNow
  const suppressionMs = Number.isFinite(Number(options.suppressionMs)) && Number(options.suppressionMs) > 0
    ? Number(options.suppressionMs)
    : DEFAULT_STEERING_SUPPRESSION_MS

  const pendingSteering = new Map()

  function pendingForSession(sessionID) {
    const entry = pendingSteering.get(sessionID)
    if (!entry) return undefined
    if (entry.expiresAt <= now()) {
      pendingSteering.delete(sessionID)
      return undefined
    }
    return entry
  }

  function shouldSuppressIdle(sessionID) {
    return Boolean(pendingForSession(sessionID))
  }

  function observeAssistantMessage(event) {
    const assistant = assistantMessageFromEvent(event)
    if (!assistant) return false
    const entry = pendingForSession(assistant.sessionID)
    if (!entry) return false
    const matchesMessage = entry.messageID && assistant.parentID === entry.messageID
    const matchesFallback = !entry.messageID && (!assistant.createdAt || assistant.createdAt >= entry.armedAt)
    if (!matchesMessage && !matchesFallback) return false
    pendingSteering.delete(assistant.sessionID)
    return true
  }

  async function handleEvent(directory, client, event) {
    observeAssistantMessage(event)
    const user = userMessageFromEvent(event)
    if (!user) return undefined
    if (isLoopOwnedUserMessage(user.sessionID, user.messageID)) {
      return { handled: false, loopOwned: true, ...user }
    }

    const state = await readState(directory, user.sessionID)
    const goals = activeGoalJobs(state)
    if (!goals.length) return { handled: false, ...user }

    const active = getActiveRun(user.sessionID)
    const activeGoalIDs = new Set(goals.map((goal) => goal.id))
    const canPreempt = active && activeGoalIDs.has(active.jobId) && isGoalJob(active.job) && typeof client?.session?.abort === "function"
    let preempted = false
    let abortError = ""

    if (canPreempt) {
      pendingSteering.set(user.sessionID, {
        messageID: user.messageID,
        goalID: active.jobId,
        armedAt: now(),
        expiresAt: now() + suppressionMs,
      })
      try {
        await fireSdk(
          client,
          "session.abort",
          client.session.abort.bind(client.session),
          { path: { id: user.sessionID }, body: {} },
          { path: { sessionID: user.sessionID }, body: {} },
          { sessionID: user.sessionID },
        )
        clearActiveRun(user.sessionID)
        preempted = true
      } catch (error) {
        pendingSteering.delete(user.sessionID)
        abortError = error instanceof Error ? error.message : String(error)
      }
    }

    await appendLoopLog(directory, "goal-user-steering", {
      sessionID: user.sessionID,
      messageID: user.messageID,
      goals: goals.length,
      preempted,
      ...(abortError ? { abortError } : {}),
    })

    return { handled: true, preempted, ...user }
  }

  function clearSession(sessionID) {
    pendingSteering.delete(sessionID)
  }

  return {
    handleEvent,
    observeAssistantMessage,
    shouldSuppressIdle,
    hasPendingSteering: shouldSuppressIdle,
    pendingForSession,
    clearSession,
  }
}
