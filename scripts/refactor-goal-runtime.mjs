import { promises as fs } from "node:fs"

const legacyPath = "src/source/legacy-v1.js"
const packagePath = "package.json"

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
const schedulerImport = 'import { createSchedulerRuntime } from "./runtime/scheduler.js"\n'
requireOnce(legacy, schedulerImport, "scheduler import")
legacy = legacy.replace(
  schedulerImport,
  schedulerImport + 'import { buildGoalPrompt, writeGoalReport, pickGoalJob, parseGoalToolText, hasConcreteGoalEvidence, goalChecksPassed, goalRequiresPassingChecks, goalMadeMeaningfulProgress } from "./runtime/goal-runtime.js"\n',
)

legacy = legacy.replace('const GOAL_REPORT_DIR = "goals"\n', "")
legacy = legacy.replace('const GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION"\n', "")
if (legacy.includes('const GOAL_REPORT_DIR = "goals"') || legacy.includes('const GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION"')) {
  throw new Error("goal constants were not removed")
}

legacy = removeUntil(
  legacy,
  "async function buildGoalPrompt(directory, job) {",
  "async function buildPrompt(directory, job) {",
  "goal prompt helper",
)
legacy = removeUntil(
  legacy,
  "function goalReportPath(directory, sessionID, job) {",
  "async function rejectGoalCompletion(directory, sessionID, state, job, reason) {",
  "goal report/evidence helper block",
)
legacy = removeUntil(
  legacy,
  "function goalProgressSnapshot(job) {",
  "async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob) {",
  "goal progress helper block",
)

for (const moved of [
  "async function buildGoalPrompt(directory, job)",
  "function goalReportPath(directory, sessionID, job)",
  "function goalReportText(job)",
  "async function writeGoalReport(directory, sessionID, job)",
  "function pickGoalJob(state, target = \"\")",
  "function parseGoalToolText(args, fields)",
  "function hasConcreteGoalEvidence(value)",
  "function goalChecksPassed(job)",
  "function goalRequiresPassingChecks(job)",
  "function goalProgressSnapshot(job)",
  "function goalMadeMeaningfulProgress(beforeJob, afterJob)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved helper remains in legacy source: ${moved}`)
}
if (!legacy.includes("async function rejectGoalCompletion(directory, sessionID, state, job, reason)")) {
  throw new Error("goal completion rejection helper must remain in legacy source")
}
await fs.writeFile(legacyPath, legacy)

const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"))
if (!pkg.scripts?.check || !pkg.scripts?.test) throw new Error("package scripts missing")
if (!pkg.scripts.check.includes("src/source/runtime/goal-runtime.js")) {
  pkg.scripts.check = pkg.scripts.check.replace(
    "node --check src/source/runtime/scheduler.js",
    "node --check src/source/runtime/scheduler.js && node --check src/source/runtime/goal-runtime.js",
  )
}
if (!pkg.scripts.check.includes("scripts/goal-runtime-test.mjs")) {
  pkg.scripts.check = pkg.scripts.check.replace(
    "node --check scripts/scheduler-runtime-test.mjs",
    "node --check scripts/scheduler-runtime-test.mjs && node --check scripts/goal-runtime-test.mjs",
  )
}
if (!pkg.scripts.test.includes("node scripts/goal-runtime-test.mjs")) {
  pkg.scripts.test = pkg.scripts.test.replace(
    "node scripts/scheduler-runtime-test.mjs",
    "node scripts/scheduler-runtime-test.mjs && node scripts/goal-runtime-test.mjs",
  )
}
await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n")

console.log("goal runtime refactor transform complete")
