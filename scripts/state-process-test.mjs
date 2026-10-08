import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readState, writeState, removeState, stateDir } from "../src/source/core/state.js"

const filename = fileURLToPath(import.meta.url)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function exists(file) { try { await stat(file); return true } catch (error) { if (error?.code === "ENOENT") return false; throw error } }
async function until(fn, duration = 15_000) {
  const started = Date.now()
  while (Date.now() - started < duration) {
    if (await fn()) return
    await pause(20)
  }
  throw new Error("state worker sync timeout")
}

if (process.argv[2] === "--worker") {
  const [, , , root, sessionID, marker, gate] = process.argv
  const snapshot = await readState(root, sessionID)
  await writeFile(`${gate}.${marker}.ready`, "ready")
  await until(() => exists(gate))
  if (marker === "delete") await removeState(root, sessionID)
  else {
    snapshot.jobs[0][marker] = Number(marker.slice(1))
    await writeState(root, sessionID, snapshot)
  }
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-process-lock-"))
  const sessionID = "multi-process"
  const lockFile = path.join(stateDir(root), `${sessionID}.json.lock`)
  try {
    for (let round = 0; round < 6; round++) {
      const initial = await readState(root, sessionID)
      initial.jobs = [{ id: "shared", round }]
      await writeState(root, sessionID, initial)
      const gate = path.join(root, `round-${round}.go`)
      const workers = []
      for (let n = 0; n < 4; n++) {
        const marker = `f${n}`
        const child = spawn(process.execPath, [filename, "--worker", root, sessionID, marker, gate], { stdio: ["ignore", "ignore", "pipe"] })
        let stderr = ""
        child.stderr.on("data", (part) => { stderr += part.toString() })
        const closed = new Promise((resolve, reject) => {
          child.once("error", reject)
          child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`worker ${marker} exited ${code}: ${stderr}`)))
        })
        workers.push({ marker, closed })
      }
      await until(async () => (await Promise.all(workers.map((w) => exists(`${gate}.${w.marker}.ready`)))).every(Boolean))
      await writeFile(gate, "go")
      await Promise.all(workers.map((w) => w.closed))
      const saved = (await readState(root, sessionID)).jobs[0]
      assert.equal(saved.round, round)
      for (let n = 0; n < 4; n++) assert.equal(saved[`f${n}`], n, "each independent writer must survive")
      assert.equal(await exists(lockFile), false, "all writers must release the lock")
    }

    // A stale writer must not resurrect a job removed by another process.
    // Race both operation orders: the lock serializes remove and write, while
    // baseline-aware merge must preserve the deletion if write runs second.
    for (let round = 0; round < 8; round++) {
      const seed = await readState(root, sessionID)
      seed.jobs = [{ id: "shared", round: `delete-${round}` }]
      await writeState(root, sessionID, seed)
      const gate = path.join(root, `delete-${round}.go`)
      const workers = []
      for (const marker of ["delete", "f0"]) {
        const child = spawn(process.execPath, [filename, "--worker", root, sessionID, marker, gate], {
          stdio: ["ignore", "ignore", "pipe"],
        })
        let stderr = ""
        child.stderr.on("data", (part) => { stderr += part.toString() })
        workers.push({
          marker,
          closed: new Promise((resolve, reject) => {
            child.once("error", reject)
            child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`worker ${marker} exited ${code}: ${stderr}`)))
          }),
        })
      }
      await until(async () => (await Promise.all(workers.map((w) =>
        exists(`${gate}.${w.marker}.ready`)))).every(Boolean))
      await writeFile(gate, "go")
      await Promise.all(workers.map((w) => w.closed))
      assert.deepEqual((await readState(root, sessionID)).jobs, [],
        "remove-vs-stale-writer must not resurrect deleted work")
      assert.equal(await exists(lockFile), false, "both processes must release lock after deletion race")
    }
    const fresh = await readState(root, sessionID)
    fresh.jobs = [{ id: "shared", round: "reseeded" }]
    await writeState(root, sessionID, fresh)

    // A malformed lock is never stolen or silently removed.
    const corrupt = await readState(root, sessionID)
    await writeFile(lockFile, "corrupt owner")
    corrupt.jobs[0].newField = "must-not-commit"
    await assert.rejects(writeState(root, sessionID, corrupt), /state lock invalid_owner/)
    assert.equal((await readState(root, sessionID)).jobs[0].newField, undefined)
    await rm(lockFile)

    // A dead owner is reclaimed with an election lock, never a blind unlink.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" })
    assert.equal(dead.status, 0)
    assert.ok(dead.pid > 0)
    const token = randomUUID()
    const candidate = path.join(stateDir(root), `.loop-lock-${dead.pid}-${token}.json`)
    const owner = { schemaVersion: 1, pid: dead.pid, token, acquiredAt: Date.now(), candidateName: path.basename(candidate) }
    await writeFile(candidate, JSON.stringify(owner))
    await link(candidate, lockFile)
    // Simulate a crash while an earlier process was cleaning the dead owner.
    // A stray, dead `.lock.cleanup` must not permanently block recovery.
    const cleanupToken = randomUUID()
    const cleanupCandidate = path.join(stateDir(root), `.loop-lock-${dead.pid}-${cleanupToken}.json`)
    const cleanupOwner = {
      schemaVersion: 1, pid: dead.pid, token: cleanupToken,
      acquiredAt: Date.now(), candidateName: path.basename(cleanupCandidate),
    }
    await writeFile(cleanupCandidate, JSON.stringify(cleanupOwner))
    await link(cleanupCandidate, `${lockFile}.cleanup`)
    const revived = await readState(root, sessionID)
    revived.jobs[0].recovered = true
    await writeState(root, sessionID, revived)
    assert.equal((await readState(root, sessionID)).jobs[0].recovered, true)
    assert.equal(await exists(lockFile), false)
    assert.equal(await exists(candidate), false)
    assert.equal(await exists(cleanupCandidate), false, "orphaned election candidate must be cleaned")
    assert.equal(await exists(`${lockFile}.cleanup`), false, "orphaned cleanup lock must be removed")

    // A malformed election must fail closed and not delete another owner's files.
    const badToken = randomUUID()
    const badCandidate = path.join(stateDir(root), `.loop-lock-${dead.pid}-${badToken}.json`)
    const badOwner = {
      schemaVersion: 1, pid: dead.pid, token: badToken,
      acquiredAt: Date.now(), candidateName: path.basename(badCandidate),
    }
    await writeFile(badCandidate, JSON.stringify(badOwner))
    await link(badCandidate, lockFile)
    await writeFile(`${lockFile}.cleanup`, "not valid owner metadata")
    const blocked = await readState(root, sessionID)
    blocked.jobs[0].mustNotWrite = true
    await assert.rejects(writeState(root, sessionID, blocked), /state lock invalid_owner/)
    assert.equal((await readState(root, sessionID)).jobs[0].mustNotWrite, undefined)
    assert.equal(await exists(lockFile), true, "invalid election must not erase the dead canonical owner")
    await rm(lockFile)
    await rm(`${lockFile}.cleanup`)
    await rm(badCandidate)

    // A path supplied by another tool cannot symlink Loop state outside the project.
    const other = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-escape-"))
    const unsafe = path.join(root, "unsafe")
    await mkdir(unsafe)
    try {
      const linkTarget = path.join(unsafe, ".opencode")
      try {
        const { symlink } = await import("node:fs/promises")
        await symlink(other, linkTarget, process.platform === "win32" ? "junction" : "dir")
        await assert.rejects(readState(unsafe, sessionID), /state lock unsafe_path/)
        await assert.rejects(writeState(unsafe, sessionID, { version: 4, jobs: [] }), /state lock unsafe_path/)
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error
      }
    } finally { await rm(other, { recursive: true, force: true }) }
    console.log("Loop multi-process write/delete races, stale-owner recovery, and unsafe-path regressions passed")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}
