import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeLoopV2ExperimentalPlugin from "../src/source/opencode2/experimental.js"
import { createOpenCode2RuntimeAdapter } from "../src/source/opencode2/runtime-adapter.js"

function controllableStream() {
  const queued = []
  const waiting = []
  let closed = false
  const iterator = {
    next() {
      if (queued.length) return Promise.resolve({ done: false, value: queued.shift() })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => waiting.push(resolve))
    },
    async return() {
      closed = true
      while (waiting.length) waiting.shift()({ done: true, value: undefined })
      return { done: true, value: undefined }
    },
  }
  return {
    stream: { [Symbol.asyncIterator]: () => iterator },
    push(value) {
      if (waiting.length) waiting.shift()({ done: false, value })
      else queued.push(value)
    },
  }
}

async function waitFor(predicate, description, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${description}`)
}

{
  const events = controllableStream()
  const commands = []
  const ctx = {
    event: { subscribe: () => events.stream },
    session: {
      prompt: async () => ({ accepted: true }),
      command: async (request) => {
        commands.push(structuredClone(request))
        return { accepted: true }
      },
    },
  }
  const adapter = createOpenCode2RuntimeAdapter(ctx)
  await adapter.start()
  const result = await adapter.command({ sessionID: "ses_adapter", command: "/review", arguments: "--quick" })
  assert.deepEqual(result, { accepted: true })
  assert.deepEqual(commands, [{ sessionID: "ses_adapter", command: "review", arguments: "--quick" }])
  assert.equal(Object.prototype.hasOwnProperty.call(commands[0], "id"), false)
  await adapter.dispose()
}

{
  const events = controllableStream()
  const adapter = createOpenCode2RuntimeAdapter({
    event: { subscribe: () => events.stream },
    session: { prompt: async () => ({ accepted: true }) },
  })
  await adapter.start()
  await assert.rejects(adapter.command({ sessionID: "ses_adapter", command: "review" }), /session\.command capability is unavailable/)
  await adapter.dispose()
}

{
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-command-wiring-"))
  const sessionID = "ses_v2_command_wiring"
  const events = controllableStream()
  const commands = []
  const ctx = {
    command: { transform: async () => ({ dispose: async () => {} }) },
    event: { subscribe: () => events.stream },
    session: {
      prompt: async () => ({ accepted: true }),
      command: async (request) => {
        commands.push(structuredClone(request))
        return { accepted: true }
      },
    },
  }
  const cleanup = await OpenCodeLoopV2ExperimentalPlugin.setup(ctx)
  try {
    events.push({
      directory,
      payload: {
        type: "command.executed",
        properties: {
          sessionID,
          name: "loop",
          arguments: '0s --max-runs 1 --command "/review --quick"',
        },
      },
    })
    events.push({ directory, payload: { type: "session.idle", properties: { sessionID } } })
    await waitFor(() => commands.length === 1, "V2 command dispatch")
    assert.deepEqual(commands[0], { sessionID, command: "review", arguments: "--quick" })
  } finally {
    await cleanup?.()
    await rm(directory, { recursive: true, force: true })
  }
}

console.log("OpenCode 2 command adapter tests passed")
