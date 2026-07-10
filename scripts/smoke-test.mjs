import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import OpenCodeLoopPlugin from "../src/index.js"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-smoke-"))
const sessionID = "ses_smoke_goal"
const attempts = { log: 0, prompt: 0, status: 0, toast: 0 }
const prompts = []
let hooks

function legacyBody(name) {
  return async (args) => {
    attempts[name]++
    assert.ok(args?.body, `${name} must use the plugin SDK body shape first`)
    return { data: true }
  }
}

const client = {
  app: {
    log: legacyBody("log"),
  },
  tui: {
    executeCommand: async (args) => {
      assert.ok(args?.body?.command)
      return { data: true }
    },
    showToast: legacyBody("toast"),
  },
  session: {
    abort: async (args) => {
      assert.equal(args?.path?.id, sessionID)
      return { data: true }
    },
    command: async (args) => {
      assert.equal(args?.path?.id, sessionID)
      assert.ok(args?.body?.command)
      return { data: true }
    },
    prompt: async (args) => {
      attempts.prompt++
      assert.equal(args?.path?.id, sessionID, "session.prompt must use path.id first")
      assert.ok(Array.isArray(args?.body?.parts))
      prompts.push(args.body.parts.map((part) => part.text || "").join("\n"))
      return { data: true }
    },
    shell: async (args) => {
      assert.equal(args?.path?.id, sessionID)
      assert.ok(args?.body?.command)
      return { data: true }
    },
    status: async (args) => {
      attempts.status++
      assert.equal(args?.query?.directory, directory, "session.status must use query.directory first")
      return { data: { [sessionID]: { type: "idle" } } }
    },
    summarize: async (args) => {
      assert.equal(args?.path?.id, sessionID)
      return { data: true }
    },
  },
}

try {
  hooks = await OpenCodeLoopPlugin({ client, directory })
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "opencode_loop_goal_blocked",
    "opencode_loop_goal_complete",
    "opencode_loop_goal_progress",
  ])

  const output = { parts: [{ type: "text", text: "original command body" }] }
  await hooks["command.execute.before"]({
    command: "loop-goal",
    sessionID,
    arguments: "Create proof.txt and verify it --max-turns 3",
  }, output)
  assert.match(output.parts[0].text, /handled by the local plugin/i)

  await hooks["command.execute.before"]({ command: "loop-now", sessionID, arguments: "goal" }, { parts: [] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(prompts.some((prompt) => prompt.includes(path.resolve(directory))), "goal prompt must include the working directory")
  assert.ok(prompts.some((prompt) => prompt.includes("never turn a relative path into a root path")))

  const stateFile = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  const activeState = JSON.parse(await fs.readFile(stateFile, "utf8"))
  assert.equal(activeState.jobs[0].activeRecoveryMs, 180_000)

  const rejected = await hooks.tool.opencode_loop_goal_complete.execute({ summary: "Done", evidence: "done" }, { directory, sessionID })
  assert.equal(rejected.title, "Goal completion rejected")

  const completed = await hooks.tool.opencode_loop_goal_complete.execute({
    summary: "Created and verified proof.txt",
    evidence: "Created proof.txt and read the file back; its exact content matched the requested value.",
  }, { directory, sessionID })
  assert.equal(completed.title, "Goal completed")

  const completedState = JSON.parse(await fs.readFile(stateFile, "utf8"))
  assert.equal(completedState.jobs[0].goalStatus, "completed")
  assert.equal(completedState.jobs[0].paused, true)
  assert.equal(completedState.jobs[0].enabled, false)

  await hooks["command.execute.before"]({ command: "loop-clear", sessionID, arguments: "" }, { parts: [] })
  assert.equal(attempts.log, 1)
  assert.ok(attempts.prompt >= 1)
  assert.ok(attempts.status >= 1)
  assert.ok(attempts.toast >= 1)
  console.log("OpenCode Loop smoke test passed")
} finally {
  await hooks?.dispose?.()
  await fs.rm(directory, { recursive: true, force: true })
}
