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

const oldArgsImport = 'import { now, safeID, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"'
const newArgsImport = 'import { now, safeID, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery } from "./core/args.js"'
requireOnce(legacy, oldArgsImport, "args import")
legacy = legacy.replace(oldArgsImport, newArgsImport)

const oldJobsImport = 'import { jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob } from "./core/jobs.js"'
const newJobsImport = 'import { actionKind, decoratePrompt, isGoalJob } from "./core/jobs.js"'
requireOnce(legacy, oldJobsImport, "jobs import")
legacy = legacy.replace(oldJobsImport, newJobsImport)

const oldContextImport = 'import { normalizedModelRef, updateSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"'
const newContextImport = 'import { normalizedModelRef, updateSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"'
requireOnce(legacy, oldContextImport, "session-context import")
legacy = legacy.replace(oldContextImport, newContextImport)

const loopCommandsImport = 'import { createLoopCommandHandlers } from "./opencode/loop-commands.js"\n'
requireOnce(legacy, loopCommandsImport, "Loop commands import")
legacy = legacy.replace(loopCommandsImport, loopCommandsImport + 'import { createLoopRegistration } from "./opencode/loop-registration.js"\n')

legacy = legacy.replace('const DEFAULT_GOAL_ACTIVE_RECOVERY_MS = 180_000\n', "")

const schedulerBinding = 'const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime\n\n'
requireOnce(legacy, schedulerBinding, "scheduler binding")
const registrationWiring = `${schedulerBinding}const { addLoop } = createLoopRegistration({
  snapshotPaths,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
  defaultActiveGuardMs: DEFAULT_ACTIVE_GUARD_MS,
})

`
legacy = legacy.replace(schedulerBinding, registrationWiring)

legacy = removeUntil(
  legacy,
  "function normalizeActionForCompare(value) {",
  "function goalTools(defaultDirectory) {",
  "Loop registration block",
)

for (const moved of [
  "function normalizeActionForCompare(value)",
  "function sameLoopDefinition(a, b)",
  "async function addLoop(directory, client, sessionID, args, defaults = {})",
]) {
  if (legacy.includes(moved)) throw new Error(`moved Loop registration helper remains in legacy source: ${moved}`)
}
if (legacy.includes("DEFAULT_GOAL_ACTIVE_RECOVERY_MS")) throw new Error("legacy Goal active-recovery constant remains")
if (!legacy.includes("const { addLoop } = createLoopRegistration({")) throw new Error("Loop registration wiring missing")
if (!legacy.includes("async function snapshotPaths(directory, files)")) throw new Error("snapshotPaths must remain in legacy runtime")
if (!legacy.includes("function goalTools(defaultDirectory) {")) throw new Error("goalTools must remain in legacy source")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
for (const stale of ["parseLoopArgs", "jobLabel", "matchJob", "getSessionExecutionContext"]) {
  if (imports.includes(stale)) throw new Error(`stale registration import remains: ${stale}`)
}
if (!imports.includes("createLoopRegistration")) throw new Error("Loop registration import missing")
if (!imports.includes("normalizedModelRef")) throw new Error("normalizedModelRef must remain for runtime fireAction")

await fs.writeFile(legacyPath, legacy)
console.log("Loop registration refactor transform complete")
