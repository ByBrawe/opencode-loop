import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import OpenCodeLoopV2ExperimentalPlugin from "../src/source/opencode2/experimental.js"
import { createOpenCode2RuntimeAdapter } from "../src/source/opencode2/runtime-adapter.js"
import { readState } from "../src/source/core/state.js"

function controllableStream() {
  const queued = []
  const waiting = []
  let closed = false
  let returns = 0

  const iterator = {
    next() {
      if (queued.length) return Promise.resolve({ done: false, value: queued.shift() })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => waiting.push(resolve))
    },
    async return() {
      returns += 1
      closed = true
      while (waiting.length) waiting.shift()({ done: true, value: undefined })
      return { done: true, value: undefined }
    },
  }

  return {
    stream: { [Symbol.asyncIterator]: () => iterator },
    push(value) {
      if (closed) throw new Error("stream is closed")
      if (waiting.length) waiting.shift()({ done: false, value })
      else queued.push(value)
    },
    returns: () => returns,
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(read, accept, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  value = await read()
  assert.ok(accept(value), "timed out waiting for V2 runtime state")
  return value
}

{
  const events = controllableStream()
  const prompts = []
  let subscriptions = 0
  const ctx = {
    event: {
      subscribe() {
        subscriptions += 1
        return events.stream
      },
    },
    session: {
      prompt: async (input) => {
        prompts.push(input)
        return { accepted: true }
      },
    },
  }

  const adapter = createOpenCode2RuntimeAdapter(ctx)
  assert.equal(await adapter.start(), true)
  assert.equal(await adapter.start(), false)
  assert.equal(subscriptions, 1)

  events.push({
    directory: "/project",
    payload: { type: "session.created", properties: { info: { id: "ses_v2", directory: "/project" } } },
  })
  await settle()
  assert.ok(adapter.runtimeManager.peek("ses_v2"), "V2 event stream must create a session runtime")

  const result = await adapter.prompt({ sessionID: "ses_v2", text: "continue" })
  assert.deepEqual(result, { accepted: true })
  assert.deepEqual(prompts, [{ sessionID: "ses_v2", text: "continue" }])

  assert.equal(await adapter.dispose("test-complete"), true)
  assert.equal(await adapter.dispose("test-complete"), false)
  assert.equal(events.returns(), 1, "disposing the V2 adapter must close the event iterator")
}

{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-wire-"))
  const sessionID = "ses_v2_wire"
  const events = controllableStream()
  const prompts = []
  const ctx = {
    event: { subscribe: () => events.stream },
    session: {
      prompt: async (input) => {
        prompts.push(input)
        return { accepted: true }
      },
    },
  }
  const adapter = createOpenCode2RuntimeAdapter(ctx)
  try {
    await adapter.start()
    events.push({
      directory,
      payload: {
        type: "command.executed",
        properties: {
          sessionID,
          name: "loop",
          arguments: "0s --no-now --max-runs 1 continue the wired V2 task",
          messageID: "msg_loop_wire",
        },
      },
    })

    const created = await waitFor(
      () => readState(directory, sessionID),
      (state) => state.jobs?.length === 1,
    )
    assert.equal(created.jobs[0].action, "continue the wired V2 task")
    assert.equal(created.jobs[0].runCount, 0)

    events.push({
      directory,
      payload: { type: "session.idle", properties: { sessionID } },
    })
    await waitFor(
      async () => prompts.length,
      (count) => count === 1,
    )
    assert.equal(prompts[0].sessionID, sessionID)
    assert.match(prompts[0].text, /AUTONOMOUS OPENCODE LOOP ITERATION/)
    assert.match(prompts[0].text, /continue the wired V2 task/)

    const completed = await waitFor(
      () => readState(directory, sessionID),
      (state) => state.jobs?.[0]?.runCount === 1,
    )
    assert.equal(completed.jobs[0].enabled, false, "max-runs=1 must stop the V2 prompt loop after one dispatch")

    events.push({
      directory,
      payload: { type: "session.idle", properties: { sessionID } },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(prompts.length, 1, "a completed V2 prompt loop must not dispatch again")
  } finally {
    await adapter.dispose("wired-test-complete")
    await fs.rm(directory, { recursive: true, force: true })
  }
}

{
  const events = controllableStream()
  let commandTransforms = 0
  let commandDisposals = 0
  let eventSubscriptions = 0
  const ctx = {
    command: {
      transform: async () => {
        commandTransforms += 1
        return { dispose: async () => { commandDisposals += 1 } }
      },
    },
    event: {
      subscribe() {
        eventSubscriptions += 1
        return events.stream
      },
    },
    session: { prompt: async () => ({ accepted: true }) },
  }

  const cleanup = await OpenCodeLoopV2ExperimentalPlugin.setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.equal(commandTransforms, 1)
  assert.equal(eventSubscriptions, 1)
  await cleanup()
  assert.equal(commandDisposals, 1, "plugin cleanup must dispose command.transform registration")
  assert.equal(events.returns(), 1, "plugin cleanup must dispose the V2 event subscription")
}

{
  let commandDisposals = 0
  const result = await OpenCodeLoopV2ExperimentalPlugin.setup({
    command: {
      transform: async () => ({ dispose: async () => { commandDisposals += 1 } }),
    },
    event: {},
    session: {},
  })
  assert.equal(result, undefined)
  assert.equal(commandDisposals, 1, "partial V2 hosts must not leak command registrations")
}

assert.throws(
  () => createOpenCode2RuntimeAdapter({ event: {}, session: { prompt: async () => {} } }),
  /event\.subscribe capability is unavailable/,
)
assert.throws(
  () => createOpenCode2RuntimeAdapter({ event: { subscribe() {} }, session: {} }),
  /session\.prompt capability is unavailable/,
)

console.log("OpenCode 2 runtime adapter contract passed")
