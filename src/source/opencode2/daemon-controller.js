import path from "node:path"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { checkGoalPulse } from "../../../scripts/pulse-check.mjs"

const controllers = new Map()
const DEFAULTS = Object.freeze({ autoStart: false, pulse: true })
const CHECK_EVERY_MS = 60_000
const parse = (s) => String(s || "").trim().toLowerCase().split(/\s+/).filter(Boolean)

export function createDaemonController({ directory, check = checkGoalPulse, everyMs = CHECK_EVERY_MS, onAlert = console.warn } = {}) {
  if (!path.isAbsolute(directory || "")) throw new Error("Daemon requires an absolute project directory")
  const root = path.join(directory, ".opencode", "opencode-loop")
  const file = path.join(root, "daemon-control.json")
  const lock = path.join(root, "daemon-control.lock")
  const nonce = randomUUID()
  let config = { ...DEFAULTS }
  let running = false
  let disposed = false
  let timer, activeCheck, lastCheck, lastError
  let chain = Promise.resolve()
  const queue = (fn) => {
    const result = chain.then(fn)
    chain = result.catch(() => {})
    return result
  }

  async function persist() {
    await fs.mkdir(root, { recursive: true })
    const temporary = `${file}.${process.pid}.${nonce}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...config }, null, 2) + "\n", "utf8")
    try { await fs.rename(temporary, file) } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  async function load() {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      if (value?.schemaVersion !== 1 || typeof value.autoStart !== "boolean" || typeof value.pulse !== "boolean") {
        throw new Error("Invalid daemon preferences; refusing autostart")
      }
      config = { autoStart: value.autoStart, pulse: value.pulse }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  async function lockOwner() {
    try { return JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) } catch { return undefined }
  }
  async function takeLock() {
    await fs.mkdir(root, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.mkdir(lock)
        await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, nonce }) + "\n")
        return
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        const owner = await lockOwner()
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Daemon lock owner unknown; manual review required")
        let alive = true
        try { process.kill(owner.pid, 0) } catch (probe) { if (probe.code === "ESRCH") alive = false }
        if (alive) throw new Error("Daemon already owned by another OpenCode server")
        await fs.rm(lock, { recursive: true, force: true })
      }
    }
    throw new Error("Daemon lock contention")
  }
  async function releaseLock() {
    const owner = await lockOwner()
    if (owner?.pid === process.pid && owner.nonce === nonce) await fs.rm(lock, { recursive: true, force: true })
  }
  async function tick() {
    if (!running || !config.pulse || activeCheck) return
    activeCheck = check(directory, { staleAfterMs: 30 * 60_000 })
    try {
      const result = await activeCheck
      lastCheck = { at: Date.now(), checked: result.checked, alerts: result.alerts.length }
      lastError = undefined
      for (const alert of result.alerts) onAlert(alert.message)
    } catch (error) {
      lastError = String(error?.message || error)
      clearInterval(timer)
      timer = undefined
      running = false
      await releaseLock()
    } finally { activeCheck = undefined }
  }
  async function start() {
    if (running) return
    if (disposed) throw new Error("Daemon controller disposed")
    await takeLock()
    running = true
    timer = setInterval(() => { void tick() }, everyMs)
    timer.unref?.()
    await tick()
  }
  async function stop() {
    clearInterval(timer)
    timer = undefined
    running = false
    if (activeCheck) await activeCheck.catch(() => {})
    await releaseLock()
  }
  const status = () => `Daemon: ${running ? "running" : "stopped"} (embedded in OpenCode server)\nAutostart: ${config.autoStart ? "on" : "off"}\nGoal pulse: ${config.pulse ? "on" : "off"}\nInterval: ${everyMs}ms\nChecked: ${lastCheck?.checked ?? "not yet"}; alerts: ${lastCheck?.alerts ?? 0}\n${lastError ? `Error: ${lastError}\n` : ""}No autonomous inference is started by this controller.`

  return {
    async init() { return queue(async () => {
      try { await load(); if (config.autoStart) await start() }
      catch (error) { lastError = String(error?.message || error); await stop() }
    }) },
    async handle(command) {
      return queue(async () => {
        const args = parse(command)
        const key = args.join(" ")
        if (key === "" || key === "status") return status()
        if (key === "start") await start()
        else if (key === "stop") { config.autoStart = false; await persist(); await stop() }
        else if (key === "restart") { await stop(); await start() }
        else if (key === "auto on" || key === "auto off") {
          const enable = key.endsWith("on")
          if (enable) await start()
          config.autoStart = enable
          await persist()
        } else if (key === "pulse on" || key === "pulse off") {
          config.pulse = key.endsWith("on")
          await persist()
          if (running && config.pulse) await tick()
        } else throw new Error("Usage: /daemon [start|stop|restart|status|auto on|auto off|pulse on|pulse off]")
        return status()
      })
    },
    async dispose() { return queue(async () => { await stop(); disposed = true }) },
    getStatus: status,
  }
}

export async function acquireDaemonController(directory) {
  const key = path.resolve(directory).toLowerCase()
  let entry = controllers.get(key)
  if (!entry) {
    const controller = createDaemonController({ directory })
    entry = { controller, refs: 0, ready: controller.init() }
    controllers.set(key, entry)
  }
  entry.refs++
  try { await entry.ready } catch (error) {
    if (--entry.refs === 0) controllers.delete(key)
    throw error
  }
  let released = false
  return {
    handle: (input) => entry.controller.handle(input),
    async release() {
      if (released) return
      released = true
      if (--entry.refs === 0) {
        controllers.delete(key)
        await entry.controller.dispose()
      }
    },
  }
}
