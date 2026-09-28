import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

// Read-only interoperation with Goal's session-sharded store. An unreadable or
// unsafe live shard is not permission to take over autonomous continuation.
export async function nativeGoalReservesSession(directory, sessionID) {
  const shard = createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
  const root = path.resolve(directory)
  const parts = [".opencode", "goals", `${shard}.json`]
  let file = root
  try {
    for (const part of parts) {
      file = path.join(file, part)
      const info = await lstat(file)
      if (info.isSymbolicLink()) return true
    }
    const goal = JSON.parse(await readFile(file, "utf8"))
    if (goal?.schemaVersion !== 1 || goal?.sessionID !== sessionID || typeof goal?.id !== "string") return true
    return !["completed", "cleared"].includes(goal.status)
  } catch (error) {
    return error?.code !== "ENOENT"
  }
}
