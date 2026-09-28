import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

// User-configured host commands, not model tools. No OpenCode session is aborted.
export function createNativeShellHost({ directory, onTerminal, onError = () => {} } = {}) {
  if (!directory || typeof onTerminal !== "function") throw new TypeError("Native shell requires directory and onTerminal")
  const tasks = new Set()
  let disposed = false
  const report = (error) => { try { onError(error) } catch {} }
  const tail = (text, data) => (text + String(data)).slice(-64_000)

  function terminate(task) {
    if (task.settled || !task.child.pid) return
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(task.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
      killer.once("error", (error) => { report(error); try { task.child.kill() } catch {} })
    } else {
      try { process.kill(-task.child.pid, "SIGTERM") } catch { try { task.child.kill("SIGTERM") } catch {} }
      if (!task.escalation) task.escalation = setTimeout(() => {
        try { process.kill(-task.child.pid, "SIGKILL") } catch { try { task.child.kill("SIGKILL") } catch {} }
      }, 1000)
    }
  }

  async function dispatch(request) {
    if (disposed) throw new Error("Native shell is disposed")
    if (!request?.sessionID || typeof request.command !== "string" || !request.command.trim()) throw new TypeError("Native shell requires sessionID and command")
    const shellID = request.id || `shell_loop_${randomUUID().replaceAll("-", "")}`
    const child = spawn(request.command, { cwd: directory, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const task = { child, settled: false, timedOut: false, cancelled: false, stdout: "", stderr: "" }
    task.closed = new Promise((resolve) => { task.resolve = resolve })
    tasks.add(task)
    child.stdout?.on("data", (chunk) => { task.stdout = tail(task.stdout, chunk) })
    child.stderr?.on("data", (chunk) => { task.stderr = tail(task.stderr, chunk) })
    const delay = Number(request.timeoutMs)
    task.timer = setTimeout(() => { task.timedOut = true; terminate(task) }, Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2_147_483_647) : 120_000)
    task.timer.unref?.()
    child.once("close", (code, signal) => {
      task.settled = true
      clearTimeout(task.timer)
      clearTimeout(task.escalation)
      tasks.delete(task)
      const event = {
        kind: "shell", action: "ended", directory, sessionID: request.sessionID, shellID,
        status: task.timedOut ? "timeout" : task.cancelled || signal || code === null ? "killed" : "exited",
        code: task.timedOut ? 124 : Number.isInteger(code) ? code : -1,
        stdout: task.stdout, stderr: task.stderr,
      }
      task.resolve(event)
      if (!task.spawnError) Promise.resolve().then(() => onTerminal(event)).catch(report)
    })
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve({ id: shellID, status: "running" }))
      child.once("error", (error) => { task.spawnError = true; reject(error) })
    })
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const active = [...tasks]
    for (const task of active) { task.cancelled = true; terminate(task) }
    await Promise.allSettled(active.map((task) => task.closed))
  }
  return Object.freeze({ dispatch, dispose, activeCount: () => tasks.size })
}
