import assert from "node:assert/strict"
import {
  clearSessionActivity,
  markToolCallActive,
  markToolCallFinished,
  sessionParents,
  sessionStatuses,
  sessionStatusSeenAt,
  updateSessionRelationship,
} from "../src/source/runtime/session-activity.js"
import { createSessionStatusRuntime } from "../src/source/runtime/session-status.js"

assert.throws(() => createSessionStatusRuntime({}), /activeRuns Map/)

const activeRuns = new Map()
const logs = []
let clock = 100_000
let completion = "unknown"
const runtime = createSessionStatusRuntime({
  activeRuns,
  now: () => clock,
  sessionStatusCacheMs: 0,
  appendLoopLog: async (...args) => { logs.push(args) },
  activeRunCompletionFromMessages: async () => completion,
})

const ids = new Set()
const track = (...values) => {
  for (const value of values) if (typeof value === "string") ids.add(value)
}

try {
  {
    const sessionID = "event-idle"
    track(sessionID)
    const result = runtime.updateSessionStatusFromEvent({ type: "session.idle", properties: { sessionID } })
    assert.deepEqual(result, { sessionID, idle: true })
    assert.equal(sessionStatuses.get(sessionID), "idle")
    assert.equal(sessionStatusSeenAt.get(sessionID), clock)

    clock++
    assert.deepEqual(
      runtime.updateSessionStatusFromEvent({ type: "session.status", properties: { sessionID, status: { type: "retry" } } }),
      { sessionID, idle: false },
    )
    assert.equal(sessionStatuses.get(sessionID), "retry")
    assert.equal(sessionStatusSeenAt.get(sessionID), clock)
    assert.equal(runtime.updateSessionStatusFromEvent({ type: "message.updated", properties: { sessionID } }), undefined)
    assert.equal(runtime.updateSessionStatusFromEvent({ type: "session.idle", properties: {} }), undefined)
  }

  {
    const sessionID = "mark-clear"
    track(sessionID)
    assert.equal(runtime.markSessionStatus(sessionID, "busy", 1234), true)
    assert.equal(sessionStatuses.get(sessionID), "busy")
    assert.equal(sessionStatusSeenAt.get(sessionID), 1234)
    assert.equal(runtime.markSessionStatus(undefined, "busy"), false)
    runtime.clearSessionStatus(sessionID)
    assert.equal(sessionStatuses.has(sessionID), false)
    assert.equal(sessionStatusSeenAt.has(sessionID), false)
  }

  {
    const sessionID = "sdk-data-wrapper"
    track(sessionID)
    const calls = []
    const client = {
      session: {
        status: async (args) => {
          calls.push(args)
          return { data: { [sessionID]: { type: "busy" } } }
        },
      },
    }
    const live = await runtime.readLiveSessionStatus(client, sessionID, "/repo")
    assert.deepEqual(live, { type: "busy", source: "sdk" })
    assert.deepEqual(calls, [{ query: { directory: "/repo" } }])
    assert.equal(sessionStatuses.get(sessionID), "busy")
    assert.equal(sessionStatusSeenAt.get(sessionID), clock)
  }

  {
    const sessionID = "sdk-error-fallback"
    track(sessionID)
    const calls = []
    const client = {
      session: {
        status: async (args) => {
          calls.push(args)
          if (calls.length === 1) return { error: { message: "unsupported query shape" } }
          return { data: { [sessionID]: { type: "idle" } } }
        },
      },
    }
    const live = await runtime.readLiveSessionStatus(client, sessionID, "/repo")
    assert.deepEqual(live, { type: "idle", source: "sdk" })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], { query: { directory: "/repo" } })
    assert.deepEqual(calls[1], { directory: "/repo" })
  }

  {
    const parentID = "parent-busy-child"
    const childID = "child-busy"
    track(parentID, childID)
    updateSessionRelationship({ id: childID, parentID })
    const client = {
      session: {
        status: async () => ({ data: { [childID]: { type: "busy" } } }),
      },
    }
    const live = await runtime.readLiveSessionStatus(client, parentID, "/repo")
    assert.deepEqual(live, { type: "busy", source: "descendant" })
    assert.equal(sessionParents.get(childID), parentID)
    assert.equal(sessionStatuses.get(childID), "busy")
  }

  {
    const parentID = "parent-finished-child"
    const childID = "child-finished"
    track(parentID, childID)
    updateSessionRelationship({ id: childID, parentID })
    runtime.markSessionStatus(childID, "busy")
    const client = {
      session: {
        status: async () => ({ data: { [parentID]: { type: "idle" } } }),
      },
    }
    const live = await runtime.readLiveSessionStatus(client, parentID, "/repo")
    assert.deepEqual(live, { type: "idle", source: "sdk" })
    assert.equal(sessionStatuses.get(childID), "idle", "omitted descendant must be cleared to idle")
  }

  {
    const sessionID = "active-tool"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    markToolCallActive({ sessionID, callID: "tool-1" })
    const client = { session: { status: async () => ({ data: { [sessionID]: { type: "idle" } } }) } }
    assert.equal(await runtime.sessionStatusType(client, sessionID, "/repo"), "busy")
    assert.equal(sessionStatuses.get(sessionID), "busy")
    markToolCallFinished({ sessionID, callID: "tool-1" })
  }

  {
    const sessionID = "message-complete-recovery"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    activeRuns.set(sessionID, { jobId: "job-1", job: { id: "job-1", name: "dev" }, startedAt: 1_000 })
    completion = "completed"
    const client = { session: { status: async () => ({ data: { [sessionID]: { type: "busy" } } }) } }
    assert.equal(await runtime.sessionStatusType(client, sessionID, "/repo"), "idle")
    assert.equal(sessionStatuses.get(sessionID), "idle")
    assert.deepEqual(logs.at(-1), ["/repo", "status-message-complete-recovery", { sessionID, job: "dev", startedAt: 1_000 }])
    activeRuns.delete(sessionID)
    completion = "unknown"
  }

  {
    const sessionID = "stale-recovery"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    activeRuns.set(sessionID, { jobId: "job-2", job: { id: "job-2" }, startedAt: 1_000 })
    completion = "unknown"
    const client = { session: { status: async () => ({ data: { [sessionID]: { type: "retry" } } }) } }
    assert.equal(await runtime.sessionStatusType(client, sessionID, "/repo"), "idle")
    assert.deepEqual(logs.at(-1), ["/repo", "status-stale-recovery", { sessionID, job: "job-2", startedAt: 1_000 }])
    activeRuns.delete(sessionID)
  }

  {
    const sessionID = "fallback-fresh"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    activeRuns.set(sessionID, { jobId: "fresh", job: {}, startedAt: clock - 1_000 })
    const client = { session: { status: async () => { throw new Error("offline") } } }
    assert.equal(await runtime.sessionStatusType(client, sessionID, "/repo"), "busy")
    activeRuns.set(sessionID, { jobId: "stale", job: {}, startedAt: clock - 60_000 })
    runtime.clearSessionStatus(sessionID)
    assert.equal(await runtime.sessionStatusType(client, sessionID, "/repo"), "idle")
    activeRuns.delete(sessionID)
  }

  {
    const sessionID = "finalize-basic"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    const active = { jobId: "job", job: {}, startedAt: clock - 100 }
    assert.equal(await runtime.canFinalizeActiveRun("/repo", {}, sessionID, active), true)

    markToolCallActive({ sessionID, callID: "tool-finalize" })
    assert.equal(await runtime.canFinalizeActiveRun("/repo", {}, sessionID, active), false)
    markToolCallFinished({ sessionID, callID: "tool-finalize" })

    runtime.markSessionStatus(sessionID, "idle", clock + 1)
    const client = { session: { status: async () => { throw new Error("status unavailable") } } }
    assert.equal(await runtime.canFinalizeActiveRun("/repo", client, sessionID, active, { requireIdle: true }), true)
  }

  {
    const sessionID = "force-stale"
    track(sessionID)
    runtime.clearSessionStatus(sessionID)
    activeRuns.set(sessionID, { jobId: "force", job: {}, startedAt: clock - 60_000 })
    completion = "unknown"
    const active = activeRuns.get(sessionID)
    const client = { session: { status: async () => ({ data: { [sessionID]: { type: "busy" } } }) } }
    assert.equal(await runtime.canFinalizeActiveRun("/repo", client, sessionID, active, { requireIdle: true, forceStale: true }), true)
    activeRuns.delete(sessionID)
  }

  assert.equal(await runtime.readLiveSessionStatus({}, "missing-client", "/repo"), undefined)
  assert.equal(await runtime.sessionIsIdle({ session: { status: async () => ({ data: {} }) } }, "unlisted", "/repo"), true)

  console.log("session status tests passed")
} finally {
  activeRuns.clear()
  for (const sessionID of ids) clearSessionActivity(sessionID)
}
