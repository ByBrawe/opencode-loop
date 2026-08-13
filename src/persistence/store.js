import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { safeID } from "../core/ids.js"

const STATE_DIR = ".opencode/opencode-loop"
const STATE_BASELINE = Symbol("opencode-loop-state-baseline")
const stateWriteLocks = new Map()

export function stateDir(directory) {
  return path.join(directory, STATE_DIR)
}

export function statePath(directory, sessionID) {
  return path.join(stateDir(directory), `${safeID(sessionID)}.json`)
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true })
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
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
  try {
    return await fn()
  } finally {
    release()
    if (stateWriteLocks.get(key) === next) stateWriteLocks.delete(key)
  }
}

async function readStateFile(directory, sessionID) {
  const target = statePath(directory, sessionID)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"))
      return { version: 4, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] }
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
  return { version: 4, jobs: [] }
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
    try {
      await fs.rm(temp, { force: true })
    } catch {}
  }
}

function stateValuesEqual(left, right) {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
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
    await ensureDir(stateDir(directory))
    const target = statePath(directory, sessionID)
    const baseline = state?.[STATE_BASELINE]
    let jobs = structuredClone(state.jobs || [])
    if (Array.isArray(baseline)) {
      const current = await readStateFile(directory, sessionID)
      jobs = mergeStateJobs(baseline, jobs, current.jobs || [])
      state.jobs = structuredClone(jobs)
      state[STATE_BASELINE] = structuredClone(jobs)
    }
    const payload = JSON.stringify({ version: 4, jobs }, null, 2)
    await writeFileAtomically(target, payload)
  })
}

export async function removeState(directory, sessionID) {
  await withStateWriteLock(directory, sessionID, async () => {
    try {
      await fs.unlink(statePath(directory, sessionID))
    } catch {}
  })
}
