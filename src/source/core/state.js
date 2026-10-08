import { promises as fs } from "node:fs"
import { randomUUID as stateLockRandomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { safeID } from "./args.js"

const STATE_DIR = ".opencode/opencode-loop"
const STATE_BASELINE = Symbol("opencode-loop-state-baseline")
const stateWriteLocks = new Map()

export function stateDir(directory) { return path.join(directory, STATE_DIR) }
function statePath(directory, sessionID) { return path.join(stateDir(directory), `${safeID(sessionID)}.json`) }
export async function ensureDir(directory) { await fs.mkdir(directory, { recursive: true }) }
export async function pathExists(filePath) { try { await fs.access(filePath); return true } catch { return false } }

const STATE_PROCESS_LOCK_TIMEOUT_MS = 5_000
const STATE_PROCESS_LOCK_POLL_MS = 20

function stateLockError(kind, detail) {
  const error = new Error(`OpenCode Loop state lock ${kind}: ${detail}`)
  error.code = "OPENCODE_LOOP_STATE_LOCK"
  return error
}

async function assertStatePathSafe(directory, target) {
  const root = path.resolve(directory)
  const relative = path.relative(root, path.resolve(target))
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw stateLockError("unsafe_path", `path escapes project: ${target}`)
  }
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = await fs.lstat(current) }
    catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink()) throw stateLockError("unsafe_path", `symbolic link or junction: ${current}`)
  }
}

function stateProcessLockOwner() {
  const token = stateLockRandomUUID()
  return {
    schemaVersion: 1, pid: process.pid, token, acquiredAt: Date.now(),
    candidateName: `.loop-lock-${process.pid}-${token}.json`,
  }
}

function stateProcessLockOwnerValid(owner) {
  return owner?.schemaVersion === 1
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.token === "string" && /^[0-9a-f-]{36}$/i.test(owner.token)
    && Number.isFinite(owner.acquiredAt) && owner.acquiredAt > 0
    && owner.candidateName === `.loop-lock-${owner.pid}-${owner.token}.json`
    && path.basename(owner.candidateName) === owner.candidateName
}

async function readStateProcessOwner(file) {
  let raw
  for (let attempt = 0; ; attempt++) {
    try { raw = await fs.readFile(file, "utf8"); break }
    catch (error) {
      if (error?.code === "ENOENT") return null
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) throw error
      await delay(10 * (attempt + 1))
    }
  }
  let owner
  try { owner = JSON.parse(raw) }
  catch { throw stateLockError("invalid_owner", `corrupt lock metadata at ${file}`) }
  if (!stateProcessLockOwnerValid(owner)) throw stateLockError("invalid_owner", `invalid lock metadata at ${file}`)
  return owner
}

function stateProcessAlive(pid) {
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true }
  catch (error) { return error?.code !== "ESRCH" }
}

async function removeStateProcessFile(file) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(file, { force: true }); return }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) throw error
      await delay(10 * (attempt + 1))
    }
  }
}

async function claimStateProcessLock(candidate, canonical) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.link(candidate, canonical); return true }
    catch (error) {
      if (error?.code === "EEXIST") return false
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) throw error
      await delay(10 * (attempt + 1))
    }
  }
}

async function createStateLockCandidate(directory, owner) {
  const candidate = path.join(stateDir(directory), owner.candidateName)
  await assertStatePathSafe(directory, candidate)
  await fs.writeFile(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 })
  return candidate
}

// A cleanup-election hard link prevents two processes from deleting a newer
// lock while reclaiming a dead owner. Never reclaim a live or corrupt owner.
async function recoverDeadStateProcessLock(directory, canonical, stale, depth = 0) {
  const cleanupFile = `${canonical}.cleanup`
  const cleanupOwner = stateProcessLockOwner()
  const cleanupCandidate = await createStateLockCandidate(directory, cleanupOwner)
  let elected = false
  try {
    await assertStatePathSafe(directory, cleanupFile)
    elected = await claimStateProcessLock(cleanupCandidate, cleanupFile)
    if (!elected) {
      // The previous cleanup winner may itself have crashed. Reclaim that
      // dead election through another hard-linked, owner-verified election.
      // Never blindly unlink the election path: a live winner may replace it.
      const existing = await readStateProcessOwner(cleanupFile)
      if (existing && !stateProcessAlive(existing.pid)) {
        if (depth >= 6) throw stateLockError("recovery_depth", `too many orphaned cleanup elections for ${canonical}`)
        await recoverDeadStateProcessLock(directory, cleanupFile, existing, depth + 1)
      }
      return false
    }
    const current = await readStateProcessOwner(canonical)
    if (!current || current.token !== stale.token || current.pid !== stale.pid || stateProcessAlive(current.pid)) return false
    await assertStatePathSafe(directory, canonical)
    await removeStateProcessFile(canonical)
    const staleCandidate = path.join(stateDir(directory), current.candidateName)
    await assertStatePathSafe(directory, staleCandidate)
    await removeStateProcessFile(staleCandidate).catch(() => {})
    return true
  } finally {
    if (elected) {
      const current = await readStateProcessOwner(cleanupFile).catch(() => null)
      if (current?.token === cleanupOwner.token) await removeStateProcessFile(cleanupFile)
    }
    await removeStateProcessFile(cleanupCandidate).catch(() => {})
  }
}

async function acquireStateProcessLock(directory, sessionID) {
  const targetDirectory = stateDir(directory)
  await assertStatePathSafe(directory, targetDirectory)
  await ensureDir(targetDirectory)
  await assertStatePathSafe(directory, targetDirectory)
  const target = statePath(directory, sessionID)
  const canonical = `${target}.lock`
  await assertStatePathSafe(directory, target)
  await assertStatePathSafe(directory, canonical)
  const owner = stateProcessLockOwner()
  const candidate = await createStateLockCandidate(directory, owner)
  const started = Date.now()
  let acquired = false
  try {
    while (true) {
      await assertStatePathSafe(directory, canonical)
      if (await claimStateProcessLock(candidate, canonical)) {
        acquired = true
        break
      }
      const current = await readStateProcessOwner(canonical)
      if (current && !stateProcessAlive(current.pid)) await recoverDeadStateProcessLock(directory, canonical, current)
      if (Date.now() - started >= STATE_PROCESS_LOCK_TIMEOUT_MS) {
        throw stateLockError("timeout", `session ${sessionID} remained locked for ${STATE_PROCESS_LOCK_TIMEOUT_MS}ms`)
      }
      await delay(STATE_PROCESS_LOCK_POLL_MS)
    }
    return async () => {
      const current = await readStateProcessOwner(canonical)
      if (current?.token !== owner.token || current.pid !== owner.pid) {
        throw stateLockError("lost", `session ${sessionID} lock ownership changed`)
      }
      await assertStatePathSafe(directory, canonical)
      await removeStateProcessFile(canonical)
      await removeStateProcessFile(candidate)
    }
  } catch (error) {
    if (acquired && (await readStateProcessOwner(canonical).catch(() => null))?.token === owner.token) {
      await removeStateProcessFile(canonical).catch(() => {})
    }
    await removeStateProcessFile(candidate).catch(() => {})
    throw error
  }
}

function stateLockKey(directory, sessionID) {
  return `${path.resolve(directory)}:${safeID(sessionID)}`
}

async function withStateWriteLock(directory, sessionID, fn) {
  const key = stateLockKey(directory, sessionID)
  const previous = stateWriteLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const next = previous.catch(() => {}).then(() => current)
  stateWriteLocks.set(key, next)
  await previous.catch(() => {})
  let unlock
  try {
    unlock = await acquireStateProcessLock(directory, sessionID)
    return await fn()
  } finally {
    try { if (unlock) await unlock() }
    finally {
      release()
      if (stateWriteLocks.get(key) === next) stateWriteLocks.delete(key)
    }
  }
}

async function readStateFile(directory, sessionID) {
  const target = statePath(directory, sessionID)
  await assertStatePathSafe(directory, target)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"))
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
        throw new SyntaxError("invalid Loop state schema: jobs must be an array")
      }
      return { version: 4, jobs: parsed.jobs }
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 4, jobs: [] }
      const transient = error instanceof SyntaxError || isRetriableStateWriteError(error)
      if (!transient || attempt === attempts - 1) break
      await delay(25 * (attempt + 1))
    }
  }
  try {
    await ensureDir(stateDir(directory))
    await fs.copyFile(target, `${target}.corrupt-${Date.now()}`)
  } catch {}
  throw new Error(`OpenCode Loop state at ${target} could not be read; refusing to replace persisted jobs.`)
}

export async function readState(directory, sessionID) {
  const state = await readStateFile(directory, sessionID)
  Object.defineProperty(state, STATE_BASELINE, {
    value: structuredClone(state.jobs || []),
    enumerable: false,
    configurable: false,
    writable: true,
  })
  return state
}

function isRetriableStateWriteError(error) {
  const code = error?.code
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST" || code === "EAGAIN"
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Windows often fails POSIX-style "write temp next to target, then rename over it":
// existing destinations can return EPERM/EEXIST while antivirus, IDE indexers, or
// OpenCode's own snapshotter briefly hold the state file. Temp files next to the
// target also show up in project git snapshots as *.tmp pathspec noise.
//
// Write the payload outside the project first, then replace the target with
// rename when possible and a copy/unlink fallback with short retries.
async function writeFileAtomically(target, contents, options = {}) {
  const encoding = options.encoding || "utf8"
  const attempts = Math.max(1, Number(options.attempts) || 5)
  const temp = path.join(
    os.tmpdir(),
    `opencode-loop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
  await fs.writeFile(temp, contents, encoding)
  try {
    let lastError
    // Prefer an atomic rename and retry transient Windows destination locks
    // before falling back to a non-atomic copy/overwrite.
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fs.rename(temp, target)
        return
      } catch (error) {
        lastError = error
        if (error?.code === "EXDEV") break
        if (!isRetriableStateWriteError(error)) throw error
        if (attempt < attempts - 1) await delay(25 * (attempt + 1))
      }
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fs.copyFile(temp, target)
        return
      } catch (error) {
        lastError = error
        if (!isRetriableStateWriteError(error)) throw error
        if (attempt < attempts - 1) await delay(25 * (attempt + 1))
      }
    }

    try {
      await fs.writeFile(target, contents, encoding)
      return
    } catch (error) {
      if (lastError && !error.cause) error.cause = lastError
      throw error
    }
  } finally {
    try { await fs.rm(temp, { force: true }) } catch {}
  }
}

function stateValuesEqual(left, right) {
  if (Object.is(left, right)) return true
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function mergeStateJob(baseJob, intendedJob, currentJob) {
  const merged = structuredClone(currentJob || {})
  const keys = new Set([
    ...Object.keys(baseJob || {}),
    ...Object.keys(intendedJob || {}),
  ])
  for (const key of keys) {
    const baseHas = Object.prototype.hasOwnProperty.call(baseJob || {}, key)
    const intendedHas = Object.prototype.hasOwnProperty.call(intendedJob || {}, key)
    const currentHas = Object.prototype.hasOwnProperty.call(currentJob || {}, key)
    const intendedChanged = baseHas !== intendedHas || !stateValuesEqual(baseJob?.[key], intendedJob?.[key])
    if (!intendedChanged) continue
    const currentChanged = baseHas !== currentHas || !stateValuesEqual(baseJob?.[key], currentJob?.[key])
    const sameResult = intendedHas === currentHas && stateValuesEqual(intendedJob?.[key], currentJob?.[key])
    // First committed writer wins a true same-field conflict. A stale snapshot
    // can still apply changes to unrelated fields without erasing newer state.
    if (currentChanged && !sameResult) continue
    if (intendedHas) merged[key] = structuredClone(intendedJob[key])
    else delete merged[key]
  }
  return merged
}

function mergeStateJobs(baseJobs, intendedJobs, currentJobs) {
  const byID = (jobs) => new Map((jobs || []).filter((job) => job?.id).map((job) => [job.id, job]))
  const base = byID(baseJobs)
  const intended = byID(intendedJobs)
  const current = byID(currentJobs)
  const merged = []

  for (const currentJob of currentJobs || []) {
    const id = currentJob?.id
    if (!id || !base.has(id)) {
      merged.push(structuredClone(currentJob))
      continue
    }
    const baseJob = base.get(id)
    const intendedJob = intended.get(id)
    if (!intendedJob) {
      // A deletion based on an old snapshot must not erase a job that changed
      // after that snapshot was read.
      if (!stateValuesEqual(baseJob, currentJob)) merged.push(structuredClone(currentJob))
      continue
    }
    merged.push(mergeStateJob(baseJob, intendedJob, currentJob))
  }

  for (const intendedJob of intendedJobs || []) {
    const id = intendedJob?.id
    if (!id || base.has(id) || current.has(id)) continue
    merged.push(structuredClone(intendedJob))
  }
  return merged
}

export async function writeState(directory, sessionID, state) {
  await withStateWriteLock(directory, sessionID, async () => {
    const target = statePath(directory, sessionID)
    await assertStatePathSafe(directory, target)
    const current = await readStateFile(directory, sessionID)
    const baseline = state?.[STATE_BASELINE]
    let jobs = structuredClone(state.jobs || [])
    if (Array.isArray(baseline)) {
      jobs = mergeStateJobs(baseline, jobs, current.jobs || [])
    }
    const payload = JSON.stringify({ version: 4, jobs }, null, 2)
    await writeFileAtomically(target, payload)
    // A failed disk write must not advance the in-memory snapshot baseline.
    state.jobs = structuredClone(jobs)
    if (Array.isArray(baseline)) state[STATE_BASELINE] = structuredClone(jobs)
  })
}

export async function removeState(directory, sessionID) {
  await withStateWriteLock(directory, sessionID, async () => {
    const target = statePath(directory, sessionID)
    await assertStatePathSafe(directory, target)
    try { await fs.unlink(target) }
    catch (error) { if (error?.code !== "ENOENT") throw error }
  })
}

