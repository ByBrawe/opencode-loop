import { tool } from "@opencode-ai/plugin/tool"
import { now } from "./core/args.js"
import { isGoalJob } from "./core/jobs.js"
import { readState, writeState } from "./core/state.js"
import { appendLoopLog, runShellCommand } from "./core/process.js"
import { sdkErrorMessage } from "./opencode/sdk.js"
import { updateSessionExecutionContext } from "./opencode/session-context.js"
import { log, toast } from "./opencode/host.js"
import { loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"
import { clearCommandLifecycle } from "./opencode/commands.js"
import { createCommandRouter } from "./opencode/command-router.js"
import { createGoalCommandHandlers } from "./opencode/goal-commands.js"
import { createLoopCommandHandlers } from "./opencode/loop-commands.js"
import { createLoopRegistration } from "./opencode/loop-registration.js"
import { markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"
import { createSchedulerRuntime } from "./runtime/scheduler.js"
import { setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"
import { createGoalExecutionPolicy } from "./runtime/goal-policy.js"
import { createJobWorkspaceRuntime, dangerousShell } from "./runtime/job-workspace.js"
import { createLoopExecutor } from "./runtime/executor.js"

const DEFAULT_ACTIVE_GUARD_MS = 45_000

const workspaceRuntime = createJobWorkspaceRuntime({ toast })
const { snapshotPaths } = workspaceRuntime
const goalPolicy = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

let schedulerRuntime
const schedulerBridge = {
  rememberSession: (...args) => schedulerRuntime.rememberSession(...args),
  scheduleDueWork: (...args) => schedulerRuntime.scheduleDueWork(...args),
}
const executorRuntime = createLoopExecutor({
  workspace: workspaceRuntime,
  goalPolicy,
  scheduler: schedulerBridge,
  toast,
  log,
  appendLoopLog,
  errorMessage: sdkErrorMessage,
  now,
})
const {
  clearActiveRun,
  finalizeActiveRun,
  maybeRunDueJobs,
  sessionIsIdle,
  updateSessionStatusFromEvent,
  noteLoopCompactionStarted,
  noteLoopCompactionCompleted,
} = executorRuntime

schedulerRuntime = createSchedulerRuntime({
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime

const { addLoop } = createLoopRegistration({
  snapshotPaths,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
  defaultActiveGuardMs: DEFAULT_ACTIVE_GUARD_MS,
})

const {
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

const {
  stopLoop,
  updateJobState,
  statusLoop,
  logsLoop,
  helpLoop,
  runNow,
  doctorLoop,
  initLoop,
  exportLoop,
} = createLoopCommandHandlers({
  clearActiveRun,
  cancelDueWork,
  stopWatchdog,
  scheduleDueWork,
  maybeRunDueJobs,
  toast,
  say,
  now,
})

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

function disposeRuntime(directory, client) {
  const sessions = schedulerRuntime.sessionIDsForHost(directory, client)
  for (const sessionID of sessions) {
    executorRuntime.disposeSession(sessionID)
    schedulerRuntime.clearSessionScheduling(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    clearCommandLifecycle(sessionID)
  }
}

function userInterruptSessionFromEvent(event) {
  if (!["message.updated", "message.created"].includes(String(event?.type || ""))) return undefined
  const props = event?.properties || {}
  const info = props.info || props.message || props
  const role = info?.role
  const sessionID = info?.sessionID || props.sessionID
  const messageID = info?.id || props.messageID
  if (role !== "user" || typeof sessionID !== "string") return undefined
  if (loopOwnedUserMessageGuardActive(sessionID, messageID)) return undefined
  return sessionID
}

async function pauseGoalsForUserInterrupt(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const interruptedAt = now()
  let count = 0
  state.jobs = (state.jobs || []).map((job) => {
    if (!isGoalJob(job) || job.paused || job.enabled === false || ["completed", "blocked", "cleared"].includes(job.goalStatus)) return job
    count++
    return {
      ...job,
      paused: true,
      lastUserInterruptAt: interruptedAt,
      goalInterruptedReason: "Paused because the user sent a new message while the experimental goal was active.",
    }
  })
  if (!count) return false
  await writeState(directory, sessionID, state)
  await toast(client, `Paused ${count} experimental goal(s) because a new user message arrived. Resume with /loop-goal-resume.`, "warning")
  await appendLoopLog(directory, "goal-user-interrupt", { sessionID, count })
  await scheduleDueWork(directory, client, sessionID)
  return true
}

function goalTools(defaultDirectory) {
  return {
    opencode_loop_goal_complete: tool({
      description: "Mark the current OpenCode Loop experimental goal as completed. Use only after acceptance criteria are satisfied and you have evidence from tests, typecheck, build, or code inspection.",
      args: {
        summary: tool.schema.string().describe("Short human-readable summary of what was completed."),
        evidence: tool.schema.string().describe("Concrete evidence that the goal is complete, such as commands run, passing checks, files changed, and important results."),
      },
      execute: async (args, context) => {
        const result = await setGoalComplete(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal completed" : result.rejected ? "Goal completion rejected" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_blocked: tool({
      description: "Mark the current OpenCode Loop experimental goal as blocked when user input or manual intervention is required.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What user input, credential, decision, or manual action is needed to continue."),
      },
      execute: async (args, context) => {
        const result = await setGoalBlocked(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal blocked" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_progress: tool({
      description: "Record meaningful progress on the current OpenCode Loop experimental goal without completing it.",
      args: {
        summary: tool.schema.string().describe("What useful progress was made."),
        next: tool.schema.string().describe("The next step toward completing the goal."),
      },
      execute: async (args, context) => {
        const result = await setGoalProgress(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal progress" : "Goal not found", output: result.message }
      },
    }),
  }
}

export const OpenCodeLoopPlugin = async ({ client, directory }) => {
  // OpenCode's local SDK can be slow or unavailable while a project instance
  // is still waiting for its plugins to return their hooks. Defer bootstrap
  // calls so headless/server sessions cannot deadlock during plugin loading.
  const bootstrap = setTimeout(() => {
    log(client, "info", "Plugin initialized", { directory }).catch(() => {})
    refreshSessionRelationships(client, directory).catch(() => {})
  }, 0)
  bootstrap.unref?.()
  return {
    dispose: async () => { disposeRuntime(directory, client) },
    tool: goalTools(directory),
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    "experimental.session.compacting": async (input) => { await noteLoopCompactionStarted(directory, input?.sessionID) },
    event: async ({ event }) => {
      if (event.type === "session.compacted") await noteLoopCompactionCompleted(directory, client, event?.properties?.sessionID)
      updateSessionRelationshipFromEvent(event)
      if (event.type === "message.updated") updateSessionExecutionContext(event?.properties?.info)
      updateToolActivityFromEvent(event)
      if (event.type === "command.executed") {
        const props = event.properties || {}
        await handleCommand(directory, client, props, props.name, props.arguments, undefined, "event")
      }
      const interruptedSessionID = userInterruptSessionFromEvent(event)
      if (interruptedSessionID) {
        rememberSession(directory, client, interruptedSessionID)
        await pauseGoalsForUserInterrupt(directory, client, interruptedSessionID)
      }
      const statusUpdate = updateSessionStatusFromEvent(event)
      if (statusUpdate?.sessionID) rememberSession(directory, client, statusUpdate.sessionID)
      if (statusUpdate?.idle) scheduleIdleWork(directory, client, statusUpdate.sessionID)
    },
  }
}

export default OpenCodeLoopPlugin
