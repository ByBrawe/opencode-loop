#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const configuredRetryMs = Number(process.env.OPENCODE_LOOPD_FAILED_RUN_RETRY_MS)
const FAILED_RUN_RETRY_MS = Number.isFinite(configuredRetryMs) && configuredRetryMs >= 0 ? configuredRetryMs : 5_000
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"
const SCHTASKS_BIN = process.env.SCHTASKS_BIN || "schtasks"
const TASK_ROOT = process.env.OPENCODE_LOOPD_TASK_DIR || path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "opencode-loop", "tasks")

function arg(name, fallback = null) {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  if (i + 1 >= args.length) throw new Error(`Missing value for ${name}`)
  return args[i + 1]
}

function has(name) {
  return args.includes(name)
}

function parseMs(value) {
  const v = String(value ?? "0s").trim().toLowerCase()
  if (v === "0" || v === "0s" || v === "now") return 0

  const m = v.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/)
  if (!m) throw new Error(`Invalid duration: ${value}`)

  const n = Number(m[1])
  const unit = m[2]

  if (unit === "ms") return n
  if (unit.startsWith("s")) return n * 1000
  if (unit.startsWith("m")) return n * 60_000
  if (unit.startsWith("h")) return n * 3_600_000
  if (unit.startsWith("d")) return n * 86_400_000

  return n
}

function parseMaxRuns(value) {
  const text = String(value ?? "0").trim()
  if (!/^\d+$/.test(text)) throw new Error(`Invalid --max-runs value: ${value}`)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid --max-runs value: ${value}`)
  return parsed
}

function validateProject(project) {
  let stat
  try { stat = fs.statSync(project) } catch { throw new Error(`Project directory does not exist: ${project}`) }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function terminateChild(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      return
    }
    if (child.pid) process.kill(-child.pid, "SIGTERM")
    else child.kill("SIGTERM")
    const force = setTimeout(() => {
      try {
        if (child.exitCode !== null) return
        if (child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }, 1_000)
    force.unref?.()
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

function spawnOnce(command, commandArgs, cwd, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const capture = options.capture === true
    const stdout = []
    const stderr = []
    let timer
    const done = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        ...result,
        timedOut,
        stdout: capture ? Buffer.concat(stdout).toString("utf8") : "",
        stderr: capture ? Buffer.concat(stderr).toString("utf8") : "",
      })
    }

    let child
    try {
      child = spawn(command, commandArgs, {
        cwd,
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      done({ code: -1, error })
      return
    }

    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    if (Number(options.timeoutMs) > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateChild(child)
      }, Number(options.timeoutMs))
      timer.unref?.()
    }
    child.on("error", (error) => done({ code: -1, error }))
    child.on("exit", (code, signal) => done({ code: timedOut ? 124 : (code ?? (signal ? 1 : 0)), signal }))
  })
}

function quoteWindowsArg(value) {
  const text = String(value ?? "")
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function run(command, commandArgs, cwd, options = {}) {
  const direct = await spawnOnce(command, commandArgs, cwd, options)
  if (direct.code !== -1 || process.platform !== "win32" || !["ENOENT", "EINVAL"].includes(direct.error?.code)) return direct

  const fallback = await spawnOnce("cmd.exe", ["/d", "/s", "/c", command, ...commandArgs], cwd, options)
  if (fallback.code === -1) {
    console.error(`[opencode-loopd] failed to start ${command}: ${fallback.error?.message || direct.error?.message || "unknown error"}`)
  }
  return fallback
}

async function resolveLatestSessionID(opencodeBin, project, preferredTitle) {
  const result = await run(opencodeBin, ["session", "list", "--format", "json", "-n", "20"], project, { capture: true, timeoutMs: 15_000 })
  if (result.code !== 0 || result.timedOut) return undefined
  let parsed
  try { parsed = JSON.parse(result.stdout || "[]") } catch { return undefined }
  const sessions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : []
  const match = preferredTitle ? sessions.find((item) => item?.title === preferredTitle) : sessions[0]
  return typeof match?.id === "string" && match.id ? match.id : undefined
}

function runSync(command, commandArgs) {
  const options = { shell: false, stdio: "inherit", windowsHide: true }
  const direct = spawnSync(command, commandArgs, options)
  const extension = path.extname(String(command || "")).toLowerCase()
  if (!direct.error || process.platform !== "win32" || direct.error.code !== "EINVAL" || ![".cmd", ".bat"].includes(extension)) return direct
  return spawnSync("cmd.exe", ["/d", "/s", "/c", command, ...commandArgs], options)
}

function readPrompt(project, options = {}) {
  const promptFile = options.promptFile ?? arg("--prompt-file")
  const promptArg = options.prompt ?? arg("--prompt")

  if (promptFile) {
    return stripBom(fs.readFileSync(path.resolve(project, promptFile), "utf8"))
  }

  if (promptArg) return promptArg

  return [
    "Continue from progress.md and implement the next unfinished TODO.",
    "Do not ask questions.",
    "Make reasonable assumptions.",
    "Mark completed TODO items with [x].",
    "Add useful follow-up TODOs when needed.",
    "Run tests/lint/build when available.",
    "Do not run destructive commands such as git reset, git clean, rm -rf, force push, deploy, or production migrations.",
    "Keep going while work remains.",
  ].join(" ")
}

async function daemon(options = {}) {
  const project = path.resolve(options.project ?? arg("--project", process.cwd()))
  validateProject(project)
  const every = options.every ?? arg("--every", "0s")
  const delay = parseMs(every)
  const maxRuns = parseMaxRuns(options.maxRuns ?? arg("--max-runs", "0"))
  const timeoutText = options.timeout ?? arg("--timeout", "30m")
  const timeoutMs = parseMs(timeoutText)
  const sleepFirst = options.sleepFirst ?? has("--sleep-first")
  const prompt = readPrompt(project, options)
  const model = options.model ?? arg("--model")
  const agent = options.agent ?? arg("--agent")
  const opencodeBin = options.opencodeBin || OPENCODE_BIN
  const explicitSessionID = options.session ?? arg("--session")
  let sessionID = explicitSessionID || await resolveLatestSessionID(opencodeBin, project)
  const sessionTitle = `OpenCode Loop daemon ${process.pid}-${Date.now()}`

  console.log("OpenCode Loop daemon")
  console.log(`project: ${project}`)
  console.log(`every: ${every}`)
  console.log(`maxRuns: ${maxRuns || "unlimited"}`)
  console.log(`timeout: ${timeoutText}`)
  if (sessionID) console.log(`session: ${sessionID} (pinned)`)

  let count = 0

  if (sleepFirst && delay > 0) await sleep(delay)

  while (true) {
    count += 1
    console.log("")
    console.log(`[opencode-loopd] run #${count} ${new Date().toISOString()}`)

    const runArgs = ["run"]
    if (sessionID) runArgs.push("--session", sessionID)
    else runArgs.push("--title", sessionTitle)
    if (model) runArgs.push("--model", model)
    if (agent) runArgs.push("--agent", agent)
    runArgs.push(prompt)

    const result = await run(opencodeBin, runArgs, project, { timeoutMs })
    const code = result.timedOut ? 124 : result.code
    const moreRunsRemain = maxRuns === 0 || count < maxRuns

    if (!sessionID && code === 0 && moreRunsRemain) {
      sessionID = await resolveLatestSessionID(opencodeBin, project, sessionTitle)
      if (!sessionID) {
        console.error("[opencode-loopd] could not resolve the newly created session; refusing to continue unpinned")
        return 1
      }
      console.log(`[opencode-loopd] pinned session ${sessionID}`)
    }

    if (result.timedOut) console.log(`[opencode-loopd] opencode run timed out after ${timeoutText}`)
    else if (code !== 0) console.log(`[opencode-loopd] opencode exited with code ${code}`)
    if (code !== 0 && delay === 0 && moreRunsRemain) await sleep(FAILED_RUN_RETRY_MS)

    if (maxRuns > 0 && count >= maxRuns) {
      console.log("[opencode-loopd] max runs reached")
      return Number.isInteger(code) && code > 0 ? code : code < 0 ? 1 : 0
    }

    if (delay > 0) await sleep(delay)
  }
}

function taskArtifacts(name) {
  const id = createHash("sha256").update(String(name || "OpenCodeLoop")).digest("hex").slice(0, 16)
  return {
    config: path.join(TASK_ROOT, `${id}.json`),
    launcher: path.join(TASK_ROOT, `${id}.cmd`),
  }
}

function removeTaskArtifacts(artifacts) {
  for (const target of [artifacts.launcher, artifacts.config]) {
    try { fs.rmSync(target, { force: true }) } catch {}
  }
}

async function taskRun() {
  const configFile = path.resolve(arg("--config"))
  let config
  try { config = JSON.parse(fs.readFileSync(configFile, "utf8")) } catch (error) { throw new Error(`Could not read task config ${configFile}: ${error.message}`) }
  return await daemon(config)
}

function installTask() {
  if (process.platform !== "win32") {
    throw new Error("install-task is currently implemented for Windows Task Scheduler only. Use daemon mode on macOS/Linux.")
  }

  const project = path.resolve(arg("--project", process.cwd()))
  validateProject(project)
  const every = arg("--every", "10m")
  const minutes = Math.max(1, Math.round(parseMs(every) / 60_000))
  const name = arg("--name", "OpenCodeLoop")
  const promptFile = arg("--prompt-file")
  const promptArg = arg("--prompt")
  const model = arg("--model")
  const agent = arg("--agent")
  const timeout = arg("--timeout", "30m")
  const node = process.execPath
  const script = fileURLToPath(import.meta.url)
  const artifacts = taskArtifacts(name)
  fs.mkdirSync(TASK_ROOT, { recursive: true })
  const taskConfig = {
    project,
    every: "0s",
    maxRuns: 1,
    promptFile: promptFile ? path.resolve(project, promptFile) : undefined,
    prompt: promptArg || undefined,
    model: model || undefined,
    agent: agent || undefined,
    timeout,
    opencodeBin: OPENCODE_BIN,
  }
  fs.writeFileSync(artifacts.config, JSON.stringify(taskConfig, null, 2) + "\n", "utf8")
  const launcherCommand = [quoteWindowsArg(node), quoteWindowsArg(script), "task-run", "--config", quoteWindowsArg(artifacts.config)].join(" ")
  fs.writeFileSync(artifacts.launcher, `@echo off\r\n${launcherCommand}\r\nexit /b %errorlevel%\r\n`, "utf8")
  const taskCommand = `cmd.exe /d /s /c "${quoteWindowsArg(artifacts.launcher)}"`
  if (taskCommand.length > 261) {
    removeTaskArtifacts(artifacts)
    throw new Error(`Task Scheduler command is still too long (${taskCommand.length} characters). Set OPENCODE_LOOPD_TASK_DIR to a shorter directory.`)
  }
  const taskArgs = ["/Create", "/F", "/SC", "MINUTE", "/MO", String(minutes), "/TN", name, "/TR", taskCommand]

  console.log([SCHTASKS_BIN, ...taskArgs.map((part) => JSON.stringify(part))].join(" "))
  const result = runSync(SCHTASKS_BIN, taskArgs)
  if (result.error) {
    removeTaskArtifacts(artifacts)
    console.error(`[opencode-loopd] failed to start ${SCHTASKS_BIN}: ${result.error.message}`)
    return 1
  }
  const status = Number.isInteger(result.status) ? result.status : 1
  if (status !== 0) removeTaskArtifacts(artifacts)
  return status
}

function uninstallTask() {
  if (process.platform !== "win32") {
    throw new Error("uninstall-task is currently implemented for Windows Task Scheduler only.")
  }

  const name = arg("--name", "OpenCodeLoop")
  const result = runSync(SCHTASKS_BIN, ["/Delete", "/F", "/TN", name])
  if (result.error) {
    console.error(`[opencode-loopd] failed to start ${SCHTASKS_BIN}: ${result.error.message}`)
    return 1
  }
  const status = Number.isInteger(result.status) ? result.status : 1
  if (status === 0) removeTaskArtifacts(taskArtifacts(name))
  return status
}

function help() {
  console.log(`
OpenCode Loop daemon

Usage:
  opencode-loopd --project . --every 5m --prompt-file loop-prompt.md
  opencode-loopd --project . --every 0s --prompt "continue from progress.md"
  opencode-loopd install-task --project . --every 10m --prompt-file loop-prompt.md --name OpenCodeLoop
  opencode-loopd uninstall-task --name OpenCodeLoop

Options:
  --project <path>       Project directory
  --every <duration>     0s, 5m, 1h, etc.
  --prompt <text>        Prompt text
  --prompt-file <file>   Read prompt from file relative to the project
  --model <provider/id>  OpenCode model used for each run
  --agent <name>         OpenCode agent used for each run
  --session <id>         Pin an existing OpenCode session (auto-pinned otherwise)
  --timeout <duration>   Max time per OpenCode run (default: 30m, 0s disables)
  --max-runs <n>         Stop after n runs
  --sleep-first          Wait before first run
`)
}

const command = args[0]

try {
  let exitCode = 0
  if (command === "daemon" || command === "loopd") {
    args.shift()
    exitCode = await daemon()
  } else if (command === "install-task") {
    args.shift()
    exitCode = installTask()
  } else if (command === "uninstall-task") {
    args.shift()
    exitCode = uninstallTask()
  } else if (command === "task-run") {
    args.shift()
    exitCode = await taskRun()
  } else if (has("--help") || has("-h") || command === "help") {
    help()
  } else {
    exitCode = await daemon()
  }
  if (exitCode) process.exitCode = exitCode
} catch (error) {
  console.error(error?.message || error)
  process.exit(1)
}
