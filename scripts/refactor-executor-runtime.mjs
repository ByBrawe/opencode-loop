import { promises as fs } from "node:fs"

const legacyPath = "src/source/legacy-v1.js"

function requireOnce(source, needle, label) {
  const first = source.indexOf(needle)
  if (first < 0) throw new Error(`missing ${label}`)
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`duplicate ${label}`)
  return first
}

function removeUntil(source, startNeedle, endNeedle, label) {
  const start = requireOnce(source, startNeedle, `${label} start`)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`missing ${label} end`)
  return source.slice(0, start) + source.slice(end)
}

let legacy = await fs.readFile(legacyPath, "utf8")

const replacements = [
  ['import path from "node:path"\n', ''],
  ['import { spawn } from "node:child_process"\n', ''],
  ['import { now, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery } from "./core/args.js"', 'import { now } from "./core/args.js"'],
  ['import { actionKind, isGoalJob } from "./core/jobs.js"', 'import { isGoalJob } from "./core/jobs.js"'],
  ['import { pathExists, readState, writeState } from "./core/state.js"', 'import { readState, writeState } from "./core/state.js"'],
  ['import { appendLoopLog, runShellCommand, notifyJob } from "./core/process.js"', 'import { appendLoopLog, runShellCommand } from "./core/process.js"'],
  ['import { sdkErrorMessage, sdkCall } from "./opencode/sdk.js"', 'import { sdkErrorMessage } from "./opencode/sdk.js"'],
  ['import { normalizedModelRef, updateSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"', 'import { updateSessionExecutionContext } from "./opencode/session-context.js"'],
  ['import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, resolveCompactionModel, log, toast } from "./opencode/host.js"', 'import { log, toast } from "./opencode/host.js"'],
  ['import { guardLoopOwnedUserMessage, loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"', 'import { loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"'],
  ['import { createSessionStatusRuntime } from "./runtime/session-status.js"\n', ''],
  ['import { createCompactionRuntime } from "./runtime/compaction.js"\n', ''],
  ['import { writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"', 'import { setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"'],
]
for (const [oldText, newText] of replacements) {
  requireOnce(legacy, oldText, `import replacement: ${oldText.slice(0, 50)}`)
  legacy = legacy.replace(oldText, newText)
}

const workspaceImport = 'import { createJobWorkspaceRuntime, dangerousShell } from "./runtime/job-workspace.js"\n'
requireOnce(legacy, workspaceImport, "workspace import")
legacy = legacy.replace(workspaceImport, workspaceImport + 'import { createLoopExecutor } from "./runtime/executor.js"\n')

legacy = legacy.replace('const BUSY_RETRY_MS = 5_000\n', '')
if (!legacy.includes('const DEFAULT_ACTIVE_GUARD_MS = 45_000')) throw new Error("registration active guard config must remain")

const oldWorkspaceWiring = `const {
  buildPrompt,
  ensureBranch,
  snapshotPaths,
  watchChanged,
  untilReached,
  createCheckpoint,
} = createJobWorkspaceRuntime({ toast })

const { runGoalChecks, applyGoalNoProgressGuard } = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

const activeRuns = new Map()
const runLocks = new Map()

const {
  updateSessionStatusFromEvent,
  staleActiveRun,
  canFinalizeActiveRun,
  sessionIsIdle,
  markSessionStatus,
  clearSessionStatus,
} = createSessionStatusRuntime({
  activeRuns,
  appendLoopLog,
  now,
})

const compactionRuntime = createCompactionRuntime({
  activeRuns,
  finalizeActiveRun,
  appendLoopLog,
  log,
  errorMessage: sdkErrorMessage,
  now,
})
const {
  maybeCompact,
  noteStarted: noteLoopCompactionStarted,
  noteCompleted: noteLoopCompactionCompleted,
} = compactionRuntime

const schedulerRuntime = createSchedulerRuntime({
  busyRetryMs: BUSY_RETRY_MS,
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime
`
requireOnce(legacy, oldWorkspaceWiring, "workspace/status/compaction/scheduler wiring")
const newWorkspaceWiring = `const workspaceRuntime = createJobWorkspaceRuntime({ toast })
const { snapshotPaths } = workspaceRuntime
const goalPolicy = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

let schedulerRuntime
const schedulerBridge = {
  rememberSession: (...args) => schedulerRuntime.rememberSession(...args),
  scheduleDueWork: (...args) => schedulerRuntime.scheduleDueWork(...args),
}
const executorRuntime = createLoopExecutor({
  workspace: workspaceRuntime,
  goalPolicy,
  scheduler: schedulerBridge,
  toast,
  log,
  appendLoopLog,
  errorMessage: sdkErrorMessage,
  now,
})
const {
  clearActiveRun,
  finalizeActiveRun,
  maybeRunDueJobs,
  sessionIsIdle,
  updateSessionStatusFromEvent,
  noteLoopCompactionStarted,
  noteLoopCompactionCompleted,
} = executorRuntime

schedulerRuntime = createSchedulerRuntime({
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime
`
legacy = legacy.replace(oldWorkspaceWiring, newWorkspaceWiring)

const oldDisposeBody = `    clearActiveRun(sessionID)
    schedulerRuntime.clearSessionScheduling(sessionID)
    runLocks.delete(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    compactionRuntime.clear(sessionID)
    clearCommandLifecycle(sessionID)`
const newDisposeBody = `    executorRuntime.disposeSession(sessionID)
    schedulerRuntime.clearSessionScheduling(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    clearCommandLifecycle(sessionID)`
requireOnce(legacy, oldDisposeBody, "dispose executor state cleanup")
legacy = legacy.replace(oldDisposeBody, newDisposeBody)

legacy = removeUntil(
  legacy,
  "function dueJobs(state, force = false) {",
  "function goalTools(defaultDirectory) {",
  "active-run executor block",
)

for (const moved of [
  "function dueJobs(state, force = false)",
  "function clearActiveRun(sessionID)",
  "async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error)",
  "async function finalizeActiveRun(directory, client, sessionID, options = {})",
  "async function fireAction(directory, client, sessionID, job)",
  "async function maybeRunDueJobs(directory, client, sessionID, options = {})",
]) {
  if (legacy.includes(moved)) throw new Error(`executor function remains in legacy source: ${moved}`)
}
if (!legacy.includes("createLoopExecutor({")) throw new Error("executor runtime wiring missing")
if (!legacy.includes("function userInterruptSessionFromEvent(event)")) throw new Error("user interrupt helper must remain")
if (!legacy.includes("async function pauseGoalsForUserInterrupt(directory, client, sessionID)")) throw new Error("goal interrupt policy must remain")
if (!legacy.includes("function goalTools(defaultDirectory)")) throw new Error("goal tools must remain")
if (!legacy.includes("export const OpenCodeLoopPlugin")) throw new Error("plugin composition root must remain")
if (!legacy.includes("defaultActiveGuardMs: DEFAULT_ACTIVE_GUARD_MS")) throw new Error("registration active guard wiring must remain")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
for (const stale of [
  "node:path",
  "node:child_process",
  "parseDuration",
  "splitFirst",
  "stripOuterQuotes",
  "escapeRegExp",
  "takeFlag",
  "takeFlagValue",
  "takeAllFlagValues",
  "parsePositiveInt",
  "parseNonNegativeInt",
  "parseCompactEvery",
  "actionKind",
  "pathExists",
  "notifyJob",
  "sdkCall",
  "normalizedModelRef",
  "setSessionExecutionContext",
  "fireSdk",
  "executeTuiCommand",
  "compactTuiCommandName",
  "readRecentSessionMessages",
  "orderedSessionMessages",
  "resolveCompactionModel",
  "guardLoopOwnedUserMessage",
  "createSessionStatusRuntime",
  "createCompactionRuntime",
  "writeGoalReport",
]) {
  if (imports.includes(stale)) throw new Error(`stale executor import remains: ${stale}`)
}
if (!imports.includes("runShellCommand") || !imports.includes("dangerousShell")) throw new Error("goal policy shell dependencies must remain")
if (!imports.includes("createLoopExecutor")) throw new Error("executor import missing")
if (legacy.includes("activeRuns") || legacy.includes("runLocks") || legacy.includes("compactionRuntime")) {
  throw new Error("legacy executor state reference remains")
}

await fs.writeFile(legacyPath, legacy)
console.log("executor runtime refactor transform complete")
