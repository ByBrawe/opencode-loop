import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import plugin from "../src/source/opencode2/experimental.js"
import { writeState } from "../src/source/core/state.js"

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-status-"))
const sessionID = "ses_v2_status"
let listener
let transforms = 0
const prompts = []

const ctx = {
  command: {
    transform: async () => {
      transforms += 1
      return { dispose: async () => {} }
    },
  },
  event: {
    subscribe: async (callback) => {
      listener = callback
      return { dispose: async () => {} }
    },
  },
  session: {
    prompt: async (request) => {
      prompts.push(structuredClone(request))
      return { accepted: true }
    },
  },
}

try {
  await plugin.setup(ctx)
  assert.equal(transforms, 1)
  assert.equal(typeof listener, "function")

  await listener({
    directory,
    payload: {
      type: "command.executed",
      properties: { name: "loop-status", sessionID, arguments: "", messageID: "msg_status_empty" },
    },
  })

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionID, sessionID)
  assert.equal(prompts[0].noReply, true)
  assert.deepEqual(prompts[0].parts, [{ type: "text", text: "OpenCode loop status:\nNo active loop jobs." }])

  await writeState(directory, sessionID, {
    version: 4,
    jobs: [{
      id: "job_status",
      name: "status-test",
      action: "continue safely",
      kind: "prompt",
      intervalMs: 60_000,
      lastRunAt: Date.now(),
      runCount: 2,
      failureCount: 1,
      noOverlap: true,
    }],
  })

  await listener({
    directory,
    payload: {
      type: "command.executed",
      properties: { name: "loop-status", sessionID, arguments: "", messageID: "msg_status_job" },
    },
  })

  assert.equal(prompts.length, 2)
  const statusText = prompts[1].parts[0].text
  assert.match(statusText, /^OpenCode loop status:/)
  assert.match(statusText, /job_status \(status-test\)/)
  assert.match(statusText, /continue safely/)
  assert.match(statusText, /runs=2/)
  assert.match(statusText, /failures=1/)
  assert.match(statusText, /active,no-overlap/)

  await listener({
    directory,
    payload: {
      type: "command.executed",
      properties: { name: "loop-help", sessionID, arguments: "", messageID: "msg_help" },
    },
  })
  assert.equal(prompts.length, 2, "the V2 status slice must ignore commands it does not own yet")

  console.log("OpenCode 2 loop status contract passed")
} finally {
  await rm(directory, { recursive: true, force: true })
}
