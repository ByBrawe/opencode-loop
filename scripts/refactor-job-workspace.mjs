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

legacy = legacy.replace('import { promises as fs } from "node:fs"\n', "")

const oldArgsImport = 'import { now, safeID, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery } from "./core/args.js"'
const newArgsImport = 'import { now, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery } from "./core/args.js"'
requireOnce(legacy, oldArgsImport, "args import")
legacy = legacy.replace(oldArgsImport, newArgsImport)

const oldJobsImport = 'import { actionKind, decoratePrompt, isGoalJob } from "./core/jobs.js"'
const newJobsImport = 'import { actionKind, isGoalJob } from "./core/jobs.js"'
requireOnce(legacy, oldJobsImport, "jobs import")
legacy = legacy.replace(oldJobsImport, newJobsImport)

const oldStateImport = 'import { stateDir, ensureDir, pathExists, readState, writeState } from "./core/state.js"'
const newStateImport = 'import { pathExists, readState, writeState } from "./core/state.js"'
requireOnce(legacy, oldStateImport, "state import")
legacy = legacy.replace(oldStateImport, newStateImport)

const oldProcessImport = 'import { appendLoopLog, readSmallTextFile, runProcess, runShellCommand, notifyJob } from "./core/process.js"'
const newProcessImport = 'import { appendLoopLog, runShellCommand, notifyJob } from "./core/process.js"'
requireOnce(legacy, oldProcessImport, "process import")
legacy = legacy.replace(oldProcessImport, newProcessImport)

const oldGoalRuntimeImport = 'import { buildGoalPrompt, writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"'
const newGoalRuntimeImport = 'import { writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"'
requireOnce(legacy, oldGoalRuntimeImport, "goal runtime import")
legacy = legacy.replace(oldGoalRuntimeImport, newGoalRuntimeImport)

const goalPolicyImport = 'import { createGoalExecutionPolicy } from "./runtime/goal-policy.js"\n'
requireOnce(legacy, goalPolicyImport, "goal policy import")
legacy = legacy.replace(goalPolicyImport, goalPolicyImport + 'import { createJobWorkspaceRuntime, dangerousShell } from "./runtime/job-workspace.js"\n')

legacy = legacy.replace('const MAX_SCAN_FILES = 200\n', "")
legacy = legacy.replace('const MAX_SCAN_BYTES = 2_000_000\n', "")

const policyWiring = 'const { runGoalChecks, applyGoalNoProgressGuard } = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })\n'
requireOnce(legacy, policyWiring, "Goal policy wiring")
const workspaceWiring = `const {
  buildPrompt,
  ensureBranch,
  snapshotPaths,
  watchChanged,
  untilReached,
  createCheckpoint,
} = createJobWorkspaceRuntime({ toast })

${policyWiring}`
legacy = legacy.replace(policyWiring, workspaceWiring)

legacy = removeUntil(
  legacy,
  "function dangerousShell(command) {",
  "async function maybeCompact(directory, client, sessionID, job) {",
  "workspace prompt/branch/safety block",
)
legacy = removeUntil(
  legacy,
  "async function snapshotPaths(directory, files) {",
  "function updateSessionStatusFromEvent(event) {",
  "workspace watch/until/checkpoint block",
)

for (const moved of [
  "function dangerousShell(command)",
  "async function buildPrompt(directory, job)",
  "async function ensureBranch(directory, job, client, sessionID)",
  "async function snapshotPaths(directory, files)",
  "async function watchChanged(directory, job)",
  "async function fileContains(filePath, needle)",
  "async function untilReached(directory, job)",
  "async function createCheckpoint(directory, sessionID, job, client)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved workspace helper remains in legacy source: ${moved}`)
}
if (!legacy.includes("createJobWorkspaceRuntime({ toast })")) throw new Error("job workspace runtime wiring missing")
if (!legacy.includes("async function maybeCompact(directory, client, sessionID, job)")) throw new Error("compaction policy must remain in legacy source")
if (!legacy.includes("async function maybeRunDueJobs(directory, client, sessionID, options = {})")) throw new Error("due-job executor must remain in legacy source")

const imports = legacy.split("\n").filter((line) => line.startsWith("import ")).join("\n")
for (const stale of ["node:fs", "safeID", "decoratePrompt", "stateDir", "ensureDir", "readSmallTextFile", "runProcess", "buildGoalPrompt"]) {
  if (imports.includes(stale)) throw new Error(`stale workspace import remains: ${stale}`)
}
if (!imports.includes("createJobWorkspaceRuntime")) throw new Error("job workspace runtime import missing")
if (!imports.includes("dangerousShell")) throw new Error("dangerousShell import missing")
if (!imports.includes('from "node:path"')) throw new Error("path import must remain for stop-file execution policy")

await fs.writeFile(legacyPath, legacy)
console.log("job workspace refactor transform complete")
