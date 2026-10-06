import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { LoopStatusRpc } from "../src/source/status-rpc.js"
import { formatLoopSidebar } from "../src/source/tui/format.js"
import { createLoopStatusController } from "../src/source/tui/status-controller.js"
import { registerLoopStatusRpc } from "../src/source/opencode2/status-rpc.js"
import { writeState } from "../src/source/core/state.js"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)

function job(overrides = {}) {
  return {
    id: "job-1",
    name: "watch",
    kind: "prompt",
    action: "devam et",
    intervalMs: 300_000,
    immediate: false,
    createdAt: new Date(NOW - 600_000).toISOString(),
    lastRunAt: NOW - 60_000,
    runCount: 12,
    failureCount: 0,
    enabled: true,
    paused: false,
    ...overrides,
  }
}

// The panel must never present "due" as a dispatch promise. Idle-safe deferral
// is the central Loop concept, so an overdue runnable job is called out
// explicitly instead of silently counting down.
// Labels stay spelled out; only magnitudes compress. This mirrors the Goal
// companion so both panels read the same way.
{
  const text = formatLoopSidebar({ jobs: [job({ runCount: 1247, failureCount: 15_400_000 })] }, NOW)
  assert.match(text, /runs 1.2K/)
  assert.match(text, /fail 15M|15\.4M/)
  assert.doesNotMatch(text, /\br\d+\b/)
  assert.doesNotMatch(text, /\bf\d+\b/)
}

{
  const text = formatLoopSidebar({ jobs: [job({ runCount: 0, failureCount: 0 })] }, NOW)
  assert.match(text, /runs 0 · fail 0/)
}

// The panel repaints continuously, so its countdown never lands on an exact
// interval boundary. Raw milliseconds were leaking into the sidebar.
{
  const text = formatLoopSidebar({ jobs: [job({ lastRunAt: NOW })] }, NOW + 240_000)
  assert.match(text, /^OpenCode Loop/)
  assert.match(text, /every 5m/)
  assert.match(text, /due in 1m/)
  assert.match(text, /runs 12 · fail 0/)
  assert.doesNotMatch(text, /! overdue/)
}

// The panel repaints continuously, so its countdown never lands on an exact
// interval boundary. Raw milliseconds were leaking into the sidebar.
{
  const off = formatLoopSidebar({ jobs: [job({ lastRunAt: NOW })] }, NOW + 11_903)
  assert.match(off, /due in 4m/)
  assert.doesNotMatch(off, /\d+ms/)
}

{
  const overdue = formatLoopSidebar({ jobs: [job({ lastRunAt: NOW - 987_654 })] }, NOW)
  assert.match(overdue, /! overdue 11m/)
  assert.doesNotMatch(overdue, /\d+ms/)
}

{
  const overdue = formatLoopSidebar({ jobs: [job({ lastRunAt: NOW - 900_000 })] }, NOW)
  assert.match(overdue, /! overdue 10m/)
  assert.match(overdue, /waiting for idle/)
}

{
  const paused = formatLoopSidebar({ jobs: [job({ paused: true })] }, NOW)
  assert.match(paused, /paused/)
  assert.doesNotMatch(paused, /! overdue/)
}

// Stop reasons are the codes written to loop.log, so the panel and the log stay
// correlatable. An idle loop going quiet is the most common support question.
{
  const stuck = formatLoopSidebar({ jobs: [job({ failureCount: 3, lastFailureReason: "dispatch_failed" })] }, NOW)
  assert.match(stuck, /! dispatch_failed \(watch\)/)
  assert.match(stuck, /runs 12 · fail 3/)
}

// No invented telemetry: a progress percentage would be fabricated because Loop
// has no completion metric of its own.
{
  const text = formatLoopSidebar({ jobs: [job()] }, NOW)
  assert.doesNotMatch(text, /\d+\s*%/)
  assert.doesNotMatch(text, /ETA|TPS/i)
}

{
  assert.equal(formatLoopSidebar({ jobs: [] }, NOW), "OpenCode Loop\nNo loop jobs")
  assert.equal(formatLoopSidebar(undefined, NOW), "OpenCode Loop\nNo loop jobs")
  assert.equal(formatLoopSidebar({ jobs: [null, 42] }, NOW), "OpenCode Loop\nNo loop jobs")
}

// Panel text must stay renderable no matter what a user typed into a job
// name. The formatter itself stays raw; sanitising is the RPC boundary job.
{
  const noisy = formatLoopSidebar({ jobs: [job({ name: "a b" })] }, NOW)
  assert.ok(noisy.length <= 4096)
  assert.equal(noisy.split("\n").length, 3)
}

// Multi-job panels are bounded so a large job list cannot flood the sidebar.
{
  const many = { jobs: Array.from({ length: 12 }, (_unused, index) => job({ id: `job-${index}`, name: `j${index}` })) }
  const text = formatLoopSidebar(many, NOW)
  assert.match(text, /12 jobs/)
  assert.match(text, /\+6 more/)
  assert.ok(text.split("\n").length <= 10)
}

// The controller keeps exactly one request in flight per mounted panel and
// keeps polling while the session is busy, so it must not fan out on events.
{
  let reads = 0
  let resolveRead
  const published = []
  const controller = createLoopStatusController({
    pollMs: 250,
    read: () => {
      reads++
      return new Promise((resolve) => {
        resolveRead = resolve
      })
    },
    publish: (text) => published.push(text),
  })
  const location = { directory: path.resolve("/tmp/project"), workspaceID: "w1" }
  const first = controller.select("ses_1", location)
  // refresh() issues the request from a microtask so select() can cancel an
  // in-flight generation before any I/O starts.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  controller.invalidate("ses_1")
  controller.invalidate("ses_1")
  controller.invalidate("ses_1")
  assert.equal(reads, 1, "invalidate must not open a parallel request")

  resolveRead({ schemaVersion: 1, sessionID: "ses_1", directory: location.directory, text: "OpenCode Loop\nok" })
  await first
  assert.deepEqual(published.at(-1), "OpenCode Loop\nok")

  // Re-selecting the same session is a no-op rather than a new request.
  const before = reads
  await controller.select("ses_1", location)
  assert.equal(reads, before)
  controller.dispose()
}

{
  const published = []
  const controller = createLoopStatusController({
    read: () => Promise.resolve({ schemaVersion: 1, sessionID: "ses_x", directory: "/other", text: "leaked" }),
    publish: (text) => published.push(text),
  })
  await controller.select("ses_1", { directory: path.resolve("/tmp/project") })
  // A response for another session/location must never be rendered.
  assert.ok(!published.includes("leaked"))
  assert.deepEqual(published.at(-1), "OpenCode Loop\n! Server Loop status unavailable")
  controller.dispose()
}

{
  const published = []
  const controller = createLoopStatusController({
    read: () => Promise.resolve({ schemaVersion: 1, sessionID: "ses_1", directory: "/d", text: "x".repeat(5000) }),
    publish: (text) => published.push(text),
  })
  await controller.select("ses_1", { directory: "/d" })
  assert.deepEqual(published.at(-1), "OpenCode Loop\n! Server Loop status unavailable")
  controller.dispose()
}

{
  const published = []
  const controller = createLoopStatusController({
    read: () => Promise.resolve("not an object"),
    publish: (text) => published.push(text),
  })
  await controller.select("ses_1", { directory: "/d" })
  assert.deepEqual(published.at(-1), "OpenCode Loop\n! Server Loop status unavailable")
  controller.dispose()
}

{
  const published = []
  const controller = createLoopStatusController({ read: () => Promise.resolve({}), publish: (text) => published.push(text) })
  // A session without a usable location must be reported, not rendered empty.
  await controller.select("ses_1", undefined)
  assert.deepEqual(published.at(-1), "OpenCode Loop\n! Session location unavailable")
  controller.dispose()
}

// The RPC is a read-only, location-bound view. It must never serve another
// session, another workspace or an unregistered host.
{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "loop-status-rpc-"))
  const sessionID = "ses_rpc"
  await writeState(directory, sessionID, { jobs: [job({ name: "panel" })] })

  let readHandler
  let disposed = false
  const ctx = {
    location: { directory, workspaceID: "w1" },
    session: { get: async ({ sessionID: id }) => (id === sessionID ? { id: sessionID, location: { directory, workspaceID: "w1" } } : undefined) },
    rpc: { register: async (_definition, handlers) => {
      readHandler = handlers.read
      // Keep the reference so the post-dispose guard can be exercised.
      return { dispose: async () => { disposed = true } }
    } },
  }

  const stop = await registerLoopStatusRpc(ctx)
  assert.equal(typeof readHandler, "function")
  assert.equal(disposed, false)

  const payload = await readHandler({ sessionID }, {})
  assert.equal(payload.schemaVersion, 1)
  assert.equal(payload.sessionID, sessionID)
  assert.equal(payload.directory, directory)
  assert.match(payload.text, /^OpenCode Loop/)
  assert.match(payload.text, /panel/)

  for (const bad of [{}, { sessionID: "" }, { sessionID, extra: "x" }, { sessionID: 1 }, { sessionID: "x".repeat(257) }]) {
    await assert.rejects(() => readHandler(bad, {}), /unavailable/)
  }
  await assert.rejects(() => readHandler({ sessionID: "ses_other" }, {}), /unavailable/)
  await assert.rejects(() => readHandler({ sessionID }, { signal: AbortSignal.abort() }), /unavailable/)

  await stop()
  assert.equal(disposed, true)
  // A released registration must refuse to keep serving stale panel text.
  await assert.rejects(() => readHandler({ sessionID }, {}), /unavailable/)
  // Disposal is idempotent, as the plugin teardown path may run twice.
  await stop()

  // A host without ctx.rpc.register stays usable instead of failing setup.
  const noRpc = await registerLoopStatusRpc({ location: { directory }, session: { get: async () => undefined } })
  assert.equal(typeof noRpc, "function")
  await noRpc()

  await fs.rm(directory, { recursive: true, force: true })
}

// The published contract id must stay stable for already-deployed TUI clients.
assert.equal(LoopStatusRpc.id, "bybrawe-opencode-loop-status")
assert.deepEqual(Object.keys(LoopStatusRpc.methods), ["read"])

console.log("OpenCode Loop TUI status contract passed")