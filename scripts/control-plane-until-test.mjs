import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createJobWorkspaceRuntime } from "../src/source/runtime/job-workspace.js"

const marker = "NATIVE_COMPLETION_FROM_WORK_ONLY_8fd8"
const runtime = createJobWorkspaceRuntime({ toast: async () => {} })
async function fixture(file, expected) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-control-until-"))
  try {
    const target = path.join(directory, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ objective: marker }))
    assert.equal(await runtime.untilReached(directory, { until: marker }), expected)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

for (const file of [
  ".opencode/goals/live.json",
  ".opencode/goals/archive/history.json",
  ".opencode/goal-sequences/session.json",
  ".opencode/goal-locks/lease.json",
  ".opencode/goal-handoff-locks/lease.json",
  ".opencode/opencode-loop/session.json",
]) {
  test("Goal/Loop control state cannot satisfy --until: " + file, () => fixture(file, false))
}
for (const file of [
  "progress.md",
  ".opencode/opencode-loop/until.txt",
  ".opencode/commands/project-task.md",
  ".opencode/goals-project-notes/finished.md",
]) {
  test("explicit or project-owned completion marker stays supported: " + file, () => fixture(file, true))
}
