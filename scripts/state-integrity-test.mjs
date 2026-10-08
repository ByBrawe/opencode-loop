import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readState, writeState, stateDir } from "../src/source/core/state.js"

// An unreadable existing session is not a new/empty session. The old fallback
// silently returned zero jobs and let the next ordinary write replace all work.
const root = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-state-integrity-"))
const sessionID = "persisted-session"
const file = path.join(stateDir(root), `${sessionID}.json`)
try {
  const missing = await readState(root, sessionID)
  assert.deepEqual(missing.jobs, [], "only ENOENT is a new empty session")

  const started = await readState(root, sessionID)
  started.jobs = [{ id: "keep-this-job", enabled: true, runCount: 7 }]
  await writeState(root, sessionID, started)
  const oldSnapshot = await readState(root, sessionID)
  assert.equal(oldSnapshot.jobs.length, 1)
  assert.equal(oldSnapshot.jobs[0].runCount, 7)

  const corrupt = '{"version":4,"jobs":['
  await mkdir(stateDir(root), { recursive: true })
  await writeFile(file, corrupt)
  await assert.rejects(readState(root, sessionID), /could not be read; refusing to replace persisted jobs/)
  assert.equal(await readFile(file, "utf8"), corrupt, "read must not reset the original state")
  const backups = (await readdir(stateDir(root))).filter((name) => name.startsWith(`${sessionID}.json.corrupt-`))
  assert.ok(backups.length >= 1, "corrupted bytes should be backed up for investigation")
  assert.equal(await readFile(path.join(stateDir(root), backups[0]), "utf8"), corrupt)

  oldSnapshot.jobs[0].runCount = 8
  await assert.rejects(
    writeState(root, sessionID, oldSnapshot),
    /could not be read; refusing to replace persisted jobs/,
    "a stale snapshot must not replace a corrupt persisted session",
  )
  assert.equal(await readFile(file, "utf8"), corrupt)
  console.log("Loop corrupt-state fail-closed and no-lost-jobs regression passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
