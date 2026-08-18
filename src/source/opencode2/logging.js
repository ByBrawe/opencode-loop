import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"

function scopeFrom(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : ""
  const sessionID = String(event?.sessionID || "").trim()
  if (!directory || !sessionID) return undefined
  return { directory, sessionID }
}

function jobName(job) {
  return String(job?.name || job?.id || "default")
}

export function createOpenCode2LogRuntime(options = {}) {
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog

  async function append(scope, line, extra = {}) {
    try {
      await appendLoopLog(scope.directory, line, { sessionID: scope.sessionID, v2: true, ...extra })
      return true
    } catch {
      return false
    }
  }

  async function record(event, result) {
    if (!result?.handled) return false
    const scope = scopeFrom(event)
    if (!scope) return false

    if (event?.kind === "session" && event?.action === "idle" && result.dispatched && result.job) {
      return await append(scope, "run", {
        job: jobName(result.job),
        kind: result.kind || "prompt",
        runs: Number(result.job.runCount || 0),
      })
    }

    if (event?.kind !== "command" || event?.action !== "executed" || result.accepted !== true) return false

    if (event.name === "loop" && result.job) {
      return await append(scope, "add", { job: jobName(result.job) })
    }
    if (event.name === "loop-now") {
      return await append(scope, "run-now", { target: result.target, count: Number(result.count || 0) })
    }
    if (event.name === "loop-pause") {
      return await append(scope, "pause", { target: result.target, count: Number(result.count || 0) })
    }
    if (event.name === "loop-resume") {
      return await append(scope, "resume", { target: result.target, count: Number(result.count || 0) })
    }
    if (event.name === "loop-stop") {
      return await append(scope, "stop", { target: result.target, count: Number(result.count || 0) })
    }
    if (event.name === "loop-remove") {
      return await append(scope, "remove", { target: result.target, count: Number(result.count || 0) })
    }
    if (event.name === "loop-clear") {
      return await append(scope, "clear", { target: result.target, count: Number(result.count || 0) })
    }
    return false
  }

  return Object.freeze({ record })
}
