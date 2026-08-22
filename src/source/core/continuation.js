const CONTINUATION_SHORTHANDS = new Set([
  "continue",
  "continue.",
  "continue working",
  "keep going",
  "go on",
  "devam",
  "devam et",
  "devam et.",
  "devam et bakalım",
])

export function isContinuationShorthand(value) {
  return CONTINUATION_SHORTHANDS.has(String(value || "").trim().toLowerCase().replace(/\s+/g, " "))
}

export function continuationProjectInstruction(value) {
  if (!isContinuationShorthand(value)) return ""
  return "Treat this as continuation of the current project and conversation, not a fresh task. Inspect the repository state, relevant files, TODO/progress notes, recent changes, and git status as needed to identify the next unfinished step. Continue from existing work, do not redo completed work, and verify meaningful changes when practical."
}
