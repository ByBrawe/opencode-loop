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
  'import { now as defaultNow, splitFirst } from "../core/args.js"',
  'import { now as defaultNow } from "../core/args.js"',
  "executor args import")
executor = replaceOnce(executor,
  'import { actionKind, isGoalJob } from "../core/jobs.js"',
  'import { isGoalJob } from "../core/jobs.js"',
  "executor jobs import")
executor = replaceOnce(executor,
  'import { sdkErrorMessage as defaultErrorMessage, sdkCall as defaultSdkCall } from "../opencode/sdk.js"',
  'import { sdkErrorMessage as defaultErrorMessage } from "../opencode/sdk.js"',
  "executor sdk import")
executor = replaceOnce(executor,
  'import { normalizedModelRef as defaultNormalizedModelRef } from "../opencode/session-context.js"\n',
  "",
  "executor model import")
executor = replaceOnce(executor,
  'import { fireSdk as defaultFireSdk, compactTuiCommandName as defaultCompactTuiCommandName, log as defaultLog, toast as defaultToast } from "../opencode/host.js"',
  'import { fireSdk as defaultFireSdk, log as defaultLog, toast as defaultToast } from "../opencode/host.js"',
  "executor host import")
executor = replaceOnce(executor,
  'import { guardLoopOwnedUserMessage as defaultGuardLoopOwnedUserMessage } from "../opencode/messages.js"\n',
  "",
  "executor message import")
executor = replaceOnce(executor,
  'import { createCompactionRuntime } from "./compaction.js"',
  'import { createCompactionRuntime } from "./compaction.js"\nimport { createActionDispatcher } from "./action-dispatch.js"',
  "action dispatcher import")

executor = replaceOnce(executor,
  '  const sdkCall = typeof options.sdkCall === "function" ? options.sdkCall : defaultSdkCall\n',
  "",
  "sdkCall option")
executor = replaceOnce(executor,
  '  const normalizedModelRef = typeof options.normalizedModelRef === "function" ? options.normalizedModelRef : defaultNormalizedModelRef\n',
  "",
  "model option")
executor = replaceOnce(executor,
  '  const compactTuiCommandName = typeof options.compactTuiCommandName === "function" ? options.compactTuiCommandName : defaultCompactTuiCommandName\n',
  "",
  "compact command option")
executor = replaceOnce(executor,
  '  const guardLoopOwnedUserMessage = typeof options.guardLoopOwnedUserMessage === "function"\n    ? options.guardLoopOwnedUserMessage\n    : defaultGuardLoopOwnedUserMessage\n',
  "",
  "message guard option")

const compactionTail = `  const compactionRuntime = createCompactionRuntime({\n    activeRuns,\n    finalizeActiveRun,\n    appendLoopLog,\n    compactSession: options.compactSession,\n    log,\n    errorMessage,\n    now,\n  })\n\n`
const dispatcherBlock = `${compactionTail}  const actionDispatcher = createActionDispatcher({\n    buildPrompt,\n    compactionRuntime,\n    appendLoopLog,\n    sdkCall: options.sdkCall,\n    normalizedModelRef: options.normalizedModelRef,\n    fireSdk: options.fireSdk,\n    compactTuiCommandName: options.compactTuiCommandName,\n    toast,\n    guardLoopOwnedUserMessage: options.guardLoopOwnedUserMessage,\n    dangerousShell,\n  })\n\n`
executor = replaceOnce(executor, compactionTail, dispatcherBlock, "action dispatcher composition")

const fireStart = executor.indexOf("  async function fireAction(directory, client, sessionID, job) {")
if (fireStart < 0) throw new Error("missing fireAction block")
const dueStart = executor.indexOf("\n  async function maybeRunDueJobs", fireStart)
if (dueStart < 0) throw new Error("missing maybeRunDueJobs marker")
executor = executor.slice(0, fireStart) + "  const fireAction = actionDispatcher.fireAction\n" + executor.slice(dueStart)

for (const stale of ["splitFirst", "actionKind", "defaultSdkCall", "defaultNormalizedModelRef", "defaultCompactTuiCommandName", "defaultGuardLoopOwnedUserMessage"]) {
  if (executor.includes(stale)) throw new Error(`stale executor dependency remained: ${stale}`)
}
await writeFile(executorPath, executor, "utf8")

const packagePath = "package.json"
let pkg = await readFile(packagePath, "utf8")
pkg = replaceOnce(pkg,
  "node --check src/source/runtime/compaction.js && node --check src/source/runtime/executor.js",
  "node --check src/source/runtime/compaction.js && node --check src/source/runtime/action-dispatch.js && node --check src/source/runtime/executor.js",
  "package runtime check")
pkg = replaceOnce(pkg,
  "node scripts/compaction-runtime-test.mjs && node scripts/executor-runtime-test.mjs",
  "node scripts/compaction-runtime-test.mjs && node scripts/action-dispatch-test.mjs && node scripts/executor-runtime-test.mjs",
  "package runtime test")
await writeFile(packagePath, pkg, "utf8")

console.log("executor action dispatch extraction staged")
