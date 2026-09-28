import { stat } from "node:fs/promises"
import path from "node:path"
import { runShellCommand, appendLoopLog } from "../core/process.js"
import { createJobWorkspaceRuntime, dangerousShell } from "../runtime/job-workspace.js"

export function createNativeJobPolicy(options = {}) {
  const now = options.now || Date.now
  const run = options.runShellCommand || runShellCommand
  const workspace = options.workspace || createJobWorkspaceRuntime({ toast: async () => {} })

  function pause(job, reason, failed = false) {
    job.paused = true
    job.pauseReason = reason
    if (failed) job.failureCount = (job.failureCount || 0) + 1
    return false
  }

  async function shell(scope, job, command, phase) {
    if (job.safe && dangerousShell(command)) {
      return { code: -1, stdout: "", stderr: `Blocked ${phase} by --safe command guard`, blocked: true }
    }
    const result = await run(command, scope.directory, Math.max(1, Number(job.timeoutMs) || 120_000))
    await appendLoopLog(scope.directory, `v2-${phase}`, {
      sessionID: scope.sessionID, job: job.name || job.id, code: result.code,
      output: String(result.stdout || "").slice(-8000), error: String(result.stderr || "").slice(-8000),
    })
    return result
  }

  async function prepare(scope, job, isCurrent = () => true) {
    const created = Date.parse(job.createdAt)
    if (job.maxRuntimeMs > 0 && Number.isFinite(created) && now() - created >= job.maxRuntimeMs) {
      job.enabled = false
      return pause(job, "max-runtime")
    }
    if (job.stopFile) {
      try {
        await stat(path.resolve(scope.directory, job.stopFile))
        job.enabled = false
        return pause(job, "stop-file")
      } catch (error) { if (error?.code !== "ENOENT") throw error }
    }
    if (await workspace.untilReached(scope.directory, job)) {
      job.enabled = false
      return pause(job, "until-reached")
    }
    if (!isCurrent()) return false
    if (job.dryRun) return true
    if (job.preflightCommand) {
      const result = await shell(scope, job, job.preflightCommand, "preflight")
      job.lastPreflightCode = result.code
      if (result.code !== 0) return pause(job, "preflight-failed", true)
    }
    if (!isCurrent()) return false
    if (job.branch) {
      await workspace.ensureBranch(scope.directory, job, undefined, scope.sessionID)
      if (!job.branchDone) return pause(job, "branch-unavailable", true)
    }
    return isCurrent()
  }

  async function finish(scope, job, isCurrent = () => true) {
    if (!isCurrent() || job.dryRun) return
    if (job.verifyCommand) {
      const result = await shell(scope, job, job.verifyCommand, "verify")
      job.lastVerifyCode = result.code
      job.lastVerifyAt = now()
      job.lastVerifyOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-8000)
      if (result.code !== 0) {
        job.failureCount = (job.failureCount || 0) + 1
        if (result.blocked || job.pauseOnVerifyFail || (job.maxFailures > 0 && job.failureCount >= job.maxFailures)) pause(job, "verification-failed")
        return
      }
      job.failureCount = 0
    }
    if (!isCurrent()) return
    if (job.postrunCommand) {
      const result = await shell(scope, job, job.postrunCommand, "postrun")
      job.lastPostrunCode = result.code
      if (result.code !== 0) {
        pause(job, "postrun-failed", true)
        return
      }
    }
    if (isCurrent()) await workspace.createCheckpoint(scope.directory, scope.sessionID, job, undefined)
  }

  async function notify(scope, job, reason) {
    if (!job.notifyCommand || job.dryRun) return
    // Placeholders are data, not a route for event/error strings to become shell syntax.
    const literal = (value) => String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160)
    const command = String(job.notifyCommand).replace(/\{reason\}/g, literal(reason)).replace(/\{job\}/g, literal(job.name || job.id))
    await shell(scope, job, command, "notify")
  }

  return {
    pause, prepare, finish, notify, shell,
    buildPrompt: workspace.buildPrompt,
    snapshotPaths: workspace.snapshotPaths,
    watchChanged: workspace.watchChanged,
  }
}
