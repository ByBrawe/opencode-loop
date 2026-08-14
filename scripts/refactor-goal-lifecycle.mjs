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
const oldImport = 'import { buildGoalPrompt, writeGoalReport, pickGoalJob, parseGoalToolText, hasConcreteGoalEvidence, goalChecksPassed, goalRequiresPassingChecks, goalMadeMeaningfulProgress } from "./runtime/goal-runtime.js"'
const newImport = 'import { buildGoalPrompt, writeGoalReport, goalMadeMeaningfulProgress, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"'
requireOnce(legacy, oldImport, "goal runtime import")
legacy = legacy.replace(oldImport, newImport)

legacy = removeUntil(
  legacy,
  "async function rejectGoalCompletion(directory, sessionID, state, job, reason) {",
  "async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob) {",
  "goal completion rejection mutation",
)
legacy = removeUntil(
  legacy,
  "async function setGoalComplete(directory, sessionID, args = {}) {",
  "async function runGoalChecks(directory, sessionID, job, client) {",
  "goal lifecycle mutations",
)

for (const moved of [
  "async function rejectGoalCompletion(directory, sessionID, state, job, reason)",
  "async function setGoalComplete(directory, sessionID, args = {})",
  "async function setGoalBlocked(directory, sessionID, args = {})",
  "async function setGoalProgress(directory, sessionID, args = {})",
]) {
  if (legacy.includes(moved)) throw new Error(`moved lifecycle function remains in legacy source: ${moved}`)
}
for (const retained of [
  "async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob)",
  "async function runGoalChecks(directory, sessionID, job, client)",
]) {
  if (!legacy.includes(retained)) throw new Error(`retained goal policy function was removed: ${retained}`)
}
for (const removedImport of ["pickGoalJob", "parseGoalToolText", "hasConcreteGoalEvidence", "goalChecksPassed", "goalRequiresPassingChecks"]) {
  const importLine = legacy.split("\n").find((line) => line.includes('from "./runtime/goal-runtime.js"')) || ""
  if (importLine.includes(removedImport)) throw new Error(`stale goal runtime import remains: ${removedImport}`)
}

await fs.writeFile(legacyPath, legacy)
console.log("goal lifecycle refactor transform complete")
