import { promises as fs, constants } from "node:fs"
import path from "node:path"

const MAX_CHECKLIST_BYTES = 256_000
const EXCLUDED_PROJECT_DIRS = new Set([".opencode", ".git", "node_modules"])

function unavailable(reason) {
  return { status: "unavailable", reason, total: 0, pending: 0 }
}

export function summarizeTaskChecklist(markdown) {
  let total = 0
  let pending = 0
  let fence = null
  let comment = false

  for (const original of String(markdown || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    // Only project tasks count, never examples in HTML comments or fenced code.
    let line = ""
    let offset = 0
    while (offset < original.length) {
      if (comment) {
        const end = original.indexOf("-->", offset)
        if (end < 0) break
        comment = false
        offset = end + 3
      } else {
        const start = original.indexOf("<!--", offset)
        if (start < 0) {
          line += original.slice(offset)
          break
        }
        line += original.slice(offset, start)
        comment = true
        offset = start + 4
      }
    }

    const trimmed = line.trimStart()
    const indentation = line.length - trimmed.length
    const marker = trimmed.charAt(0)
    let markerSize = 0
    if (marker === "~" || marker.charCodeAt(0) === 96) {
      while (trimmed.charAt(markerSize) === marker) markerSize++
    }
    if (fence) {
      if (indentation <= 3 && markerSize >= fence.length && marker === fence.marker && !trimmed.slice(markerSize).trim()) fence = null
      continue
    }
    if (indentation <= 3 && markerSize >= 3) {
      fence = { marker, length: markerSize }
      continue
    }
    // A quoted example must not be mistaken for an actionable checkbox.
    if (/^\s*>/.test(line)) continue
    const match = line.match(/^\s{0,24}[-+*]\s+\[([ xX])\](?:\s|$)/)
    if (!match) continue
    total++
    if (match[1] === " ") pending++
  }

  return { status: total === 0 ? "unavailable" : pending === 0 ? "complete" : "pending",
    reason: total === 0 ? "no-task-checkboxes" : "",
    total, pending }
}

export async function inspectTaskChecklist(directory, progressFile) {
  const name = String(progressFile || "").trim()
  if (!name || name.includes("\u0000")) return unavailable("missing-progress-file")
  if (path.isAbsolute(name) || path.win32.isAbsolute(name)) return unavailable("absolute-path")
  const root = path.resolve(directory)
  const target = path.resolve(root, name)
  const relative = path.relative(root, target)
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    return unavailable("outside-project")
  }
  const parts = relative.split(path.sep)
  if (parts.some((part) => EXCLUDED_PROJECT_DIRS.has(part.toLowerCase()))) return unavailable("control-plane-path")

  try {
    const rootInfo = await fs.lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return unavailable("unsafe-project-root")
    let current = root
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index])
      const info = await fs.lstat(current)
      if (info.isSymbolicLink()) return unavailable("symlink-path")
      if (index < parts.length - 1 && !info.isDirectory()) return unavailable("invalid-parent")
      if (index === parts.length - 1 && (!info.isFile() || info.size > MAX_CHECKLIST_BYTES)) {
        return unavailable(!info.isFile() ? "not-regular-file" : "file-too-large")
      }
    }
    // Do not follow a last-component symlink introduced between lstat and open.
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_CHECKLIST_BYTES) {
        return unavailable(!info.isFile() ? "not-regular-file" : "file-too-large")
      }
      const content = await handle.readFile({ encoding: "utf8" })
      const after = await fs.lstat(target)
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) {
        return unavailable("file-changed-during-read")
      }
      return summarizeTaskChecklist(content)
    } finally {
      await handle.close()
    }
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "file-missing" : error?.code === "ELOOP" ? "symlink-path" : "file-unreadable")
  }
}
