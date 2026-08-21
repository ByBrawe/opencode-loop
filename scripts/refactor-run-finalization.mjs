import { readFile, writeFile } from "node:fs/promises"

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before)
  if (first < 0) throw new Error(`missing ${label}`)
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous ${label}`)
  return text.slice(0, first) + after + text.slice(first + before.length)
}

const executorPath = "src/source/runtime/executor.js"
let executor = await readFile(executorPath, "utf8")

executor = replaceOnce(executor,
  'import { writeGoalReport as defaultWriteGoalReport } from "./goal-runtime.js"\n',
  "",
  "goal report import")
executor = replaceOnce(executor,
  'import { createActionDispatcher } from "./action-dispatch.js"',
  'import { createActionDispatcher } from "./action-dispatch.js"\nimport { createRunFinalizationRuntime } from "./run-finalization.js"',
  "run finalization import")
executor = replaceOnce(executor,
  '  const writeGoalReport = typeof options.writeGoalReport === "function" ? options.writeGoalReport : defaultWriteGoalReport\n',
  "",
  "goal report option")

const actionBlock = `  const actionDispatcher = createActionDispatcher({\n    buildPrompt,\n    compactionRuntime,\n    appendLoopLog,\n    sdkCall: options.sdkCall,\n    normalizedModelRef: options.normalizedModelRef,\n    fireSdk: options.fireSdk,\n    compactTuiCommandName: options.compactTuiCommandName,\n    toast,\n    guardLoopOwnedUserMessage: options.guardLoopOwnedUserMessage,\n    dangerousShell,\n  })\n\n`
const composed = `${actionBlock}  const finalizationRuntime = createRunFinalizationRuntime({\n    runGoalChecks,\n    applyGoalNoProgressGuard,\n    createCheckpoint,\n    scheduleDueWork,\n    now,\n    writeState,\n    appendLoopLog,\n    runShellCommand,\n    notifyJob,\n    toast,\n    writeGoalReport: options.writeGoalReport,\n    dangerousShell,\n  })\n\n`
executor = replaceOnce(executor, actionBlock, composed, "run finalization composition")

const finalizeStart = executor.indexOf("    if (job.verifyCommand) {")
if (finalizeStart < 0) throw new Error("missing verify finalization block")
const finalizeTail = "    await scheduleDueWork(directory, client, sessionID)\n    return true\n  }\n\n  const fireAction"
const finalizeEnd = executor.indexOf(finalizeTail, finalizeStart)
if (finalizeEnd < 0) throw new Error("missing finalization tail")
executor = executor.slice(0, finalizeStart)
  + "    await finalizationRuntime.finalizeJob(directory, client, sessionID, state, job, active.job)\n    return true\n  }\n\n  const fireAction"
  + executor.slice(finalizeEnd + finalizeTail.length)

if (executor.includes("defaultWriteGoalReport")) throw new Error("stale goal report dependency remained")
await writeFile(executorPath, executor, "utf8")

const packagePath = "package.json"
let pkg = await readFile(packagePath, "utf8")
pkg = replaceOnce(pkg,
  "node --check src/source/runtime/action-dispatch.js && node --check src/source/runtime/executor.js",
  "node --check src/source/runtime/action-dispatch.js && node --check src/source/runtime/run-finalization.js && node --check src/source/runtime/executor.js",
  "package runtime check")
pkg = replaceOnce(pkg,
  "node scripts/action-dispatch-test.mjs && node scripts/executor-runtime-test.mjs",
  "node scripts/action-dispatch-test.mjs && node scripts/run-finalization-test.mjs && node scripts/executor-runtime-test.mjs",
  "package runtime test")
await writeFile(packagePath, pkg, "utf8")

console.log("run finalization extraction staged")
