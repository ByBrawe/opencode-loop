import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCode2PromptRuntime } from "../src/source/opencode2/prompt-runtime.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-command-"))
const sessionID = "ses_v2_command_runtime"
const prompts = []
const commands = []
const runtime = createOpenCode2PromptRuntime({
  prompt: async (request) => { prompts.push(request) },
  command: async (request) => { commands.push(request); return { accepted: true } },
})

async function readState() {
  const file = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  return JSON.parse(await readFile(file, "utf8"))
}

try {
  const added = await runtime.onEvent({
    kind: "command",
    action: "executed",
    name: "loop",
    sessionID,
    directory,
    arguments: '0s --max-runs 2 --command "/review --quick"',
  })
  assert.equal(added.accepted, true)
  assert.equal(added.job.kind, "command")
  assert.equal(added.job.action, "/review --quick")

  const first = await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })
  assert.equal(first.dispatched, true)
  assert.equal(first.kind, "command")
  assert.deepEqual(first.request, { sessionID, command: "review", arguments: "--quick" })
  assert.deepEqual(commands, [{ sessionID, command: "review", arguments: "--quick" }])
  assert.equal(Object.prototype.hasOwnProperty.call(commands[0], "id"), false, "OpenCode 2 id is a msg_ message ID, never the command name")
  assert.equal(prompts.length, 0)
  let state = await readState()
  assert.equal(state.jobs[0].runCount, 1)
  assert.equal(state.jobs[0].enabled, true)

  const second = await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })
  assert.equal(second.dispatched, true)
  assert.deepEqual(commands[1], { sessionID, command: "review", arguments: "--quick" })
  state = await readState()
  assert.equal(state.jobs[0].runCount, 2)
  assert.equal(state.jobs[0].enabled, false)

  const third = await runtime.onEvent({ kind: "session", action: "idle", sessionID, directory })
  assert.equal(third.dispatched, false)
  assert.equal(commands.length, 2)

  const compact = await runtime.onEvent({
    kind: "command",
    action: "executed",
    name: "loop",
    sessionID,
    directory,
    arguments: '0s --command "/compact"',
  })
  assert.equal(compact.accepted, false)
  assert.ok(compact.blockers.includes("kind"), "shared actionKind keeps /compact on the dedicated compact path")

  const shell = await runtime.onEvent({
    kind: "command",
    action: "executed",
    name: "loop",
    sessionID,
    directory,
    arguments: '0s --shell "echo hello"',
  })
  assert.equal(shell.accepted, false)
  assert.ok(shell.blockers.includes("kind"), "shell actions remain unsupported because OpenCode 2 plugin ctx has no session.shell")

  const noCommandRuntime = createOpenCode2PromptRuntime({ prompt: async () => {} })
  try {
    const unavailable = await noCommandRuntime.onEvent({
      kind: "command",
      action: "executed",
      name: "loop",
      sessionID: "ses_no_command",
      directory,
      arguments: '0s --command "/review"',
    })
    assert.equal(unavailable.accepted, false)
    assert.ok(unavailable.blockers.includes("command-capability"))
  } finally {
    await noCommandRuntime.dispose()
  }

  console.log("OpenCode 2 command runtime tests passed")
} finally {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
}
