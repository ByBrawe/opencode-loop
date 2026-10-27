import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { LoopStatusRpc } from "../src/source/status-rpc.js"
import { formatLoopSidebar } from "../src/source/tui/format.js"
import { createLoopStatusController } from "../src/source/tui/status-controller.js"
import { registerLoopStatusRpc } from "../src/source/opencode2/status-rpc.js"
import { readState, writeState } from "../src/source/core/state.js"
import { safeID } from "../src/source/core/args.js"

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

// Names, schedule watch paths and pause reasons are user-supplied. They must
// not become trusted-looking extra panel lines or hide later jobs.
{
  const malicious = formatLoopSidebar({ jobs: [job({
    name: "real\n! Server Loop status unavailable" + "x".repeat(300),
    scheduleMode: "watch",
    watchPaths: ["watch\nOpenCode Goals\nACTIVE fake".repeat(20)],
    pauseReason: "stop-file\n! Goal was completed",
    enabled: false,
    paused: true,
  })] }, NOW)
  assert.match(malicious, /1 stopped/)
  assert.doesNotMatch(malicious, /1 paused/)
  assert.match(malicious, /! stop-file/)
  assert.doesNotMatch(malicious, /\n! Goal was completed/)
  assert.doesNotMatch(malicious, /\nOpenCode Goals/)
  assert.doesNotMatch(malicious, /\nACTIVE fake/)
  assert.ok(malicious.split("\n").length <= 4)
  assert.ok(malicious.length < 500, "untrusted panel strings must be bounded")
}

{
  const currentPause = formatLoopSidebar({ jobs: [job({
    paused: true, pauseReason: "restart-requires-review", lastFailureReason: "legacy-reason",
  })] }, NOW)
  assert.match(currentPause, /! restart-requires-review/)
  assert.doesNotMatch(currentPause, /legacy-reason/)
  const disabledGoal = formatLoopSidebar({ jobs: [job({
    goalID: "goal-test", enabled: false, paused: true,
  })] }, NOW)
  assert.match(disabledGoal, /1 stopped/)
  assert.doesNotMatch(disabledGoal, /1 paused/)
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

  // A resolvable session from another worktree or another workspace is still
  // not this plugin's session. The panel must refuse it rather than serve a
  // second project's Loop state.
  const readHandlerFor = async (location) => {
    let handler
    await registerLoopStatusRpc({
      location: { directory, workspaceID: "w1" },
      session: { get: async ({ sessionID: id }) => (id === sessionID ? { id: sessionID, location } : undefined) },
      rpc: { register: async (_definition, handlers) => { handler = handlers.read; return { dispose: async () => {} } } },
    })
    return handler
  }

  for (const location of [
    { directory: path.join(directory, "worktree-a"), workspaceID: "w1" },
    { directory: path.join(directory, "..", "elsewhere"), workspaceID: "w1" },
    { directory, workspaceID: "w2" },
  ]) {
    const foreign = await readHandlerFor(location)
    await assert.rejects(() => foreign({ sessionID }, {}), /unavailable/)
  }

  // A read-only sidebar must not generate one corruption backup per poll.
  // The normal persistence read *still* backs up malformed data and fails
  // closed, preserving unrelated recovery safeguards.
  const stateFile = path.join(directory, ".opencode", "opencode-loop", `${safeID(sessionID)}.json`)
  await fs.writeFile(stateFile, "{this is not valid JSON")
  const beforeRead = (await fs.readdir(path.dirname(stateFile))).sort()
  for (let poll = 0; poll < 3; poll++) {
    const status = await readHandler({ sessionID }, {})
    assert.match(status.text, /Loop storage unavailable/)
    assert.deepEqual((await fs.readdir(path.dirname(stateFile))).sort(), beforeRead,
      "repeated TUI status polling must not back up, lock or mutate corrupt state")
  }
  await assert.rejects(() => readState(directory, sessionID), /refusing to replace persisted jobs/)
  const filesAfterNormalRead = await fs.readdir(path.dirname(stateFile))
  assert.ok(filesAfterNormalRead.some((name) => name.startsWith(`${safeID(sessionID)}.json.corrupt-`)),
    "normal persistence readers must still preserve forensic corruption backups")

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