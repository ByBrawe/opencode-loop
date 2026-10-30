import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { nativeGoalReservesSession, nativeOpenCodeGoalReservesSession, byBraweGoalPluginInstalled, nativeGoalRPC } from "../src/source/opencode2/native-companion.js"
import { createNativeLoopRuntime } from "../src/source/opencode2/native-runtime.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "native-coexist-"))
const sessionID = "native-shared-session"
const root = path.join(directory, ".opencode", "goals")
const file = path.join(root, `${createHash("sha256").update(sessionID).digest("hex").slice(0, 32)}.json`)
const scope = { directory, sessionID }
let prompts = 0
const runtime = createNativeLoopRuntime({ directory, prompt: async (request) => { prompts++; return { id: request.id } } })
try {
  assert.equal(await nativeGoalReservesSession(directory, sessionID), false)
  await mkdir(root, { recursive: true })
  for (const status of ["active", "paused", "waiting_user", "handoff_pending", "handed_off", "budget_limited"]) {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, id: "shared-goal", sessionID, status }))
    assert.equal(await nativeGoalReservesSession(directory, sessionID), true, status)
  }
  await runtime.onEvent({ ...scope, kind: "command", action: "executed", name: "loop", arguments: "0s do work --max-runs 1" })
  await runtime.wake(scope)
  assert.equal(prompts, 0, "Loop must not take over a reserved Goal session")
  await writeFile(file, "invalid json")
  await runtime.wake(scope)
  assert.equal(prompts, 0, "corrupt Goal storage must fail closed")
  await writeFile(file, JSON.stringify({ schemaVersion: 1, id: "shared-goal", sessionID, status: "completed" }))
  assert.equal(await nativeGoalReservesSession(directory, sessionID), false)
  await runtime.wake(scope)
  assert.equal(prompts, 1, "completed Goal can release continuation to an explicitly configured Loop")
  assert.equal(await nativeGoalReservesSession(directory, "another-session"), false)

  const nativeSessionID = "native-built-in-goal-session"
  let nativeStatus = "active"
  let nativeReads = 0
  const rpc = (definition) => {
    assert.equal(definition.id, "opencode.goal")
    assert.equal(definition.methods.get.input.properties.sessionID.type, "string")
    return {
      get: async (input) => {
        assert.equal(input.sessionID, nativeSessionID)
        nativeReads++
        return nativeStatus === null ? null : { id: "native-goal", status: nativeStatus }
      },
    }
  }
  const ctx = { app: { version: "2.2.4" }, rpc }
  assert.equal(nativeGoalRPC.id, "opencode.goal")
  for (const [status, expected] of [[null, false], ["active", true], ["paused", true], ["complete", false], ["invalid", true]]) {
    nativeStatus = status
    assert.equal(await nativeOpenCodeGoalReservesSession(ctx, nativeSessionID), expected, String(status))
  }
  assert.equal(nativeReads, 5)
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.0.18" } }, nativeSessionID), false, "old V2 hosts never had native Goal")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.1.4" }, rpc: () => ({ get: async () => { throw Error("legacy host RPC error") } }) }, nativeSessionID), false, "legacy RPC errors cannot block a pre-native-Goal host")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "opencode v2.0.11" }, rpc: () => ({ get: async () => { throw { type: "rpc.method_not_found" } } }) }, nativeSessionID), false, "old host must bypass Goal RPC entirely")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.2.4" } }, nativeSessionID), true, "modern host without Goal RPC must fail closed")
  const unavailable = () => ({ get: async () => { throw { type: "rpc.unavailable" } } })
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.2.4" }, rpc: unavailable, plugin: { list: async () => [] } }, nativeSessionID), false, "disabled native Goal should not block Loop")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.2.4" }, rpc: unavailable, plugin: { list: async () => [{ id: "opencode.goal" }] } }, nativeSessionID), true, "Goal registered but RPC unavailable must block")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.2.4" }, rpc: unavailable, plugin: { list: async () => { throw Error("offline") } } }, nativeSessionID), true, "unverified Goal state fails closed")
  assert.equal(await nativeOpenCodeGoalReservesSession({ app: { version: "2.2.4" }, rpc: () => ({ get: async () => { throw Error("transient error") } }) }, nativeSessionID), true)

  let nativePrompts = 0
  const nativeScope = { directory, sessionID: nativeSessionID }
  const nativeLoop = createNativeLoopRuntime({
    directory,
    nativeGoalReservesSession: (id) => nativeOpenCodeGoalReservesSession(ctx, id),
    prompt: async (request) => { nativePrompts++; return { id: request.id } },
  })
  try {
    nativeStatus = "active"
    await nativeLoop.onEvent({ ...nativeScope, kind: "command", action: "executed", name: "loop", arguments: "0s separate task --max-runs 1" })
    await nativeLoop.wake(nativeScope)
    assert.equal(nativePrompts, 0, "active built-in Goal must stop Loop turn admission")
    nativeStatus = "paused"
    await nativeLoop.wake(nativeScope)
    assert.equal(nativePrompts, 0, "paused built-in Goal still reserves the session")
    nativeStatus = "complete"
    await nativeLoop.wake(nativeScope)
    assert.equal(nativePrompts, 1, "completed native Goal releases independently scheduled Loop")
  } finally {
    await nativeLoop.dispose()
  }

  const absentGoal = { plugin: { list: async () => [] } }
  assert.equal(await byBraweGoalPluginInstalled(absentGoal), false, "standalone Loop has no separate Goal plugin")
  assert.equal(await byBraweGoalPluginInstalled({ plugin: { list: async () => [{ id: "@bybrawe/opencode-goal" }] } }), true)
  assert.equal(await byBraweGoalPluginInstalled({ plugin: { list: async () => [{ source: { target: "@bybrawe/opencode-goal@1.3.49" } }] } }), true)
  assert.equal(await byBraweGoalPluginInstalled({}), true, "older hosts retain conservative disk guard")
  assert.equal(await byBraweGoalPluginInstalled({ plugin: { list: async () => { throw Error("catalog offline") } } }), true)

  const orphanSessionID = "orphaned-bybrawe-goal-shard"
  const orphanPath = path.join(root, `${createHash("sha256").update(orphanSessionID).digest("hex").slice(0, 32)}.json`)
  await writeFile(orphanPath, JSON.stringify({ schemaVersion: 1, id: "retired-goal", sessionID: orphanSessionID, status: "paused" }))
  let orphanPrompts = 0
  const orphan = createNativeLoopRuntime({
    directory,
    dedicatedGoalInstalled: () => byBraweGoalPluginInstalled(absentGoal),
    nativeGoalReservesSession: async () => false,
    prompt: async (request) => { orphanPrompts++; return { id: request.id } },
  })
  try {
    await orphan.onEvent({ directory, sessionID: orphanSessionID, kind: "command", action: "executed", name: "loop", arguments: "0s independent task --max-runs 1" })
    await orphan.wake({ directory, sessionID: orphanSessionID })
    assert.equal(orphanPrompts, 1, "a removed Goal must not block independent Loop via orphaned state")
  } finally {
    await orphan.dispose()
  }

  let checks = 0
  let racedPrompts = 0
  const racedSessionID = "native-goal-race-session"
  const raced = createNativeLoopRuntime({
    directory,
    nativeGoalReservesSession: async () => ++checks >= 2,
    prompt: async (request) => { racedPrompts++; return { id: request.id } },
  })
  try {
    await raced.onEvent({ directory, sessionID: racedSessionID, kind: "command", action: "executed", name: "loop", arguments: "0s task --max-runs 1" })
    await raced.wake({ directory, sessionID: racedSessionID })
    assert.ok(checks >= 2, "ownership must be rechecked just before dispatch")
    assert.equal(racedPrompts, 0, "a newly armed native Goal must win the last admission check")
  } finally {
    await raced.dispose()
  }
  console.log("Native Goal/Loop ownership tests passed")
} finally {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
}
