import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import OpenCodeLoopV2ExperimentalPlugin from "../src/source/opencode2/experimental.js"
import { createOpenCode2RuntimeAdapter } from "../src/source/opencode2/runtime-adapter.js"

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
  let callback
  let subscriptions = 0
  let disposals = 0
  const ctx = {
    event: {
      subscribe(handler) {
        subscriptions += 1
        callback = handler
        return { dispose: async () => { disposals += 1 } }
      },
    },
    session: { prompt: async () => ({ accepted: true }) },
  }

  const adapter = createOpenCode2RuntimeAdapter(ctx)
  assert.equal(await adapter.start(), true)
  assert.equal(subscriptions, 1)
  assert.equal(typeof callback, "function", "callback-style V2 subscribe must receive the bridge callback")

  await callback({
    directory: "/callback-project",
    payload: { type: "session.created", properties: { info: { id: "ses_v2_callback", directory: "/callback-project" } } },
  })
  assert.ok(adapter.runtimeManager.peek("ses_v2_callback"), "callback-style V2 event subscription must reach the runtime manager")

  assert.equal(await adapter.dispose("callback-test-complete"), true)
  assert.equal(disposals, 1, "callback-style V2 subscription must dispose its registration")
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-wiring-"))
  const sessionID = "ses_v2_wiring"
  const events = controllableStream()
  const prompts = []
  const ctx = {
    command: { transform: async () => ({ dispose: async () => {} }) },
    event: { subscribe: () => events.stream },
    session: {
      prompt: async (input) => {
        prompts.push(structuredClone(input))
        return { accepted: true }
      },
    },
  }

  const stateFile = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  const readState = async () => JSON.parse(await readFile(stateFile, "utf8"))
  const cleanup = await OpenCodeLoopV2ExperimentalPlugin.setup(ctx)
  try {
    events.push({
      directory,
      payload: {
        type: "command.executed",
        properties: { sessionID, name: "loop", arguments: "0s --max-runs 2 continue the wiring test" },
      },
    })
    await waitFor(async () => {
      try { return (await readState()).jobs?.length === 1 } catch { return false }
    }, "V2 loop state creation")

    events.push({ directory, payload: { type: "session.idle", properties: { sessionID } } })
    await waitFor(() => prompts.length === 1, "first V2 prompt dispatch")
    assert.equal(prompts[0].sessionID, sessionID)
    assert.ok(prompts[0].text.includes("AUTONOMOUS OPENCODE LOOP ITERATION"))
    assert.ok(prompts[0].text.includes("continue the wiring test"))

    events.push({ directory, payload: { type: "session.idle", properties: { sessionID } } })
    await waitFor(() => prompts.length === 2, "second V2 prompt dispatch")
    const state = await readState()
    assert.equal(state.jobs[0].runCount, 2)
    assert.equal(state.jobs[0].enabled, false)

    events.push({ directory, payload: { type: "session.idle", properties: { sessionID } } })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(prompts.length, 2, "max-runs must stop a third V2 prompt")
  } finally {
    await cleanup?.()
    await rm(directory, { recursive: true, force: true })
  }
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
