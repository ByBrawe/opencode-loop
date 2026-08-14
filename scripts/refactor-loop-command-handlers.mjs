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

const oldArgsImport = 'import { now, safeID, parseDuration, durationToText, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"'
const newArgsImport = 'import { now, safeID, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"'
requireOnce(legacy, oldArgsImport, "args import")
legacy = legacy.replace(oldArgsImport, newArgsImport)

const oldJobsImport = 'import { jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob, goalStatusText } from "./core/jobs.js"'
const newJobsImport = 'import { jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob } from "./core/jobs.js"'
requireOnce(legacy, oldJobsImport, "jobs import")
legacy = legacy.replace(oldJobsImport, newJobsImport)

const oldStateImport = 'import { stateDir, ensureDir, pathExists, readState, writeState, removeState } from "./core/state.js"'
const newStateImport = 'import { stateDir, ensureDir, pathExists, readState, writeState } from "./core/state.js"'
requireOnce(legacy, oldStateImport, "state import")
legacy = legacy.replace(oldStateImport, newStateImport)

const goalCommandsImport = 'import { createGoalCommandHandlers } from "./opencode/goal-commands.js"\n'
requireOnce(legacy, goalCommandsImport, "Goal commands import")
legacy = legacy.replace(goalCommandsImport, goalCommandsImport + 'import { createLoopCommandHandlers } from "./opencode/loop-commands.js"\n')

legacy = legacy.replace('const SERVICE = "opencode-loop"\n', "")
if (legacy.includes('const SERVICE = "opencode-loop"')) throw new Error("legacy SERVICE constant remains")

legacy = removeUntil(
  legacy,
  "const DEFAULT_PROGRESS_MD = `# Progress",
  "const schedulerRuntime = createSchedulerRuntime({",
  "default progress template",
)

const goalWiringEnd = `} = createGoalCommandHandlers({
  addLoop,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
})

`
requireOnce(legacy, goalWiringEnd, "Goal command handler wiring")
const loopWiring = `${goalWiringEnd}const {
  stopLoop,
  updateJobState,
  statusLoop,
  logsLoop,
  helpLoop,
  runNow,
  doctorLoop,
  initLoop,
  exportLoop,
} = createLoopCommandHandlers({
  clearActiveRun,
  cancelDueWork,
  stopWatchdog,
  scheduleDueWork,
  maybeRunDueJobs,
  toast,
  say,
  now,
})

`
legacy = legacy.replace(goalWiringEnd, loopWiring)

legacy = removeUntil(
  legacy,
  "async function stopLoop(directory, client, sessionID, args) {",
  "function goalTools(defaultDirectory) {",
  "general Loop command handler block",
)

for (const moved of [
  "async function stopLoop(directory, client, sessionID, args)",
  "async function updateJobState(directory, client, sessionID, args, updater, message)",
  "async function statusLoop(directory, client, sessionID)",
  "async function logsLoop(directory, client, sessionID)",
  "async function helpLoop(client, sessionID)",
  "async function runNow(directory, client, sessionID, args)",
  "async function doctorLoop(directory, client, sessionID)",
  "async function initLoop(directory, client, sessionID, args)",
  "async function exportLoop(directory, client, sessionID)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved general Loop handler remains in legacy source: ${moved}`)
}
if (!legacy.includes("createLoopCommandHandlers({")) throw new Error("general Loop command handler wiring missing")
if (!legacy.includes("async function addLoop(directory, client, sessionID, args, defaults = {})")) throw new Error("addLoop must remain in legacy source")
if (!legacy.includes("function goalTools(defaultDirectory) {")) throw new Error("goalTools must remain in legacy source")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
for (const stale of ["durationToText", "goalStatusText", "removeState"]) {
  if (imports.includes(stale)) throw new Error(`stale general-command import remains: ${stale}`)
}
if (legacy.includes("DEFAULT_PROGRESS_MD")) throw new Error("default progress template remains in legacy source")
if (!imports.includes('createLoopCommandHandlers')) throw new Error("loop command handler import missing")
if (!imports.includes('pathExists')) throw new Error("pathExists must remain for stop-file runtime policy")

await fs.writeFile(legacyPath, legacy)
console.log("general Loop command handler refactor transform complete")
