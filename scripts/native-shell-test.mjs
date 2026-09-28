import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNativeShellHost } from "../src/source/opencode2/native-shell.js"

let cases = 0
async function scenario(source, check, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "loop-native-shell-"))
  const events = [], errors = []
  let terminal
  const ended = new Promise((resolve) => { terminal = resolve })
  const host = createNativeShellHost({ directory, onTerminal: (event) => { events.push(event); terminal(event) }, onError: (error) => errors.push(error) })
  try {
    await writeFile(path.join(directory, "command.cjs"), source)
    const admitted = await host.dispatch({ id: "owned-shell", sessionID: "owned-session", command: `"${process.execPath}" command.cjs`, timeoutMs: 5000, ...options })
    assert.equal(admitted.id, "owned-shell")
    assert.equal(admitted.status, "running")
    if (options.dispose) await host.dispose()
    const event = await Promise.race([ended, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("shell never settled")), 10_000); t.unref() })])
    assert.equal(event.sessionID, "owned-session")
    assert.equal(event.shellID, "owned-shell")
    assert.equal(events.length, 1)
    assert.equal(host.activeCount(), 0)
    assert.equal(errors.length, 0)
    await check(event, host)
    cases++
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
await scenario('process.stdout.write("SUCCESS")', (event) => { assert.equal(event.code, 0); assert.equal(event.status, "exited"); assert.equal(event.stdout, "SUCCESS") })
await scenario('process.stderr.write("FAILED"); process.exitCode=7', (event) => { assert.equal(event.code, 7); assert.equal(event.stderr, "FAILED") })
await scenario('setInterval(()=>{},1000)', (event) => { assert.equal(event.code, 124); assert.equal(event.status, "timeout") }, { timeoutMs: 100 })
await scenario('setInterval(()=>{},1000)', (event) => { assert.equal(event.status, "killed"); assert.notEqual(event.code, 0) }, { dispose: true })
await scenario('process.stdout.write("A".repeat(100000))', (event) => { assert.equal(event.stdout.length, 64000); assert.equal(event.code, 0) })
await scenario('process.exitCode=0', async (_, host) => { await host.dispose(); await assert.rejects(host.dispatch({ sessionID: "s", command: "echo nope" }), /disposed/) })
assert.throws(() => createNativeShellHost({}), /requires directory/)
console.log(`Native local shell lifecycle: ${cases + 1} scenarios passed`)
