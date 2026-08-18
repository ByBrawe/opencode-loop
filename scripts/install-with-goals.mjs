#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
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
const loopArgs = rawArgs.filter((arg) => arg !== "--with-goals" && arg !== "--loop-only")
const uninstallRequested = loopArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(loopArgs[0] || "")
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
      if (Array.isArray(parsed.plugin) && parsed.plugin.some(isGoalPluginSpec)) return true
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
    env: { ...process.env, OPENCODE_CONFIG_DIR: config },
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
  console.log(`\nOpenCode Goals companion options:\n  --with-goals  Install/update @bybrawe/opencode-goal@latest even when it is not already installed.\n  --loop-only   Skip all OpenCode Goals companion detection and network update work.\n\nNormal Loop install/update refreshes an already-managed OpenCode Goals installation on a best-effort basis. Loop uninstall never removes Goals.`)
}

async function main() {
  if (withGoals && loopOnly) {
    console.error("Use either --with-goals or --loop-only, not both.")
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

  if (loopOnly) {
    console.log("Skipped OpenCode Goals companion update (--loop-only).")
    return
  }

  const alreadyInstalled = await goalsAlreadyInstalled()
  if (!alreadyInstalled && !withGoals) return

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
