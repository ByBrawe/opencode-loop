import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import plugin from '../src/source/opencode2/native-plugin.js'
import { createNativeLoopRuntime } from '../src/source/opencode2/native-runtime.js'

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loop-location-'))
  const foreign = await mkdtemp(path.join(os.tmpdir(), 'loop-foreign-'))
  let session = { id: 'ses_scope', location: { directory } }
  const commands = new Map(), hooks = new Map(), prompts = []
  const ctx = {
    location: { directory }, options: {}, app: { version: '2.0.18' },
    session: {
      get: async () => session,
      prompt: async (input) => { prompts.push(input); return { id: input.id || 'msg_status' } },
      hook: async (name, fn) => { hooks.set(name, fn); return { dispose() { hooks.delete(name) } } },
    },
    command: { transform: async (fn) => { fn({ add(def) { commands.set(def.name, def) } }); return { dispose() {} } } },
    event: { subscribe({ signal }) { return (async function* () { await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) }) })() } },
  }
  const close = await plugin.setup(ctx)
  return {
    directory, foreign, ctx, commands, hooks, prompts,
    setSession(value) { session = value },
    command(name, text = '') { return commands.get(name).execute({ sessionID: 'ses_scope', prompt: { text } }) },
    async close() { await close(); await rm(directory, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }) },
  }
}
test('foreign-worktree command cannot create progress in the plugin directory', async () => {
  const f = await fixture()
  try {
    f.setSession({ id: 'ses_scope', location: { directory: f.foreign } })
    await assert.rejects(f.command('loop-init', 'progress.md'), /session.*location|project.*worktree/i)
    await assert.rejects(access(path.join(f.directory, 'progress.md')))
    await assert.rejects(access(path.join(f.foreign, 'progress.md')))
    assert.equal(f.prompts.length, 0)
  } finally { await f.close() }
})
test('native command still initializes a confirmed local session', async () => {
  const f = await fixture()
  try {
    await f.command('loop-init', 'progress.md')
    assert.ok((await readFile(path.join(f.directory, 'progress.md'), 'utf8')).length)
    assert.equal(f.prompts.length, 1)
  } finally { await f.close() }
})
test('missing, mismatched and unreadable session identity fail closed', async () => {
  const f = await fixture()
  try {
    for (const value of [null, { id: 'ses_other', location: { directory: f.directory } }, { id: 'ses_scope' }, { id: 'ses_scope', location: { directory: f.directory, workspaceID: 'other' } }]) {
      f.setSession(value)
      await assert.rejects(f.command('loop-init'), /session.*location|project.*worktree/i)
    }
    f.ctx.session.get = async () => { throw new Error('session unavailable') }
    await assert.rejects(f.command('loop-init'), /session.*location|project.*worktree/i)
    await assert.rejects(access(path.join(f.directory, 'progress.md')))
  } finally { await f.close() }
})
test('scoped runtime refuses persistent commands and timer dispatch when ownership changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loop-runtime-location-'))
  let allowed = false
  const prompts = [], timers = []
  const runtime = createNativeLoopRuntime({ directory,
    scopeAllowed: async () => allowed,
    prompt: async (input) => { prompts.push(input); return { id: input.id } },
    setTimer(fn) { const timer = { fn }; timers.push(timer); return timer }, clearTimer(timer) { timer.cancelled = true },
  })
  const scope = { directory, sessionID: 'ses_runtime' }
  const command = () => runtime.onEvent({ ...scope, kind: 'command', action: 'executed', name: 'loop', arguments: '1h scoped task --defer' })
  try {
    assert.equal((await command()).accepted, false)
    await assert.rejects(access(path.join(directory, '.opencode')))
    allowed = true
    assert.equal((await command()).accepted, true)
    const file = path.join(directory, '.opencode', 'opencode-loop', 'ses_runtime.json')
    const before = await readFile(file, 'utf8')
    allowed = false
    for (const timer of timers.filter((t) => !t.cancelled)) await timer.fn()
    assert.equal((await runtime.wake(scope)).accepted, false)
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal(prompts.length, 0)
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) }
})
