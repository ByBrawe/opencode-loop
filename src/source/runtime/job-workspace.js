import { promises as fs } from "node:fs"
import path from "node:path"
import { safeID } from "../core/args.js"
import { decoratePrompt, isGoalJob } from "../core/jobs.js"
import { stateDir, ensureDir } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog, readSmallTextFile as defaultReadSmallTextFile, runProcess as defaultRunProcess } from "../core/process.js"
import { buildGoalPrompt as defaultBuildGoalPrompt } from "./goal-runtime.js"

const MAX_SCAN_FILES = 200
const MAX_SCAN_BYTES = 2_000_000

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createJobWorkspaceRuntime requires ${name}`)
  return value
}

export function dangerousShell(command) {
  const text = String(command || "").toLowerCase()
  return [
    /\brm\b(?=[^\r\n]*\s-{1,2}(?:[a-z]*r[a-z]*|recursive)\b)(?=[^\r\n]*\s-{1,2}(?:[a-z]*f[a-z]*|force)\b)/,
    /\bremove-item\b[^\r\n]*(?:-recurse|-force)/,
    /\bgit\s+reset\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+push\b/,
    /\bdel\b[^\r\n]*\s\/s\b/,
    /\b(?:rmdir|rd)\b[^\r\n]*\s\/s\b/,
    /(?:^|[;&|]\s*)format(?:\.com)?\s+(?:[a-z]:|\/(?:fs|q)\b)/,
    /\bterraform\s+destroy\b/,
    /\bkubectl\s+delete\b/,
    /\bdeploy\b.*\bproduction\b/,
  ].some((pattern) => pattern.test(text))
}

export function createJobWorkspaceRuntime(options = {}) {
  const toast = requireFunction(options.toast, "toast")
  const runProcess = typeof options.runProcess === "function" ? options.runProcess : defaultRunProcess
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const readSmallTextFile = typeof options.readSmallTextFile === "function" ? options.readSmallTextFile : defaultReadSmallTextFile
  const buildGoalPrompt = typeof options.buildGoalPrompt === "function" ? options.buildGoalPrompt : defaultBuildGoalPrompt

  async function buildPrompt(directory, job) {
    if (isGoalJob(job)) return await buildGoalPrompt(directory, job)
    const sections = []
    if (job.promptFile) {
      const text = await readSmallTextFile(path.resolve(directory, job.promptFile))
      if (text.trim()) sections.push(`Instructions from ${job.promptFile}:\n${text.trim()}`)
      else sections.push(`Prompt file ${job.promptFile} was requested but could not be read. Continue from the regular action instead.`)
    }
    if (job.action) sections.push(decoratePrompt(job))
    for (const file of job.includeFiles || []) {
      const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
      if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
    }
    return sections.join("\n\n---\n\n") || decoratePrompt(job)
  }

  async function ensureBranch(directory, job, client, sessionID) {
    if (!job.branch || job.branchDone) return job
    const branch = safeID(job.branch)
    const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
    if (inRepo.code !== 0) { job.branchDone = true; return job }
    let result = await runProcess("git", ["switch", branch], directory, 30_000)
    if (result.code !== 0) result = await runProcess("git", ["switch", "-c", branch], directory, 30_000)
    job.branchDone = true
    await toast(client, result.code === 0 ? `Loop branch active: ${branch}` : `Could not switch/create branch: ${branch}`, result.code === 0 ? "success" : "warning")
    await appendLoopLog(directory, "branch", { sessionID, branch, code: result.code })
    return job
  }

  async function snapshotPaths(directory, files) {
    const snapshot = {}
    for (const file of files || []) {
      try {
        const stat = await fs.stat(path.resolve(directory, file))
        snapshot[file] = `${stat.mtimeMs}:${stat.size}`
      } catch { snapshot[file] = "missing" }
    }
    return snapshot
  }

  async function watchChanged(directory, job) {
    if (!job.watchPaths?.length) return false
    const next = await snapshotPaths(directory, job.watchPaths)
    const previous = job.watchSnapshot || {}
    const changed = job.watchPaths.some((file) => previous[file] !== next[file])
    if (changed) job.watchSnapshot = next
    return changed
  }

  async function fileContains(filePath, needle) {
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return false
      return (await fs.readFile(filePath, "utf8")).includes(needle)
    } catch { return false }
  }

  async function untilReached(directory, job) {
    if (!job.until) return false
    const files = ["progress.md", "PROGRESS.md", "todo.md", "TODO.md", "todolist.md", "TODOLIST.md", path.join(".opencode", "opencode-loop", "until.txt")]
    for (const file of files) if (await fileContains(path.resolve(directory, file), job.until)) return true
    let scanned = 0
    async function walk(current) {
      if (scanned >= MAX_SCAN_FILES) return false
      let entries
      try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return false }
      for (const entry of entries) {
        if (scanned >= MAX_SCAN_FILES) return false
        if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) { if (await walk(full)) return true }
        else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) { scanned++; if (await fileContains(full, job.until)) return true }
      }
      return false
    }
    return await walk(directory)
  }

  async function createCheckpoint(directory, sessionID, job, client) {
    if (!job.checkpointOnly && !job.gitCheckpoint) return
    const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
    if (inRepo.code !== 0) return
    const status = await runProcess("git", ["status", "--short"], directory, 30_000)
    if (!status.stdout.trim()) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const checkpointDir = path.join(stateDir(directory), "checkpoints", safeID(sessionID))
    await ensureDir(checkpointDir)
    const diff = await runProcess("git", ["diff", "--binary"], directory, 120_000)
    const staged = await runProcess("git", ["diff", "--cached", "--binary"], directory, 120_000)
    const prefix = `${timestamp}-${safeID(job.name || job.id)}`
    await fs.writeFile(path.join(checkpointDir, `${prefix}.status.txt`), status.stdout + status.stderr)
    await fs.writeFile(path.join(checkpointDir, `${prefix}.patch`), `${diff.stdout}\n${staged.stdout}`)
    if (job.gitCheckpoint) {
      await runProcess("git", ["add", "-A"], directory, 120_000)
      await runProcess("git", ["commit", "-m", `chore: opencode loop checkpoint ${timestamp}`], directory, 120_000)
    }
    await toast(client, `Loop checkpoint saved: ${prefix}`, "success")
  }

  return {
    buildPrompt,
    ensureBranch,
    snapshotPaths,
    watchChanged,
    untilReached,
    createCheckpoint,
  }
}
