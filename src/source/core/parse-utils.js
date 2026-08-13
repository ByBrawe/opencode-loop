export function safeID(value) {
  return String(value || "job")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "job"
}

export function parseDuration(value) {
  const input = String(value || "").trim()
  if (input === "0") return 0
  const match = input.match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i)
  if (!match) return null
  const amount = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  if (!Number.isFinite(amount) || amount < 0) return null
  if (unit === "ms") return amount
  if (unit.startsWith("s")) return amount * 1000
  if (unit.startsWith("m")) return amount * 60_000
  if (unit.startsWith("h")) return amount * 3_600_000
  if (unit.startsWith("d")) return amount * 86_400_000
  return null
}

export function durationToText(ms) {
  if (ms === 0) return "every idle"
  if (!Number.isFinite(ms)) return "unknown"
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

export function splitFirst(input) {
  const match = String(input || "").trim().match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return ["", ""]
  return [match[1], (match[2] || "").trim()]
}

export function stripOuterQuotes(value) {
  const input = String(value || "").trim()
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1)
  }
  return input
}

export function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

export function takeFlag(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i")
  const found = pattern.test(rest)
  return [found, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

export function takeFlagValue(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}\\s+(?:\"([^\"]*)\"|'([^']*)'|(\\S+))`, "i")
  const match = rest.match(pattern)
  if (!match) return [undefined, rest]
  const value = match[2] ?? match[3] ?? match[4]
  return [value, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

export function takeAllFlagValues(rest, flag) {
  const values = []
  let current = rest
  while (true) {
    const [value, next] = takeFlagValue(current, flag)
    if (value === undefined) return [values, current]
    values.push(value)
    current = next
  }
}

export function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function parseCompactEvery(value) {
  const duration = parseDuration(value)
  if (duration !== null) return { compactEveryMs: duration }
  const runs = parsePositiveInt(value, 0)
  return runs > 0 ? { compactEveryRuns: runs } : {}
}
