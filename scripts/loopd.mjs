#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)

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

function run(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
      env: process.env,
    })

    child.on("exit", (code) => resolve(code ?? 0))
  })
}

function readPrompt(project) {
  const promptFile = arg("--prompt-file")
  const promptArg = arg("--prompt")

  if (promptFile) {
    return fs.readFileSync(path.resolve(project, promptFile), "utf8")
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

    const command = `opencode run --continue --prompt ${JSON.stringify(prompt)}`
    const code = await run(command, project)

    if (code !== 0) {
      console.log(`[opencode-loopd] opencode exited with code ${code}`)
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
    `"${node}"`,
    `"${script}"`,
    "daemon",
    "--project",
    `"${project}"`,
    "--every",
    "0s",
    "--max-runs",
    "1",
  ]

  if (promptFile) commandParts.push("--prompt-file", `"${promptFile}"`)
  if (promptArg) commandParts.push("--prompt", `"${promptArg.replaceAll('"', '\\"')}"`)

  const taskCommand = commandParts.join(" ")
  const schtasks = `schtasks /Create /F /SC MINUTE /MO ${minutes} /TN "${name}" /TR ${JSON.stringify(taskCommand)}`

  console.log(schtasks)
  const result = spawnSync(schtasks, { shell: true, stdio: "inherit" })
  process.exit(result.status ?? 0)
}

function uninstallTask() {
  if (process.platform !== "win32") {
    throw new Error("uninstall-task is currently implemented for Windows Task Scheduler only.")
  }

  const name = arg("--name", "OpenCodeLoop")
  const result = spawnSync(`schtasks /Delete /F /TN "${name}"`, { shell: true, stdio: "inherit" })
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
