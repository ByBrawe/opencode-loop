import path from "node:path"
import { DEFAULT_GOAL_MAX_NO_PROGRESS } from "../core/args.js"
import { readSmallTextFile } from "../core/process.js"

const GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION"

export async function buildGoalPrompt(directory, job) {
  const sections = []
  sections.push(`Working directory:\n${path.resolve(directory)}\nKeep every file operation inside this directory. Prefer workspace-relative paths such as \"src/index.js\"; never turn a relative path into a root path such as \"/src/index.js\".`)
  const objective = String(job.action || "").trim()
  if (objective) sections.push(`Goal objective:\n${objective}`)
  if (job.goalFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.goalFile), 120_000)
    if (text.trim()) sections.push(`Goal file ${job.goalFile}:\n${text.trim()}`)
    else sections.push(`Goal file ${job.goalFile} was requested but could not be read. Continue from the inline goal objective.`)
  }
  if (job.promptFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.promptFile), 120_000)
    if (text.trim()) sections.push(`Extra goal instructions from ${job.promptFile}:\n${text.trim()}`)
  }
  if (job.goalAcceptance?.length) sections.push("Acceptance criteria:\n" + job.goalAcceptance.map((item, index) => `${index + 1}. ${item}`).join("\n"))
  if (job.goalChecks?.length) sections.push("Verification commands that define useful evidence:\n" + job.goalChecks.map((item, index) => `${index + 1}. ${item}`).join("\n"))
  if (job.verifyCommand) sections.push(`Post-turn verify command configured by the loop: ${job.verifyCommand}`)
  if (job.lastGoalChecks?.length) sections.push("Latest goal check results:\n" + job.lastGoalChecks.map((item) => `- ${item.command}: exit ${item.code}`).join("\n"))
  if (job.lastVerifyFailure) sections.push("Previous verify/check failure summary:\n" + String(job.lastVerifyFailure).slice(0, 1600))
  if (job.goalCompletionRejectedReason) sections.push(`Previous completion attempt was rejected:\n${job.goalCompletionRejectedReason}`)
  if ((job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0) sections.push(`No-progress guard:\n${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS} recent turn(s) without recorded meaningful progress.`)
  if (job.goalProgress?.length) sections.push("Recent goal progress:\n" + job.goalProgress.slice(-5).map((item) => `- ${item.time}: ${item.summary}`).join("\n"))
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
    if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
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

${sections.join("\n\n---\n\n")}`
}
