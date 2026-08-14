import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCode2PromptRuntime } from "../src/source/opencode2/prompt-runtime.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-prompt-"))
const sessionID = "ses_v2_prompt_runtime"
const prompts = []
const runtime = createOpenCode2PromptRuntime({ prompt: async (request) => { prompts.push(request) } })

async function readState() {
  const file = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { jobs: [] }
    throw error
  }
}

try {
  const added = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --max-runs 2 --ask-never continue the current task" })
  assert.equal(added.accepted, true)
  let state = await readState()
  assert.equal(state.jobs.length, 1)
  assert.equal(state.jobs[0].runCount, 0)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, true)
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].text.includes("AUTONOMOUS OPENCODE LOOP ITERATION"))
  assert.ok(prompts[0].text.includes("continue the current task"))
  assert.ok(prompts[0].text.includes("Do not ask the user questions"))
  state = await readState()
  assert.equal(state.jobs[0].runCount, 1)
  assert.equal(state.jobs[0].enabled, true)

  const paused = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-pause", sessionID, directory, arguments: "" })
  assert.equal(paused.count, 1)
  state = await readState()
  assert.equal(state.jobs[0].paused, true)
  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, false)
  assert.equal(prompts.length, 1)

  const resumed = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-resume", sessionID, directory, arguments: "" })
  assert.equal(resumed.count, 1)
  state = await readState()
  assert.equal(state.jobs[0].paused, false)
  assert.equal(state.jobs[0].lastRunAt, 0)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, true)
  state = await readState()
  assert.equal(state.jobs[0].runCount, 2)
  assert.equal(state.jobs[0].enabled, false)

  assert.equal((await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })).dispatched, false)
  assert.equal(prompts.length, 2)

  const interval = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "5m --name later --multi do this later" })
  assert.equal(interval.accepted, true)
  assert.equal(interval.job.intervalMs, 300_000)
  assert.equal(runtime.scheduledCount(), 0)
  assert.equal((await readState()).jobs.length, 2)

  const intervalRemoved = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-stop", sessionID, directory, arguments: "later" })
  assert.equal(intervalRemoved.count, 1)
  assert.equal((await readState()).jobs.length, 1)

  const command = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --command /review" })
  assert.equal(command.accepted, false)
  assert.ok(command.blockers.includes("command-capability"))
  assert.equal((await readState()).jobs.length, 1)

  const named = await runtime.onEvent({ kind: "command", action: "executed", name: "loop", sessionID, directory, arguments: "0s --name keep --multi keep working" })
  assert.equal(named.accepted, true)
  assert.equal((await readState()).jobs.length, 2)

  const removed = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-stop", sessionID, directory, arguments: "keep" })
  assert.equal(removed.count, 1)
  assert.equal((await readState()).jobs.length, 1)

  const cleared = await runtime.onEvent({ kind: "command", action: "executed", name: "loop-clear", sessionID, directory, arguments: "missing-target-is-ignored" })
  assert.equal(cleared.count, 1)
  assert.equal(cleared.target, "all")
  assert.equal((await readState()).jobs.length, 0)

  console.log("OpenCode 2 prompt runtime contract passed")
} finally {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
}
