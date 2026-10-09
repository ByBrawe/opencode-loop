// A TCP listener is not proof that OpenCode's session router and project
// plugin graph have finished initialization. This is intentionally read-only:
// never send a prompt/command or retry a mutating session request.
export async function waitForSessionBootstrap({
  baseURL, workspace, fetchImpl = fetch,
  timeoutMs = 90_000, perRequestMs = 6_000, intervalMs = 300,
} = {}) {
  if (!URL.canParse(baseURL) || !workspace) throw new Error("Missing OpenCode bootstrap baseURL/workspace")
  const base = new URL(baseURL)
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("OpenCode bootstrap is restricted to a local service")
  if (base.username || base.password) throw new Error("Credentials must not be embedded in the bootstrap URL")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid bootstrap timeout")
  const url = new URL("/session", base)
  url.searchParams.set("directory", workspace)
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let last = "no response"
  let commandProbe = "not checked"
  while (Date.now() < deadline) {
    attempts++
    const remaining = deadline - Date.now()
    const signal = AbortSignal.timeout(Math.max(1, Math.min(perRequestMs, remaining)))
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { "x-opencode-directory": workspace, accept: "application/json" },
        signal,
        redirect: "error",
      })
      if (res.ok) {
        const body = await res.json()
        if (!Array.isArray(body?.data ?? body)) {
          throw new Error("OpenCode GET /session returned an unexpected payload (not a session array)")
        }
        return body
      }
      if (![502, 503, 504].includes(res.status)) {
        throw new Error("OpenCode GET /session returned non-retryable HTTP " + res.status)
      }
      last = "HTTP " + res.status
    } catch (error) {
      if (!["TimeoutError", "AbortError", "TypeError"].includes(error?.name)) throw error
      last = error?.name === "TimeoutError" ? "request timed out" : error?.name === "AbortError" ? "request aborted" : "connection not ready"
    }
    // A side probe distinguishes a live command catalog from a stalled global
    // bootstrap. It is diagnostic only: we never waive the session readiness
    // requirement, and do not emit any endpoint response or credentials.
    if (attempts % 3 === 0 && Date.now() < deadline - 2_000) {
      try {
        const res = await fetchImpl(new URL("/command", base), {
          method: "GET",
          headers: { "x-opencode-directory": workspace, accept: "application/json" },
          signal: AbortSignal.timeout(Math.min(2_000, deadline - Date.now())),
          redirect: "error",
        })
        commandProbe = "HTTP " + res.status
      } catch (error) {
        commandProbe = error?.name === "TimeoutError" ? "timed out" : "unavailable"
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
  }
  throw new Error(
    "OpenCode GET /session did not become ready after " + attempts
    + " bounded attempts in " + timeoutMs + "ms"
    + " (last=" + last + ", GET /command=" + commandProbe + ")."
    + " Server routing/plugin initialization must be investigated before claiming a Goal/Loop collision.",
  )
}
