import fs from "node:fs"
import path from "node:path"

function versionFromOutput(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:opencode(?:2)?\s+v?)?v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
    if (match) return { major: Number(match[1]), version: line.trim() }
  }
  return undefined
}

// Probe once before any workload. An explicit binary never falls back to a
// different installation, and native mode never silently selects a V1 host.
export async function selectOpenCodeHost({ binary, legacyV1 = false, probe } = {}) {
  if (typeof probe !== "function") throw new TypeError("OpenCode host selection requires a version probe")
  const major = legacyV1 ? 1 : 2
  const explicit = String(binary || "").trim()
  const candidates = explicit ? [explicit] : legacyV1 ? ["opencode"] : ["opencode", "opencode2"]
  for (const candidate of candidates) {
    const result = await probe(candidate)
    if (result?.code !== 0 || result.timedOut) continue
    const observed = versionFromOutput(`${result.stdout || ""}\n${result.stderr || ""}`)
    if (observed?.major === major) return { binary: candidate, ...observed }
  }
  throw new Error(`Could not select OpenCode ${major}.x${explicit ? ` from ${JSON.stringify(explicit)}` : ""}. Set OPENCODE_BIN to the matching executable.${legacyV1 ? "" : " V1 requires explicit --legacy-v1; no workload was dispatched."}`)
}

function canonicalDirectory(directory) {
  const absolute = path.resolve(directory)
  try { return fs.realpathSync.native(absolute) } catch { return absolute }
}

export function projectSessions(text, directory, native = true) {
  let parsed
  try { parsed = JSON.parse(String(text || "")) } catch { throw new Error("OpenCode session list returned invalid JSON") }
  const sessions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : undefined
  if (!sessions) throw new Error("OpenCode session list did not return an array")
  const project = canonicalDirectory(directory)
  return sessions.filter((session) => {
    if (typeof session?.id !== "string" || !session.id.trim()) return false
    const location = session.directory ?? session.location?.directory
    // V2 session list is project-scoped, not worktree-scoped. Never let its
    // newest session pull a daemon into another worktree or an unknown path.
    if (typeof location !== "string" || !location.trim()) return !native
    return canonicalDirectory(location) === project
  })
}
