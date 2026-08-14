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

const oldJobsImport = 'import { presetDefaults, jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob, goalStatusText } from "./core/jobs.js"'
const newJobsImport = 'import { jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob, goalStatusText } from "./core/jobs.js"'
requireOnce(legacy, oldJobsImport, "jobs import")
legacy = legacy.replace(oldJobsImport, newJobsImport)

const oldContextImport = 'import { normalizedModelRef, updateSessionExecutionContext, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"'
const newContextImport = 'import { normalizedModelRef, updateSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"'
requireOnce(legacy, oldContextImport, "session-context import")
legacy = legacy.replace(oldContextImport, newContextImport)

const oldCommandsImport = 'import { markHandled, consumeHandled, hasHandledCommandEvent, markHandledCommandEvent, forgetHandledCommandEvent, clearCommandLifecycle, commandName, isPreset, isLoopCommandName, commandArgsText } from "./opencode/commands.js"'
const newCommandsImports = 'import { clearCommandLifecycle } from "./opencode/commands.js"\nimport { createCommandRouter } from "./opencode/command-router.js"'
requireOnce(legacy, oldCommandsImport, "commands import")
legacy = legacy.replace(oldCommandsImport, newCommandsImports)

const schedulerBinding = 'const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime\n'
requireOnce(legacy, schedulerBinding, "scheduler binding")
const routerWiring = `${schedulerBinding}
const handleCommand = createCommandRouter({
  rememberSession,
  handlers: {
    addGoal,
    statusGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    completeGoalCommand,
    blockGoalCommand,
    addLoop,
    stopLoop,
    statusLoop,
    logsLoop,
    helpLoop,
    runNow,
    updateJobState,
    doctorLoop,
    initLoop,
    exportLoop,
  },
})
`
legacy = legacy.replace(schedulerBinding, routerWiring)

legacy = removeUntil(
  legacy,
  'async function handleCommand(directory, client, input, fallbackName, fallbackArgs, output, source = "before") {',
  'function goalTools(defaultDirectory) {',
  "command router implementation",
)

if (legacy.includes('async function handleCommand(directory, client, input, fallbackName, fallbackArgs, output, source = "before") {')) {
  throw new Error("local command router remains in legacy source")
}
if (!legacy.includes("const handleCommand = createCommandRouter({")) throw new Error("command router wiring missing")
if (!legacy.includes("function goalTools(defaultDirectory) {")) throw new Error("goalTools must remain in legacy source")
if (!legacy.includes('"command.execute.before": async (input, output) => { await handleCommand(')) throw new Error("before hook no longer routes through handleCommand")
if (!legacy.includes('if (event.type === "command.executed")')) throw new Error("command.executed compatibility hook missing")

const importLines = legacy.split("\n").filter((line) => line.startsWith("import "))
const joinedImports = importLines.join("\n")
for (const stale of [
  "presetDefaults",
  "captureSessionExecutionContext",
  "markHandled,",
  "consumeHandled,",
  "hasHandledCommandEvent",
  "markHandledCommandEvent",
  "forgetHandledCommandEvent",
  "commandName",
  "isPreset",
  "isLoopCommandName",
  "commandArgsText",
]) {
  if (joinedImports.includes(stale)) throw new Error(`stale command-router import remains in legacy source: ${stale}`)
}
if (!joinedImports.includes('import { clearCommandLifecycle } from "./opencode/commands.js"')) throw new Error("clearCommandLifecycle import must remain")
if (!joinedImports.includes('import { createCommandRouter } from "./opencode/command-router.js"')) throw new Error("command-router import missing")

await fs.writeFile(legacyPath, legacy)
console.log("command router refactor transform complete")
