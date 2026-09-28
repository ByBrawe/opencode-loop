import assert from "node:assert/strict"
import { createNativeShellHost } from "../src/source/opencode2/native-shell.js"
import { processTreeFixture, bounded } from "./native-process-tree-fixture.mjs"

for (const mode of ["timeout", "dispose", "concurrent-dispose"]) {
  const fixture = await processTreeFixture()
  const events = []
  let terminal
  const ended = new Promise((resolve) => { terminal = resolve })
  const host = createNativeShellHost({
    directory: fixture.directory,
    onTerminal: (event) => { events.push(event); terminal(event) },
  })
  try {
    await host.dispatch({ id: "tree-command", sessionID: "tree-session", command: fixture.command,
      timeoutMs: mode === "timeout" ? 2000 : 10000 })
    await fixture.ready()
    if (mode === "dispose") await bounded(host.dispose())
    if (mode === "concurrent-dispose") {
      const first = host.dispose()
      const second = host.dispose()
      // Every caller must wait for the same cleanup, not return on a boolean.
      await bounded(second)
      assert.equal(host.activeCount(), 0, "second dispose returned before cleanup")
      await fixture.assertStopped()
      await bounded(first)
    }
    const event = await bounded(ended)
    assert.equal(event.status, mode === "timeout" ? "timeout" : "killed")
    assert.equal(event.sessionID, "tree-session")
    assert.equal(event.shellID, "tree-command")
    assert.equal(events.length, 1)
    assert.equal(host.activeCount(), 0)
    await fixture.assertStopped()
    console.log(`Native process-tree regression passed: ${mode}`)
  } finally {
    await fixture.cleanup()
    await bounded(host.dispose())
  }
}
