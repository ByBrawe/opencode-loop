import { promises as fs } from "node:fs"
import path from "node:path"
import { stateDir } from "../core/state.js"
import { scheduleDescription, scheduleState } from "./schedule-policy.js"

export function describeJobScheduling(job, current = Date.now()) {
  return {
    schedule: scheduleDescription(job),
    state: scheduleState(job, current),
  }
}

export async function listPersistedLoopSessions(directory, currentSessionID) {
  const root = stateDir(directory)
  let names
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    return []
  }

  const sessions = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const sessionID = name.slice(0, -5)
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, name), "utf8"))
      const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      const enabled = jobs.filter((job) => job?.enabled !== false && !job?.paused).length
      const neverRan = jobs.filter((job) => Number(job?.runCount || 0) === 0).length
      sessions.push({
        sessionID,
        current: sessionID === currentSessionID,
        jobs: jobs.length,
        enabled,
        neverRan,
      })
    } catch {
      sessions.push({ sessionID, current: sessionID === currentSessionID, jobs: 0, enabled: 0, neverRan: 0, corrupt: true })
    }
  }

  return sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.enabled - a.enabled || a.sessionID.localeCompare(b.sessionID))
}
