import { promises as fs } from "node:fs"
import path from "node:path"

export const DEFAULT_PROGRESS_MD = `# Progress

## Current Goal
Describe the current project goal here.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, and follow-up work as TODOs.
- Run tests, lint, or build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and pick the next safe improvement.

## Completed
- [x] Created progress.md.

## Backlog Ideas
- [ ] Add more project-specific tasks here.

## Blocked
- None.
`

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// This direct command creates only a missing progress file. It does not own
// native sessions, mutate Goal/Loop records, or start a model execution.
export async function initializeProgressFile(directory, argumentsText = "") {
  const root = await fs.realpath(directory)
  const target = String(argumentsText || "").trim() || "progress.md"
  const file = path.resolve(root, target)
  const relative = path.relative(root, file)
  if (!relative || !inside(root, file)) throw new Error("Progress file must be inside the project")
  if ([".git", ".opencode"].includes(relative.split(path.sep)[0].toLowerCase())) {
    throw new Error("Progress file cannot replace a control-plane path")
  }
  const parent = await fs.realpath(path.dirname(file))
  if (!inside(root, parent)) throw new Error("Progress file must remain inside the project; symlink escape refused")
  try {
    // Exclusive creation closes the exists-then-write race and never follows
    // an existing target symlink. Existing parent directories are required.
    await fs.writeFile(file, DEFAULT_PROGRESS_MD, { encoding: "utf8", flag: "wx" })
    return { created: true, file: relative }
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, file: relative }
    throw error
  }
}
