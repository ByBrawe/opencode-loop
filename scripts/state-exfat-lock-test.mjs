import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readState, writeState, stateDir } from "../src/source/core/state.js"

const source = fileURLToPath(import.meta.url)
const originalLink = fs.link
const linkError = (code) => Object.assign(new Error(`synthetic unsupported hard link: ${code}`), { code })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function exists(file) { try { await fs.access(file); return true } catch (error) { if (error?.code === "ENOENT") return false; throw error } }
async function until(fn) { for (let i = 0; i < 500; i++) { if (await fn()) return; await wait(20) } throw new Error("worker barrier timeout") }

if (process.argv[2] === "--worker") {
  fs.link = async () => { throw linkError("EISDIR") }
  try {
    const [, , , root, sessionID, label, gate] = process.argv
    const snapshot = await readState(root, sessionID)
    await fs.writeFile(`${gate}.${label}.ready`, "ready")
    await until(() => exists(gate))
    snapshot.jobs[0][label] = label
    await writeState(root, sessionID, snapshot)
  } finally { fs.link = originalLink }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-exfat-lock-"))
  const sessionID = "exfat-session"
  const canonical = path.join(stateDir(root), `${sessionID}.json.lock`)
  fs.link = async () => { throw linkError("EISDIR") }
  try {
    const original = await readState(root, sessionID)
    original.jobs = [{ id: "one", round: 1 }]
    await writeState(root, sessionID, original)

    // Workers each simulate an exFAT runtime: independent Node processes with
    // no usable hard-link support must still merge their distinct writes.
    const gate = path.join(root, "go")
    const workers = []
    for (let i = 0; i < 4; i++) {
      const label = `worker${i}`
      const child = spawn(process.execPath, [source, "--worker", root, sessionID, label, gate], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
      workers.push({
        label,
        done: new Promise((resolve, reject) => {
          child.once("error", reject)
          child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exFAT worker ${label} failed: ${stderr}`)))
        }),
      })
    }
    await until(async () => (await Promise.all(workers.map(w => exists(`${gate}.${w.label}.ready`)))).every(Boolean))
    await fs.writeFile(gate, "go")
    await Promise.all(workers.map(w => w.done))
    const saved = (await readState(root, sessionID)).jobs[0]
    for (const w of workers) assert.equal(saved[w.label], w.label)
    assert.equal(await exists(canonical), false)

    // Simulate an abandoned primary lock and an orphaned cleanup election,
    // both written without hard links. Neither may prevent dead-PID recovery.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"])
    assert.equal(dead.status, 0)
    const deadOwner = () => {
      const token = randomUUID()
      return { schemaVersion: 1, pid: dead.pid, token, acquiredAt: Date.now(),
        candidateName: `.loop-lock-${dead.pid}-${token}.json` }
    }
    for (const suffix of ["", ".cleanup"]) {
      const owner = deadOwner()
      await fs.writeFile(path.join(stateDir(root), owner.candidateName), JSON.stringify(owner))
      await fs.writeFile(`${canonical}${suffix}`, JSON.stringify(owner))
    }
    const revived = await readState(root, sessionID)
    revived.jobs[0].recovered = true
    await writeState(root, sessionID, revived)
    assert.equal((await readState(root, sessionID)).jobs[0].recovered, true)
    assert.equal(await exists(canonical), false)
    assert.equal(await exists(`${canonical}.cleanup`), false)

    await fs.writeFile(canonical, "invalid owner")
    const corrupt = await readState(root, sessionID)
    corrupt.jobs[0].forbidden = "never commit"
    await assert.rejects(writeState(root, sessionID, corrupt), /state lock invalid_owner/)
    assert.equal((await readState(root, sessionID)).jobs[0].forbidden, undefined)
    await fs.rm(canonical)

    // Unexpected failures must not be turned into 'contention' or ignored.
    fs.link = async () => { throw linkError("ENOSPC") }
    await assert.rejects(writeState(root, sessionID, await readState(root, sessionID)), { code: "ENOSPC" })
    assert.equal(await exists(canonical), false)

    console.log("Loop exFAT-style exclusive lock, process merge, dead-owner election and corrupt-state protections passed")
  } finally {
    fs.link = originalLink
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}
