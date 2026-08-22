import { DEFAULT_GOAL_MAX_NO_PROGRESS, parseDuration, durationToText } from "./args.js"
import { continuationProjectInstruction } from "./continuation.js"

export function presetDefaults(name) {
  // parseLoopArgs owns duration/flag/action parsing. Presets only provide real
  // defaults; deriving an action from the raw string made flag-only invocations
  // such as `/loop-compact --dry-run` use "--dry-run" as the action.
  if (name === "loop-compact") return { intervalMs: parseDuration("200m"), action: "/compact", kind: "compact", name: "compact", immediate: false }
  if (name === "loop-command" || name === "loop-cmd") return { intervalMs: 0, kind: "command", name: "command", immediate: false }
  if (name === "loop-prompt") return { intervalMs: 0, kind: "prompt", name: "prompt", immediate: true }
  if (name === "loop-ask") return { intervalMs: 0, kind: "prompt", name: "ask", immediate: false }
  if (name === "loop-shell") return { intervalMs: 0, kind: "shell", name: "shell", immediate: false }
  if (name === "loop-testfix") return { intervalMs: 0, name: "testfix", safe: true, askNever: true, verifyCommand: "npm test", testfixPreset: true, action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test" }
  if (name === "loop-progress") return { intervalMs: 0, name: "progress", safe: true, askNever: true, progressFile: "progress.md", action: "Read progress.md and continue the next unfinished TODO. Mark completed TODOs with [x]. Add useful TODOs when you discover them." }
  if (name === "loop-safe-dev") return { intervalMs: 0, name: "safe-dev", safe: true, askNever: true, noOverlap: true, checkpointOnly: true, batch: 5, progressFile: "progress.md", action: "Develop the project from progress.md. Work in small safe batches. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
  return { intervalMs: 0, name: "dev", askNever: true, progressFile: "progress.md", action: "Continue developing the project from progress.md. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
}

export function jobLabel(job) {
  const title = job.name ? `${job.name}: ` : ""
  const kind = job.kind ? ` [${job.kind}]` : ""
  const limit = job.maxRuns > 0 ? `, max ${job.maxRuns}` : ""
  const runtime = job.maxRuntimeMs > 0 ? `, runtime ${durationToText(job.maxRuntimeMs)}` : ""
  const timeout = job.timeoutMs > 0 ? `, timeout ${durationToText(job.timeoutMs)}` : ""
  const compact = job.compactEveryRuns > 0 ? `, compact every ${job.compactEveryRuns} runs` : job.compactEveryMs > 0 ? `, compact every ${durationToText(job.compactEveryMs)}` : ""
  const verify = job.verifyCommand ? ", verify" : ""
  const preflight = job.preflightCommand ? ", preflight" : ""
  const failures = job.maxFailures > 0 ? `, max failures ${job.maxFailures}` : ""
  const noProgress = isGoalJob(job) && (job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0 ? `, max no-progress ${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}` : ""
  const stopFile = job.stopFile ? ", stop-file" : ""
  const watch = job.watchPaths?.length ? `, watch ${job.watchPaths.join(",")}` : ""
  const paused = job.paused ? ", paused" : ""
  return `${title}${durationToText(job.intervalMs)}${kind} -> ${job.action || `[prompt-file: ${job.promptFile}]`}${limit}${runtime}${timeout}${compact}${verify}${preflight}${failures}${noProgress}${stopFile}${watch}${paused}`
}

export function matchJob(job, target, index) {
  const text = String(target || "").trim()
  if (!text || text.toLowerCase() === "all") return true
  return job.id === text || job.name === text || String(index + 1) === text
}

export function actionKind(action, job = {}) {
  const text = String(action || "").trim()
  const forced = String(job.kind || "").trim().toLowerCase()
  if (forced === "compact") return "compact"
  if (forced === "goal") return "goal"
  if (text === "/compact" || text === "/summarize") return "compact"
  if (forced === "prompt" || forced === "ask") return "prompt"
  if (forced === "command" || forced === "cmd" || forced === "slash") return "command"
  if (forced === "shell") return "shell"
  if (text.startsWith("/")) return "command"
  if (text.startsWith("!") || text.startsWith("$")) return "shell"
  return "prompt"
}

export function decoratePrompt(job) {
  const additions = []
  const continuation = continuationProjectInstruction(job.action)
  if (continuation) additions.push(continuation)
  if (job.progressFile) additions.push(`Use ${job.progressFile} as the main progress/TODO state file. Read it before choosing the next task and update it after work.`)
  if (job.lastVerifyFailure) additions.push("Previous verify command failed. Fix this before moving on. Failure summary: " + String(job.lastVerifyFailure).slice(0, 1200))
  if (job.askNever) additions.push("Do not ask the user questions. Make reasonable assumptions and continue. Only write a short BLOCKED note if truly blocked.")
  if (job.safe) additions.push("Safety rules: do not run destructive commands such as git reset, git clean, rm -rf, del /s, rmdir /s, force push, production deploys, production migrations, terraform destroy, or deleting user data. If such an action seems needed, write a BLOCKED note instead.")
  if (job.batch > 0) additions.push(`Batch rule: in this run, work on at most ${job.batch} unfinished TODO item(s). Mark completed items with [x].`)
  if (job.quiet) additions.push("Keep replies short. Summarize only what changed, tests run, and next step.")
  if (job.testCommand) additions.push(`After making changes, run this test/check command if applicable: ${job.testCommand}. If it fails, fix the failure and try again.`)
  if (job.checkpointOnly || job.gitCheckpoint) additions.push("Keep changes incremental and easy to review because the loop will create a checkpoint after the run.")
  if (!additions.length) return job.action
  return `${job.action}\n\nOpenCode loop instructions:\n- ${additions.join("\n- ")}`
}

export function isGoalJob(job) {
  return String(job?.kind || "").toLowerCase() === "goal"
}

export function goalStatusText(job) {
  const status = job?.goalStatus || (isGoalJob(job) ? "active" : "")
  if (!status) return ""
  if (status === "completed") return "completed"
  if (status === "blocked") return "blocked"
  if (job?.paused) return "paused"
  return status
}
