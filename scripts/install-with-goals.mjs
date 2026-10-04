#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFile, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const loopInstaller = join(root, "scripts", "install-node.mjs")
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const goalPackageName = "@bybrawe/opencode-goal"
const goalPackageSpec = `${goalPackageName}@latest`
const managedGoalCommandMarker = "<!-- managed-by:@bybrawe/opencode-goal -->"
const rawArgs = process.argv.slice(2)
const withGoals = rawArgs.includes("--with-goals")
const loopOnly = rawArgs.includes("--loop-only")
const withLoopGoals = rawArgs.includes("--with-loop-goals")
const withoutLoopGoals = rawArgs.includes("--without-loop-goals")
const loopArgs = rawArgs.filter((arg) => !["--with-goals", "--loop-only", "--with-loop-goals", "--without-loop-goals"].includes(arg))
const commandArgs = loopArgs.filter((arg) => arg !== "--legacy-v1")
const uninstallRequested = commandArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(commandArgs[0] || "")
const helpRequested = loopArgs.some((arg) => ["--help", "-h"].includes(arg))
const versionRequested = loopArgs.some((arg) => ["--version", "-v"].includes(arg))
const informational = helpRequested || versionRequested

function stripJsonComments(input) {
  let output = ""
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]
    if (lineComment) {
      if (char === "\n" || char === "\r") { lineComment = false; output += char }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index++ }
      else if (char === "\n" || char === "\r") output += char
      continue
    }
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') { quote = char; output += char; continue }
    if (char === "/" && next === "/") { lineComment = true; index++; continue }
    if (char === "/" && next === "*") { blockComment = true; index++; continue }
    output += char
  }
  return output
}

function stripTrailingCommas(input) {
  let output = ""
  let quote = ""
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') { quote = char; output += char; continue }
    if (char === ",") {
      let lookahead = index + 1
      while (/\s/.test(input[lookahead] || "")) lookahead++
      if (input[lookahead] === "]" || input[lookahead] === "}") continue
    }
    output += char
  }
  return output
}

function parseJsonc(input) {
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(input)))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenCode config root must be a JSON object")
  return parsed
}

function isGoalPluginSpec(value) {
  if (Array.isArray(value)) value = value[0]
  if (value && typeof value === "object") value = value.package
  if (typeof value !== "string") return false
  const spec = value.trim()
  if (spec === goalPackageName || spec.startsWith(`${goalPackageName}@`)) return true
  const normalized = spec.replaceAll("\\", "/")
  return normalized === "./plugins/opencode-goal.ts"
    || normalized === "./plugins/opencode-goal.js"
    || normalized.endsWith("/plugins/opencode-goal.ts")
    || normalized.endsWith("/plugins/opencode-goal.js")
}

async function goalsAlreadyInstalled() {
  for (const name of configCandidates) {
    try {
      const parsed = parseJsonc(await readFile(join(config, name), "utf8"))
      if ([parsed.plugin, parsed.plugins].some((entries) => Array.isArray(entries) && entries.some(isGoalPluginSpec))) return true
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`Could not inspect ${join(config, name)} for OpenCode Goals: ${error.message}`)
      }
    }
  }

  try {
    const command = await readFile(join(config, "commands", "goal.md"), "utf8")
    return command.includes(managedGoalCommandMarker)
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Could not inspect managed /goal command: ${error.message}`)
  }
  return false
}

async function removeLoopGoalCommands() {
  const commandDir = join(config, "commands")
  const names = (await readdir(join(root, "commands")))
    .filter((name) => name === "loop-goal.md" || (name.startsWith("loop-goal-") && name.endsWith(".md")))
  let removed = 0
  for (const name of names) {
    try {
      const installed = await readFile(join(commandDir, name), "utf8")
      const packaged = await readFile(join(root, "commands", name), "utf8")
      const recognized = /OpenCode Loop[^\n]{0,120}handled (?:locally|exactly)/.test(installed) || /OpenCode Loop local command handled/.test(installed)
      if (installed !== packaged && !recognized) continue
      await rm(join(commandDir, name))
      removed++
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  return removed
}

function runLoopInstaller() {
  return spawnSync(process.execPath, [loopInstaller, ...loopArgs], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
}

function runGoalInstaller() {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm")
  const args = npmExecPath
    ? [npmExecPath, "exec", "--yes", `--package=${goalPackageSpec}`, "--", "opencode-goal"]
    : ["exec", "--yes", `--package=${goalPackageSpec}`, "--", "opencode-goal"]

  return spawnSync(command, args, {
    cwd: root,
    // This is a target-dialect hint, not a claim about an installed binary.
    // Older Goal installers already understand this variable, unlike new CLI flags.
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_GOAL_HOST_VERSION: rawArgs.includes("--legacy-v1") ? "1.0.0" : "2.0.0",
    },
    stdio: "inherit",
    windowsHide: true,
    timeout: 180_000,
  })
}

function statusCode(result) {
  if (Number.isInteger(result?.status)) return result.status
  return result?.error ? 1 : 0
}

function printCompanionHelp() {
  console.log(`\nOpenCode Goal options:\n  --with-goals          Explicitly install/update @bybrawe/opencode-goal@latest after Loop.\n  --loop-only           Explicit alias for the default: install/update Loop only and never touch Goal.\n  --with-loop-goals     Also install Loop's legacy experimental /loop-goal* command files (not recommended).\n  --without-loop-goals  Compatibility alias for the default: omit/remove legacy /loop-goal* commands.\n\nDefault install/update touches only OpenCode Loop. For durable outcome-driven work, install OpenCode Goal separately with: npx -y @bybrawe/opencode-goal@latest. Loop uninstall never removes Goal.`)
}

async function main() {
  if (withGoals && loopOnly) {
    console.error("Use either --with-goals or --loop-only, not both.")
    process.exitCode = 2
    return
  }
  if (withLoopGoals && withoutLoopGoals) {
    console.error("Use either --with-loop-goals or --without-loop-goals, not both.")
    process.exitCode = 2
    return
  }

  const loopResult = runLoopInstaller()
  if (loopResult.error) {
    console.error(`OpenCode Loop installer failed to start: ${loopResult.error.message}`)
    process.exitCode = 1
    return
  }
  const loopCode = statusCode(loopResult)
  if (loopCode !== 0) {
    process.exitCode = loopCode
    return
  }

  if (informational) {
    if (helpRequested) printCompanionHelp()
    return
  }
  if (uninstallRequested) return

  if (!withLoopGoals) {
    const removed = await removeLoopGoalCommands()
    const reason = withoutLoopGoals ? "--without-loop-goals" : "default Loop-only command surface"
    console.log(`Omitted ${removed} packaged experimental /loop-goal* command file(s) (${reason}).`)
  }

  if (!withGoals) {
    if (loopOnly) console.log("Installed/updated OpenCode Loop only (--loop-only).")
    else console.log("Installed/updated OpenCode Loop only. OpenCode Goal is optional and recommended for durable goals: npx -y @bybrawe/opencode-goal@latest")
    return
  }

  const goalResult = runGoalInstaller()
  const goalCode = statusCode(goalResult)
  if (goalCode === 0) {
    console.log(`Installed/updated OpenCode Goals via ${goalPackageSpec}.`)
    return
  }

  const detail = goalResult.error?.message || `exit code ${goalCode}`
  if (withGoals) {
    console.error(`OpenCode Goals companion install/update failed (${detail}).`)
    process.exitCode = goalCode || 1
    return
  }

  console.warn(`OpenCode Loop updated, but the existing OpenCode Goals companion could not be refreshed (${detail}).`)
  console.warn(`Retry later with: npx -y ${goalPackageSpec}`)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
