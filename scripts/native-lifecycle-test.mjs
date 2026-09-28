import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/source/opencode2/native-plugin.js"
import { createOpenCode2EventBridge } from "../src/source/opencode2/event-bridge.js"

async function fixture({ failDispose = false, failSubscribe = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-native-unload-"))
  const cleaned = []
  const cleanupError = new Error("command cleanup rejected")
  const subscribeError = new Error("subscription rejected")
  let signal, stopped = 0, release = () => {}
  const registration = name => ({ dispose: async () => {
    cleaned.push(name)
    if (failDispose && name === "commands") throw cleanupError
  } })
  const ctx = {
    location: { directory }, options: {},
    session: {
      prompt: async () => { throw new Error("cleanup must not prompt or abort a native session") },
      hook: async name => registration(name),
    },
    command: { transform: async edit => { edit({ add() {} }); return registration("commands") } },
    event: { subscribe(input) {
      signal = input?.signal
      if (failSubscribe) throw subscribeError
      return (async function* () {
        try {
          await new Promise(resolve => {
            release = resolve
            if (signal?.aborted) resolve()
            else signal?.addEventListener("abort", resolve, { once: true })
          })
        } finally { stopped++ }
      })()
    } },
  }
  return { ctx, cleaned, cleanupError, subscribeError, signal: () => signal, stopped: () => stopped,
    release: () => release(), remove: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("native unload blocked on event next()")), 1500) })]) }
  finally { clearTimeout(timer) }
}

test("native unload aborts a pending public event stream and shares cleanup", async () => {
  const host = await fixture()
  let dispose
  try {
    dispose = await plugin.setup(host.ctx)
    assert.ok(host.signal() instanceof AbortSignal, "the native subscription needs a cancellation signal")
    const first = dispose(), second = dispose()
    assert.equal(first, second)
    await bounded(first)
    assert.equal(host.signal().aborted, true)
    assert.equal(host.stopped(), 1)
    assert.deepEqual(host.cleaned, ["commands", "compaction", "prompt"])
    await dispose()
    assert.equal(host.cleaned.length, 3)
  } finally { host.release(); await dispose?.().catch(() => {}); await host.remove() }
})

test("one failed native disposer does not skip remaining registrations", async () => {
  const host = await fixture({ failDispose: true })
  let dispose
  try {
    dispose = await plugin.setup(host.ctx)
    host.release()
    await assert.rejects(bounded(dispose()), error => error instanceof AggregateError && error.errors.includes(host.cleanupError))
    assert.deepEqual(host.cleaned, ["commands", "compaction", "prompt"])
    assert.equal(host.signal()?.aborted, true)
    await assert.rejects(dispose(), AggregateError)
    assert.equal(host.cleaned.length, 3)
  } finally { host.release(); await dispose?.().catch(() => {}); await host.remove() }
})

test("failed native setup preserves its error and attempts all cleanup", async () => {
  const host = await fixture({ failDispose: true, failSubscribe: true })
  try {
    await assert.rejects(plugin.setup(host.ctx), error => error === host.subscribeError)
    assert.deepEqual(host.cleaned, ["commands", "compaction", "prompt"])
    assert.equal(host.signal()?.aborted, true)
  } finally { host.release(); await host.remove() }
})

test("event bridge disposes session scopes even when unsubscribe rejects", async () => {
  const sentinel = new Error("unsubscribe failed")
  const bridge = createOpenCode2EventBridge({ directory: "/project" })
  let listener
  await bridge.attach(async callback => { listener = callback; return { unsubscribe: async () => { throw sentinel } } })
  await listener({ directory: "/project", payload: { type: "session.created", properties: { info: { id: "ses_cleanup", directory: "/project" } } } })
  const runtime = bridge.runtimeManager.peek("ses_cleanup")
  assert.ok(runtime?.scope.isActive())
  await assert.rejects(bridge.dispose(), error => error === sentinel)
  assert.equal(runtime.scope.isActive(), false)
  assert.deepEqual(bridge.runtimeManager.entries(), [])
})
