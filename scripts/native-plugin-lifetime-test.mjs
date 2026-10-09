import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/source/opencode2/native-plugin.js"

function fixture(directory, { failCleanup = false, captureCommands = false } = {}) {
  const released = []
  const commands = new Map()
  const prompts = []
  let releaseRead, signal
  let streamClosed = false
  const end = () => releaseRead?.()
  const registration = (name) => ({ async dispose() {
    released.push(name)
    if (failCleanup && name === "commands") throw new Error("cleanup sentinel")
  } })
  const ctx = {
    location: { directory }, options: {}, app: { version: "2.0.18" },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
      prompt: async (request) => {
        if (!captureCommands) throw new Error("cleanup must not dispatch a prompt")
        prompts.push(request)
        return { id: "test-prompt" }
      },
      hook: async (name) => registration(name),
    },
    command: { transform: async (register) => {
      if (captureCommands) await register({ add: ({ name, execute }) => commands.set(name, execute) })
      return registration("commands")
    } },
    event: { subscribe(options = {}) {
      signal = options.signal
      return (async function* () {
        try {
          await new Promise((resolve) => {
            releaseRead = resolve
            if (signal?.aborted) resolve()
            else signal?.addEventListener("abort", resolve, { once: true })
          })
        } finally { streamClosed = true }
      })()
    } },
  }
  return { ctx, end, released, commands, prompts, signal: () => signal, streamClosed: () => streamClosed }
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => "closed"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 500) }),
    ])
  } finally { clearTimeout(timer) }
}

test("native Loop fails setup when the public session.get location capability is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-v2-no-session-get-"))
  const host = fixture(directory)
  delete host.ctx.session.get
  try {
    await assert.rejects(plugin.setup(host.ctx), /requires session\.get/)
  } finally {
    host.end()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("native Loop aborts an idle subscription before awaiting iterator return", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-v2-lifetime-"))
  const host = fixture(directory)
  let closing
  try {
    const dispose = await plugin.setup(host.ctx)
    closing = dispose()
    assert.equal(await bounded(closing), "closed", "idle subscription cleanup requires an AbortSignal")
    assert.equal(host.signal()?.aborted, true)
    assert.equal(host.streamClosed(), true)
    assert.deepEqual(host.released, ["commands", "compaction", "prompt"])
  } finally {
    host.end()
    await closing?.catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("native Loop cleanup is shared and drains all registrations after an error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-v2-cleanup-error-"))
  const host = fixture(directory, { failCleanup: true })
  let closing
  try {
    const dispose = await plugin.setup(host.ctx)
    host.end()
    closing = dispose()
    const observed = closing.catch((error) => error)
    assert.strictEqual(dispose(), closing, "concurrent unloads must await the same cleanup")
    const error = await observed
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /cleanup sentinel/)
    assert.deepEqual(host.released, ["commands", "compaction", "prompt"])
    assert.equal(host.streamClosed(), true)
  } finally {
    host.end()
    await closing?.catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("native Loop never probes undocumented SessionDomain shell or inbox fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-v2-public-session-"))
  const host = fixture(directory)
  let dispose
  try {
    for (const field of ["shell", "inbox"]) {
      Object.defineProperty(host.ctx.session, field, {
        configurable: true,
        get() { throw new Error(`undocumented session.${field} was accessed`) },
      })
    }
    const calls = []
    host.ctx.session.compact = async (input) => { calls.push(input); return { id: input.id } }
    dispose = await plugin.setup(host.ctx)
    assert.equal(typeof dispose, "function")
    assert.deepEqual(calls, [], "public compact is invoked only for scheduled work")
  } finally {
    host.end()
    await dispose?.().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("native Loop uses the same public plugin identity as the package entry", () => {
  assert.equal(plugin.id, "@bybrawe/opencode-loop", "native entry must share canonical plugin identity")
})

test("native /loop-help reflects public V2 compaction rather than obsolete unsupported guidance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-v2-help-compaction-"))
  const host = fixture(directory, { captureCommands: true })
  host.ctx.session.compact = async () => ({ id: "unused-compaction" })
  let dispose
  try {
    dispose = await plugin.setup(host.ctx)
    const help = host.commands.get("loop-help")
    assert.equal(typeof help, "function")
    await help({ sessionID: "ses-help" })
    assert.equal(host.prompts.length, 1)
    assert.match(host.prompts[0].text, /public session\.compact/)
    assert.match(host.prompts[0].text, /inputID/)
    assert.doesNotMatch(host.prompts[0].text, /does not expose manual session compaction/)
  } finally {
    host.end()
    await dispose?.().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
