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

const oldArgsImport = 'import { DEFAULT_GOAL_MAX_NO_PROGRESS, now, safeID, parseDuration, durationToText, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"'
const newArgsImport = 'import { now, safeID, parseDuration, durationToText, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"'
requireOnce(legacy, oldArgsImport, "args import")
legacy = legacy.replace(oldArgsImport, newArgsImport)

const routerImport = 'import { createCommandRouter } from "./opencode/command-router.js"\n'
requireOnce(legacy, routerImport, "command router import")
legacy = legacy.replace(routerImport, routerImport + 'import { createGoalCommandHandlers } from "./opencode/goal-commands.js"\n')

const schedulerBinding = 'const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime\n\n'
requireOnce(legacy, schedulerBinding, "scheduler binding")
const goalHandlerWiring = `${schedulerBinding}const {
  addGoal,
  statusGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  completeGoalCommand,
  blockGoalCommand,
} = createGoalCommandHandlers({
  addLoop,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
})

`
legacy = legacy.replace(schedulerBinding, goalHandlerWiring)

legacy = removeUntil(
  legacy,
  "async function statusGoal(directory, client, sessionID) {",
  "async function statusLoop(directory, client, sessionID) {",
  "Goal command handler block",
)

for (const moved of [
  "async function statusGoal(directory, client, sessionID)",
  "async function pauseGoal(directory, client, sessionID, args)",
  "async function resumeGoal(directory, client, sessionID, args)",
  "async function clearGoal(directory, client, sessionID, args)",
  "async function completeGoalCommand(directory, client, sessionID, args)",
  "async function blockGoalCommand(directory, client, sessionID, args)",
  "async function addGoal(directory, client, sessionID, args)",
]) {
  if (legacy.includes(moved)) throw new Error(`moved Goal command handler remains in legacy source: ${moved}`)
}
if (!legacy.includes("createGoalCommandHandlers({")) throw new Error("Goal command handler wiring missing")
if (!legacy.includes("async function addLoop(directory, client, sessionID, args, defaults = {})")) throw new Error("addLoop must remain in legacy source")
if (!legacy.includes("async function statusLoop(directory, client, sessionID)")) throw new Error("statusLoop must remain in legacy source")
if (legacy.includes("DEFAULT_GOAL_MAX_NO_PROGRESS")) throw new Error("stale DEFAULT_GOAL_MAX_NO_PROGRESS legacy reference remains")

await fs.writeFile(legacyPath, legacy)
console.log("Goal command handler refactor transform complete")
