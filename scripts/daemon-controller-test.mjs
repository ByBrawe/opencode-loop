import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createDaemonController, acquireDaemonController } from "../src/source/opencode2/daemon-controller.js"

const fixture = async (fn) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-daemon-"))
  try { await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("daemon is disabled by default, one monitor instance, no prompt execution", async () => fixture(async (directory) => {
  let checks = 0
  const alerts = []
  const daemon = createDaemonController({ directory, check: async () => {
    checks++
    return { checked: 1, alerts: checks === 1 ? [{ message: "stalled goal" }] : [] }
  }, onAlert: (message) => alerts.push(message), everyMs: 20_000 })
  await daemon.init()
  assert.match(daemon.getStatus(), /Daemon: stopped/)
  await daemon.handle("start")
  await daemon.handle("start")
  assert.equal(checks, 1)
  assert.deepEqual(alerts, ["stalled goal"])
  assert.match(await daemon.handle("status"), /Daemon: running/)
  await daemon.handle("pulse off")
  await daemon.handle("pulse on")
  assert.equal(checks, 2)
  await daemon.handle("stop")
  assert.match(daemon.getStatus(), /Autostart: off/)
  assert.match(daemon.getStatus(), /Daemon: stopped/)
  await assert.rejects(stat(path.join(directory, ".opencode/opencode-loop/daemon-control.lock")), { code: "ENOENT" })
  await daemon.dispose()
}))

test("autostart preference resumes only on plugin startup and stop persists off", async () => fixture(async (directory) => {
  let checks = 0
  const options = { directory, check: async () => ({ checked: ++checks, alerts: [] }), everyMs: 20_000 }
  const first = createDaemonController(options)
  await first.init()
  await first.handle("auto on")
  assert.match(first.getStatus(), /running/)
  await first.dispose()
  const file = path.join(directory, ".opencode/opencode-loop/daemon-control.json")
  assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, 1)
  const second = createDaemonController(options)
  await second.init()
  assert.match(second.getStatus(), /Daemon: running/)
  assert.equal(checks, 2)
  await second.handle("stop")
  await second.dispose()
  const third = createDaemonController(options)
  await third.init()
  assert.match(third.getStatus(), /Daemon: stopped/)
  await assert.rejects(third.handle("auto enabled"), /Usage/)
  await third.dispose()
}))

test("second controller fails closed on live lock; other owner not killed", async () => fixture(async (directory) => {
  const check = async () => ({ checked: 0, alerts: [] })
  const one = createDaemonController({ directory, check })
  const two = createDaemonController({ directory, check })
  await one.init(); await two.init()
  await one.handle("start")
  await assert.rejects(two.handle("start"), /owned by another OpenCode server/)
  assert.match(one.getStatus(), /Daemon: running/)
  await one.dispose(); await two.dispose()
}))

test("same-process plugin contexts share a single controller", async () => fixture(async (directory) => {
  const first = await acquireDaemonController(directory)
  const second = await acquireDaemonController(directory)
  assert.match(await first.handle("status"), /Daemon: stopped/)
  await first.release()
  assert.match(await second.handle("status"), /Daemon: stopped/)
  await second.release()
}))

test("malformed preferences refuse autostart instead of guessing", async () => fixture(async (directory) => {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const base = path.join(directory, ".opencode/opencode-loop")
  await mkdir(base, { recursive: true })
  await writeFile(path.join(base, "daemon-control.json"), '{"autoStart":"true"}')
  const daemon = createDaemonController({ directory, check: async () => ({ checked: 0, alerts: [] }) })
  await daemon.init()
  assert.match(daemon.getStatus(), /Invalid daemon preferences/)
  assert.match(daemon.getStatus(), /Daemon: stopped/)
  await daemon.dispose()
}))
