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

const COMPLETION_BOUNDED_PATTERNS = [
  /\bbitene kadar\b/i,
  /\b(?:tamamen|komple) projeyi bitir\b/i,
  /\bişi bitir\b/i,
  /\buntil (?:it(?:'s| is) )?(?:done|complete|completed|finished)\b/i,
  /\bfinish (?:the )?(?:project|task|work)\b/i,
  /\bkeep going until\b/i,
]

const TERMINAL_COMPLETION_PATTERNS = [
  /\bproje tamamland[ıi]\b/i,
  /\bproject (?:is )?(?:complete|completed|finished|done)\b/i,
  /\b(?:task|work) (?:is )?(?:complete|completed|finished|done)\b/i,
]

const TERMINAL_NO_WORK_PATTERNS = [
  /\byap[ıi]lacak (?:başka )?iş yok\b/i,
  /\bbaşka (?:bir )?iş (?:kalmad[ıi]|yok)\b/i,
  /\bnothing (?:else )?left to do\b/i,
  /\bno (?:more|remaining) work\b/i,
  /\bno known (?:bugs|issues)\b/i,
  /\bzero known (?:bugs|issues)\b/i,
]

const NEXT_WORK_PATTERNS = [
  /\bnext(?: step| task)?\b/i,
  /\bs[ıi]radaki\b/i,
  /\bsonraki\b/i,
  /\bkalan (?:iş|işler|todo|adım)\b/i,
  /\bremaining (?:work|task|todo|step)/i,
  /\bdevam (?:edeceğim|ediyorum|etmek gerek)/i,
]

export function isContinuationShorthand(value) {
  return CONTINUATION_SHORTHANDS.has(String(value || "").trim().toLowerCase().replace(/\s+/g, " "))
}

export function isCompletionBoundedContinuation(value) {
  const text = String(value || "").trim()
  return COMPLETION_BOUNDED_PATTERNS.some((pattern) => pattern.test(text))
}

export function isTerminalNoWorkReply(value) {
  const text = String(value || "").trim()
  if (!text || NEXT_WORK_PATTERNS.some((pattern) => pattern.test(text))) return false
  const completed = TERMINAL_COMPLETION_PATTERNS.some((pattern) => pattern.test(text))
  const noWork = TERMINAL_NO_WORK_PATTERNS.some((pattern) => pattern.test(text))
  return completed && noWork
}

export function continuationProjectInstruction(value) {
  if (!isContinuationShorthand(value) && !isCompletionBoundedContinuation(value)) return ""
  const finish = isCompletionBoundedContinuation(value)
    ? " If you believe the project is finished, perform a fresh verification pass before declaring completion; report both that the project is complete and that no work remains only when you have concrete current evidence."
    : ""
  return `Treat this as continuation of the current project and conversation, not a fresh task. Inspect the repository state, relevant files, TODO/progress notes, recent changes, and git status as needed to identify the next unfinished step. Continue from existing work, do not redo completed work, and verify meaningful changes when practical.${finish}`
}
