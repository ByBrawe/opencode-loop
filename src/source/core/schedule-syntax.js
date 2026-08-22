import { parseDuration } from "./args.js"

function removeBooleanFlag(input, flag) {
  const pattern = new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`, "i")
  const found = pattern.test(input)
  return {
    found,
    value: String(input || "").replace(pattern, " ").replace(/\s+/g, " ").trim(),
  }
}

function firstToken(input) {
  const match = String(input || "").trim().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  return match ? { token: match[1], rest: String(match[2] || "").trim() } : { token: "", rest: "" }
}

function inferredMode(intervalMs, maxRuns) {
  if (Number(maxRuns || 0) === 1 && Number(intervalMs || 0) > 0) return "once"
  return Number(intervalMs || 0) === 0 ? "idle" : "interval"
}

/**
 * Normalize the human-facing /loop schedule grammar before the legacy flag parser.
 *
 * Supported forms:
 *   /loop <prompt>                 -> every idle, unlimited
 *   /loop idle <prompt>            -> every idle, unlimited
 *   /loop every 5m <prompt>        -> recurring, first run after 5m
 *   /loop after 5m <prompt>        -> one shot after 5m
 *   /loop in 5m <prompt>           -> alias for `after`
 *   /loop 5m <prompt>              -> legacy compact form (starts now unless --no-now)
 */
export function normalizeLoopScheduleArgs(raw, defaults = {}) {
  const overlap = removeBooleanFlag(String(raw || "").trim(), "--allow-goal-overlap")
  let input = overlap.value
  const nextDefaults = { ...defaults }
  let scheduleMode = defaults.scheduleMode
  let scheduleSyntax = "legacy"

  const first = firstToken(input)
  const keyword = first.token.toLowerCase()

  if (keyword === "idle") {
    nextDefaults.intervalMs = 0
    nextDefaults.immediate = true
    scheduleMode = "idle"
    scheduleSyntax = "idle"
    input = first.rest
  } else if (keyword === "every" || keyword === "after" || keyword === "in") {
    const duration = firstToken(first.rest)
    const intervalMs = parseDuration(duration.token)
    if (intervalMs === null) {
      return {
        ok: false,
        error: `Invalid ${keyword} schedule. Example: /loop ${keyword === "every" ? "every" : "after"} 5m continue the project`,
      }
    }
    nextDefaults.intervalMs = intervalMs
    nextDefaults.immediate = false
    input = duration.rest
    if (keyword === "every") {
      scheduleMode = intervalMs === 0 ? "idle" : "interval"
      scheduleSyntax = "every"
    } else {
      nextDefaults.maxRuns = 1
      scheduleMode = "once"
      scheduleSyntax = "after"
    }
  } else {
    const duration = parseDuration(first.token)
    if (duration !== null) {
      scheduleMode = duration === 0 ? "idle" : "interval"
    } else if (nextDefaults.intervalMs === undefined || nextDefaults.intervalMs === null) {
      // Plain /loop text is the ergonomic auto-continue form. Flags at the front
      // are also accepted because the lower-level parser now receives an idle default.
      nextDefaults.intervalMs = 0
      nextDefaults.immediate = nextDefaults.immediate ?? true
      scheduleMode = "idle"
      scheduleSyntax = "idle-shorthand"
    } else {
      scheduleMode = scheduleMode || inferredMode(nextDefaults.intervalMs, nextDefaults.maxRuns)
    }
  }

  return {
    ok: true,
    args: input,
    defaults: nextDefaults,
    scheduleMode: scheduleMode || inferredMode(nextDefaults.intervalMs, nextDefaults.maxRuns),
    scheduleSyntax,
    allowGoalOverlap: overlap.found || defaults.allowGoalOverlap === true,
  }
}
