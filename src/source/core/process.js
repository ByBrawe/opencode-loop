import { promises as fs } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { stateDir, ensureDir } from "./state.js"

export async function appendLoopLog(directory, line, extra = {}) {
  try {
    await ensureDir(stateDir(directory))
    await fs.appendFile(path.join(stateDir(directory), "loop.log"), JSON.stringify({ time: new Date().toISOString(), line, ...extra }) + "\n")
  } catch {}
}

export async function readSmallTextFile(filePath, maxBytes = 120_000) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return ""
    return await fs.readFile(filePath, "utf8")
  } catch { return "" }
}

export async function runProcess(command, args, cwd, timeoutMs = 60_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

export async function runShellCommand(command, cwd, timeoutMs = 120_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, [], { cwd, shell: true, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

export async function notifyJob(directory, job, reason) {
  if (!job.notifyCommand) return
  const command = String(job.notifyCommand).replace(/\{reason\}/g, String(reason || "")).replace(/\{job\}/g, String(job.name || job.id || ""))
  await runShellCommand(command, directory, 60_000)
}
