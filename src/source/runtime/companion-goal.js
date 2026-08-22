import { promises as fs } from "node:fs"
import path from "node:path"

function goalRoot(directory) {
  return path.join(directory, ".opencode", "goals")
}

export async function findDedicatedGoalForSession(directory, sessionID) {
  if (!directory || !sessionID) return undefined
  let names
  try {
    names = await fs.readdir(goalRoot(directory))
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    return undefined
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const value = JSON.parse(await fs.readFile(path.join(goalRoot(directory), name), "utf8"))
      if (value?.sessionID === sessionID) return value
    } catch {}
  }
  return undefined
}

export function dedicatedGoalOwnsContinuation(goal) {
  return goal?.status === "active"
}

export function dedicatedGoalSummary(goal) {
  if (!goal) return "not detected"
  const id = String(goal.id || "unknown").slice(0, 12)
  const status = String(goal.status || "unknown")
  return `${status} (${id})`
}
