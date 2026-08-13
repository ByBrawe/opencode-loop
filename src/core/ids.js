export function safeID(value) {
  const input = String(value || "job")
  let normalized = ""
  let pendingSeparator = false
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === "_" || char === "." || char === "-"
    if (allowed) {
      if (pendingSeparator && normalized) normalized += "-"
      normalized += char
      pendingSeparator = false
    } else {
      pendingSeparator = true
    }
  }
  while (normalized.startsWith("-")) normalized = normalized.slice(1)
  while (normalized.endsWith("-")) normalized = normalized.slice(0, -1)
  return normalized.slice(0, 80) || "job"
}
