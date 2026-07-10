#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const FAILED_RUN_RETRY_MS = 5_000
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"

function arg(name, fallback = null) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] ?? fallback : fallback
}

function has(name) {
  return args.includes(name)
}

function parseMs(value) {
  const v = String(value || "0s").trim().toLowerCase()
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnOnce(command, commandArgs, cwd) {
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child
    try {
      child = spawn(command, commandArgs, {
        cwd,
        shell: false,
        stdio: "inherit",
        env: process.env,
        windowsHide: true,
      })
    } catch (error) {
      done({ code: -1, error })
      return
    }

    child.on("error", (error) => done({ code: -1, error }))
    child.on("exit", (code) => done({ code: code ?? 0 }))
  })
}

function quoteWindowsArg(value) {
  const text = String(value ?? "")
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function run(command, commandArgs, cwd) {
  const direct = await spawnOnce(command, commandArgs, cwd)
  if (direct.code !== -1 || process.platform !== "win32" || !["ENOENT", "EINVAL"].includes(direct.error?.code)) return direct.code

  const fallback = await spawnOnce("cmd.exe", ["/d", "/s", "/c", command, ...commandArgs], cwd)
  if (fallback.code === -1) {
    console.error(`[opencode-loopd] failed to start ${command}: ${fallback.error?.message || direct.error?.message || "unknown error"}`)
  }
  return fallback.code
}

function readPrompt(project) {
  const promptFile = arg("--prompt-file")
  const promptArg = arg("--prompt")

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

async function daemon() {
  const project = path.resolve(arg("--project", process.cwd()))
  const every = arg("--every", "0s")
  const delay = parseMs(every)
  const maxRuns = Number(arg("--max-runs", "0")) || 0
  const sleepFirst = has("--sleep-first")
  const prompt = readPrompt(project)

  console.log("OpenCode Loop daemon")
  console.log(`project: ${project}`)
  console.log(`every: ${every}`)
  console.log(`maxRuns: ${maxRuns || "unlimited"}`)

  let count = 0

  if (sleepFirst && delay > 0) {
    await sleep(delay)
  }

  while (true) {
    count += 1

    console.log("")
    console.log(`[opencode-loopd] run #${count} ${new Date().toISOString()}`)

    const code = await run(OPENCODE_BIN, ["run", "--continue", prompt], project)

    if (code !== 0) {
      console.log(`[opencode-loopd] opencode exited with code ${code}`)
      if (delay === 0) {
        await sleep(FAILED_RUN_RETRY_MS)
      }
    }

    if (maxRuns > 0 && count >= maxRuns) {
      console.log("[opencode-loopd] max runs reached")
      break
    }

    if (delay > 0) {
      await sleep(delay)
    }
  }
}

function installTask() {
  if (process.platform !== "win32") {
    throw new Error("install-task is currently implemented for Windows Task Scheduler only. Use daemon mode on macOS/Linux.")
  }

  const project = path.resolve(arg("--project", process.cwd()))
  const every = arg("--every", "10m")
  const minutes = Math.max(1, Math.round(parseMs(every) / 60_000))
  const name = arg("--name", "OpenCodeLoop")
  const promptFile = arg("--prompt-file")
  const promptArg = arg("--prompt")
  const node = process.execPath
  const script = fileURLToPath(import.meta.url)

  const commandParts = [
    quoteWindowsArg(node),
    quoteWindowsArg(script),
    "daemon",
    "--project",
    quoteWindowsArg(project),
    "--every",
    "0s",
    "--max-runs",
    "1",
  ]

  if (promptFile) commandParts.push("--prompt-file", quoteWindowsArg(promptFile))
  if (promptArg) commandParts.push("--prompt", quoteWindowsArg(promptArg))

  const taskCommand = commandParts.join(" ")
  const taskArgs = ["/Create", "/F", "/SC", "MINUTE", "/MO", String(minutes), "/TN", name, "/TR", taskCommand]

  console.log(["schtasks", ...taskArgs.map((part) => JSON.stringify(part))].join(" "))
  const result = spawnSync("schtasks", taskArgs, { shell: false, stdio: "inherit" })
  process.exit(result.status ?? 0)
}

function uninstallTask() {
  if (process.platform !== "win32") {
    throw new Error("uninstall-task is currently implemented for Windows Task Scheduler only.")
  }

  const name = arg("--name", "OpenCodeLoop")
  const result = spawnSync("schtasks", ["/Delete", "/F", "/TN", name], { shell: false, stdio: "inherit" })
  process.exit(result.status ?? 0)
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
  --max-runs <n>         Stop after n runs
  --sleep-first          Wait before first run
`)
}

const command = args[0]

try {
  if (command === "daemon" || command === "loopd") {
    args.shift()
    await daemon()
  } else if (command === "install-task") {
    args.shift()
    installTask()
  } else if (command === "uninstall-task") {
    args.shift()
    uninstallTask()
  } else if (has("--help") || has("-h") || command === "help") {
    help()
  } else {
    await daemon()
  }
} catch (error) {
  console.error(error?.message || error)
  process.exit(1)
}
