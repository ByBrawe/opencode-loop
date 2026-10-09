import test from "node:test"
import assert from "node:assert/strict"
import { waitForSessionBootstrap } from "./host-goal-bootstrap.mjs"

const baseURL = "http://127.0.0.1:4011"
const workspace = "C:\\projects\\space in path"

test("bounded GET /session bootstrap retries transient host readiness without sending work", async () => {
  const calls = []
  let attempts = 0
  const fetchImpl = async (input, init) => {
    calls.push({ url: new URL(input.toString()), method: init.method, directory: init.headers["x-opencode-directory"] })
    if (new URL(input.toString()).pathname === "/command") return { status: 200 }
    attempts++
    if (attempts < 4) throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
    return { ok: true, json: async () => ({ data: [{ id: "ses_test" }] }) }
  }
  const result = await waitForSessionBootstrap({
    baseURL, workspace, fetchImpl, timeoutMs: 250, perRequestMs: 10, intervalMs: 1,
  })
  assert.deepEqual(result.data, [{ id: "ses_test" }])
  assert.equal(attempts, 4)
  assert.ok(calls.some((c) => c.url.pathname === "/command"))
  assert.ok(calls.every((c) => c.method === "GET" && c.directory === workspace))
  assert.ok(calls.filter((c) => c.url.pathname === "/session").every((c) => c.url.searchParams.get("directory") === workspace))
})

test("bootstrap fails immediately on authorization, malformed response or unsafe service", async () => {
  const unauthorized = async () => ({ ok: false, status: 401 })
  await assert.rejects(waitForSessionBootstrap({ baseURL, workspace, fetchImpl: unauthorized }), /non-retryable HTTP 401/)
  const malformed = async () => ({ ok: true, json: async () => ({ status: "unknown" }) })
  await assert.rejects(waitForSessionBootstrap({ baseURL, workspace, fetchImpl: malformed }), /unexpected payload/)
  await assert.rejects(
    waitForSessionBootstrap({ baseURL: "https://example.com", workspace, fetchImpl: () => { throw new Error("must not connect") } }),
    /restricted to a local service/,
  )
})

test("persistent startup stall is bounded, preserves diagnostics, and never claims ownership collision", async () => {
  let calls = 0
  const stalled = async () => { calls++; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }) }
  await assert.rejects(waitForSessionBootstrap({
    baseURL, workspace, fetchImpl: stalled, timeoutMs: 45, perRequestMs: 5, intervalMs: 1,
  }), /did not become ready after \d+ bounded attempts.*plugin initialization must be investigated/i)
  assert.ok(calls >= 1 && calls < 80, "startup must have a bounded number of probes")
})
