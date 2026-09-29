// @bun
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// src/source/core/args.js
function now() {
  return Date.now();
}
function safeID(value) {
  return String(value || "job").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "job";
}
function parseDuration(value) {
  const input = String(value || "").trim();
  if (input === "0")
    return 0;
  const match = input.match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match)
    return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount < 0)
    return null;
  if (unit === "ms")
    return amount;
  if (unit.startsWith("s"))
    return amount * 1000;
  if (unit.startsWith("m"))
    return amount * 60000;
  if (unit.startsWith("h"))
    return amount * 3600000;
  if (unit.startsWith("d"))
    return amount * 86400000;
  return null;
}
function durationToText(ms) {
  if (ms === 0)
    return "every idle";
  if (!Number.isFinite(ms))
    return "unknown";
  if (ms % 86400000 === 0)
    return `${ms / 86400000}d`;
  if (ms % 3600000 === 0)
    return `${ms / 3600000}h`;
  if (ms % 60000 === 0)
    return `${ms / 60000}m`;
  if (ms % 1000 === 0)
    return `${ms / 1000}s`;
  return `${ms}ms`;
}
function splitFirst(input) {
  const match = String(input || "").trim().match(/^(\S+)\s*([\s\S]*)$/);
  if (!match)
    return ["", ""];
  return [match[1], (match[2] || "").trim()];
}
function stripOuterQuotes(value) {
  const input = String(value || "").trim();
  if (input.startsWith('"') && input.endsWith('"') || input.startsWith("'") && input.endsWith("'")) {
    return input.slice(1, -1);
  }
  return input;
}
function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}
function takeFlag(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i");
  const found = pattern.test(rest);
  return [found, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()];
}
function takeFlagValue(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, "i");
  const match = rest.match(pattern);
  if (!match)
    return [undefined, rest];
  const value = match[2] ?? match[3] ?? match[4];
  return [value, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()];
}
function takeAllFlagValues(rest, flag) {
  const values = [];
  let current = rest;
  while (true) {
    const [value, next] = takeFlagValue(current, flag);
    if (value === undefined)
      return [values, current];
    values.push(value);
    current = next;
  }
}
function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function parseCompactEvery(value) {
  const duration = parseDuration(value);
  if (duration !== null)
    return { compactEveryMs: duration };
  const runs = parsePositiveInt(value, 0);
  return runs > 0 ? { compactEveryRuns: runs } : {};
}
function parseLoopArgs(raw, defaults = {}) {
  let input = stripOuterQuotes(String(raw || "").trim());
  let first = "";
  let rest = input;
  let intervalMs = defaults.intervalMs ?? null;
  if (!input && defaults.action) {
    rest = defaults.action;
  } else {
    [first, rest] = splitFirst(input);
    if (first === "--watch") {
      intervalMs = defaults.intervalMs ?? 0;
      rest = input;
    } else if (first) {
      const parsedDuration = parseDuration(first);
      if (parsedDuration !== null)
        intervalMs = parsedDuration;
      else if (intervalMs === null)
        return { ok: false, error: "Usage: /loop 0s <prompt> | /loop 5m <prompt> | /loop-goal <objective> | /loop-command 200m /compact | /loop-shell 10m npm test | /loop --watch progress.md <prompt>" };
      else
        rest = input;
    }
  }
  if (intervalMs === null)
    intervalMs = 0;
  const job = {
    id: `${now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    name: defaults.name,
    action: defaults.action || "",
    kind: defaults.kind || undefined,
    intervalMs,
    immediate: defaults.immediate ?? true,
    maxRuns: defaults.maxRuns ?? 0,
    maxRuntimeMs: defaults.maxRuntimeMs ?? 0,
    maxFailures: defaults.maxFailures ?? 0,
    timeoutMs: defaults.timeoutMs ?? 0,
    until: defaults.until,
    stopFile: defaults.stopFile,
    progressFile: defaults.progressFile,
    promptFile: defaults.promptFile,
    includeFiles: Array.isArray(defaults.includeFiles) ? [...defaults.includeFiles] : [],
    watchPaths: Array.isArray(defaults.watchPaths) ? [...defaults.watchPaths] : [],
    compactEveryRuns: defaults.compactEveryRuns ?? 0,
    compactEveryMs: defaults.compactEveryMs ?? 0,
    testCommand: defaults.testCommand,
    verifyCommand: defaults.verifyCommand,
    preflightCommand: defaults.preflightCommand,
    postrunCommand: defaults.postrunCommand,
    notifyCommand: defaults.notifyCommand,
    branch: defaults.branch,
    branchDone: false,
    goalStatus: defaults.goalStatus,
    goalFile: defaults.goalFile,
    goalAcceptance: Array.isArray(defaults.goalAcceptance) ? [...defaults.goalAcceptance] : [],
    goalChecks: Array.isArray(defaults.goalChecks) ? [...defaults.goalChecks] : [],
    goalCompleteWhenChecksPass: defaults.goalCompleteWhenChecksPass ?? false,
    goalRequireEvidence: defaults.goalRequireEvidence,
    goalRequireChecksPass: defaults.goalRequireChecksPass,
    goalEvidenceFile: defaults.goalEvidenceFile,
    goalSummary: defaults.goalSummary || "",
    goalEvidence: defaults.goalEvidence || "",
    goalBlockedReason: defaults.goalBlockedReason || "",
    goalProgress: Array.isArray(defaults.goalProgress) ? [...defaults.goalProgress] : [],
    maxNoProgress: defaults.maxNoProgress,
    noProgressCount: defaults.noProgressCount ?? 0,
    lastProgressAt: defaults.lastProgressAt ?? 0,
    noOverlap: defaults.noOverlap ?? true,
    safe: defaults.safe ?? false,
    quiet: defaults.quiet ?? false,
    askNever: defaults.askNever ?? false,
    pauseOnVerifyFail: defaults.pauseOnVerifyFail ?? false,
    gitCheckpoint: defaults.gitCheckpoint ?? false,
    checkpointOnly: defaults.checkpointOnly ?? false,
    dryRun: defaults.dryRun ?? false,
    multi: defaults.multi ?? false,
    batch: defaults.batch ?? 0,
    runCount: 0,
    failureCount: 0,
    lastRunAt: 0,
    lastCompactAt: 0,
    lastCompactRunCount: 0,
    watchSnapshot: {},
    watchTriggered: false,
    createdAt: new Date().toISOString(),
    enabled: true,
    paused: false
  };
  let found;
  let value;
  [found, rest] = takeFlag(rest, "--no-now");
  if (found)
    job.immediate = false;
  [found, rest] = takeFlag(rest, "--now");
  if (found)
    job.immediate = true;
  [found, rest] = takeFlag(rest, "--no-overlap");
  if (found)
    job.noOverlap = true;
  [found, rest] = takeFlag(rest, "--allow-overlap");
  if (found)
    job.noOverlap = false;
  [found, rest] = takeFlag(rest, "--safe");
  if (found)
    job.safe = true;
  [found, rest] = takeFlag(rest, "--quiet");
  if (found)
    job.quiet = true;
  [found, rest] = takeFlag(rest, "--ask-never");
  if (found)
    job.askNever = true;
  [found, rest] = takeFlag(rest, "--git-checkpoint");
  if (found)
    job.gitCheckpoint = true;
  [found, rest] = takeFlag(rest, "--checkpoint-only");
  if (found)
    job.checkpointOnly = true;
  [found, rest] = takeFlag(rest, "--pause-on-verify-fail");
  if (found)
    job.pauseOnVerifyFail = true;
  [found, rest] = takeFlag(rest, "--dry-run");
  if (found)
    job.dryRun = true;
  [found, rest] = takeFlag(rest, "--multi");
  if (found)
    job.multi = true;
  [found, rest] = takeFlag(rest, "--replace");
  if (found)
    job.multi = false;
  [found, rest] = takeFlag(rest, "--prompt");
  if (found)
    job.kind = "prompt";
  [found, rest] = takeFlag(rest, "--ask");
  if (found)
    job.kind = "prompt";
  [found, rest] = takeFlag(rest, "--command");
  if (found)
    job.kind = "command";
  [found, rest] = takeFlag(rest, "--cmd");
  if (found)
    job.kind = "command";
  [found, rest] = takeFlag(rest, "--slash");
  if (found)
    job.kind = "command";
  [found, rest] = takeFlag(rest, "--shell");
  if (found)
    job.kind = "shell";
  [found, rest] = takeFlag(rest, "--compact");
  if (found)
    job.kind = "compact";
  [found, rest] = takeFlag(rest, "--goal");
  if (found)
    job.kind = "goal";
  [found, rest] = takeFlag(rest, "--complete-when-checks-pass");
  if (found)
    job.goalCompleteWhenChecksPass = true;
  [found, rest] = takeFlag(rest, "--no-complete-when-checks-pass");
  if (found)
    job.goalCompleteWhenChecksPass = false;
  [found, rest] = takeFlag(rest, "--require-evidence");
  if (found)
    job.goalRequireEvidence = true;
  [found, rest] = takeFlag(rest, "--allow-weak-evidence");
  if (found)
    job.goalRequireEvidence = false;
  [found, rest] = takeFlag(rest, "--require-checks-pass");
  if (found)
    job.goalRequireChecksPass = true;
  [found, rest] = takeFlag(rest, "--allow-complete-without-checks");
  if (found)
    job.goalRequireChecksPass = false;
  [found, rest] = takeFlag(rest, "--allow-complete-with-failing-checks");
  if (found)
    job.goalRequireChecksPass = false;
  [value, rest] = takeFlagValue(rest, "--name");
  if (value !== undefined)
    job.name = value.trim();
  [value, rest] = takeFlagValue(rest, "--max-runs");
  if (value !== undefined)
    job.maxRuns = parsePositiveInt(value, 0);
  [value, rest] = takeFlagValue(rest, "--max-turns");
  if (value !== undefined)
    job.maxRuns = parsePositiveInt(value, 0);
  [value, rest] = takeFlagValue(rest, "--max-no-progress");
  if (value !== undefined)
    job.maxNoProgress = parseNonNegativeInt(value, DEFAULT_GOAL_MAX_NO_PROGRESS);
  [value, rest] = takeFlagValue(rest, "--timeout");
  if (value !== undefined)
    job.timeoutMs = parseDuration(value) ?? 0;
  [value, rest] = takeFlagValue(rest, "--max-runtime");
  if (value !== undefined)
    job.maxRuntimeMs = parseDuration(value) ?? 0;
  [value, rest] = takeFlagValue(rest, "--max-failures");
  if (value !== undefined)
    job.maxFailures = parsePositiveInt(value, 0);
  [value, rest] = takeFlagValue(rest, "--until");
  if (value !== undefined)
    job.until = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--stop-file");
  if (value !== undefined)
    job.stopFile = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--progress-file");
  if (value !== undefined)
    job.progressFile = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--prompt-file");
  if (value !== undefined)
    job.promptFile = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--goal-file");
  if (value !== undefined)
    job.goalFile = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--evidence-file");
  if (value !== undefined)
    job.goalEvidenceFile = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--test");
  if (value !== undefined)
    job.testCommand = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--verify");
  if (value !== undefined)
    job.verifyCommand = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--preflight");
  if (value !== undefined)
    job.preflightCommand = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--postrun");
  if (value !== undefined)
    job.postrunCommand = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--notify");
  if (value !== undefined)
    job.notifyCommand = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--branch");
  if (value !== undefined)
    job.branch = stripOuterQuotes(value);
  [value, rest] = takeFlagValue(rest, "--batch");
  if (value !== undefined)
    job.batch = parsePositiveInt(value, 0);
  [value, rest] = takeFlagValue(rest, "--compact-every");
  if (value !== undefined)
    Object.assign(job, parseCompactEvery(value));
  const watch = takeAllFlagValues(rest, "--watch");
  job.watchPaths.push(...watch[0].map(stripOuterQuotes).filter(Boolean));
  rest = watch[1];
  const includes = takeAllFlagValues(rest, "--include-file");
  job.includeFiles.push(...includes[0].map(stripOuterQuotes).filter(Boolean));
  rest = includes[1];
  const acceptances = takeAllFlagValues(rest, "--acceptance");
  job.goalAcceptance.push(...acceptances[0].map(stripOuterQuotes).filter(Boolean));
  rest = acceptances[1];
  const success = takeAllFlagValues(rest, "--success");
  job.goalAcceptance.push(...success[0].map(stripOuterQuotes).filter(Boolean));
  rest = success[1];
  const checks = takeAllFlagValues(rest, "--check");
  job.goalChecks.push(...checks[0].map(stripOuterQuotes).filter(Boolean));
  rest = checks[1];
  job.action = stripOuterQuotes(rest || job.action || "");
  job.watchPaths = [...new Set(job.watchPaths)];
  job.includeFiles = [...new Set(job.includeFiles)];
  job.goalAcceptance = [...new Set(job.goalAcceptance || [])];
  job.goalChecks = [...new Set(job.goalChecks || [])];
  if (String(job.kind || "").toLowerCase() === "goal") {
    job.name = job.name || "goal";
    job.goalStatus = job.goalStatus || "active";
    job.safe = job.safe !== false;
    job.askNever = job.askNever !== false;
    job.noOverlap = job.noOverlap !== false;
    job.goalRequireEvidence = job.goalRequireEvidence !== false;
    job.goalRequireChecksPass = job.goalRequireChecksPass ?? job.goalChecks.length > 0;
    job.maxNoProgress = job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS;
  }
  job.lastRunAt = job.immediate ? 0 : now();
  if (!job.action && !job.promptFile && !job.goalFile)
    return { ok: false, error: "Missing action. Example: /loop 0s continue from progress.md, /loop-goal ship the feature, or /loop 0s --prompt-file loop-prompt.md" };
  return { ok: true, job };
}
var DEFAULT_GOAL_MAX_NO_PROGRESS = 3;

// src/source/core/continuation.js
function isContinuationShorthand(value) {
  return CONTINUATION_SHORTHANDS.has(String(value || "").trim().toLowerCase().replace(/\s+/g, " "));
}
function isCompletionBoundedContinuation(value) {
  const text = String(value || "").trim();
  return COMPLETION_BOUNDED_PATTERNS.some((pattern) => pattern.test(text));
}
function continuationProjectInstruction(value) {
  if (!isContinuationShorthand(value) && !isCompletionBoundedContinuation(value))
    return "";
  const finish = isCompletionBoundedContinuation(value) ? " If you believe the project is finished, perform a fresh verification pass before declaring completion; report both that the project is complete and that no work remains only when you have concrete current evidence." : "";
  return `Treat this as continuation of the current project and conversation, not a fresh task. Inspect the repository state, relevant files, TODO/progress notes, recent changes, and git status as needed to identify the next unfinished step. Continue from existing work, do not redo completed work, and verify meaningful changes when practical.${finish}`;
}
var CONTINUATION_SHORTHANDS, COMPLETION_BOUNDED_PATTERNS;
var init_continuation = __esm(() => {
  CONTINUATION_SHORTHANDS = new Set([
    "continue",
    "continue.",
    "continue working",
    "keep going",
    "go on",
    "devam",
    "devam et",
    "devam et.",
    "devam et bakal\u0131m"
  ]);
  COMPLETION_BOUNDED_PATTERNS = [
    /\bbitene kadar\b/i,
    /\b(?:tamamen|komple) projeyi bitir\b/i,
    /\bi\u015Fi bitir\b/i,
    /\buntil (?:it(?:'s| is) )?(?:done|complete|completed|finished)\b/i,
    /\bfinish (?:the )?(?:project|task|work)\b/i,
    /\bkeep going until\b/i
  ];
});

// src/source/core/jobs.js
function presetDefaults(name) {
  if (name === "loop-compact")
    return { intervalMs: parseDuration("200m"), action: "/compact", kind: "compact", name: "compact", immediate: false };
  if (name === "loop-command" || name === "loop-cmd")
    return { intervalMs: 0, kind: "command", name: "command", immediate: false };
  if (name === "loop-prompt")
    return { intervalMs: 0, kind: "prompt", name: "prompt", immediate: true };
  if (name === "loop-ask")
    return { intervalMs: 0, kind: "prompt", name: "ask", immediate: false };
  if (name === "loop-shell")
    return { intervalMs: 0, kind: "shell", name: "shell", immediate: false };
  if (name === "loop-testfix")
    return { intervalMs: 0, name: "testfix", safe: true, askNever: true, verifyCommand: "npm test", testfixPreset: true, action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test" };
  if (name === "loop-progress")
    return { intervalMs: 0, name: "progress", safe: true, askNever: true, progressFile: "progress.md", action: "Read progress.md and continue the next unfinished TODO. Mark completed TODOs with [x]. Add useful TODOs when you discover them." };
  if (name === "loop-safe-dev")
    return { intervalMs: 0, name: "safe-dev", safe: true, askNever: true, noOverlap: true, checkpointOnly: true, batch: 5, progressFile: "progress.md", action: "Develop the project from progress.md. Work in small safe batches. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." };
  return { intervalMs: 0, name: "dev", askNever: true, progressFile: "progress.md", action: "Continue developing the project from progress.md. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." };
}
function jobLabel(job) {
  const title = job.name ? `${job.name}: ` : "";
  const kind = job.kind ? ` [${job.kind}]` : "";
  const limit = job.maxRuns > 0 ? `, max ${job.maxRuns}` : "";
  const runtime = job.maxRuntimeMs > 0 ? `, runtime ${durationToText(job.maxRuntimeMs)}` : "";
  const timeout = job.timeoutMs > 0 ? `, timeout ${durationToText(job.timeoutMs)}` : "";
  const compact = job.compactEveryRuns > 0 ? `, compact every ${job.compactEveryRuns} runs` : job.compactEveryMs > 0 ? `, compact every ${durationToText(job.compactEveryMs)}` : "";
  const verify = job.verifyCommand ? ", verify" : "";
  const preflight = job.preflightCommand ? ", preflight" : "";
  const failures = job.maxFailures > 0 ? `, max failures ${job.maxFailures}` : "";
  const noProgress = isGoalJob(job) && (job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0 ? `, max no-progress ${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}` : "";
  const stopFile = job.stopFile ? ", stop-file" : "";
  const watch = job.watchPaths?.length ? `, watch ${job.watchPaths.join(",")}` : "";
  const paused = job.paused ? ", paused" : "";
  return `${title}${durationToText(job.intervalMs)}${kind} -> ${job.action || `[prompt-file: ${job.promptFile}]`}${limit}${runtime}${timeout}${compact}${verify}${preflight}${failures}${noProgress}${stopFile}${watch}${paused}`;
}
function matchJob(job, target, index) {
  const text = String(target || "").trim();
  if (!text || text.toLowerCase() === "all")
    return true;
  return job.id === text || job.name === text || String(index + 1) === text;
}
function actionKind(action, job = {}) {
  const text = String(action || "").trim();
  const forced = String(job.kind || "").trim().toLowerCase();
  if (forced === "compact")
    return "compact";
  if (forced === "goal")
    return "goal";
  if (text === "/compact" || text === "/summarize")
    return "compact";
  if (forced === "prompt" || forced === "ask")
    return "prompt";
  if (forced === "command" || forced === "cmd" || forced === "slash")
    return "command";
  if (forced === "shell")
    return "shell";
  if (text.startsWith("/"))
    return "command";
  if (text.startsWith("!") || text.startsWith("$"))
    return "shell";
  return "prompt";
}
function decoratePrompt(job) {
  const additions = [];
  const continuation = continuationProjectInstruction(job.action);
  if (continuation)
    additions.push(continuation);
  if (job.progressFile)
    additions.push(`Use ${job.progressFile} as the main progress/TODO state file. Read it before choosing the next task and update it after work.`);
  if (job.lastVerifyFailure)
    additions.push("Previous verify command failed. Fix this before moving on. Failure summary: " + String(job.lastVerifyFailure).slice(0, 1200));
  if (job.askNever)
    additions.push("Do not ask the user questions. Make reasonable assumptions and continue. Only write a short BLOCKED note if truly blocked.");
  if (job.safe)
    additions.push("Safety rules: do not run destructive commands such as git reset, git clean, rm -rf, del /s, rmdir /s, force push, production deploys, production migrations, terraform destroy, or deleting user data. If such an action seems needed, write a BLOCKED note instead.");
  if (job.batch > 0)
    additions.push(`Batch rule: in this run, work on at most ${job.batch} unfinished TODO item(s). Mark completed items with [x].`);
  if (job.quiet)
    additions.push("Keep replies short. Summarize only what changed, tests run, and next step.");
  if (job.testCommand)
    additions.push(`After making changes, run this test/check command if applicable: ${job.testCommand}. If it fails, fix the failure and try again.`);
  if (job.checkpointOnly || job.gitCheckpoint)
    additions.push("Keep changes incremental and easy to review because the loop will create a checkpoint after the run.");
  if (!additions.length)
    return job.action;
  return `${job.action}

OpenCode loop instructions:
- ${additions.join(`
- `)}`;
}
function isGoalJob(job) {
  return String(job?.kind || "").toLowerCase() === "goal";
}
function goalStatusText(job) {
  const status = job?.goalStatus || (isGoalJob(job) ? "active" : "");
  if (!status)
    return "";
  if (status === "completed")
    return "completed";
  if (status === "blocked")
    return "blocked";
  if (job?.paused)
    return "paused";
  return status;
}
function applyTestfixPreset(job, defaults = {}) {
  if (defaults.testfixPreset) {
    const defaultCommand = String(defaults.verifyCommand || "npm test");
    const parsedAction = String(job.action || "").trim();
    const usedDefaultAction = parsedAction === String(defaults.action || "").trim();
    if (!usedDefaultAction && job.verifyCommand === defaults.verifyCommand) {
      job.verifyCommand = parsedAction;
      job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsedAction}`;
    } else if (usedDefaultAction && job.verifyCommand !== defaults.verifyCommand) {
      job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${job.verifyCommand || defaultCommand}`;
    }
  }
  return job;
}
var init_jobs = __esm(() => {
  init_continuation();
});

// src/source/core/state.js
import { promises as fs } from "fs";
import os from "os";
import path3 from "path";
function stateDir(directory) {
  return path3.join(directory, STATE_DIR);
}
function statePath(directory, sessionID) {
  return path3.join(stateDir(directory), `${safeID(sessionID)}.json`);
}
async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}
function stateLockKey(directory, sessionID) {
  return `${path3.resolve(directory)}:${safeID(sessionID)}`;
}
async function withStateWriteLock(directory, sessionID, fn) {
  const key = stateLockKey(directory, sessionID);
  const previous = stateWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => {}).then(() => current);
  stateWriteLocks.set(key, next);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateWriteLocks.get(key) === next)
      stateWriteLocks.delete(key);
  }
}
async function readStateFile(directory, sessionID) {
  const target = statePath(directory, sessionID);
  const attempts = 5;
  for (let attempt = 0;attempt < attempts; attempt++) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"));
      return { version: 4, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
    } catch (error) {
      if (error?.code === "ENOENT")
        return { version: 4, jobs: [] };
      const transient = error instanceof SyntaxError || isRetriableStateWriteError(error);
      if (!transient || attempt === attempts - 1)
        break;
      await delay(25 * (attempt + 1));
    }
  }
  try {
    await ensureDir(stateDir(directory));
    await fs.copyFile(target, `${target}.corrupt-${Date.now()}`);
  } catch {}
  return { version: 4, jobs: [] };
}
async function readState(directory, sessionID) {
  const state = await readStateFile(directory, sessionID);
  Object.defineProperty(state, STATE_BASELINE, {
    value: structuredClone(state.jobs || []),
    enumerable: false,
    configurable: false,
    writable: true
  });
  return state;
}
function isRetriableStateWriteError(error) {
  const code = error?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST" || code === "EAGAIN";
}
async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function writeFileAtomically(target, contents, options = {}) {
  const encoding = options.encoding || "utf8";
  const attempts = Math.max(1, Number(options.attempts) || 5);
  const temp = path3.join(os.tmpdir(), `opencode-loop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  await fs.writeFile(temp, contents, encoding);
  try {
    let lastError;
    for (let attempt = 0;attempt < attempts; attempt++) {
      try {
        await fs.rename(temp, target);
        return;
      } catch (error) {
        lastError = error;
        if (error?.code === "EXDEV")
          break;
        if (!isRetriableStateWriteError(error))
          throw error;
        if (attempt < attempts - 1)
          await delay(25 * (attempt + 1));
      }
    }
    for (let attempt = 0;attempt < attempts; attempt++) {
      try {
        await fs.copyFile(temp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetriableStateWriteError(error))
          throw error;
        if (attempt < attempts - 1)
          await delay(25 * (attempt + 1));
      }
    }
    try {
      await fs.writeFile(target, contents, encoding);
      return;
    } catch (error) {
      if (lastError && !error.cause)
        error.cause = lastError;
      throw error;
    }
  } finally {
    try {
      await fs.rm(temp, { force: true });
    } catch {}
  }
}
function stateValuesEqual(left, right) {
  if (Object.is(left, right))
    return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
function mergeStateJob(baseJob, intendedJob, currentJob) {
  const merged = structuredClone(currentJob || {});
  const keys = new Set([
    ...Object.keys(baseJob || {}),
    ...Object.keys(intendedJob || {})
  ]);
  for (const key of keys) {
    const baseHas = Object.prototype.hasOwnProperty.call(baseJob || {}, key);
    const intendedHas = Object.prototype.hasOwnProperty.call(intendedJob || {}, key);
    const currentHas = Object.prototype.hasOwnProperty.call(currentJob || {}, key);
    const intendedChanged = baseHas !== intendedHas || !stateValuesEqual(baseJob?.[key], intendedJob?.[key]);
    if (!intendedChanged)
      continue;
    const currentChanged = baseHas !== currentHas || !stateValuesEqual(baseJob?.[key], currentJob?.[key]);
    const sameResult = intendedHas === currentHas && stateValuesEqual(intendedJob?.[key], currentJob?.[key]);
    if (currentChanged && !sameResult)
      continue;
    if (intendedHas)
      merged[key] = structuredClone(intendedJob[key]);
    else
      delete merged[key];
  }
  return merged;
}
function mergeStateJobs(baseJobs, intendedJobs, currentJobs) {
  const byID = (jobs) => new Map((jobs || []).filter((job) => job?.id).map((job) => [job.id, job]));
  const base = byID(baseJobs);
  const intended = byID(intendedJobs);
  const current = byID(currentJobs);
  const merged = [];
  for (const currentJob of currentJobs || []) {
    const id = currentJob?.id;
    if (!id || !base.has(id)) {
      merged.push(structuredClone(currentJob));
      continue;
    }
    const baseJob = base.get(id);
    const intendedJob = intended.get(id);
    if (!intendedJob) {
      if (!stateValuesEqual(baseJob, currentJob))
        merged.push(structuredClone(currentJob));
      continue;
    }
    merged.push(mergeStateJob(baseJob, intendedJob, currentJob));
  }
  for (const intendedJob of intendedJobs || []) {
    const id = intendedJob?.id;
    if (!id || base.has(id) || current.has(id))
      continue;
    merged.push(structuredClone(intendedJob));
  }
  return merged;
}
async function writeState(directory, sessionID, state) {
  await withStateWriteLock(directory, sessionID, async () => {
    await ensureDir(stateDir(directory));
    const target = statePath(directory, sessionID);
    const baseline = state?.[STATE_BASELINE];
    let jobs = structuredClone(state.jobs || []);
    if (Array.isArray(baseline)) {
      const current = await readStateFile(directory, sessionID);
      jobs = mergeStateJobs(baseline, jobs, current.jobs || []);
      state.jobs = structuredClone(jobs);
      state[STATE_BASELINE] = structuredClone(jobs);
    }
    const payload = JSON.stringify({ version: 4, jobs }, null, 2);
    await writeFileAtomically(target, payload);
  });
}
async function removeState(directory, sessionID) {
  await withStateWriteLock(directory, sessionID, async () => {
    try {
      await fs.unlink(statePath(directory, sessionID));
    } catch {}
  });
}
var STATE_DIR = ".opencode/opencode-loop", STATE_BASELINE, stateWriteLocks;
var init_state = __esm(() => {
  STATE_BASELINE = Symbol("opencode-loop-state-baseline");
  stateWriteLocks = new Map;
});

// src/source/core/process.js
import { promises as fs2 } from "fs";
import path4 from "path";
import { spawn as spawn2 } from "child_process";
async function appendLoopLog(directory, line, extra = {}) {
  try {
    await ensureDir(stateDir(directory));
    await fs2.appendFile(path4.join(stateDir(directory), "loop.log"), JSON.stringify({ time: new Date().toISOString(), line, ...extra }) + `
`);
  } catch {}
}
async function readSmallTextFile(filePath, maxBytes = 120000) {
  try {
    const stat = await fs2.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes)
      return "";
    return await fs2.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
async function runProcess(command, args, cwd, timeoutMs = 60000) {
  return await new Promise((resolve) => {
    const child = spawn2(command, args, { cwd, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)));
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
async function runShellCommand(command, cwd, timeoutMs = 120000) {
  return await new Promise((resolve) => {
    const child = spawn2(command, [], { cwd, shell: true, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)));
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
var init_process = __esm(() => {
  init_state();
});

// src/source/runtime/goal-report.js
var init_goal_report = __esm(() => {
  init_jobs();
  init_state();
});
// src/source/runtime/goal-prompt.js
import path5 from "path";
async function buildGoalPrompt(directory, job) {
  const sections = [];
  sections.push(`Working directory:
${path5.resolve(directory)}
Keep every file operation inside this directory. Prefer workspace-relative paths such as "src/index.js"; never turn a relative path into a root path such as "/src/index.js".`);
  const objective = String(job.action || "").trim();
  if (objective)
    sections.push(`Goal objective:
${objective}`);
  if (job.goalFile) {
    const text = await readSmallTextFile(path5.resolve(directory, job.goalFile), 120000);
    if (text.trim())
      sections.push(`Goal file ${job.goalFile}:
${text.trim()}`);
    else
      sections.push(`Goal file ${job.goalFile} was requested but could not be read. Continue from the inline goal objective.`);
  }
  if (job.promptFile) {
    const text = await readSmallTextFile(path5.resolve(directory, job.promptFile), 120000);
    if (text.trim())
      sections.push(`Extra goal instructions from ${job.promptFile}:
${text.trim()}`);
  }
  if (job.goalAcceptance?.length)
    sections.push(`Acceptance criteria:
` + job.goalAcceptance.map((item, index) => `${index + 1}. ${item}`).join(`
`));
  if (job.goalChecks?.length)
    sections.push(`Verification commands that define useful evidence:
` + job.goalChecks.map((item, index) => `${index + 1}. ${item}`).join(`
`));
  if (job.verifyCommand)
    sections.push(`Post-turn verify command configured by the loop: ${job.verifyCommand}`);
  if (job.lastGoalChecks?.length)
    sections.push(`Latest goal check results:
` + job.lastGoalChecks.map((item) => `- ${item.command}: exit ${item.code}`).join(`
`));
  if (job.lastVerifyFailure)
    sections.push(`Previous verify/check failure summary:
` + String(job.lastVerifyFailure).slice(0, 1600));
  if (job.goalCompletionRejectedReason)
    sections.push(`Previous completion attempt was rejected:
${job.goalCompletionRejectedReason}`);
  if ((job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0)
    sections.push(`No-progress guard:
${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS} recent turn(s) without recorded meaningful progress.`);
  if (job.goalProgress?.length)
    sections.push(`Recent goal progress:
` + job.goalProgress.slice(-5).map((item) => `- ${item.time}: ${item.summary}`).join(`
`));
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path5.resolve(directory, file), 80000);
    if (text.trim())
      sections.push(`Context from ${file}:
${text.trim().slice(0, 20000)}`);
  }
  return `${GOAL_PROMPT_PREFIX}.

You are pursuing an experimental persistent goal for this OpenCode session. This is not a timer loop and not a one-shot prompt. Keep working toward the goal until it is completed, blocked, paused, cleared, or stopped by safety limits.

Rules:
- Work on the next smallest useful step toward the goal.
- Prefer direct code changes, tests, typechecks, builds, and evidence over discussion.
- Do not claim the goal is complete unless the acceptance criteria are satisfied and verification evidence supports it.
- If verification commands are configured, do not call opencode_loop_goal_complete until the latest relevant checks have passed unless the user explicitly overrides the goal.
- Completion evidence must be concrete: mention commands, files, checks, results, or code inspection details.
- When the goal is complete, call the tool opencode_loop_goal_complete with a summary and evidence.
- If you are truly blocked and need user input, call the tool opencode_loop_goal_blocked with the reason and what is needed.
- If you made meaningful progress but the goal is not complete, call the tool opencode_loop_goal_progress with the summary and next step.
- If you cannot make meaningful progress for this turn, call opencode_loop_goal_blocked instead of repeating the same attempt.
- Do not call completion tools just to be polite; only call them when the state is real.
- Do not ask the user questions unless blocked; make reasonable assumptions and continue.
- Follow safety rules: no destructive commands, force pushes, production deploys, production database resets, or deleting user data.

${sections.join(`

---

`)}`;
}
var GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION";
var init_goal_prompt = __esm(() => {
  init_process();
});

// src/source/runtime/goal-runtime.js
var init_goal_runtime = __esm(() => {
  init_jobs();
  init_state();
  init_process();
  init_goal_report();
  init_goal_prompt();
  init_goal_report();
});

// src/source/runtime/job-workspace.js
import { promises as fs3 } from "fs";
import path6 from "path";
function requireFunction(value, name) {
  if (typeof value !== "function")
    throw new TypeError(`createJobWorkspaceRuntime requires ${name}`);
  return value;
}
function dangerousShell(command) {
  const text = String(command || "").toLowerCase();
  return [
    /\brm\b(?=[^\r\n]*\s-{1,2}(?:[a-z]*r[a-z]*|recursive)\b)(?=[^\r\n]*\s-{1,2}(?:[a-z]*f[a-z]*|force)\b)/,
    /\bremove-item\b[^\r\n]*(?:-recurse|-force)/,
    /\bgit\s+reset\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+push\b/,
    /\bdel\b[^\r\n]*\s\/s\b/,
    /\b(?:rmdir|rd)\b[^\r\n]*\s\/s\b/,
    /(?:^|[;&|]\s*)format(?:\.com)?\s+(?:[a-z]:|\/(?:fs|q)\b)/,
    /\bterraform\s+destroy\b/,
    /\bkubectl\s+delete\b/,
    /\bdeploy\b.*\bproduction\b/
  ].some((pattern) => pattern.test(text));
}
function createJobWorkspaceRuntime(options = {}) {
  const toast = requireFunction(options.toast, "toast");
  const runProcess2 = typeof options.runProcess === "function" ? options.runProcess : runProcess;
  const appendLoopLog2 = typeof options.appendLoopLog === "function" ? options.appendLoopLog : appendLoopLog;
  const readSmallTextFile2 = typeof options.readSmallTextFile === "function" ? options.readSmallTextFile : readSmallTextFile;
  const buildGoalPrompt2 = typeof options.buildGoalPrompt === "function" ? options.buildGoalPrompt : buildGoalPrompt;
  async function buildPrompt(directory, job) {
    if (isGoalJob(job))
      return await buildGoalPrompt2(directory, job);
    const sections = [];
    if (job.promptFile) {
      const text = await readSmallTextFile2(path6.resolve(directory, job.promptFile));
      if (text.trim())
        sections.push(`Instructions from ${job.promptFile}:
${text.trim()}`);
      else
        sections.push(`Prompt file ${job.promptFile} was requested but could not be read. Continue from the regular action instead.`);
    }
    if (job.action)
      sections.push(decoratePrompt(job));
    for (const file of job.includeFiles || []) {
      const text = await readSmallTextFile2(path6.resolve(directory, file), 80000);
      if (text.trim())
        sections.push(`Context from ${file}:
${text.trim().slice(0, 20000)}`);
    }
    return sections.join(`

---

`) || decoratePrompt(job);
  }
  async function ensureBranch(directory, job, client, sessionID) {
    if (!job.branch || job.branchDone)
      return job;
    const branch = safeID(job.branch);
    const inRepo = await runProcess2("git", ["rev-parse", "--is-inside-work-tree"], directory, 1e4);
    if (inRepo.code !== 0) {
      job.branchDone = false;
      job.branchUnavailable = true;
      return job;
    }
    let result = await runProcess2("git", ["switch", branch], directory, 30000);
    if (result.code !== 0)
      result = await runProcess2("git", ["switch", "-c", branch], directory, 30000);
    job.branchDone = result.code === 0;
    await toast(client, result.code === 0 ? `Loop branch active: ${branch}` : `Could not switch/create branch: ${branch}`, result.code === 0 ? "success" : "warning");
    await appendLoopLog2(directory, "branch", { sessionID, branch, code: result.code });
    return job;
  }
  async function snapshotPaths(directory, files) {
    const snapshot = {};
    for (const file of files || []) {
      try {
        const stat = await fs3.stat(path6.resolve(directory, file));
        snapshot[file] = `${stat.mtimeMs}:${stat.size}`;
      } catch {
        snapshot[file] = "missing";
      }
    }
    return snapshot;
  }
  async function watchChanged(directory, job) {
    if (!job.watchPaths?.length)
      return false;
    const next = await snapshotPaths(directory, job.watchPaths);
    const previous = job.watchSnapshot || {};
    const changed = job.watchPaths.some((file) => previous[file] !== next[file]);
    if (changed)
      job.watchSnapshot = next;
    return changed;
  }
  async function fileContains(filePath, needle) {
    try {
      const stat = await fs3.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_SCAN_BYTES)
        return false;
      return (await fs3.readFile(filePath, "utf8")).includes(needle);
    } catch {
      return false;
    }
  }
  async function untilReached(directory, job) {
    if (!job.until)
      return false;
    const controlRoots = new Set([
      stateDir(directory),
      ...["goals", "goal-locks", "goal-handoff-locks", "goal-sequences"].map((name) => path6.join(directory, ".opencode", name))
    ].map((root) => path6.resolve(root).toLowerCase()));
    const files = ["progress.md", "PROGRESS.md", "todo.md", "TODO.md", "todolist.md", "TODOLIST.md", path6.join(".opencode", "opencode-loop", "until.txt")];
    for (const file of files)
      if (await fileContains(path6.resolve(directory, file), job.until))
        return true;
    let scanned = 0;
    async function walk(current) {
      if (scanned >= MAX_SCAN_FILES)
        return false;
      let entries;
      try {
        entries = await fs3.readdir(current, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (scanned >= MAX_SCAN_FILES)
          return false;
        if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name))
          continue;
        const full = path6.join(current, entry.name);
        if (controlRoots.has(path6.resolve(full).toLowerCase()))
          continue;
        if (entry.isDirectory()) {
          if (await walk(full))
            return true;
        } else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) {
          scanned++;
          if (await fileContains(full, job.until))
            return true;
        }
      }
      return false;
    }
    return await walk(directory);
  }
  async function createCheckpoint(directory, sessionID, job, client) {
    if (!job.checkpointOnly && !job.gitCheckpoint)
      return;
    const inRepo = await runProcess2("git", ["rev-parse", "--is-inside-work-tree"], directory, 1e4);
    if (inRepo.code !== 0)
      return;
    const status = await runProcess2("git", ["status", "--short"], directory, 30000);
    if (!status.stdout.trim())
      return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const checkpointDir = path6.join(stateDir(directory), "checkpoints", safeID(sessionID));
    await ensureDir(checkpointDir);
    const diff = await runProcess2("git", ["diff", "--binary"], directory, 120000);
    const staged = await runProcess2("git", ["diff", "--cached", "--binary"], directory, 120000);
    const prefix = `${timestamp}-${safeID(job.name || job.id)}`;
    await fs3.writeFile(path6.join(checkpointDir, `${prefix}.status.txt`), status.stdout + status.stderr);
    await fs3.writeFile(path6.join(checkpointDir, `${prefix}.patch`), `${diff.stdout}
${staged.stdout}`);
    if (job.gitCheckpoint) {
      await runProcess2("git", ["add", "-A"], directory, 120000);
      await runProcess2("git", ["commit", "-m", `chore: opencode loop checkpoint ${timestamp}`], directory, 120000);
    }
    await toast(client, `Loop checkpoint saved: ${prefix}`, "success");
  }
  return {
    buildPrompt,
    ensureBranch,
    snapshotPaths,
    watchChanged,
    untilReached,
    createCheckpoint
  };
}
var MAX_SCAN_FILES = 200, MAX_SCAN_BYTES = 2000000;
var init_job_workspace = __esm(() => {
  init_jobs();
  init_state();
  init_process();
  init_goal_runtime();
});

// src/source/opencode2/native-plugin.js
import path9 from "path";

// src/source/opencode2/session-location.js
import path from "path";
function createNativeSessionLocationGuard({ directory, workspaceID, getSession }) {
  const expected = path.resolve(directory);
  return async (sessionID) => {
    if (typeof sessionID !== "string" || !sessionID || typeof getSession !== "function")
      return false;
    try {
      const session = await getSession({ sessionID });
      if (session?.id !== sessionID || typeof session.location?.directory !== "string" || !path.isAbsolute(session.location.directory))
        return false;
      if (path.relative(expected, path.resolve(session.location.directory)) !== "")
        return false;
      return (session.location.workspaceID ?? "") === (workspaceID ?? "");
    } catch {
      return false;
    }
  };
}

// src/source/opencode2/native-shell.js
import { spawn } from "child_process";
import { randomUUID } from "crypto";
function createNativeShellHost({ directory, onTerminal, onError = () => {} } = {}) {
  if (!directory || typeof onTerminal !== "function")
    throw new TypeError("Native shell requires directory and onTerminal");
  const tasks = new Set;
  let disposed = false;
  let disposal;
  const report = (error) => {
    try {
      onError(error);
    } catch {}
  };
  const tail = (text, data) => (text + String(data)).slice(-64000);
  function terminate(task) {
    if (task.termination)
      return task.termination;
    if (task.settled || !task.child.pid)
      return Promise.resolve();
    const pid = task.child.pid;
    task.termination = new Promise((resolve) => {
      if (process.platform === "win32") {
        const fallback = () => {
          try {
            task.child.kill();
          } catch {}
        };
        try {
          const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", (error) => {
            report(error);
            fallback();
            resolve();
          });
          killer.once("close", (code) => {
            if (code !== 0)
              fallback();
            resolve();
          });
        } catch (error) {
          report(error);
          fallback();
          resolve();
        }
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            task.child.kill("SIGTERM");
          } catch {}
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
          resolve();
        }, 1000);
      }
    });
    return task.termination;
  }
  async function dispatch(request) {
    if (disposed)
      throw new Error("Native shell is disposed");
    if (!request?.sessionID || typeof request.command !== "string" || !request.command.trim())
      throw new TypeError("Native shell requires sessionID and command");
    const shellID = request.id || `shell_loop_${randomUUID().replaceAll("-", "")}`;
    const child = spawn(request.command, { cwd: directory, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const task = { child, settled: false, timedOut: false, cancelled: false, stdout: "", stderr: "" };
    task.closed = new Promise((resolve) => {
      task.resolve = resolve;
    });
    tasks.add(task);
    child.stdout?.on("data", (chunk) => {
      task.stdout = tail(task.stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      task.stderr = tail(task.stderr, chunk);
    });
    const delay = Number(request.timeoutMs);
    task.timer = setTimeout(() => {
      task.timedOut = true;
      terminate(task);
    }, Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2147483647) : 120000);
    task.timer.unref?.();
    child.once("close", async (code, signal) => {
      task.settled = true;
      clearTimeout(task.timer);
      await task.termination;
      tasks.delete(task);
      const event = {
        kind: "shell",
        action: "ended",
        directory,
        sessionID: request.sessionID,
        shellID,
        status: task.timedOut ? "timeout" : task.cancelled || signal || code === null ? "killed" : "exited",
        code: task.timedOut ? 124 : Number.isInteger(code) ? code : -1,
        stdout: task.stdout,
        stderr: task.stderr
      };
      task.resolve(event);
      if (!task.spawnError)
        Promise.resolve().then(() => onTerminal(event)).catch(report);
    });
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve({ id: shellID, status: "running" }));
      child.once("error", (error) => {
        task.spawnError = true;
        reject(error);
      });
    });
  }
  function dispose() {
    if (disposal)
      return disposal;
    disposed = true;
    const active = [...tasks];
    for (const task of active) {
      task.cancelled = true;
      terminate(task);
    }
    disposal = Promise.allSettled(active.map((task) => task.closed)).then(() => {
      return;
    });
    return disposal;
  }
  return Object.freeze({ dispatch, dispose, activeCount: () => tasks.size });
}

// src/source/opencode2/native-runtime.js
import { randomUUID as randomUUID2 } from "crypto";

// src/source/opencode2/native-companion.js
import { createHash } from "crypto";
import { lstat, readFile } from "fs/promises";
import path2 from "path";
async function nativeGoalReservesSession(directory, sessionID) {
  const shard = createHash("sha256").update(sessionID).digest("hex").slice(0, 32);
  const root = path2.resolve(directory);
  const parts = [".opencode", "goals", `${shard}.json`];
  let file = root;
  try {
    for (const part of parts) {
      file = path2.join(file, part);
      const info = await lstat(file);
      if (info.isSymbolicLink())
        return true;
    }
    const goal = JSON.parse(await readFile(file, "utf8"));
    if (goal?.schemaVersion !== 1 || goal?.sessionID !== sessionID || typeof goal?.id !== "string")
      return true;
    return !["completed", "cleared"].includes(goal.status);
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

// src/source/opencode2/native-runtime.js
init_jobs();

// src/source/core/schedule-syntax.js
function removeBooleanFlag(input, flag) {
  const pattern = new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`, "i");
  const found = pattern.test(input);
  return {
    found,
    value: String(input || "").replace(pattern, " ").replace(/\s+/g, " ").trim()
  };
}
function firstToken(input) {
  const match = String(input || "").trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? { token: match[1], rest: String(match[2] || "").trim() } : { token: "", rest: "" };
}
function inferredMode(intervalMs, maxRuns) {
  if (Number(maxRuns || 0) === 1 && Number(intervalMs || 0) > 0)
    return "once";
  return Number(intervalMs || 0) === 0 ? "idle" : "interval";
}
function normalizeLoopScheduleArgs(raw, defaults = {}) {
  const overlap = removeBooleanFlag(String(raw || "").trim(), "--allow-goal-overlap");
  let input = overlap.value;
  const nextDefaults = { ...defaults };
  let scheduleMode = defaults.scheduleMode;
  let scheduleSyntax = "legacy";
  const first = firstToken(input);
  const keyword = first.token.toLowerCase();
  if (keyword === "idle") {
    nextDefaults.intervalMs = 0;
    nextDefaults.immediate = true;
    scheduleMode = "idle";
    scheduleSyntax = "idle";
    input = first.rest;
  } else if (keyword === "every" || keyword === "after" || keyword === "in") {
    const duration = firstToken(first.rest);
    const intervalMs = parseDuration(duration.token);
    if (intervalMs === null) {
      return {
        ok: false,
        error: `Invalid ${keyword} schedule. Example: /loop ${keyword === "every" ? "every" : "after"} 5m continue the project`
      };
    }
    nextDefaults.intervalMs = intervalMs;
    nextDefaults.immediate = false;
    input = duration.rest;
    if (keyword === "every") {
      scheduleMode = intervalMs === 0 ? "idle" : "interval";
      scheduleSyntax = "every";
    } else {
      nextDefaults.maxRuns = 1;
      scheduleMode = "once";
      scheduleSyntax = "after";
    }
  } else {
    const duration = parseDuration(first.token);
    if (duration !== null) {
      scheduleMode = duration === 0 ? "idle" : "interval";
    } else if (nextDefaults.intervalMs === undefined || nextDefaults.intervalMs === null) {
      nextDefaults.intervalMs = 0;
      nextDefaults.immediate = nextDefaults.immediate ?? true;
      scheduleMode = "idle";
      scheduleSyntax = "idle-shorthand";
    } else {
      scheduleMode = scheduleMode || inferredMode(nextDefaults.intervalMs, nextDefaults.maxRuns);
    }
  }
  return {
    ok: true,
    args: input,
    defaults: nextDefaults,
    scheduleMode: scheduleMode || inferredMode(nextDefaults.intervalMs, nextDefaults.maxRuns),
    scheduleSyntax,
    allowGoalOverlap: overlap.found || defaults.allowGoalOverlap === true
  };
}

// src/source/opencode2/commands.js
var OPENCODE_LOOP_V2_PRESET_NAMES = Object.freeze([
  "loop-dev",
  "loop-testfix",
  "loop-compact",
  "loop-progress",
  "loop-safe-dev",
  "loop-command",
  "loop-cmd",
  "loop-prompt",
  "loop-ask",
  "loop-shell"
]);
var OPENCODE_LOOP_V2_COMMANDS = Object.freeze({
  loop: Object.freeze({
    description: "Start an OpenCode auto-continue loop. Usage: /loop 5m <task>",
    template: "OpenCode Loop local command handled. Reply exactly: OK."
  }),
  "loop-pause": Object.freeze({
    description: "Pause OpenCode Loop jobs.",
    template: "OpenCode Loop pause command handled locally. Reply exactly: OK."
  }),
  "loop-resume": Object.freeze({
    description: "Resume OpenCode Loop jobs.",
    template: "OpenCode Loop resume command handled locally. Reply exactly: OK."
  }),
  "loop-stop": Object.freeze({
    description: "Stop OpenCode Loop jobs.",
    template: "OpenCode Loop stop command handled locally. Reply exactly: OK."
  }),
  "loop-remove": Object.freeze({
    description: "Remove OpenCode Loop jobs.",
    template: "OpenCode Loop remove command handled locally. Reply exactly: OK."
  }),
  "loop-clear": Object.freeze({
    description: "Clear all OpenCode Loop jobs.",
    template: "OpenCode Loop clear command handled locally. Reply exactly: OK."
  }),
  "loop-status": Object.freeze({
    description: "Show OpenCode Loop status for the current session.",
    template: "OpenCode Loop status command handled locally. Reply exactly: OK."
  }),
  "loop-now": Object.freeze({
    description: "Run matching OpenCode Loop jobs on the next idle boundary.",
    template: "OpenCode Loop run-now command handled locally. Reply exactly: OK."
  }),
  "loop-export": Object.freeze({
    description: "Export OpenCode Loop state for the current session.",
    template: "OpenCode Loop export command handled locally. Reply exactly: OK."
  }),
  "loop-help": Object.freeze({
    description: "Show the native OpenCode 2 Loop command help.",
    template: "OpenCode Loop help command handled locally. Reply exactly: OK."
  }),
  "loop-doctor": Object.freeze({
    description: "Show native OpenCode 2 Loop diagnostics.",
    template: "OpenCode Loop doctor command handled locally. Reply exactly: OK."
  }),
  "loop-logs": Object.freeze({
    description: "Show recent native OpenCode 2 Loop runtime events.",
    template: "OpenCode Loop logs command handled locally. Reply exactly: OK."
  })
});
function commandArguments(input) {
  const prompt = input?.prompt;
  if (typeof prompt?.text === "string")
    return prompt.text.trim();
  if (typeof input?.arguments === "string")
    return input.arguments.trim();
  return "";
}
function registerOpenCode2LoopCommands(draft, options = {}) {
  if (!draft || typeof draft !== "object") {
    throw new Error("OpenCode 2 command transform draft is unavailable");
  }
  if (typeof draft.add === "function") {
    const execute = options.execute;
    if (typeof execute !== "function") {
      throw new Error("OpenCode 2 command draft.add requires a local Loop command executor");
    }
    for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
      draft.add({
        name,
        description: definition.description,
        execute: async (input) => await execute({
          name,
          sessionID: input?.sessionID,
          arguments: commandArguments(input),
          delivery: input?.delivery
        })
      });
    }
    return;
  }
  if (typeof draft.update === "function") {
    for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
      draft.update(name, (command) => {
        command.template = definition.template;
        command.description = definition.description;
      });
    }
    return;
  }
  throw new Error("OpenCode 2 command transform exposes neither add() nor update()");
}
function parseOpenCode2LoopCommandText(value) {
  if (typeof value !== "string")
    return;
  for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
    const template = definition.template;
    if (value === template)
      return Object.freeze({ name, arguments: "" });
    if (!value.startsWith(`${template}

`))
      continue;
    return Object.freeze({
      name,
      arguments: value.slice(template.length + 2).trim()
    });
  }
  return;
}

// src/source/opencode2/native-runtime.js
init_state();
init_process();

// src/source/opencode2/status.js
init_jobs();
function dueAt(job, current) {
  if (Number(job?.runNowRequestedAt || 0) > 0)
    return current;
  const intervalMs = Math.max(0, Number(job?.intervalMs || 0));
  const lastRunAt = Number(job?.lastRunAt || 0);
  if (intervalMs === 0)
    return current;
  if (lastRunAt > 0)
    return lastRunAt + intervalMs;
  if (job?.immediate === false) {
    const createdAt = Date.parse(job?.createdAt || "");
    return (Number.isFinite(createdAt) ? createdAt : current) + intervalMs;
  }
  return current;
}
function formatOpenCode2LoopStatus(state, current = Date.now()) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const lines = jobs.length ? jobs.map((job, index) => {
    const dueIn = Math.max(0, dueAt(job, current) - current);
    const flags = [
      isGoalJob(job) ? `goal:${goalStatusText(job)}` : undefined,
      job.paused ? "paused" : "active",
      Number(job.runNowRequestedAt || 0) > 0 ? "run-now" : undefined,
      job.safe ? "safe" : undefined,
      job.askNever ? "ask-never" : undefined,
      job.noOverlap ? "no-overlap" : undefined,
      job.checkpointOnly ? "checkpoint-only" : undefined,
      job.gitCheckpoint ? "git-checkpoint" : undefined
    ].filter(Boolean).join(",");
    return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${jobLabel(job)} | runs=${job.runCount || 0} | failures=${job.failureCount || 0} | due in ${durationToText(dueIn)} | ${flags}`;
  }) : ["No active loop jobs."];
  return Object.freeze({
    jobs,
    text: `OpenCode loop status:
${lines.join(`
`)}`
  });
}

// src/source/opencode2/native-policy.js
init_process();
init_job_workspace();
import { stat } from "fs/promises";
import path7 from "path";
function createNativeJobPolicy(options = {}) {
  const now = options.now || Date.now;
  const run = options.runShellCommand || runShellCommand;
  const workspace = options.workspace || createJobWorkspaceRuntime({ toast: async () => {} });
  function pause(job, reason, failed = false) {
    job.paused = true;
    job.pauseReason = reason;
    if (failed)
      job.failureCount = (job.failureCount || 0) + 1;
    return false;
  }
  async function shell(scope, job, command, phase) {
    if (job.safe && dangerousShell(command)) {
      return { code: -1, stdout: "", stderr: `Blocked ${phase} by --safe command guard`, blocked: true };
    }
    const result = await run(command, scope.directory, Math.max(1, Number(job.timeoutMs) || 120000));
    await appendLoopLog(scope.directory, `v2-${phase}`, {
      sessionID: scope.sessionID,
      job: job.name || job.id,
      code: result.code,
      output: String(result.stdout || "").slice(-8000),
      error: String(result.stderr || "").slice(-8000)
    });
    return result;
  }
  async function checkStop(scope, job) {
    const created = Date.parse(job.createdAt);
    if (job.maxRuntimeMs > 0 && Number.isFinite(created) && now() - created >= job.maxRuntimeMs) {
      job.enabled = false;
      return pause(job, "max-runtime");
    }
    if (job.stopFile) {
      try {
        await stat(path7.resolve(scope.directory, job.stopFile));
        job.enabled = false;
        return pause(job, "stop-file");
      } catch (error) {
        if (error?.code !== "ENOENT")
          throw error;
      }
    }
    if (await workspace.untilReached(scope.directory, job)) {
      job.enabled = false;
      return pause(job, "until-reached");
    }
    return true;
  }
  async function prepare(scope, job, isCurrent = () => true) {
    if (!await checkStop(scope, job) || !isCurrent())
      return false;
    if (job.dryRun)
      return true;
    if (job.preflightCommand) {
      const result = await shell(scope, job, job.preflightCommand, "preflight");
      job.lastPreflightCode = result.code;
      if (result.code !== 0)
        return pause(job, "preflight-failed", true);
    }
    if (!isCurrent())
      return false;
    if (job.branch) {
      await workspace.ensureBranch(scope.directory, job, undefined, scope.sessionID);
      if (!job.branchDone)
        return pause(job, "branch-unavailable", true);
    }
    return isCurrent();
  }
  async function finish(scope, job, isCurrent = () => true) {
    if (!isCurrent() || job.dryRun)
      return;
    if (job.verifyCommand) {
      const result = await shell(scope, job, job.verifyCommand, "verify");
      job.lastVerifyCode = result.code;
      job.lastVerifyAt = now();
      job.lastVerifyOutput = `${result.stdout || ""}
${result.stderr || ""}`.trim().slice(-8000);
      if (result.code !== 0) {
        job.failureCount = (job.failureCount || 0) + 1;
        if (result.blocked || job.pauseOnVerifyFail || job.maxFailures > 0 && job.failureCount >= job.maxFailures)
          pause(job, "verification-failed");
        return;
      }
      job.failureCount = 0;
    }
    if (!isCurrent())
      return;
    if (job.postrunCommand) {
      const result = await shell(scope, job, job.postrunCommand, "postrun");
      job.lastPostrunCode = result.code;
      if (result.code !== 0) {
        pause(job, "postrun-failed", true);
        return;
      }
    }
    if (isCurrent())
      await workspace.createCheckpoint(scope.directory, scope.sessionID, job, undefined);
  }
  async function notify(scope, job, reason) {
    if (!job.notifyCommand || job.dryRun)
      return;
    const literal = (value) => String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
    const command = String(job.notifyCommand).replace(/\{reason\}/g, literal(reason)).replace(/\{job\}/g, literal(job.name || job.id));
    await shell(scope, job, command, "notify");
  }
  return {
    pause,
    checkStop,
    prepare,
    finish,
    notify,
    shell,
    buildPrompt: workspace.buildPrompt,
    snapshotPaths: workspace.snapshotPaths,
    watchChanged: workspace.watchChanged
  };
}

// src/source/opencode2/native-runtime.js
var PREFIX = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Work directly on the configured task.";
var result = (detail = {}) => ({ handled: true, dispatched: false, ...detail });
var id = () => `msg_loop_${randomUUID2().replaceAll("-", "")}`;
function createNativeLoopRuntime(options = {}) {
  if (typeof options.prompt !== "function")
    throw new TypeError("Native Loop requires prompt()");
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const policy = createNativeJobPolicy({ ...options, now });
  const scopes = new Map;
  let disposed = false;
  function scopeFor(event) {
    const sessionID = String(event?.sessionID || "").trim();
    const directory = String(event?.directory || options.directory || "").trim();
    if (!sessionID || !directory)
      return;
    const key = `${directory}\x00${sessionID}`;
    if (!scopes.has(key))
      scopes.set(key, { key, sessionID, directory, epoch: 0, busy: false, queue: Promise.resolve() });
    return scopes.get(key);
  }
  const current = (scope) => !disposed && !scope.deleted;
  const read = (scope) => readState(scope.directory, scope.sessionID);
  const save = (scope, state) => writeState(scope.directory, scope.sessionID, state);
  const report = (error) => {
    try {
      options.onError?.(error);
    } catch {}
  };
  function enqueue(scope, task) {
    const pending = scope.queue.catch(() => {}).then(async () => {
      if (!current(scope))
        return result({ reason: "disposed" });
      if (typeof options.scopeAllowed === "function" && !await options.scopeAllowed(scope)) {
        scope.epoch++;
        clear(scope, "timer");
        clear(scope, "deadline");
        clear(scope, "companionTimer");
        return result({ accepted: false, reason: "session-location-mismatch", error: "Native session location cannot be verified for this project/worktree." });
      }
      return current(scope) ? task() : result({ reason: "disposed" });
    });
    scope.queue = pending.catch(report);
    return pending;
  }
  function clear(scope, field) {
    if (scope[field] !== undefined)
      clearTimer(scope[field]);
    delete scope[field];
  }
  function eligible(job) {
    return job.enabled !== false && !job.paused && !(job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns);
  }
  function dueAt(job) {
    if (job.runNowRequestedAt > 0)
      return now();
    if (job.watchPaths?.length && !job.watchTriggered)
      return Infinity;
    if (job.lastRunAt > 0)
      return job.lastRunAt + Math.max(0, job.intervalMs || 0);
    return job.immediate === false ? Date.parse(job.createdAt) + Math.max(0, job.intervalMs || 0) : now();
  }
  function blocked(job) {
    const kind = actionKind(job.action, job);
    if (kind === "goal")
      return ["Use the native @bybrawe/opencode-goal /goal workflow; legacy Loop Goal state is not silently converted."];
    if (!["prompt", "command", "compact", "shell"].includes(kind))
      return ["unsupported action kind"];
    if (kind === "command" && (typeof options.command !== "function" || typeof options.wait !== "function"))
      return ["native command and wait capabilities are required"];
    if ((kind === "compact" || job.compactEveryRuns > 0 || job.compactEveryMs > 0) && typeof options.compact !== "function")
      return ["native compaction capability is required"];
    if (kind === "shell" && typeof options.shell !== "function")
      return ["native shell capability is required"];
    if (job.noOverlap === false)
      return ["Native V2 sessions are serialized; remove --allow-overlap."];
    return [];
  }
  async function schedule(scope) {
    clear(scope, "timer");
    if (!current(scope) || scope.busy || scope.active || scope.compaction)
      return;
    const state = await read(scope);
    if (!current(scope) || scope.busy || scope.active || scope.compaction)
      return;
    let delay = Infinity;
    for (const job of state.jobs || []) {
      if (!eligible(job) || job.v2Run || blocked(job).length)
        continue;
      if (job.watchPaths?.length || job.stopFile || job.until)
        delay = Math.min(delay, 1000);
      const due = dueAt(job);
      if (due > now())
        delay = Math.min(delay, due - now());
      else if (job.immediate === false && !(job.lastRunAt > 0))
        delay = Math.min(delay, 1);
      if (job.maxRuntimeMs > 0)
        delay = Math.min(delay, Math.max(1, Date.parse(job.createdAt) + job.maxRuntimeMs - now()));
    }
    if (!Number.isFinite(delay))
      return;
    scope.timer = setTimer(() => {
      delete scope.timer;
      return enqueue(scope, () => advance(scope)).catch(report);
    }, Math.max(1, Math.min(delay, 2147483647)));
    scope.timer?.unref?.();
  }
  async function note(scope, name, detail = {}) {
    await appendLoopLog(scope.directory, `v2-native-${name}`, { sessionID: scope.sessionID, ...detail });
  }
  async function pauseActive(scope, reason, failed = true) {
    clear(scope, "deadline");
    const state = await read(scope);
    for (const job of state.jobs || []) {
      if (scope.active ? job.id !== scope.active.jobID : !eligible(job))
        continue;
      policy.pause(job, reason, failed);
    }
    await save(scope, state);
    await cancelPending(scope, state);
    await note(scope, "paused", { reason });
    return result({ reason });
  }
  async function cancelPending(scope, state) {
    const run = scope.active;
    if (!run || run.delivered || !["prompt", "command"].includes(run.kind) || !run.inboxID || typeof options.cancel !== "function")
      return false;
    let cancelled = false;
    try {
      cancelled = await options.cancel({ sessionID: scope.sessionID, inboxID: run.inboxID }) === true;
    } catch (error) {
      report(error);
    }
    if (!cancelled)
      return false;
    const job = (state.jobs || []).find((entry) => entry.id === run.jobID);
    if (job?.v2Run?.id === run.id) {
      Object.assign(job, run.previous);
      delete job.v2Run;
      await save(scope, state);
    }
    if (scope.active === run)
      delete scope.active;
    clear(scope, "deadline");
    return true;
  }
  async function finish(scope) {
    const run = scope.active;
    if (!run || scope.compaction || scope.busy)
      return result({ reason: "no-terminal-boundary" });
    if (run.kind === "prompt" && !run.delivered || run.kind === "command" && !run.commandFinished || run.kind === "shell" && !run.shellFinished || ["compact", "cadence"].includes(run.kind) && !run.compactFinished) {
      return result({ reason: "awaiting-owned-completion" });
    }
    clear(scope, "deadline");
    const state = await read(scope);
    const job = (state.jobs || []).find((entry) => entry.id === run.jobID);
    if (job?.v2Run?.id === run.id) {
      if (["compact", "cadence"].includes(run.kind)) {
        job.lastCompactAt = now();
        job.lastCompactRunCount = job.runCount || 0;
      } else if (!job.paused && !run.foreground) {
        await policy.finish(scope, job, () => current(scope) && scope.active === run && !run.foreground);
      }
      delete job.v2Run;
      job.lastCompletedAt = now();
      await save(scope, state);
      if (job.paused || job.enabled === false)
        await policy.notify(scope, job, job.pauseReason || "completed");
    }
    if (scope.active === run)
      delete scope.active;
    await note(scope, "completed", { jobID: run.jobID, kind: run.kind, foreground: Boolean(run.foreground) });
    return advance(scope);
  }
  async function dispatch(scope, state, job, kind) {
    const epoch = scope.epoch;
    const isCurrent = () => current(scope) && scope.epoch === epoch && !scope.busy && !scope.compaction;
    let request;
    if (kind === "prompt")
      request = { sessionID: scope.sessionID, id: id(), text: `${PREFIX}

${await policy.buildPrompt(scope.directory, job)}`, delivery: "queue", metadata: { opencode_loop_v2: true, opencode_loop_job: job.id } };
    else if (kind === "compact" || kind === "cadence")
      request = { sessionID: scope.sessionID, id: id(), delivery: "queue" };
    else if (kind === "shell")
      request = { sessionID: scope.sessionID, id: id(), command: String(job.action).replace(/^[!$]\s*/, ""), timeoutMs: job.timeoutMs };
    else {
      const [name, text] = splitFirst(String(job.action).replace(/^\/+/, ""));
      request = { sessionID: scope.sessionID, name, text: text || "", delivery: "queue" };
    }
    if (!isCurrent())
      return result({ reason: "foreground-or-compaction" });
    if (job.dryRun) {
      policy.pause(job, "dry-run");
      await save(scope, state);
      return result({ dryRun: true, request });
    }
    if (kind === "shell" && job.safe) {
      await Promise.resolve().then(() => init_job_workspace());
      if (dangerousShell(request.command)) {
        policy.pause(job, "unsafe-shell", true);
        await save(scope, state);
        return result({ reason: "unsafe-shell" });
      }
    }
    const run = {
      id: request.id || id(),
      jobID: job.id,
      kind,
      createdAt: now(),
      delivered: false,
      previous: { runCount: job.runCount || 0, lastRunAt: job.lastRunAt || 0, enabled: job.enabled }
    };
    job.v2Run = { id: run.id, kind, status: "admitting", createdAt: run.createdAt };
    await save(scope, state);
    job = state.jobs.find((entry) => entry.id === run.jobID);
    if (!isCurrent() || !job || !eligible(job)) {
      if (job?.v2Run?.id === run.id) {
        delete job.v2Run;
        await save(scope, state);
      }
      return result({ reason: "admission-withdrawn" });
    }
    scope.active = run;
    clear(scope, "timer");
    try {
      let response;
      if (kind === "prompt")
        response = await options.prompt(request);
      else if (kind === "compact" || kind === "cadence")
        response = await options.compact(request);
      else if (kind === "shell")
        response = await options.shell(request);
      else
        response = await options.command(request);
      if (response?.error || response?.accepted === false)
        throw new Error(String(response.error?.message || response.error || "Native admission rejected"));
      run.inboxID = response?.id || response?.data?.id || request.id;
      run.shellID = kind === "shell" ? response?.id || response?.shell?.id || request.id : undefined;
      if (kind !== "cadence") {
        job.runCount = (job.runCount || 0) + 1;
        job.lastRunAt = now();
        if (job.maxRuns > 0 && job.runCount >= job.maxRuns)
          job.enabled = false;
      }
      delete job.runNowRequestedAt;
      job.watchTriggered = false;
      job.v2Run = { ...job.v2Run, status: "admitted", inboxID: run.inboxID, shellID: run.shellID };
      await save(scope, state);
      await note(scope, "admitted", { jobID: job.id, kind, inboxID: run.inboxID, runCount: job.runCount });
      if (current(scope) && job.timeoutMs > 0) {
        scope.deadline = setTimer(() => enqueue(scope, () => scope.active === run ? pauseActive(scope, "timeout-waiting-for-host-boundary") : result()).catch(report), Math.min(job.timeoutMs, 2147483647));
        scope.deadline?.unref?.();
      }
      if (kind === "command") {
        Promise.resolve().then(() => options.wait({ sessionID: scope.sessionID })).then(() => enqueue(scope, async () => {
          if (scope.active !== run)
            return result();
          run.commandFinished = true;
          return finish(scope);
        }), () => enqueue(scope, () => pauseActive(scope, "command-failed"))).catch(report);
      }
      if (kind === "shell" && response?.status && response.status !== "running") {
        run.shellFinished = true;
        if (response.status !== "exited" || Number(response.exit || 0) !== 0)
          return pauseActive(scope, "shell-failed");
        return finish(scope);
      }
      return result({ dispatched: true, job, kind, request });
    } catch (error) {
      policy.pause(job, "admission-uncertain", true);
      job.lastError = error instanceof Error ? error.message : String(error);
      await save(scope, state);
      await note(scope, "admission-failed", { jobID: job.id, message: job.lastError });
      return result({ reason: "admission-uncertain", error: job.lastError });
    }
  }
  async function advance(scope) {
    if (!current(scope) || scope.busy || scope.compaction || scope.active)
      return result({ reason: "host-not-idle" });
    const epoch = scope.epoch;
    const state = await read(scope);
    clear(scope, "companionTimer");
    if (!(state.jobs || []).some(eligible))
      return result();
    if (await nativeGoalReservesSession(scope.directory, scope.sessionID)) {
      if (current(scope)) {
        scope.companionTimer = setTimer(() => {
          delete scope.companionTimer;
          return enqueue(scope, () => advance(scope)).catch(report);
        }, 1000);
        scope.companionTimer?.unref?.();
      }
      return result({ reason: "dedicated-goal-owns-session" });
    }
    for (const job of state.jobs || []) {
      if (!eligible(job))
        continue;
      if (job.v2Run) {
        policy.pause(job, "restart-requires-review");
        await save(scope, state);
        return result({ reason: "restart-requires-review" });
      }
      if (blocked(job).length)
        continue;
      if (job.watchPaths?.length && await policy.watchChanged(scope.directory, job))
        job.watchTriggered = true;
      const safe = () => current(scope) && !scope.busy && !scope.compaction && !scope.active && scope.epoch === epoch;
      if (!safe())
        return result({ reason: "foreground-or-compaction" });
      if (!await policy.checkStop(scope, job)) {
        await save(scope, state);
        await policy.notify(scope, job, job.pauseReason);
        return advance(scope);
      }
      if (dueAt(job) > now())
        continue;
      if (!await policy.prepare(scope, job, safe)) {
        if (job.paused || job.enabled === false) {
          await save(scope, state);
          await policy.notify(scope, job, job.pauseReason);
          return advance(scope);
        }
        return result({ reason: job.pauseReason || "foreground-or-compaction" });
      }
      const kind = actionKind(job.action, job);
      const cadence = kind !== "compact" && job.runCount > 0 && (job.compactEveryRuns > 0 && job.runCount - (job.lastCompactRunCount || 0) >= job.compactEveryRuns || job.compactEveryMs > 0 && now() - (job.lastCompactAt || Date.parse(job.createdAt)) >= job.compactEveryMs);
      return dispatch(scope, state, job, cadence ? "cadence" : kind);
    }
    await schedule(scope);
    return result();
  }
  async function command(scope, event) {
    const state = await read(scope);
    const target = String(event.arguments || "").trim() || "all";
    if (event.name === "loop" || OPENCODE_LOOP_V2_PRESET_NAMES.includes(event.name)) {
      const defaults = event.name === "loop" ? {} : presetDefaults(event.name);
      const normalized = normalizeLoopScheduleArgs(event.arguments || "", defaults);
      if (!normalized.ok)
        return result({ accepted: false, error: normalized.error });
      if (normalized.allowGoalOverlap)
        return result({ accepted: false, error: "Native Goal session reservation cannot be overridden; use another session." });
      const parsed = parseLoopArgs(normalized.args, normalized.defaults);
      if (!parsed.ok)
        return result({ accepted: false, error: parsed.error });
      parsed.job.scheduleMode = normalized.scheduleMode;
      parsed.job.scheduleSyntax = normalized.scheduleSyntax;
      if (normalized.scheduleSyntax === "after") {
        parsed.job.immediate = false;
        parsed.job.maxRuns = 1;
      }
      applyTestfixPreset(parsed.job, defaults);
      const blockers = blocked(parsed.job);
      if (blockers.length)
        return result({ accepted: false, reason: "unsupported", blockers, error: blockers.join(" ") });
      const job = parsed.job;
      job.name = String(job.name || "default");
      job.createdAt = new Date(now()).toISOString();
      job.lastRunAt = 0;
      if (job.watchPaths?.length)
        job.watchSnapshot = await policy.snapshotPaths(scope.directory, job.watchPaths);
      const jobs = state.jobs || [];
      if (!job.multi && jobs.some((other) => (other.name || "default") === job.name && other.v2Run))
        return result({ accepted: false, error: "Pause/stop the existing in-flight job before replacing it." });
      state.jobs = job.multi ? jobs : jobs.filter((other) => (other.name || "default") !== job.name);
      state.jobs.push(job);
      await save(scope, state);
      await schedule(scope);
      return result({ accepted: true, job });
    }
    if (event.name === "loop-status" || event.name === "loop-export") {
      const status = formatOpenCode2LoopStatus(state, now());
      const text = event.name === "loop-export" ? JSON.stringify(state, null, 2) : status.text;
      await options.prompt({ sessionID: scope.sessionID, text, resume: false, metadata: { opencode_loop_v2: true } });
      return result({ accepted: true, status });
    }
    if (!["loop-now", "loop-pause", "loop-resume", "loop-stop", "loop-remove", "loop-clear"].includes(event.name))
      return { handled: false };
    const matches = (job, index) => event.name === "loop-clear" || matchJob(job, target, index);
    let count = 0;
    for (const [index, job] of (state.jobs || []).entries()) {
      if (!matches(job, index))
        continue;
      count++;
      if (["loop-pause", "loop-stop", "loop-remove", "loop-clear"].includes(event.name)) {
        policy.pause(job, "user-paused");
      } else if (!job.v2Run) {
        job.paused = false;
        delete job.pauseReason;
        if (event.name === "loop-now" || event.name === "loop-resume")
          job.runNowRequestedAt = Math.max(1, now());
      }
    }
    await save(scope, state);
    if (state.jobs.some((job) => job.id === scope.active?.jobID && job.paused))
      await cancelPending(scope, state);
    if (["loop-stop", "loop-remove", "loop-clear"].includes(event.name)) {
      state.jobs = state.jobs.filter((job, index) => !matches(job, index));
      if (!state.jobs.length)
        await removeState(scope.directory, scope.sessionID);
      else
        await save(scope, state);
    }
    await schedule(scope);
    return result({ accepted: true, count, target });
  }
  async function onEvent(event) {
    if (disposed)
      return result({ reason: "disposed" });
    if (event?.kind === "server" && event.action === "disposed") {
      await dispose();
      return result({ disposed: true });
    }
    const scope = scopeFor(event);
    if (!scope)
      return { handled: false };
    if (event.kind === "foreground") {
      scope.epoch++;
      scope.busy = true;
      if (scope.active)
        scope.active.foreground = true;
      clear(scope, "timer");
      return result({ reason: "foreground-admission" });
    }
    if (event.kind === "compaction" && event.action === "started") {
      scope.compaction ||= { ended: false, terminal: false };
      scope.busy = true;
      clear(scope, "timer");
      return result({ reason: "compacting" });
    }
    if (event.kind === "session" && event.action === "status" && ["busy", "retry"].includes(event.status)) {
      scope.busy = true;
      clear(scope, "timer");
      return result();
    }
    if (event.kind === "session" && event.action === "deleted") {
      scope.deleted = true;
      clear(scope, "timer");
      clear(scope, "deadline");
      clear(scope, "companionTimer");
      scopes.delete(scope.key);
      return result({ disposedScope: true });
    }
    return enqueue(scope, async () => {
      if (event.kind === "command" && event.action === "executed")
        return command(scope, event);
      if (event.kind === "inbox") {
        if (scope.active?.inboxID === event.inboxID || scope.active?.id === event.inboxID) {
          if (event.action === "delivered")
            scope.active.delivered = true;
          if (event.action === "cancelled") {
            const run = scope.active;
            const state = await read(scope);
            const job = (state.jobs || []).find((entry) => entry.id === run.jobID);
            if (job?.v2Run?.id === run.id && !run.delivered) {
              Object.assign(job, run.previous);
              policy.pause(job, "inbox-cancelled");
              delete job.v2Run;
              await save(scope, state);
            }
            if (scope.active === run)
              delete scope.active;
            clear(scope, "deadline");
            return result({ reason: "inbox-cancelled" });
          }
        }
        return result();
      }
      if (event.kind === "shell" && event.action === "ended" && scope.active?.shellID === event.shellID) {
        scope.active.shellFinished = true;
        if (event.status !== "exited" || event.code !== 0) {
          const run = scope.active;
          const paused = await pauseActive(scope, "shell-failed");
          const state = await read(scope);
          const job = (state.jobs || []).find((entry) => entry.id === run.jobID);
          if (job?.v2Run?.id === run.id) {
            delete job.v2Run;
            await save(scope, state);
          }
          if (scope.active === run)
            delete scope.active;
          return paused;
        }
        return finish(scope);
      }
      if (event.kind === "session" && ["error", "failed", "interrupted"].includes(event.action) || event.kind === "compaction" && event.action === "failed") {
        delete scope.compaction;
        scope.busy = false;
        const run = scope.active;
        const paused = await pauseActive(scope, event.reason || `${event.kind}-${event.action}`);
        if (run && (run.delivered || ["compact", "cadence", "shell"].includes(run.kind))) {
          const state = await read(scope);
          const job = (state.jobs || []).find((entry) => entry.id === run.jobID);
          if (job?.v2Run?.id === run.id) {
            delete job.v2Run;
            await save(scope, state);
          }
          if (scope.active === run)
            delete scope.active;
        }
        return paused;
      }
      if (event.kind === "compaction" && event.action === "ended") {
        scope.compaction ||= { ended: false, terminal: false };
        scope.compaction.ended = true;
        if (["compact", "cadence"].includes(scope.active?.kind))
          scope.active.compactFinished = true;
        if (!scope.compaction.terminal)
          return result({ reason: "awaiting-execution-terminal" });
      } else if (event.kind === "session" && event.action === "idle") {
        if (scope.compaction) {
          scope.compaction.terminal = true;
          if (!scope.compaction.ended)
            return result({ reason: "awaiting-compaction-end" });
        }
      } else if (event.kind === "session" && event.action === "status" && event.status === "idle") {
        if (scope.active || scope.compaction)
          return result({ reason: "awaiting-execution-terminal" });
      } else
        return { handled: false };
      delete scope.compaction;
      scope.busy = false;
      return scope.active ? finish(scope) : advance(scope);
    });
  }
  async function wake(event) {
    const scope = scopeFor(event);
    return scope ? enqueue(scope, () => advance(scope)) : { handled: false };
  }
  async function dispose() {
    if (disposed)
      return false;
    disposed = true;
    for (const scope of scopes.values()) {
      clear(scope, "timer");
      clear(scope, "deadline");
      clear(scope, "companionTimer");
    }
    await Promise.allSettled([...scopes.values()].map((scope) => scope.queue));
    scopes.clear();
    return true;
  }
  return Object.freeze({ onEvent, wake, dispose, scheduledCount: () => [...scopes.values()].filter((scope) => scope.timer !== undefined).length });
}

// src/source/runtime/events.js
function record(value) {
  return value && typeof value === "object" ? value : undefined;
}
function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function envelope(input) {
  const outer = record(input);
  if (!outer)
    return;
  const payload = record(outer.payload);
  if (payload && text(payload.type)) {
    return { directory: text(outer.directory), event: payload };
  }
  const wrappedEvent = record(outer.event);
  if (wrappedEvent && text(wrappedEvent.type)) {
    return { directory: text(outer.directory), event: wrappedEvent };
  }
  if (!text(outer.type))
    return;
  return { directory: undefined, event: outer };
}
function freezeEvent(value) {
  return Object.freeze(value);
}
function normalizeOpenCodeEvent(input) {
  const parsed = envelope(input);
  if (!parsed)
    return;
  const { directory, event } = parsed;
  const properties = record(event.properties) || {};
  if (event.type === "session.status") {
    const sessionID = text(properties.sessionID);
    const status = text(record(properties.status)?.type);
    if (!sessionID || !status)
      return;
    return freezeEvent({ kind: "session", action: "status", sessionID, directory, status });
  }
  if (event.type === "session.idle" || event.type === "session.compacted") {
    const sessionID = text(properties.sessionID);
    if (!sessionID)
      return;
    return freezeEvent({
      kind: "session",
      action: event.type === "session.idle" ? "idle" : "compacted",
      sessionID,
      directory
    });
  }
  if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
    const info = record(properties.info);
    const sessionID = text(info?.id);
    if (!sessionID)
      return;
    return freezeEvent({
      kind: "session",
      action: event.type.slice("session.".length),
      sessionID,
      directory: directory || text(info?.directory),
      parentID: text(info?.parentID)
    });
  }
  if (event.type === "session.error") {
    const sessionID = text(properties.sessionID);
    if (!sessionID)
      return;
    return freezeEvent({ kind: "session", action: "error", sessionID, directory });
  }
  if (event.type === "message.updated") {
    const info = record(properties.info);
    const sessionID = text(info?.sessionID);
    const messageID = text(info?.id);
    const role = text(info?.role);
    if (!sessionID || !messageID || !role)
      return;
    const time = record(info?.time);
    return freezeEvent({
      kind: "message",
      action: "updated",
      sessionID,
      directory,
      messageID,
      role,
      completedAt: Number.isFinite(time?.completed) ? time.completed : undefined,
      finish: text(info?.finish)
    });
  }
  if (event.type === "command.executed") {
    const sessionID = text(properties.sessionID);
    const name = text(properties.name);
    if (!sessionID || !name)
      return;
    return freezeEvent({
      kind: "command",
      action: "executed",
      sessionID,
      directory,
      name,
      arguments: typeof properties.arguments === "string" ? properties.arguments : "",
      messageID: text(properties.messageID)
    });
  }
  if (event.type === "server.instance.disposed") {
    const disposedDirectory = directory || text(properties.directory);
    if (!disposedDirectory)
      return;
    return freezeEvent({ kind: "server", action: "disposed", directory: disposedDirectory });
  }
  return;
}

// src/source/runtime/session-registry.js
var DEFAULT_SESSION_STALE_MS = 12 * 60 * 60 * 1000;
function sessionKey(sessionID) {
  return String(sessionID || "").trim();
}
function createSessionRegistry({ now = Date.now, staleAfterMs = DEFAULT_SESSION_STALE_MS } = {}) {
  if (typeof now !== "function")
    throw new TypeError("session registry requires a clock function");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0)
    throw new TypeError("session registry requires a non-negative staleAfterMs");
  const sessions = new Map;
  function observeExternal(sessionID, runtime) {
    const key = sessionKey(sessionID);
    if (!key)
      throw new TypeError("session registry requires a session ID");
    const seenAt = Number(now());
    if (!Number.isFinite(seenAt))
      throw new TypeError("session registry clock must return a finite number");
    const entry = Object.freeze({ sessionID: key, runtime, seenAt });
    sessions.set(key, entry);
    return entry;
  }
  function peek(sessionID) {
    return sessions.get(sessionKey(sessionID));
  }
  function remove(sessionID, expectedRuntime) {
    const key = sessionKey(sessionID);
    const current = sessions.get(key);
    if (!current)
      return false;
    if (arguments.length > 1 && current.runtime !== expectedRuntime)
      return false;
    return sessions.delete(key);
  }
  function pruneStale(at = now()) {
    const timestamp = Number(at);
    if (!Number.isFinite(timestamp))
      throw new TypeError("session registry prune time must be finite");
    const removed = [];
    for (const [key, entry] of sessions) {
      if (timestamp - entry.seenAt < staleAfterMs)
        continue;
      sessions.delete(key);
      removed.push(key);
    }
    return removed;
  }
  function entries() {
    return [...sessions.values()];
  }
  return Object.freeze({
    observeExternal,
    peek,
    remove,
    pruneStale,
    entries
  });
}

// src/source/runtime/scope.js
function createRuntimeScope() {
  const controller = new AbortController;
  const cleanups = new Set;
  let disposed = false;
  function track(cleanup) {
    if (typeof cleanup !== "function")
      throw new TypeError("runtime scope cleanup must be a function");
    if (disposed) {
      cleanup();
      return () => false;
    }
    const entry = { cleanup };
    cleanups.add(entry);
    let tracked = true;
    return () => {
      if (!tracked)
        return false;
      tracked = false;
      return cleanups.delete(entry);
    };
  }
  function guard(callback) {
    if (typeof callback !== "function")
      throw new TypeError("runtime scope guard requires a function");
    return function(...args) {
      if (disposed)
        return;
      return callback.apply(this, args);
    };
  }
  function dispose(reason) {
    if (disposed)
      return false;
    disposed = true;
    controller.abort(reason);
    const errors = [];
    for (const entry of [...cleanups].reverse()) {
      cleanups.delete(entry);
      try {
        entry.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "runtime scope cleanup failed");
    return true;
  }
  return Object.freeze({
    signal: controller.signal,
    isActive: () => !disposed,
    track,
    guard,
    dispose
  });
}

// src/source/runtime/timers.js
function createOwnedTimer(scope, callback, delay, repeat, api, ref) {
  if (!scope?.isActive?.())
    return;
  let active = true;
  let release;
  let handle;
  const invoke = scope.guard((...args) => {
    if (!active)
      return;
    if (!repeat) {
      active = false;
      release?.();
    }
    callback(...args);
  });
  handle = repeat ? api.setInterval(invoke, delay) : api.setTimeout(invoke, delay);
  release = scope.track(() => {
    if (repeat)
      api.clearInterval(handle);
    else
      api.clearTimeout(handle);
  });
  if (!ref)
    handle?.unref?.();
  return Object.freeze({
    handle,
    cancel() {
      if (!active)
        return false;
      active = false;
      if (repeat)
        api.clearInterval(handle);
      else
        api.clearTimeout(handle);
      release();
      return true;
    }
  });
}
function createRuntimeTimers(scope, api = globalThis) {
  return Object.freeze({
    timeout(callback, delay, options = {}) {
      return createOwnedTimer(scope, callback, delay, false, api, options.ref !== false);
    },
    interval(callback, delay, options = {}) {
      return createOwnedTimer(scope, callback, delay, true, api, options.ref !== false);
    }
  });
}

// src/source/runtime/session-manager.js
function defaultRuntimeFactory({ sessionID, timerAPI }) {
  const scope = createRuntimeScope();
  return Object.freeze({
    sessionID,
    scope,
    timers: createRuntimeTimers(scope, timerAPI),
    dispose: (reason) => scope.dispose(reason)
  });
}
function validateRuntime(runtime, sessionID) {
  if (!runtime || runtime.sessionID !== sessionID)
    throw new TypeError("session runtime factory must preserve the session ID");
  if (typeof runtime?.scope?.isActive !== "function")
    throw new TypeError("session runtime factory must provide an active scope");
  if (typeof runtime.dispose !== "function")
    throw new TypeError("session runtime factory must provide dispose()");
  return runtime;
}
function createSessionRuntimeManager({
  now = Date.now,
  staleAfterMs = DEFAULT_SESSION_STALE_MS,
  timerAPI = globalThis,
  runtimeFactory = defaultRuntimeFactory
} = {}) {
  if (typeof runtimeFactory !== "function")
    throw new TypeError("session runtime manager requires a runtime factory");
  const registry = createSessionRegistry({ now, staleAfterMs });
  let disposed = false;
  function observeExternal(sessionID) {
    if (disposed)
      throw new Error("session runtime manager is disposed");
    const key = String(sessionID || "").trim();
    if (!key)
      throw new TypeError("session runtime manager requires a session ID");
    const current = registry.peek(key);
    const runtime = current?.runtime?.scope?.isActive?.() ? current.runtime : validateRuntime(runtimeFactory({ sessionID: key, timerAPI }), key);
    registry.observeExternal(key, runtime);
    return runtime;
  }
  function peek(sessionID) {
    return registry.peek(sessionID)?.runtime;
  }
  function entries() {
    return registry.entries();
  }
  function remove(sessionID, { expectedRuntime, reason } = {}) {
    const current = registry.peek(sessionID);
    if (!current)
      return false;
    if (expectedRuntime !== undefined && current.runtime !== expectedRuntime)
      return false;
    if (!registry.remove(sessionID, current.runtime))
      return false;
    current.runtime.dispose(reason);
    return true;
  }
  function pruneStale(at = now()) {
    const before = new Map(registry.entries().map((entry) => [entry.sessionID, entry.runtime]));
    const removed = registry.pruneStale(at);
    const errors = [];
    for (const sessionID of removed) {
      try {
        before.get(sessionID)?.dispose("stale-session");
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "stale session cleanup failed");
    return removed;
  }
  function dispose(reason) {
    if (disposed)
      return false;
    disposed = true;
    const errors = [];
    for (const entry of registry.entries()) {
      registry.remove(entry.sessionID, entry.runtime);
      try {
        entry.runtime.dispose(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "session runtime manager cleanup failed");
    return true;
  }
  return Object.freeze({
    observeExternal,
    peek,
    entries,
    remove,
    pruneStale,
    dispose
  });
}

// src/source/opencode2/events.js
function record2(value) {
  return value && typeof value === "object" ? value : undefined;
}
function text2(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function directoryFrom(raw) {
  return text2(record2(raw?.location)?.directory);
}
function sessionIDFrom(raw) {
  const data = record2(raw?.data);
  return text2(data?.sessionID);
}
function normalizeOpenCode2NativeEvent(raw) {
  const type = text2(raw?.type);
  if (!type)
    return;
  const data = record2(raw?.data) || {};
  const directory = directoryFrom(raw);
  const sessionID = sessionIDFrom(raw);
  if (type === "session.inbox.enqueued") {
    const item = record2(data.item);
    const payload = record2(item?.payload);
    const parsed = item?.type === "user" ? parseOpenCode2LoopCommandText(payload?.text) : undefined;
    if (!sessionID || !parsed)
      return;
    return Object.freeze({
      kind: "command",
      action: "executed",
      sessionID,
      directory,
      name: parsed.name,
      arguments: parsed.arguments
    });
  }
  if (type === "session.status") {
    const status = text2(record2(data.status)?.type);
    if (!sessionID || !status)
      return;
    return Object.freeze({ kind: "session", action: "status", sessionID, directory, status });
  }
  if (type === "session.idle") {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "idle", sessionID, directory });
  }
  if (type === "session.execution.started") {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "status", sessionID, directory, status: "busy" });
  }
  if (type === "session.execution.succeeded") {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "idle", sessionID, directory });
  }
  if (type === "session.inbox.delivered" || type === "session.inbox.cancelled") {
    if (!sessionID || !text2(data.inboxID))
      return;
    return Object.freeze({ kind: "inbox", action: type.endsWith("delivered") ? "delivered" : "cancelled", sessionID, directory, inboxID: data.inboxID });
  }
  if (["session.compaction.started", "session.compaction.ended", "session.compaction.failed"].includes(type)) {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "compaction", action: type.split(".").at(-1), sessionID, directory });
  }
  if (["session.execution.failed", "session.execution.interrupted"].includes(type)) {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "error", sessionID, directory, reason: type });
  }
  if (["session.shell.started", "session.shell.ended"].includes(type)) {
    if (!sessionID)
      return;
    const shell = record2(data.shell) || {};
    return Object.freeze({ kind: "shell", action: type.endsWith("started") ? "started" : "ended", sessionID, directory, shellID: shell.id, command: shell.command, code: typeof shell.exit === "number" ? shell.exit : -1, status: shell.status, metadata: shell.metadata });
  }
  if (type === "location.shutdown")
    return Object.freeze({ kind: "server", action: "disposed", directory });
  if (type === "session.created") {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "created", sessionID, directory: directory || text2(record2(data.location)?.directory) });
  }
  if (type === "session.deleted") {
    if (!sessionID)
      return;
    return Object.freeze({ kind: "session", action: "deleted", sessionID, directory });
  }
  return;
}

// src/source/opencode2/event-bridge.js
function cleanupRegistration(registration) {
  if (typeof registration === "function")
    return registration;
  if (!registration || typeof registration !== "object")
    return;
  for (const key of ["dispose", "unsubscribe", "close"]) {
    if (typeof registration[key] === "function")
      return registration[key].bind(registration);
  }
  return;
}
function eventStream(registration) {
  const stream = registration?.stream ?? registration;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new TypeError("OpenCode 2 event subscribe must return an async event stream");
  }
  return stream;
}
function sameDirectory(expected, actual) {
  if (!expected || !actual)
    return true;
  return String(expected) === String(actual);
}
function createOpenCode2EventBridge({
  directory,
  allowInboxCommands = true,
  onEvent = async () => {},
  onError = () => {},
  runtimeManager = createSessionRuntimeManager()
} = {}) {
  if (typeof onEvent !== "function")
    throw new TypeError("OpenCode 2 event bridge requires onEvent to be a function");
  if (typeof onError !== "function")
    throw new TypeError("OpenCode 2 event bridge requires onError to be a function");
  let registration;
  let iterator;
  let iteratorClosed = false;
  let pump;
  let attached = false;
  let stopped = false;
  let disposed = false;
  let managerDisposed = false;
  let queue = Promise.resolve();
  const sessionDirectories = new Map;
  const seenEventIDs = new Set;
  function report(error) {
    try {
      onError(error);
    } catch {}
  }
  function disposeManager(reason) {
    if (managerDisposed)
      return false;
    managerDisposed = true;
    return runtimeManager.dispose(reason);
  }
  async function closeIterator() {
    if (iteratorClosed)
      return false;
    iteratorClosed = true;
    const current = iterator;
    iterator = undefined;
    if (typeof current?.return === "function")
      await current.return();
    return Boolean(current);
  }
  function normalize(raw) {
    const current = normalizeOpenCode2NativeEvent(raw) || normalizeOpenCodeEvent(raw);
    if (!current)
      return;
    const sessionID = current.sessionID;
    const rememberedDirectory = sessionID ? sessionDirectories.get(sessionID) : undefined;
    const eventDirectory = current.directory || rememberedDirectory || directory;
    const event = eventDirectory === current.directory ? current : Object.freeze({ ...current, directory: eventDirectory });
    if (sessionID && event.directory)
      sessionDirectories.set(sessionID, event.directory);
    return event;
  }
  async function process2(raw) {
    if (stopped)
      return;
    if (!allowInboxCommands && raw?.type === "session.inbox.enqueued")
      return;
    const event = normalize(raw);
    if (!event || !sameDirectory(directory, event.directory))
      return;
    if (typeof raw?.id === "string") {
      if (seenEventIDs.has(raw.id))
        return;
      seenEventIDs.add(raw.id);
      if (seenEventIDs.size > 2048)
        seenEventIDs.delete(seenEventIDs.values().next().value);
    }
    const runtime = event.sessionID ? runtimeManager.observeExternal(event.sessionID) : undefined;
    await onEvent(event, runtime);
    if (event.kind === "session" && event.action === "deleted") {
      sessionDirectories.delete(event.sessionID);
      runtimeManager.remove(event.sessionID, { expectedRuntime: runtime, reason: "session-deleted" });
    }
    if (event.kind === "server" && event.action === "disposed") {
      stopped = true;
      sessionDirectories.clear();
      disposeManager("server-disposed");
    }
    return event;
  }
  function dispatch(raw) {
    if (stopped)
      return Promise.resolve(undefined);
    const result = queue.then(() => process2(raw));
    queue = result.catch(() => {
      return;
    });
    return result;
  }
  function callback(raw) {
    const pending = dispatch(raw);
    pending.catch(report);
    return pending.catch(() => {
      return;
    });
  }
  async function consume(stream) {
    const current = stream[Symbol.asyncIterator]();
    iterator = current;
    iteratorClosed = false;
    try {
      while (!stopped) {
        const next = await current.next();
        if (next?.done)
          break;
        await dispatch(next?.value);
      }
    } catch (error) {
      if (!stopped)
        report(error);
    } finally {
      if (stopped && !iteratorClosed)
        await closeIterator().catch(() => {
          return;
        });
      if (iterator === current)
        iterator = undefined;
    }
  }
  async function attach(subscribe) {
    if (disposed)
      throw new Error("OpenCode 2 event bridge is disposed");
    if (attached)
      throw new Error("OpenCode 2 event bridge is already attached");
    if (typeof subscribe !== "function")
      throw new TypeError("OpenCode 2 event bridge requires an event subscribe function");
    if (subscribe.length > 0) {
      registration = await subscribe(callback);
      attached = true;
      return registration;
    }
    registration = await subscribe();
    const stream = eventStream(registration);
    attached = true;
    pump = consume(stream);
    return registration;
  }
  async function dispose(reason = "bridge-disposed") {
    if (disposed)
      return false;
    disposed = true;
    stopped = true;
    await closeIterator().catch(() => {
      return;
    });
    await pump?.catch(() => {
      return;
    });
    await queue.catch(() => {
      return;
    });
    const cleanup = cleanupRegistration(registration);
    registration = undefined;
    try {
      if (cleanup)
        await cleanup();
    } finally {
      sessionDirectories.clear();
      disposeManager(reason);
    }
    return true;
  }
  return Object.freeze({
    attach,
    dispatch,
    dispose,
    runtimeManager,
    isAttached: () => attached,
    isDisposed: () => disposed
  });
}

// src/source/opencode2/native-plugin.js
init_process();
init_state();

// src/source/core/progress.js
import { promises as fs4 } from "fs";
import path8 from "path";
var DEFAULT_PROGRESS_MD = `# Progress

## Current Goal
Describe the current project goal here.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, and follow-up work as TODOs.
- Run tests, lint, or build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and pick the next safe improvement.

## Completed
- [x] Created progress.md.

## Backlog Ideas
- [ ] Add more project-specific tasks here.

## Blocked
- None.
`;
function inside(root, candidate) {
  const relative = path8.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path8.sep}`) && !path8.isAbsolute(relative);
}
async function initializeProgressFile(directory, argumentsText = "") {
  const root = await fs4.realpath(directory);
  const target = String(argumentsText || "").trim() || "progress.md";
  const file = path8.resolve(root, target);
  const relative = path8.relative(root, file);
  if (!relative || !inside(root, file))
    throw new Error("Progress file must be inside the project");
  if ([".git", ".opencode"].includes(relative.split(path8.sep)[0].toLowerCase())) {
    throw new Error("Progress file cannot replace a control-plane path");
  }
  const parent = await fs4.realpath(path8.dirname(file));
  if (!inside(root, parent))
    throw new Error("Progress file must remain inside the project; symlink escape refused");
  try {
    await fs4.writeFile(file, DEFAULT_PROGRESS_MD, { encoding: "utf8", flag: "wx" });
    return { created: true, file: relative };
  } catch (error) {
    if (error?.code === "EEXIST")
      return { created: false, file: relative };
    throw error;
  }
}

// src/source/opencode2/native-plugin.js
var HELP = `OpenCode Loop: native OpenCode 2 runtime
/loop 0s <task> --max-runs 3
/loop 5m <task> --verify "npm test" --pause-on-verify-fail
/loop --watch progress.md <task>
/loop 0s <task> --prompt-file instructions.md --include-file progress.md
/loop 0s <task> --compact-every 3
/loop 5m --shell npm test
/loop 15m --compact /compact
Presets: /loop-dev, /loop-testfix, /loop-progress, /loop-safe-dev, /loop-ask, /loop-prompt, /loop-command, /loop-cmd, /loop-shell, /loop-compact.
/loop-init [progress.md] creates a missing project-local progress file without overwriting existing data.
Controls: /loop-now, /loop-pause, /loop-resume, /loop-stop, /loop-remove, /loop-clear, /loop-status, /loop-export.
Preflight, postrun, notifications, stop files, completion markers, runtime/failure/run limits, branches and checkpoints are supported.
Scheduled shell commands run as bounded local child processes managed by Loop; OpenCode 2's ctx.shell surface is a hook API, not a shell-execution method.
The public OpenCode 2 plugin API does not expose manual session compaction. /loop-compact, --compact and --compact-every are rejected before job creation on V2; native automatic compaction remains host-owned and is observed through the compaction hook.
An unfinished dedicated Goal reserves its session; Loop will not override it.
--timeout pauses future iterations without aborting the current native model/tool/compaction operation.
--safe is a command heuristic, not a sandbox. --dry-run does not dispatch or run hooks.
Native sessions stay serialized; --allow-overlap is rejected.
Use @bybrawe/opencode-goal and /goal for native Goal contracts. Legacy Loop Goal state is not silently migrated.
An uncertain admission after a restart is paused for review instead of being replayed automatically.`;
async function cleanup(value) {
  if (typeof value === "function")
    await value();
  else if (typeof value?.dispose === "function")
    await value.dispose();
  else if (typeof value?.unsubscribe === "function")
    await value.unsubscribe();
}
var OpenCodeLoopNativePlugin = Object.freeze({
  id: "@bybrawe/opencode-loop",
  async setup(ctx) {
    for (const [label, fn] of [["session.prompt", ctx?.session?.prompt], ["session.hook", ctx?.session?.hook], ["event.subscribe", ctx?.event?.subscribe], ["command.transform", ctx?.command?.transform]]) {
      if (typeof fn !== "function")
        throw new Error(`Native OpenCode Loop requires ${label}; use OpenCode 2.0.18 or newer.`);
    }
    const directory = String(ctx.location?.directory || ctx.options?.directory || "").trim();
    if (!directory)
      throw new Error("Native OpenCode Loop requires a project directory");
    const ownsSession = createNativeSessionLocationGuard({
      directory,
      workspaceID: ctx.location?.workspaceID,
      getSession: (input) => ctx.session.get(input)
    });
    const registrations = [];
    const lifecycleAbort = new AbortController;
    const prompt = (request) => ctx.session.prompt({ ...request, delivery: request.delivery || "queue", metadata: { ...request.metadata, opencode_loop_v2: true } });
    const shellHost = createNativeShellHost({
      directory,
      onTerminal: (event) => runtime.onEvent(event),
      onError: (error) => {
        appendLoopLog(directory, "v2-shell-error", { message: String(error?.message || error) }).catch(() => {});
      }
    });
    const runtime = createNativeLoopRuntime({
      directory,
      scopeAllowed: (scope) => ownsSession(scope.sessionID),
      prompt,
      command: typeof ctx.session.command === "function" ? (request) => ctx.session.command(request) : undefined,
      wait: typeof ctx.session.wait === "function" ? (request) => ctx.session.wait(request) : undefined,
      compact: undefined,
      shell: (request) => shellHost.dispatch(request),
      cancel: undefined,
      onError: (error) => {
        appendLoopLog(directory, "v2-native-error", { message: String(error?.message || error) }).catch(() => {});
      }
    });
    const bridge = createOpenCode2EventBridge({ directory, allowInboxCommands: false, onEvent: async (event) => {
      if (event.sessionID && !(event.kind === "session" && event.action === "deleted") && !await ownsSession(event.sessionID))
        return;
      return runtime.onEvent(event);
    }, onError: (error) => {
      appendLoopLog(directory, "v2-native-event-error", { message: String(error?.message || error) }).catch(() => {});
    } });
    let closed = false;
    let disposeTask;
    function dispose() {
      if (disposeTask)
        return disposeTask;
      closed = true;
      disposeTask = Promise.resolve().then(async () => {
        const errors = [];
        const stopped = bridge.dispose("native-plugin-disposed").catch((error) => {
          errors.push(error);
        });
        lifecycleAbort.abort();
        for (const action of [() => runtime.dispose(), () => shellHost.dispose()]) {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        }
        await stopped;
        for (const registration of [...registrations].reverse()) {
          try {
            await cleanup(registration);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "Native Loop cleanup failed");
      });
      return disposeTask;
    }
    async function execute({ name, sessionID, arguments: argumentsText }) {
      if (closed)
        throw new Error("Native Loop is disposed");
      if (!await ownsSession(sessionID))
        throw new Error("Native Loop cannot resolve this session in the plugin location; use its own project/worktree.");
      if (closed)
        throw new Error("Native Loop is disposed");
      if (name === "loop-init") {
        const output = await initializeProgressFile(directory, argumentsText);
        await prompt({ sessionID, text: output.created ? `Created ${output.file}.` : `${output.file} already exists; preserved unchanged.`, resume: false });
        return { handled: true, accepted: true, ...output };
      }
      if (["loop-help", "loop-doctor", "loop-logs"].includes(name)) {
        const text = name === "loop-logs" ? (await readSmallTextFile(path9.join(stateDir(directory), "loop.log"), 2000000)).split(`
`).slice(-60).join(`
`) || "No Loop log entries." : name === "loop-doctor" ? `Native OpenCode Loop
Host: ${ctx.app?.version || "unknown"}
Directory: ${directory}
Prompt hooks: enabled
Compaction ownership: native host
Delivery: durable queue
Scheduled timers: ${runtime.scheduledCount()}
Use /loop-status for paused/admitted job state.` : HELP;
        await prompt({ sessionID, text, resume: false });
        return { handled: true, accepted: true };
      }
      const event = { kind: "command", action: "executed", directory, sessionID, name, arguments: argumentsText };
      const result = await runtime.onEvent(event);
      if (result?.accepted === false)
        throw new Error(result.error || result.blockers?.join(" ") || "Loop command rejected");
      const shouldWake = result?.job ? result.job.immediate !== false : ["loop-now", "loop-resume"].includes(name);
      if (result?.accepted && shouldWake)
        await runtime.wake(event);
      return result;
    }
    try {
      registrations.push(await ctx.session.hook("prompt", async (event) => {
        if (closed || event.metadata?.opencode_loop_v2 === true || !await ownsSession(event.sessionID))
          return;
        if (closed)
          return;
        return runtime.onEvent({ kind: "foreground", directory, sessionID: event.sessionID });
      }));
      registrations.push(await ctx.session.hook("compaction", async (event) => {
        if (closed || !await ownsSession(event.sessionID))
          return;
        if (!closed)
          return runtime.onEvent({ kind: "compaction", action: "started", directory, sessionID: event.sessionID });
      }));
      registrations.push(await ctx.command.transform((draft) => {
        registerOpenCode2LoopCommands(draft, { execute });
        if (typeof draft.add !== "function")
          return;
        for (const name of [...OPENCODE_LOOP_V2_PRESET_NAMES, "loop-init"]) {
          draft.add({
            name,
            description: name === "loop-init" ? "Create a missing project-local progress file." : `Native Loop ${name.slice(5)} preset`,
            execute: (input) => execute({ name, sessionID: input.sessionID, arguments: commandArguments(input) })
          });
        }
      }));
      await bridge.attach(() => ctx.event.subscribe({ signal: lifecycleAbort.signal }));
      await appendLoopLog(directory, "v2-native-ready", { host: ctx.app?.version || "unknown" });
      return dispose;
    } catch (error) {
      await dispose().catch(() => {});
      throw error;
    }
  }
});

// src/source/opencode2/capabilities.js
function hasFunction(value, key) {
  return Boolean(value && typeof value[key] === "function");
}
function frozenRecord(value) {
  return Object.freeze(value);
}
var OPENCODE_LOOP_V2_HOST_REQUIREMENTS = Object.freeze([
  "event.subscribe",
  "session.prompt"
]);
var OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS = Object.freeze([
  ...OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
  "runtime.adapter"
]);
function inspectOpenCode2Context(ctx) {
  const command = ctx?.command;
  const session = ctx?.session;
  const event = ctx?.event;
  const tool = ctx?.tool;
  return frozenRecord({
    commandTransform: hasFunction(command, "transform"),
    eventSubscribe: hasFunction(event, "subscribe"),
    sessionHook: hasFunction(session, "hook"),
    sessionPrompt: hasFunction(session, "prompt"),
    sessionCommand: hasFunction(session, "command"),
    sessionShell: hasFunction(session, "shell"),
    toolTransform: hasFunction(tool, "transform"),
    toolHook: hasFunction(tool, "hook")
  });
}

// src/source/opencode2/diagnostics.js
init_state();
import { promises as fs5 } from "fs";
import path10 from "path";
var OPENCODE_LOOP_V2_HELP_TEXT = [
  "OpenCode Loop V2 experimental help:",
  "/loop 0s --max-runs 2 <prompt>                  autonomous prompt loop",
  "/loop 5m --no-now --name later --multi <prompt> delayed named prompt loop",
  "/loop 0s --command /review                       slash-command loop when the host exposes session.command",
  "/loop-status                                      show current Loop jobs",
  "/loop-now [target]                                run matching jobs on the next idle boundary",
  "/loop-pause [target] | /loop-resume [target]      pause or resume jobs",
  "/loop-stop [target] | /loop-remove [target]       remove matching jobs",
  "/loop-clear                                       clear all jobs",
  "/loop-export                                      export current session Loop state as JSON",
  "/loop-logs                                        show the latest V2 runtime events",
  "/loop-help                                        show this experimental V2 help",
  "/loop-doctor                                      show local V2 diagnostics",
  "Experimental V2 does not yet claim full stable-plugin parity; unsupported options fail closed."
].join(`
`);
function scopeFrom(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : "";
  const sessionID = String(event?.sessionID || "").trim();
  if (!directory || !sessionID)
    return;
  return { directory, sessionID };
}
function createOpenCode2DiagnosticsRuntime(options = {}) {
  if (typeof options.prompt !== "function")
    throw new TypeError("V2 diagnostics runtime requires prompt()");
  const readState2 = typeof options.readState === "function" ? options.readState : readState;
  const readFile = typeof options.readFile === "function" ? options.readFile : (...args) => fs5.readFile(...args);
  const runtimeVersion = options.runtimeVersion || process.version;
  const runtimePlatform = options.runtimePlatform || process.platform;
  async function exportState(event) {
    const scope = scopeFrom(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    const state = await readState2(scope.directory, scope.sessionID);
    const text = `OpenCode loop state export:
\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\``;
    const request = { sessionID: scope.sessionID, text, noReply: true };
    await options.prompt(request);
    return { handled: true, accepted: true, state, request };
  }
  async function help(event) {
    const scope = scopeFrom(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    const request = { sessionID: scope.sessionID, text: OPENCODE_LOOP_V2_HELP_TEXT, noReply: true };
    await options.prompt(request);
    return { handled: true, accepted: true, request };
  }
  async function doctor(event) {
    const scope = scopeFrom(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    const state = await readState2(scope.directory, scope.sessionID);
    const text = [
      "OpenCode Loop V2 doctor:",
      "- plugin: bybrawe.opencode-loop.v2.experimental",
      `- project directory: ${scope.directory}`,
      `- state directory: ${stateDir(scope.directory)}`,
      `- active jobs: ${(state.jobs || []).length}`,
      `- node: ${runtimeVersion}`,
      `- platform: ${runtimePlatform}`,
      "- full stable parity: not claimed",
      "- smoke test: /loop 0s --max-runs 1 continue the current task"
    ].join(`
`);
    const request = { sessionID: scope.sessionID, text, noReply: true };
    await options.prompt(request);
    return { handled: true, accepted: true, state, request };
  }
  async function logs(event) {
    const scope = scopeFrom(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    let text = "No OpenCode 2 Loop log found.";
    try {
      const raw = await readFile(path10.join(stateDir(scope.directory), "loop.log"), "utf8");
      const lines = String(raw || "").trim().split(/\r?\n/).filter((line) => line.includes('"v2":true')).slice(-80);
      if (lines.length)
        text = lines.join(`
`);
    } catch {}
    const request = { sessionID: scope.sessionID, text: `OpenCode Loop V2 logs:
${text}`, noReply: true };
    await options.prompt(request);
    return { handled: true, accepted: true, request };
  }
  async function onEvent(event) {
    if (event?.kind === "command" && event?.action === "executed") {
      if (event?.name === "loop-export")
        return await exportState(event);
      if (event?.name === "loop-help")
        return await help(event);
      if (event?.name === "loop-doctor")
        return await doctor(event);
      if (event?.name === "loop-logs")
        return await logs(event);
    }
    return { handled: false };
  }
  return Object.freeze({ onEvent, exportState, help, doctor, logs });
}

// src/source/opencode2/logging.js
init_process();
function scopeFrom2(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : "";
  const sessionID = String(event?.sessionID || "").trim();
  if (!directory || !sessionID)
    return;
  return { directory, sessionID };
}
function jobName(job) {
  return String(job?.name || job?.id || "default");
}
function createOpenCode2LogRuntime(options = {}) {
  const appendLoopLog2 = typeof options.appendLoopLog === "function" ? options.appendLoopLog : appendLoopLog;
  async function append(scope, line, extra = {}) {
    try {
      await appendLoopLog2(scope.directory, line, { sessionID: scope.sessionID, v2: true, ...extra });
      return true;
    } catch {
      return false;
    }
  }
  async function record(event, result) {
    if (!result?.handled)
      return false;
    const scope = scopeFrom2(event);
    if (!scope)
      return false;
    if (event?.kind === "session" && event?.action === "idle" && result.dispatched && result.job) {
      return await append(scope, "run", {
        job: jobName(result.job),
        kind: result.kind || "prompt",
        runs: Number(result.job.runCount || 0)
      });
    }
    if (event?.kind !== "command" || event?.action !== "executed" || result.accepted !== true)
      return false;
    if (event.name === "loop" && result.job) {
      return await append(scope, "add", { job: jobName(result.job) });
    }
    if (event.name === "loop-now") {
      return await append(scope, "run-now", { target: result.target, count: Number(result.count || 0) });
    }
    if (event.name === "loop-pause") {
      return await append(scope, "pause", { target: result.target, count: Number(result.count || 0) });
    }
    if (event.name === "loop-resume") {
      return await append(scope, "resume", { target: result.target, count: Number(result.count || 0) });
    }
    if (event.name === "loop-stop") {
      return await append(scope, "stop", { target: result.target, count: Number(result.count || 0) });
    }
    if (event.name === "loop-remove") {
      return await append(scope, "remove", { target: result.target, count: Number(result.count || 0) });
    }
    if (event.name === "loop-clear") {
      return await append(scope, "clear", { target: result.target, count: Number(result.count || 0) });
    }
    return false;
  }
  return Object.freeze({ record });
}

// src/source/opencode2/prompt-runtime.js
init_jobs();
init_state();
var OPENCODE_LOOP_V2_PROMPT_PREFIX = "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly.";
function directoryFrom2(event) {
  return typeof event?.directory === "string" && event.directory.trim() ? event.directory : undefined;
}
function commandParts(action) {
  const normalized = String(action || "").trim().replace(/^\/+/, "");
  return splitFirst(normalized);
}
function unsupportedRuntimeJob(job, supportsCommand) {
  const blockers = [];
  const kind = actionKind(job?.action, job);
  if (!String(job?.action || "").trim())
    blockers.push("action");
  if (kind === "command") {
    if (!supportsCommand)
      blockers.push("command-capability");
    if (!commandParts(job?.action)[0])
      blockers.push("action");
  } else if (kind !== "prompt") {
    blockers.push("kind");
  }
  if (job?.watchPaths?.length)
    blockers.push("watch");
  if (job?.promptFile)
    blockers.push("prompt-file");
  if (job?.includeFiles?.length)
    blockers.push("include-file");
  if (job?.verifyCommand)
    blockers.push("verify");
  if (job?.preflightCommand)
    blockers.push("preflight");
  if (job?.postrunCommand)
    blockers.push("postrun");
  if (job?.notifyCommand)
    blockers.push("notify");
  if (job?.branch)
    blockers.push("branch");
  if (job?.compactEveryRuns > 0 || job?.compactEveryMs > 0)
    blockers.push("compact-every");
  if (job?.gitCheckpoint || job?.checkpointOnly)
    blockers.push("checkpoint");
  if (job?.timeoutMs > 0)
    blockers.push("timeout");
  if (job?.maxRuntimeMs > 0)
    blockers.push("max-runtime");
  if (job?.maxFailures > 0)
    blockers.push("max-failures");
  if (job?.until)
    blockers.push("until");
  if (job?.stopFile)
    blockers.push("stop-file");
  return [...new Set(blockers)];
}
function jobName2(job) {
  return String(job?.name || "default");
}
function promptText(job) {
  return `${OPENCODE_LOOP_V2_PROMPT_PREFIX}

${decoratePrompt(job)}`;
}
function commandTarget(event, fallback = "all") {
  return String(event?.arguments || "").trim() || fallback;
}
function scopeFrom3(event) {
  const directory = directoryFrom2(event);
  const sessionID = String(event?.sessionID || "").trim();
  if (!directory || !sessionID)
    return;
  return { directory, sessionID, key: `${directory}\x00${sessionID}` };
}
function runNowRequested(job) {
  return Number(job?.runNowRequestedAt || 0) > 0;
}
function dueAt2(job, current) {
  if (runNowRequested(job))
    return current;
  const intervalMs = Math.max(0, Number(job?.intervalMs || 0));
  const lastRunAt = Number(job?.lastRunAt || 0);
  if (intervalMs === 0)
    return current;
  if (lastRunAt <= 0) {
    if (job?.immediate === false) {
      const createdAt = Date.parse(job?.createdAt || "");
      return (Number.isFinite(createdAt) ? createdAt : current) + intervalMs;
    }
    return current;
  }
  return lastRunAt + intervalMs;
}
function createOpenCode2PromptRuntime(options = {}) {
  if (typeof options.prompt !== "function")
    throw new TypeError("V2 prompt runtime requires prompt()");
  const supportsCommand = typeof options.command === "function";
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const requireBusyBeforeIdle = options.requireBusyBeforeIdle === true;
  const timers = new Map;
  const idle = new Map;
  const queues = new Map;
  const awaitingBusy = new Set;
  let disposed = false;
  function report(error) {
    try {
      onError(error);
    } catch {}
  }
  function eligibleRuntimeJob(job) {
    if (!job?.enabled || job?.paused)
      return false;
    if (unsupportedRuntimeJob(job, supportsCommand).length)
      return false;
    return !(job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns);
  }
  function clearScopeTimer(key) {
    const current = timers.get(key);
    if (!current)
      return false;
    timers.delete(key);
    try {
      clearTimer(current.handle);
    } catch {}
    return true;
  }
  function clearScope(scope) {
    clearScopeTimer(scope.key);
    idle.delete(scope.key);
    awaitingBusy.delete(scope.key);
  }
  function enqueueScope(scope, task) {
    if (disposed)
      return Promise.resolve({ handled: false, reason: "disposed" });
    const previous = queues.get(scope.key) || Promise.resolve();
    const result = previous.catch(() => {
      return;
    }).then(async () => {
      if (disposed)
        return { handled: false, reason: "disposed" };
      return await task();
    });
    const tail = result.catch(() => {
      return;
    });
    queues.set(scope.key, tail);
    tail.then(() => {
      if (queues.get(scope.key) === tail)
        queues.delete(scope.key);
    });
    return result;
  }
  async function scheduleScope(scope) {
    clearScopeTimer(scope.key);
    if (disposed)
      return;
    const state = await readState(scope.directory, scope.sessionID);
    const current = now();
    let earliest;
    for (const job of state.jobs || []) {
      if (!eligibleRuntimeJob(job))
        continue;
      const intervalMs = Math.max(0, Number(job?.intervalMs || 0));
      if (intervalMs === 0)
        continue;
      const candidate = dueAt2(job, current);
      if (candidate <= current)
        continue;
      if (!earliest || candidate < earliest)
        earliest = candidate;
    }
    if (!earliest)
      return;
    const delay = Math.max(0, earliest - current);
    const token = Symbol(scope.key);
    const handle = setTimer(() => {
      const pending = enqueueScope(scope, async () => {
        const currentTimer = timers.get(scope.key);
        if (!currentTimer || currentTimer.token !== token)
          return { handled: false, reason: "stale-timer" };
        timers.delete(scope.key);
        if (idle.get(scope.key) !== true)
          return { handled: true, dispatched: false, reason: "not-idle" };
        return await runDueAction(scope);
      });
      pending.catch(report);
      return pending;
    }, delay);
    handle?.unref?.();
    timers.set(scope.key, { handle, token, dueAt: earliest });
    return earliest;
  }
  async function dispatchJob(scope, job) {
    const kind = actionKind(job?.action, job);
    if (kind === "command") {
      const [command, argumentsText] = commandParts(job.action);
      const request = {
        sessionID: scope.sessionID,
        command,
        arguments: argumentsText || undefined
      };
      await options.command(request);
      return { kind, request };
    }
    const text = promptText(job);
    const request = { sessionID: scope.sessionID, text };
    if (requireBusyBeforeIdle)
      awaitingBusy.add(scope.key);
    try {
      await options.prompt(request);
    } catch (error) {
      awaitingBusy.delete(scope.key);
      throw error;
    }
    return { kind: "prompt", request, text };
  }
  async function runDueAction(scope) {
    const state = await readState(scope.directory, scope.sessionID);
    const current = now();
    const due = (state.jobs || []).filter((candidate) => eligibleRuntimeJob(candidate) && dueAt2(candidate, current) <= current);
    const job = due.find(runNowRequested) || due[0];
    if (!job) {
      await scheduleScope(scope);
      return { handled: true, dispatched: false };
    }
    delete job.runNowRequestedAt;
    job.lastRunAt = current;
    job.runCount = (job.runCount || 0) + 1;
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns)
      job.enabled = false;
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate);
    await writeState(scope.directory, scope.sessionID, state);
    idle.set(scope.key, false);
    await scheduleScope(scope);
    const dispatched = await dispatchJob(scope, job);
    return { handled: true, dispatched: true, job, ...dispatched };
  }
  async function addPromptLoop(event) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    return await enqueueScope(scope, async () => {
      const parsed = parseLoopArgs(event.arguments || "");
      if (!parsed.ok)
        return { handled: true, accepted: false, reason: "parse", error: parsed.error };
      const blockers = unsupportedRuntimeJob(parsed.job, supportsCommand);
      if (blockers.length)
        return { handled: true, accepted: false, reason: "unsupported", blockers };
      parsed.job.createdAt = new Date(now()).toISOString();
      parsed.job.lastRunAt = parsed.job.immediate === false ? now() : 0;
      parsed.job.name = jobName2(parsed.job);
      const state = await readState(scope.directory, scope.sessionID);
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      if (!parsed.job.multi) {
        state.jobs = jobs.filter((job) => jobName2(job) !== parsed.job.name);
      } else {
        state.jobs = jobs;
      }
      state.jobs.push(parsed.job);
      await writeState(scope.directory, scope.sessionID, state);
      await scheduleScope(scope);
      return { handled: true, accepted: true, job: parsed.job };
    });
  }
  async function statusPromptLoops(event) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    return await enqueueScope(scope, async () => {
      const status = formatOpenCode2LoopStatus(await readState(scope.directory, scope.sessionID), now());
      const request = { sessionID: scope.sessionID, text: status.text, noReply: true };
      await options.prompt(request);
      return { handled: true, accepted: true, status, request };
    });
  }
  async function runPromptLoopsNow(event) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    return await enqueueScope(scope, async () => {
      const target = commandTarget(event);
      const state = await readState(scope.directory, scope.sessionID);
      const requestedAt = Math.max(1, now());
      let count = 0;
      state.jobs = (state.jobs || []).map((job, index) => {
        if (!matchJob(job, target, index))
          return job;
        const resumed = { ...job, paused: false };
        if (!eligibleRuntimeJob(resumed))
          return job;
        count += 1;
        return { ...resumed, runNowRequestedAt: requestedAt };
      });
      await writeState(scope.directory, scope.sessionID, state);
      await scheduleScope(scope);
      return { handled: true, accepted: true, count, target, requestedAt: count ? requestedAt : undefined };
    });
  }
  async function updatePromptLoops(event, updater) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    return await enqueueScope(scope, async () => {
      const target = commandTarget(event);
      const state = await readState(scope.directory, scope.sessionID);
      let count = 0;
      state.jobs = (state.jobs || []).map((job, index) => {
        if (!matchJob(job, target, index))
          return job;
        count += 1;
        return updater(job);
      });
      await writeState(scope.directory, scope.sessionID, state);
      await scheduleScope(scope);
      return { handled: true, accepted: true, count, target };
    });
  }
  async function stopPromptLoops(event, forcedTarget) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    return await enqueueScope(scope, async () => {
      const target = forcedTarget || commandTarget(event);
      if (target.toLowerCase() === "all") {
        const state = await readState(scope.directory, scope.sessionID);
        const count = (state.jobs || []).length;
        await removeState(scope.directory, scope.sessionID);
        await scheduleScope(scope);
        return { handled: true, accepted: true, count, target };
      }
      const state = await readState(scope.directory, scope.sessionID);
      const before = (state.jobs || []).length;
      state.jobs = (state.jobs || []).filter((job, index) => !matchJob(job, target, index));
      await writeState(scope.directory, scope.sessionID, state);
      await scheduleScope(scope);
      return { handled: true, accepted: true, count: before - state.jobs.length, target };
    });
  }
  async function runIdlePrompt(event) {
    const scope = scopeFrom3(event);
    if (!scope)
      return { handled: false, reason: "missing-scope" };
    idle.set(scope.key, true);
    return await enqueueScope(scope, () => runDueAction(scope));
  }
  async function onEvent(event) {
    const scope = scopeFrom3(event);
    if (event?.kind === "command" && event?.action === "executed") {
      if (scope)
        idle.set(scope.key, false);
      if (event?.name === "loop")
        return addPromptLoop(event);
      if (event?.name === "loop-status")
        return statusPromptLoops(event);
      if (event?.name === "loop-now")
        return runPromptLoopsNow(event);
      if (event?.name === "loop-pause")
        return updatePromptLoops(event, (job) => ({ ...job, paused: true }));
      if (event?.name === "loop-resume")
        return updatePromptLoops(event, (job) => ({ ...job, paused: false, lastRunAt: 0 }));
      if (["loop-stop", "loop-remove"].includes(event?.name))
        return stopPromptLoops(event);
      if (event?.name === "loop-clear")
        return stopPromptLoops(event, "all");
    }
    if (event?.kind === "session" && event?.action === "idle") {
      if (requireBusyBeforeIdle && scope && awaitingBusy.has(scope.key)) {
        return { handled: true, dispatched: false, reason: "awaiting-busy" };
      }
      return runIdlePrompt(event);
    }
    if (event?.kind === "session" && event?.action === "status" && scope) {
      if (event.status === "busy" || event.status === "retry") {
        awaitingBusy.delete(scope.key);
        idle.set(scope.key, false);
        return await enqueueScope(scope, async () => {
          await scheduleScope(scope);
          return { handled: true, dispatched: false };
        });
      }
      if (event.status === "idle") {
        if (requireBusyBeforeIdle) {
          if (awaitingBusy.has(scope.key)) {
            return { handled: true, dispatched: false, reason: "awaiting-busy" };
          }
          return runIdlePrompt(event);
        }
        idle.set(scope.key, true);
        return await enqueueScope(scope, async () => {
          await scheduleScope(scope);
          return { handled: true, dispatched: false };
        });
      }
      return { handled: false };
    }
    if (event?.kind === "session" && event?.action === "deleted" && scope) {
      clearScope(scope);
      return { handled: true, disposedScope: true };
    }
    if (event?.kind === "message" && event?.action === "updated" && scope) {
      if (event.role === "user" || event.role === "assistant" && !event.completedAt)
        idle.set(scope.key, false);
      return { handled: false };
    }
    if (event?.kind === "server" && event?.action === "disposed") {
      await dispose();
      return { handled: true, disposed: true };
    }
    return { handled: false };
  }
  async function dispose() {
    if (disposed)
      return false;
    disposed = true;
    for (const { handle } of timers.values()) {
      try {
        clearTimer(handle);
      } catch {}
    }
    timers.clear();
    idle.clear();
    awaitingBusy.clear();
    const pending = [...queues.values()];
    if (pending.length)
      await Promise.allSettled(pending);
    queues.clear();
    return true;
  }
  return Object.freeze({
    onEvent,
    addPromptLoop,
    statusPromptLoops,
    runPromptLoopsNow,
    updatePromptLoops,
    stopPromptLoops,
    runIdlePrompt,
    dispose,
    scheduledCount: () => timers.size
  });
}

// src/source/opencode2/host-contract.js
function normalizePrompt(input) {
  const sessionID = String(input?.sessionID || "").trim();
  const text = String(input?.text || "");
  if (!sessionID)
    throw new TypeError("prompt requires a session ID");
  if (!text.trim())
    throw new TypeError("prompt requires text");
  return Object.freeze({
    sessionID,
    text,
    agent: input?.agent,
    model: input?.model,
    noReply: input?.noReply === true
  });
}
function normalizeCommand(input) {
  const sessionID = String(input?.sessionID || "").trim();
  const command = String(input?.command || "").trim().replace(/^\/+/, "");
  if (!sessionID)
    throw new TypeError("command requires a session ID");
  if (!command)
    throw new TypeError("command requires a command name");
  return Object.freeze({
    sessionID,
    command,
    arguments: input?.arguments === undefined ? undefined : String(input.arguments),
    agent: input?.agent,
    model: input?.model,
    delivery: input?.delivery,
    resume: input?.resume
  });
}
function createOpenCode2HostContract(options = {}) {
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : async () => {};
  let started = false;
  let disposed = false;
  let hostDisposed = false;
  const bridge = createOpenCode2EventBridge({
    directory: options.directory,
    onError: options.onError,
    onEvent: async (event, runtime) => {
      if (event.kind === "server" && event.action === "disposed")
        hostDisposed = true;
      await onEvent(event, runtime);
    }
  });
  async function start() {
    if (disposed)
      throw new Error("OpenCode 2 host contract is disposed");
    if (started)
      return false;
    if (typeof options.subscribe !== "function")
      throw new TypeError("subscribe must be a function");
    if (typeof options.sendPrompt !== "function")
      throw new TypeError("sendPrompt must be a function");
    await bridge.attach(options.subscribe);
    started = true;
    return true;
  }
  async function prompt(input) {
    if (disposed || hostDisposed)
      throw new Error("OpenCode 2 host contract is unavailable");
    if (!started)
      throw new Error("OpenCode 2 host contract is not started");
    const request = normalizePrompt(input);
    const runtime = bridge.runtimeManager.observeExternal(request.sessionID);
    return await options.sendPrompt(Object.freeze({ ...request, runtime }));
  }
  async function command(input) {
    if (disposed || hostDisposed)
      throw new Error("OpenCode 2 host contract is unavailable");
    if (!started)
      throw new Error("OpenCode 2 host contract is not started");
    if (typeof options.sendCommand !== "function")
      throw new Error("OpenCode 2 session.command capability is unavailable");
    const request = normalizeCommand(input);
    const runtime = bridge.runtimeManager.observeExternal(request.sessionID);
    return await options.sendCommand(Object.freeze({ ...request, runtime }));
  }
  async function dispose(reason = "host-contract-disposed") {
    if (disposed)
      return false;
    disposed = true;
    await bridge.dispose(reason);
    return true;
  }
  return Object.freeze({
    start,
    prompt,
    command,
    dispose,
    runtimeManager: bridge.runtimeManager,
    isStarted: () => started,
    isDisposed: () => disposed,
    isHostDisposed: () => hostDisposed
  });
}

// src/source/opencode2/runtime-adapter.js
function promptRequest(request) {
  const value = {
    sessionID: request.sessionID
  };
  if (request.noReply === true) {
    value.noReply = true;
    value.parts = [{ type: "text", text: request.text }];
    value.text = request.text;
    value.resume = false;
  } else {
    value.text = request.text;
  }
  if (request.agent !== undefined)
    value.agent = request.agent;
  if (request.model !== undefined)
    value.model = request.model;
  return value;
}
function commandRequest(request) {
  const value = {
    sessionID: request.sessionID,
    name: request.command,
    command: request.command
  };
  if (request.arguments !== undefined) {
    value.arguments = request.arguments;
    value.text = request.arguments;
  }
  if (request.agent !== undefined)
    value.agent = request.agent;
  if (request.model !== undefined)
    value.model = request.model;
  if (request.delivery !== undefined)
    value.delivery = request.delivery;
  if (request.resume !== undefined)
    value.resume = request.resume;
  return value;
}
function createOpenCode2RuntimeAdapter(ctx, options = {}) {
  const capabilities = inspectOpenCode2Context(ctx);
  if (!capabilities.eventSubscribe)
    throw new Error("OpenCode 2 event.subscribe capability is unavailable");
  if (!capabilities.sessionPrompt)
    throw new Error("OpenCode 2 session.prompt capability is unavailable");
  const subscribe = options.eventSubscribeStyle === "stream" ? () => ctx.event.subscribe() : ctx.event.subscribe.bind(ctx.event);
  const host = createOpenCode2HostContract({
    directory: options.directory,
    subscribe,
    sendPrompt: (request) => ctx.session.prompt(promptRequest(request)),
    sendCommand: capabilities.sessionCommand ? (request) => ctx.session.command(commandRequest(request)) : undefined,
    onEvent: options.onEvent,
    onError: options.onError
  });
  return Object.freeze({
    start: () => host.start(),
    prompt: (request) => host.prompt(request),
    command: (request) => host.command(request),
    dispose: (reason = "runtime-adapter-disposed") => host.dispose(reason),
    runtimeManager: host.runtimeManager,
    isStarted: host.isStarted,
    isDisposed: host.isDisposed,
    isHostDisposed: host.isHostDisposed
  });
}

// src/source/opencode2/experimental.js
var OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental";
var OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    if (typeof ctx?.session?.hook === "function")
      return OpenCodeLoopNativePlugin.setup(ctx);
    const capabilities = inspectOpenCode2Context(ctx);
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable");
    }
    let promptRuntime;
    let diagnosticsRuntime;
    const hostVersion = String(ctx?.app?.version || "").trim();
    const promiseStreamHost = /^2\./.test(hostVersion);
    const requireBusyBeforeIdle = promiseStreamHost;
    const logRuntime = createOpenCode2LogRuntime();
    const runtimeDirectory = String(ctx?.location?.directory || ctx?.options?.directory || "").trim() || undefined;
    const onRuntimeEvent = async (event) => {
      const promptResult = await promptRuntime?.onEvent(event);
      await logRuntime.record(event, promptResult);
      if (promptResult?.handled)
        return promptResult;
      return await diagnosticsRuntime?.onEvent(event) ?? promptResult;
    };
    const commandRegistration = await ctx.command.transform((draft) => {
      return registerOpenCode2LoopCommands(draft, {
        execute: async ({ name, sessionID, arguments: argumentsText, delivery }) => {
          if (!promptRuntime || !diagnosticsRuntime) {
            throw new Error("OpenCode Loop V2 runtime is not ready");
          }
          const commandEvent = Object.freeze({
            kind: "command",
            action: "executed",
            sessionID: String(sessionID || ""),
            directory: runtimeDirectory,
            name,
            arguments: argumentsText,
            delivery
          });
          const result = await onRuntimeEvent(commandEvent);
          if (result?.handled && result?.accepted && ["loop", "loop-now", "loop-resume"].includes(name)) {
            await onRuntimeEvent(Object.freeze({
              kind: "session",
              action: "idle",
              sessionID: String(sessionID || ""),
              directory: runtimeDirectory
            }));
          }
          return result;
        }
      });
    });
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await commandRegistration?.dispose?.();
      return;
    }
    const runtime = createOpenCode2RuntimeAdapter(ctx, {
      directory: runtimeDirectory,
      onEvent: onRuntimeEvent,
      eventSubscribeStyle: promiseStreamHost ? "stream" : "auto"
    });
    promptRuntime = createOpenCode2PromptRuntime({
      prompt: (request) => runtime.prompt(request),
      command: capabilities.sessionCommand ? (request) => runtime.command(request) : undefined,
      requireBusyBeforeIdle
    });
    diagnosticsRuntime = createOpenCode2DiagnosticsRuntime({
      prompt: (request) => runtime.prompt(request)
    });
    try {
      await runtime.start();
    } catch (error) {
      await promptRuntime?.dispose?.().catch(() => {
        return;
      });
      await commandRegistration?.dispose?.().catch(() => {
        return;
      });
      throw error;
    }
    return async () => {
      await promptRuntime?.dispose?.();
      await runtime.dispose("plugin-cleanup");
      await commandRegistration?.dispose?.();
    };
  }
};
var experimental_default = OpenCodeLoopV2ExperimentalPlugin;

// src/source/server.js
async function OpenCodeLoopPlugin(...args) {
  const { default: legacy } = await import(new URL("./v1.js", import.meta.url).href);
  return legacy(...args);
}
var OPENCODE_LOOP_PLUGIN_ID = "@bybrawe/opencode-loop";
var OpenCodeLoopPluginModule = Object.freeze({
  id: OPENCODE_LOOP_PLUGIN_ID,
  server: OpenCodeLoopPlugin,
  setup: (context) => experimental_default.setup(context)
});
var server_default = OpenCodeLoopPluginModule;
export {
  OPENCODE_LOOP_PLUGIN_ID,
  OpenCodeLoopPlugin,
  OpenCodeLoopPluginModule,
  experimental_default as OpenCodeLoopV2ExperimentalPlugin,
  server_default as default
};
