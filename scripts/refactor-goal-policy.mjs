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
const oldGoalImport = 'import { buildGoalPrompt, writeGoalReport, goalMadeMeaningfulProgress, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"\n'
const newGoalImports = 'import { buildGoalPrompt, writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"\nimport { createGoalExecutionPolicy } from "./runtime/goal-policy.js"\n'
requireOnce(legacy, oldGoalImport, "goal runtime import")
legacy = legacy.replace(oldGoalImport, newGoalImports)

const policyAnchor = 'const DEFAULT_GOAL_ACTIVE_RECOVERY_MS = 180_000\n\n'
requireOnce(legacy, policyAnchor, "goal policy anchor")
legacy = legacy.replace(
  policyAnchor,
  policyAnchor + 'const { runGoalChecks, applyGoalNoProgressGuard } = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })\n\n',
)

legacy = removeUntil(
  legacy,
  "async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob) {",
  "async function finalizeActiveRun(directory, client, sessionID, options = {}) {",
  "goal execution policy block",
)

for (const moved of [
  "async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob)",
  "async function runGoalChecks(directory, sessionID, job, client)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved goal policy function remains in legacy source: ${moved}`)
}
if (!legacy.includes('createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })')) {
  throw new Error("goal execution policy is not wired into legacy runtime")
}
if (!legacy.includes("async function finalizeActiveRun(directory, client, sessionID, options = {})")) {
  throw new Error("finalizeActiveRun must remain in legacy source")
}
if (legacy.includes("goalMadeMeaningfulProgress")) {
  throw new Error("stale goalMadeMeaningfulProgress legacy reference remains")
}

await fs.writeFile(legacyPath, legacy)
console.log("goal policy refactor transform complete")
