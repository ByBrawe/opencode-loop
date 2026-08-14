import assert from "node:assert/strict"

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
  assert.deepEqual(prompts, [{
    sessionID: "ses_v2",
    noReply: false,
    parts: [{ type: "text", text: "continue" }],
  }])

  assert.equal(await adapter.dispose("test-complete"), true)
  assert.equal(await adapter.dispose("test-complete"), false)
  assert.equal(events.returns(), 1, "disposing the V2 adapter must close the event iterator")
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
