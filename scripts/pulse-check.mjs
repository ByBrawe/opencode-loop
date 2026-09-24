import { promises as fs } from "node:fs"
import path from "node:path"
import { dedicatedGoalOwnsContinuation } from "../src/source/runtime/companion-goal.js"

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 25
const LOCK_RETRIES = 80

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parsePulseDurationMs(value) {
  const text = String(value ?? "").trim().toLowerCase()
  if (text === "0" || text === "0s" || text === "now") return 0
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/)
  if (!match) throw new Error(`Invalid duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2]
  if (unit === "ms") return amount
  if (unit.startsWith("s")) return amount * 1000
  if (unit.startsWith("m")) return amount * 60_000
  if (unit.startsWith("h")) return amount * 3_600_000
  if (unit.startsWith("d")) return amount * 86_400_000
  return amount
}

function pulseDirectory(project) {
  return path.join(project, ".opencode", "opencode-loop")
}

function pulseStateFile(project) {
  return path.join(pulseDirectory(project), "pulse-check.json")
}

function pulseLockDirectory(project) {
  return path.join(pulseDirectory(project), "pulse-check.lock")
}

function goalDirectory(project) {
  return path.join(project, ".opencode", "goals")
}

function timestamp(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function revision(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function goalFingerprint(goal) {
  return [
    String(goal?.status || "unknown"),
    timestamp(goal?.updatedAt) ?? 0,
    revision(goal?.progressRevision),
    revision(goal?.revision),
    revision(goal?.storageGeneration),
  ].join(":")
}

function formatAge(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)}h`
  return `${(ms / 86_400_000).toFixed(ms < 864_000_000 ? 1 : 0)}d`
}

function iso(value) {
  const parsed = timestamp(value)
  if (parsed === undefined) return "unknown"
  try { return new Date(parsed).toISOString() } catch { return "unknown" }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return fallback
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8")
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    try { await fs.rm(temporary, { force: true }) } catch {}
    throw error
  }
}

async function acquireLock(project) {
  const directory = pulseDirectory(project)
  const lock = pulseLockDirectory(project)
  await fs.mkdir(directory, { recursive: true })

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await fs.mkdir(lock)
      return async () => {
        try { await fs.rm(lock, { recursive: true, force: true }) } catch {}
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        const stat = await fs.stat(lock)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError
      }
      await sleep(LOCK_RETRY_MS)
    }
  }

  throw new Error("Goal pulse-check state is busy; another checker still holds the lock")
}

async function readGoalSnapshots(project, target) {
  let names
  try {
    names = await fs.readdir(goalDirectory(project))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  const goals = []
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue
    try {
      const goal = JSON.parse(await fs.readFile(path.join(goalDirectory(project), name), "utf8"))
      if (!goal?.id || !goal?.sessionID) continue
      if (target && goal.id !== target && goal.sessionID !== target) continue
      goals.push(goal)
    } catch {}
  }
  return goals
}

export async function checkGoalPulse(project, options = {}) {
  const staleAfterMs = Number(options.staleAfterMs)
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error("staleAfterMs must be a non-negative number")
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const target = options.target ? String(options.target) : undefined
  const sessionActivity = options.sessionActivity && typeof options.sessionActivity === "object" ? options.sessionActivity : {}
  const release = await acquireLock(project)

  try {
    const goals = await readGoalSnapshots(project, target)
    const stateFile = pulseStateFile(project)
    const state = await readJson(stateFile, { schemaVersion: 1, goals: {} })
    if (!state.goals || typeof state.goals !== "object") state.goals = {}

    const alerts = []
    for (const goal of goals) {
      const id = String(goal.id)
      const status = String(goal.status || "unknown")
      const progressRevision = revision(goal.progressRevision)
      const goalUpdatedAt = timestamp(goal.updatedAt) ?? now
      const fingerprint = goalFingerprint(goal)
      const previous = state.goals[id]
      const changed = !previous || previous.fingerprint !== fingerprint
      const statusChanged = Boolean(previous && previous.status !== status)
      const progressChanged = Boolean(previous && Number(previous.progressRevision || 0) !== progressRevision)
      const updatedAdvanced = Boolean(previous && goalUpdatedAt > Number(previous.goalUpdatedAt || 0))

      let lastActivityAt
      if (!previous) {
        lastActivityAt = goalUpdatedAt
      } else if (!changed) {
        lastActivityAt = Number(previous.lastActivityAt || goalUpdatedAt)
      } else if (updatedAdvanced) {
        lastActivityAt = goalUpdatedAt
      } else if (statusChanged || progressChanged || Number(previous.revision || 0) !== revision(goal.revision)) {
        lastActivityAt = now
      } else {
        lastActivityAt = Math.max(Number(previous.lastActivityAt || 0), goalUpdatedAt)
      }

      let alerted = changed ? false : Boolean(previous?.alerted)
      let newAlert = false
      const active = dedicatedGoalOwnsContinuation(goal)
      const ageMs = Math.max(0, now - lastActivityAt)
      const sessionUpdatedAt = timestamp(sessionActivity[goal.sessionID])

      if (!active) {
        alerted = false
      } else if (ageMs >= staleAfterMs && !alerted) {
        alerted = true
        newAlert = true
        const message = [
          "[opencode-loopd] GOAL PULSE STALLED",
          `goal=${id}`,
          `session=${goal.sessionID}`,
          `stale=${formatAge(ageMs)}`,
          `goalUpdated=${iso(goalUpdatedAt)}`,
          sessionUpdatedAt === undefined ? undefined : `sessionUpdated=${iso(sessionUpdatedAt)}`,
          'action="/goal resume"',
        ].filter(Boolean).join(" ")
        alerts.push({
          goalID: id,
          sessionID: String(goal.sessionID),
          ageMs,
          goalUpdatedAt,
          sessionUpdatedAt,
          progressRevision,
          message,
        })
      } else if (ageMs < staleAfterMs) {
        alerted = false
      }

      state.goals[id] = {
        fingerprint,
        status,
        progressRevision,
        revision: revision(goal.revision),
        goalUpdatedAt,
        lastActivityAt,
        alerted,
        ...(alerted ? { lastAlertAt: newAlert ? now : previous?.lastAlertAt } : {}),
        sessionID: String(goal.sessionID),
      }
    }

    state.schemaVersion = 1
    state.updatedAt = now
    await writeJsonAtomic(stateFile, state)
    return {
      alerts,
      checked: goals.length,
      stateFile,
    }
  } finally {
    await release()
  }
}
