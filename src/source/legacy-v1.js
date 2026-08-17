import { tool } from "@opencode-ai/plugin/tool"
import { now } from "./core/args.js"
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
import { createGoalSteeringRuntime } from "./runtime/goal-steering.js"

const DEFAULT_ACTIVE_GUARD_MS = 45_000
const STEERING_ABORT_READY_TIMEOUT_MS = 2_000
const STEERING_ABORT_READY_POLL_MS = 25

const workspaceRuntime = createJobWorkspaceRuntime({ toast })
const { snapshotPaths } = workspaceRuntime
const goalPolicy = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

let schedulerRuntime
let goalSteeringRuntime
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
  maybeRunDueJobs: runDueJobs,
  sessionIsIdle,
  updateSessionStatusFromEvent,
  noteLoopCompactionStarted,
  noteLoopCompactionCompleted,
} = executorRuntime

async function maybeRunDueJobs(directory, client, sessionID, runOptions) {
  if (goalSteeringRuntime?.shouldSuppressIdle(sessionID)) return
  return await runDueJobs(directory, client, sessionID, runOptions)
}

async function waitForSteeringAbortReady(directory, client, sessionID) {
  const deadline = Date.now() + STEERING_ABORT_READY_TIMEOUT_MS
  do {
    executorRuntime.clearSessionStatus(sessionID)
    if (await sessionIsIdle(client, sessionID, directory, { recoverStaleActive: false })) return true
    await new Promise((resolve) => setTimeout(resolve, STEERING_ABORT_READY_POLL_MS))
  } while (Date.now() < deadline)
  executorRuntime.clearSessionStatus(sessionID)
  return await sessionIsIdle(client, sessionID, directory, { recoverStaleActive: false })
}

schedulerRuntime = createSchedulerRuntime({
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime

goalSteeringRuntime = createGoalSteeringRuntime({
  getActiveRun: executorRuntime.getActiveRun,
  clearActiveRun,
  isLoopOwnedUserMessage: loopOwnedUserMessageGuardActive,
  appendLoopLog,
  waitForAbortReady: waitForSteeringAbortReady,
  now,
})

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
    goalSteeringRuntime.clearSession(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    clearCommandLifecycle(sessionID)
  }
}

function steeringToolRejection(sessionID) {
  if (!goalSteeringRuntime.hasPendingSteering(sessionID)) return undefined
  return {
    title: "Goal steering pending",
    output: "Goal lifecycle update deferred because queued user steering is pending. The experimental Goal remains active and unchanged.",
  }
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
        const steering = steeringToolRejection(context.sessionID)
        if (steering) return steering
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
        const steering = steeringToolRejection(context.sessionID)
        if (steering) return steering
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
        const steering = steeringToolRejection(context.sessionID)
        if (steering) return steering
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
    "chat.message": async (input, output) => {
      const steering = await goalSteeringRuntime.handleChatMessage(directory, client, input, output)
      if (steering?.handled && steering.sessionID) rememberSession(directory, client, steering.sessionID)
    },
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
      const steering = await goalSteeringRuntime.handleEvent(directory, client, event)
      if (steering?.handled && steering.sessionID) rememberSession(directory, client, steering.sessionID)
      const statusUpdate = updateSessionStatusFromEvent(event)
      if (statusUpdate?.sessionID) rememberSession(directory, client, statusUpdate.sessionID)
      if (statusUpdate?.idle && !goalSteeringRuntime.shouldSuppressIdle(statusUpdate.sessionID)) {
        scheduleIdleWork(directory, client, statusUpdate.sessionID)
      }
    },
  }
}

export default OpenCodeLoopPlugin
