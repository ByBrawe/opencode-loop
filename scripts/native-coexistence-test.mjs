import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { nativeGoalReservesSession } from "../src/source/opencode2/native-companion.js"
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
  console.log("Native Goal/Loop ownership tests passed")
} finally {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
}
