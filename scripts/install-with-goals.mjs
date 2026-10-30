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
const rawArgs = process.argv.slice(2)
const loopOnly = rawArgs.includes("--loop-only")
const withoutLoopGoals = rawArgs.includes("--without-loop-goals")
const loopArgs = rawArgs.filter((arg) => !["--loop-only", "--without-loop-goals"].includes(arg))
const commandArgs = loopArgs.filter((arg) => arg !== "--legacy-v1")
const uninstallRequested = commandArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(commandArgs[0] || "")
const helpRequested = loopArgs.some((arg) => ["--help", "-h"].includes(arg))
const versionRequested = loopArgs.some((arg) => ["--version", "-v"].includes(arg))
const informational = helpRequested || versionRequested

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

function statusCode(result) {
  if (Number.isInteger(result?.status)) return result.status
  return result?.error ? 1 : 0
}

function printLoopHelp() {
  console.log("\nOpenCode Loop installs and uninstalls only @bybrawe/opencode-loop.\n  --loop-only           Compatibility alias for the default Loop-only install.\n  --without-loop-goals  Compatibility alias for removing old Loop Goal command files.\n\nThe old --with-goals and --with-loop-goals options have been removed.\nIf you choose to use @bybrawe/opencode-goal, manage it with its own installer.\nLoop never invokes, installs, updates or removes the Goal package.")
}

async function main() {
  // Refuse discontinued Goal installation modes *before* any installer or diagnostic
  // can mutate the config; never interpret them as a successful Loop-only install.
  const removed = rawArgs.filter((arg) => arg === "--with-goals" || arg === "--with-loop-goals")
  if (removed.length) {
    console.error(`Unsupported Loop option(s): ${removed.join(", ")}. Loop now installs only Loop. Manage Goal separately if needed; nothing was changed.`)
    process.exitCode = 2
    return
  }
  if (rawArgs[0] === "--desktop-diagnostics") {
    // Diagnostic mode must not run either installer or modify any configuration.
    const { runDesktopDiagnosticCli } = await import("./desktop-command-diagnostics.mjs")
    process.exitCode = await runDesktopDiagnosticCli(rawArgs.slice(1))
    return
  }
  if (rawArgs.includes("--desktop-diagnostics")) {
    console.error("--desktop-diagnostics must be the first argument.")
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
    if (helpRequested) printLoopHelp()
    return
  }
  if (uninstallRequested) return

  // Clean only Loop-owned, packaged legacy /loop-goal* commands; preserve
  // user-owned files and do not touch any Goal package registration or state.
  const removedLegacy = await removeLoopGoalCommands()
  const reason = withoutLoopGoals ? "--without-loop-goals" : "standalone Loop install"
  console.log(`Omitted ${removedLegacy} packaged experimental /loop-goal* command file(s) (${reason}).`)
  console.log(loopOnly
    ? "Installed/updated OpenCode Loop only (--loop-only)."
    : "Installed/updated OpenCode Loop only. Goal is installed and managed separately.")

}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
