import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import OpenCodeLoopPlugin from "../src/index.js"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-smoke-"))
const sessionID = "ses_smoke_goal"
const attempts = { log: 0, prompt: 0, status: 0, toast: 0 }
const prompts = []
const liveStatuses = new Map([[sessionID, "idle"]])
let hooks

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

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
    list: async (args) => {
      assert.equal(args?.query?.directory, directory)
      return { data: [{ id: sessionID, directory, projectID: "project", title: "smoke", version: "test", time: { created: Date.now(), updated: Date.now() } }] }
    },
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
      return { data: Object.fromEntries([...liveStatuses].filter(([, type]) => type !== "idle").map(([id, type]) => [id, { type }])) }
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
  assert.equal(output.parts.length, 1, "a locally handled slash command must keep a valid acknowledgement prompt")
  assert.equal(output.parts[0].text, "original command body")
  assert.equal(output.noReply, true, "handled commands should request noReply for compatible OpenCode hosts")

  await hooks["command.execute.before"]({ command: "loop-now", sessionID, arguments: "goal" }, { parts: [] })
  assert.equal(
    await waitFor(() => prompts.some((prompt) => prompt.includes(path.resolve(directory)))),
    true,
    "goal prompt must include the working directory",
  )
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

  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  await hooks["command.execute.before"]({ command: "loop-clear", sessionID, arguments: "" }, { parts: [] })

  const promptCountBeforeAutoGoal = prompts.length
  await hooks["command.execute.before"]({
    command: "loop-goal",
    sessionID,
    arguments: "--no-now --check \"node -e process.exitCode=0\" --complete-when-checks-pass make the configured checks pass",
  }, { parts: [] })
  await hooks["command.execute.before"]({ command: "loop-now", sessionID, arguments: "goal" }, { parts: [] })
  assert.equal(
    await waitFor(() => prompts.length === promptCountBeforeAutoGoal + 1),
    true,
    "a Goal Mode check-gated run must start when forced",
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  let autoCompletedState
  for (let attempt = 0; attempt < 400; attempt++) {
    autoCompletedState = JSON.parse(await fs.readFile(stateFile, "utf8"))
    if (autoCompletedState.jobs[0]?.goalStatus === "completed") break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(autoCompletedState.jobs[0].goalStatus, "completed", "--complete-when-checks-pass must complete the goal after successful configured checks")
  assert.equal(autoCompletedState.jobs[0].paused, true)
  assert.equal(autoCompletedState.jobs[0].enabled, false)
  assert.ok(autoCompletedState.jobs[0].lastGoalChecks?.every((item) => item.code === 0), "auto-completed Goal Mode must persist passing check evidence")

  await hooks["command.execute.before"]({ command: "loop-clear", sessionID, arguments: "" }, { parts: [] })

  const promptCountBeforeBackgroundTool = prompts.length
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "call_background" }, { args: {} })
  await hooks["command.execute.before"]({
    command: "loop",
    sessionID,
    arguments: "0s --max-runs 1 continue after the background task",
  }, { parts: [] })
  await new Promise((resolve) => setTimeout(resolve, 1_400))
  assert.equal(prompts.length, promptCountBeforeBackgroundTool, "an active tool call must keep the loop busy even when session.status says idle")

  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "call_background", args: {} }, { title: "done", output: "", metadata: {} })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  assert.equal(
    await waitFor(() => prompts.length === promptCountBeforeBackgroundTool + 1, 5_000),
    true,
    "the due loop must resume after the active tool finishes and the session becomes idle",
  )

  await hooks["command.execute.before"]({ command: "loop-clear", sessionID, arguments: "" }, { parts: [] })

  const childSessionID = "ses_background_child"
  liveStatuses.set(childSessionID, "busy")
  await hooks.event({ event: { type: "session.created", properties: { info: { id: childSessionID, parentID: sessionID } } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: childSessionID, status: { type: "busy" } } } })
  const promptCountBeforeBackgroundChild = prompts.length
  await hooks["command.execute.before"]({
    command: "loop",
    sessionID,
    arguments: "0s --max-runs 1 continue after the background subtask",
  }, { parts: [] })
  await new Promise((resolve) => setTimeout(resolve, 2_700))
  assert.equal(prompts.length, promptCountBeforeBackgroundChild, "a running background child session must keep its parent loop busy")

  liveStatuses.set(childSessionID, "idle")
  await hooks.event({ event: { type: "session.status", properties: { sessionID: childSessionID, status: { type: "idle" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  assert.equal(
    await waitFor(() => prompts.length === promptCountBeforeBackgroundChild + 1, 5_000),
    true,
    "the parent loop must resume after its background child becomes idle",
  )

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
