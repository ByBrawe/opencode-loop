import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const file = path.resolve("src/source/legacy-v1.js")
let source = await readFile(file, "utf8")

function replaceOnce(text, from, to, label) {
  const index = text.indexOf(from)
  if (index < 0) throw new Error(`${label}: source fragment not found`)
  if (text.indexOf(from, index + from.length) >= 0) throw new Error(`${label}: source fragment is not unique`)
  return text.slice(0, index) + to + text.slice(index + from.length)
}

const activityImport = 'import { activeToolCalls, sessionParents, sessionStatuses, sessionStatusSeenAt, hasActiveToolCalls, markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, isDescendantSession, hasBusyDescendant, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"\n'
const schedulerImport = 'import { createSchedulerRuntime } from "./runtime/scheduler.js"\n'
if (!source.includes(schedulerImport)) source = replaceOnce(source, activityImport, activityImport + schedulerImport, "scheduler import")

for (const line of [
  'const IDLE_DEBOUNCE_MS = 1_200\n',
  'const MIN_DUE_TIMER_MS = 250\n',
  'const MAX_DUE_TIMER_MS = 2_147_000_000\n',
  'const HEARTBEAT_MS = 2_500\n',
]) source = replaceOnce(source, line, "", `remove ${line.trim()}`)

source = replaceOnce(source,
  'const activeRuns = new Map()\nconst idleTimers = new Map()\nconst dueTimers = new Map()\nconst watchdogTimers = new Map()\nconst runLocks = new Map()\nconst knownSessions = new Map()\nlet heartbeatTimer\nconst loopCompactionRequests = new Map()\n',
  'const activeRuns = new Map()\nconst runLocks = new Map()\nconst loopCompactionRequests = new Map()\n',
  "timer maps",
)

const lifecycleStart = source.indexOf("function rememberSession(directory, client, sessionID) {")
const dangerousStart = source.indexOf("function dangerousShell(command) {", lifecycleStart)
if (lifecycleStart < 0 || dangerousStart < 0) throw new Error("scheduler lifecycle block layout changed")
const schedulerSetup = `const schedulerRuntime = createSchedulerRuntime({
  busyRetryMs: BUSY_RETRY_MS,
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime

function disposeRuntime(directory, client) {
  const sessions = schedulerRuntime.sessionIDsForHost(directory, client)
  for (const sessionID of sessions) {
    clearActiveRun(sessionID)
    schedulerRuntime.clearSessionScheduling(sessionID)
    runLocks.delete(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    loopCompactionRequests.delete(sessionID)
    clearCommandLifecycle(sessionID)
  }
}

`
source = source.slice(0, lifecycleStart) + schedulerSetup + source.slice(dangerousStart)

const scheduleStart = source.indexOf("function scheduleIdleWork(directory, client, sessionID) {")
const dueJobsStart = source.indexOf("function dueJobs(state, force = false) {", scheduleStart)
if (scheduleStart < 0 || dueJobsStart < 0) throw new Error("scheduler timer block layout changed")
source = source.slice(0, scheduleStart) + source.slice(dueJobsStart)

source = replaceOnce(
  source,
  '    const due = dueTimers.get(sessionID); if (due) clearTimeout(due); dueTimers.delete(sessionID)\n',
  '    cancelDueWork(sessionID)\n',
  "stop all due timer",
)

for (const forbidden of ["idleTimers", "dueTimers", "watchdogTimers", "knownSessions", "heartbeatTimer", "IDLE_DEBOUNCE_MS", "MIN_DUE_TIMER_MS", "MAX_DUE_TIMER_MS", "HEARTBEAT_MS"]) {
  if (source.includes(forbidden)) throw new Error(`legacy-v1 still owns scheduler symbol: ${forbidden}`)
}

await writeFile(file, source)
