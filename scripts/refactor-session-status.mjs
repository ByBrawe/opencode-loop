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

const oldHostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, activeRunCompletionFromMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"'
const newHostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"'
requireOnce(legacy, oldHostImport, "host import")
legacy = legacy.replace(oldHostImport, newHostImport)

const oldActivityImport = 'import { activeToolCalls, sessionParents, sessionStatuses, sessionStatusSeenAt, hasActiveToolCalls, markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, isDescendantSession, hasBusyDescendant, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"'
const newActivityImport = 'import { markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"'
requireOnce(legacy, oldActivityImport, "session activity import")
legacy = legacy.replace(oldActivityImport, newActivityImport)

const activityImport = newActivityImport + '\n'
requireOnce(legacy, activityImport, "updated session activity import")
legacy = legacy.replace(activityImport, activityImport + 'import { createSessionStatusRuntime } from "./runtime/session-status.js"\n')

legacy = legacy.replace('const STALE_ACTIVE_RECOVERY_MS = 45_000\n', "")
legacy = legacy.replace('const SESSION_STATUS_CACHE_MS = 1_500\n', "")

const runMaps = 'const activeRuns = new Map()\nconst runLocks = new Map()\nconst loopCompactionRequests = new Map()\n\n'
requireOnce(legacy, runMaps, "active-run maps")
const statusWiring = `${runMaps}const {
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

`
legacy = legacy.replace(runMaps, statusWiring)

legacy = removeUntil(
  legacy,
  "function updateSessionStatusFromEvent(event) {",
  "function dueJobs(state, force = false) {",
  "session status runtime block",
)

const clearPair = 'sessionStatuses.delete(sessionID)\n  sessionStatusSeenAt.delete(sessionID)'
let clearCount = 0
while (legacy.includes(clearPair)) {
  legacy = legacy.replace(clearPair, 'clearSessionStatus(sessionID)')
  clearCount++
}
if (clearCount !== 1) throw new Error(`expected 1 remaining session-status clear pair, found ${clearCount}`)

const busyPair = 'sessionStatuses.set(sessionID, "busy")\n      sessionStatusSeenAt.set(sessionID, now())'
requireOnce(legacy, busyPair, "remaining busy status update")
legacy = legacy.replace(busyPair, 'markSessionStatus(sessionID, "busy")')

for (const moved of [
  "function updateSessionStatusFromEvent(event)",
  "function staleActiveRun(sessionID)",
  "async function canFinalizeActiveRun(directory, client, sessionID, active, options = {})",
  "async function readLiveSessionStatus(client, sessionID, directory)",
  "async function sessionStatusType(client, sessionID, directory, options = {})",
  "async function sessionIsIdle(client, sessionID, directory, options = {})",
]) {
  if (legacy.includes(moved)) throw new Error(`moved session-status function remains in legacy source: ${moved}`)
}
if (!legacy.includes("createSessionStatusRuntime({")) throw new Error("session status runtime wiring missing")
if (!legacy.includes("function dueJobs(state, force = false)")) throw new Error("dueJobs must remain in legacy source")
if (!legacy.includes("async function finalizeActiveRun(directory, client, sessionID, options = {})")) throw new Error("finalizeActiveRun must remain in legacy source")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
for (const stale of [
  "activeToolCalls",
  "sessionParents",
  "sessionStatuses",
  "sessionStatusSeenAt",
  "hasActiveToolCalls",
  "isDescendantSession",
  "hasBusyDescendant",
  "activeRunCompletionFromMessages",
]) {
  if (imports.includes(stale)) throw new Error(`stale session-status import remains: ${stale}`)
}
for (const staleReference of ["sessionStatuses", "sessionStatusSeenAt", "sessionParents", "STALE_ACTIVE_RECOVERY_MS", "SESSION_STATUS_CACHE_MS"]) {
  if (legacy.includes(staleReference)) throw new Error(`stale session-status reference remains: ${staleReference}`)
}
if (!imports.includes("createSessionStatusRuntime")) throw new Error("session status runtime import missing")
if (!legacy.includes('markSessionStatus(sessionID, "busy")')) throw new Error("busy status helper wiring missing")
if ((legacy.match(/clearSessionStatus\(sessionID\)/g) || []).length !== 1) throw new Error("expected one clearSessionStatus call in executor")

await fs.writeFile(legacyPath, legacy)
console.log("session status refactor transform complete")
