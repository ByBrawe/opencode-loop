import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// The descendant stays in the command's process group but closes every pipe.
// Killing the shell therefore emits close before this descendant has stopped.
export async function processTreeFixture(mode = "timeout") {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-native-process-tree-"))
  await writeFile(path.join(directory, "descendant.cjs"), `
    const fs = require("node:fs")
    process.on("SIGTERM", () => {})
    let n = 0
    const beat = () => fs.writeFileSync("heartbeat.txt", String(++n))
    beat()
    fs.writeFileSync("descendant.pid", String(process.pid))
    setInterval(beat, 20)
    setTimeout(() => process.exit(0), 20000)
  `)
  await writeFile(path.join(directory, "parent.cjs"), `
    const fs = require("node:fs")
    const { spawn } = require("node:child_process")
    fs.writeFileSync("parent.pid", String(process.pid))
    spawn(process.execPath, ["descendant.cjs"], { stdio: "ignore" })
    const ready = setInterval(() => {
      if (!fs.existsSync("descendant.pid")) return
      clearInterval(ready)
      fs.writeFileSync("ready.txt", "ready")
      if (${JSON.stringify(mode)} === "overflow") process.stdout.write("A".repeat(20000))
    }, 10)
    setInterval(() => {}, 1000)
  `)
  return {
    directory,
    command: `"${process.execPath}" parent.cjs`,
    async ready() {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try { await readFile(path.join(directory, "ready.txt")); return }
        catch (error) { if (error.code !== "ENOENT") throw error }
        await delay(20)
      }
      throw new Error("descendant fixture never became ready")
    },
    async assertStopped() {
      await readFile(path.join(directory, "ready.txt"))
      // Let any in-flight filesystem write finish, then detect continued work.
      await delay(60)
      const before = await readFile(path.join(directory, "heartbeat.txt"), "utf8")
      await delay(180)
      assert.equal(await readFile(path.join(directory, "heartbeat.txt"), "utf8"), before,
        "terminal result must not precede stopping a pipe-detached descendant")
    },
    async cleanup() {
      for (const file of ["descendant.pid", "parent.pid"]) {
        try { process.kill(Number(await readFile(path.join(directory, file), "utf8")), "SIGKILL") } catch {}
      }
      await delay(80)
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

export async function bounded(promise, milliseconds = 12000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("native process cleanup never settled")), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
