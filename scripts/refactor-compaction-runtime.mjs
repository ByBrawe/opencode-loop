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

const oldHostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"'
const newHostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, resolveCompactionModel, log, toast } from "./opencode/host.js"'
requireOnce(legacy, oldHostImport, "host import")
legacy = legacy.replace(oldHostImport, newHostImport)

const statusImport = 'import { createSessionStatusRuntime } from "./runtime/session-status.js"\n'
requireOnce(legacy, statusImport, "session status import")
legacy = legacy.replace(statusImport, statusImport + 'import { createCompactionRuntime } from "./runtime/compaction.js"\n')

const oldMaps = 'const activeRuns = new Map()\nconst runLocks = new Map()\nconst loopCompactionRequests = new Map()\n'
const newMaps = 'const activeRuns = new Map()\nconst runLocks = new Map()\n'
requireOnce(legacy, oldMaps, "runtime maps")
legacy = legacy.replace(oldMaps, newMaps)

const statusWiringEnd = `} = createSessionStatusRuntime({
  activeRuns,
  appendLoopLog,
  now,
})

`
requireOnce(legacy, statusWiringEnd, "session status wiring")
const compactionWiring = `${statusWiringEnd}const compactionRuntime = createCompactionRuntime({
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

`
legacy = legacy.replace(statusWiringEnd, compactionWiring)

requireOnce(legacy, '    loopCompactionRequests.delete(sessionID)\n', "dispose compaction cleanup")
legacy = legacy.replace('    loopCompactionRequests.delete(sessionID)\n', '    compactionRuntime.clear(sessionID)\n')

legacy = removeUntil(
  legacy,
  "async function maybeCompact(directory, client, sessionID, job) {",
  "function userInterruptSessionFromEvent(event) {",
  "scheduled compaction helper",
)

const oldClearActive = `  const compact = loopCompactionRequests.get(sessionID)
  if (!compact || !active || compact.jobId === active.jobId) loopCompactionRequests.delete(sessionID)
  activeRuns.delete(sessionID)`
const newClearActive = `  compactionRuntime.clearForActiveRun(sessionID, active)
  activeRuns.delete(sessionID)`
requireOnce(legacy, oldClearActive, "clearActiveRun compaction cleanup")
legacy = legacy.replace(oldClearActive, newClearActive)

legacy = removeUntil(
  legacy,
  "function beginLoopCompaction(sessionID, jobId, resumeAfter = false) {",
  "async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {",
  "compaction lifecycle block",
)

const pendingRead = 'const pending = loopCompactionRequests.get(sessionID)'
let pendingReads = 0
while (legacy.includes(pendingRead)) {
  legacy = legacy.replace(pendingRead, 'const pending = compactionRuntime.getPending(sessionID)')
  pendingReads++
}
if (pendingReads !== 3) throw new Error(`expected three remaining pending reads, found ${pendingReads}`)

const oldStart = `beginLoopCompaction(sessionID, job.id, false)
    const ok = await compactSession(directory, client, sessionID, model)
    if (!ok) loopCompactionRequests.delete(sessionID)`
const newStart = `const ok = await compactionRuntime.start(directory, client, sessionID, job.id, model, false)`
let startCount = 0
while (legacy.includes(oldStart)) {
  legacy = legacy.replace(oldStart, newStart)
  startCount++
}
if (startCount !== 2) throw new Error(`expected two compact action starts, found ${startCount}`)

const completionPattern = /const pending = compactionRuntime\.getPending\(sessionID\)\n\s*if \(pending\?\.jobId === job\.id && pending\.completedAt\) \{\n\s*await finalizeLoopCompaction\(directory, client, sessionID\)\n\s*return\n\s*\}/g
const completionMatches = legacy.match(completionPattern) || []
if (completionMatches.length !== 2) throw new Error(`expected two completed-event races, found ${completionMatches.length}`)
legacy = legacy.replace(completionPattern, 'if (compactionRuntime.isCompleted(sessionID, job.id)) {\n        await compactionRuntime.finalize(directory, client, sessionID)\n        return\n      }')

for (const moved of [
  "async function maybeCompact(directory, client, sessionID, job)",
  "function beginLoopCompaction(sessionID, jobId, resumeAfter = false)",
  "async function noteLoopCompactionStarted(directory, sessionID)",
  "async function finalizeLoopCompaction(directory, client, sessionID)",
  "async function noteLoopCompactionCompleted(directory, client, sessionID)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved compaction function remains: ${moved}`)
}

if (legacy.includes("loopCompactionRequests")) throw new Error("legacy compaction request map reference remains")
if (legacy.includes("compactSession(")) throw new Error("legacy compactSession call remains")
if (legacy.includes("beginLoopCompaction(")) throw new Error("legacy beginLoopCompaction call remains")
if (legacy.includes("finalizeLoopCompaction(")) throw new Error("legacy finalizeLoopCompaction call remains")
if (!legacy.includes("createCompactionRuntime({")) throw new Error("compaction runtime wiring missing")
if (!legacy.includes("async function finalizeActiveRun(directory, client, sessionID, options = {})")) throw new Error("executor finalization must remain in legacy")
if (!legacy.includes("async function maybeRunDueJobs(directory, client, sessionID, options = {})")) throw new Error("due-job executor must remain in legacy")
if (!legacy.includes("function userInterruptSessionFromEvent(event)")) throw new Error("user interrupt handling must remain")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
if (imports.includes("compactSession")) throw new Error("stale compactSession import remains")
if (!imports.includes("createCompactionRuntime")) throw new Error("compaction runtime import missing")

await fs.writeFile(legacyPath, legacy)
console.log("compaction runtime refactor transform complete")
