import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeState } from "../src/source/core/state.js"
import {
  createOpenCode2StatusTool,
  formatOpenCode2LoopStatus,
  registerOpenCode2StatusTool,
  summarizeOpenCode2LoopState,
} from "../src/source/opencode2/status-tool.js"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-status-"))
const sessionID = "ses_v2_status"

try {
  await writeState(directory, sessionID, {
    version: 4,
    jobs: [
      {
        id: "job_1",
        name: "build",
        kind: "prompt",
        paused: false,
        runCount: 2,
        intervalMs: 5_000,
        nextRunAt: 123_456,
      },
    ],
  })

  const sessionGets = []
  const ctx = {
    session: {
      get: async (input) => {
        sessionGets.push(input)
        return { data: { id: sessionID, location: { directory } } }
      },
    },
  }

  const tool = createOpenCode2StatusTool(ctx)
  assert.equal(tool.name, "opencode_loop_status")
  assert.equal(tool.input.type, "object")
  assert.equal(tool.input.additionalProperties, false)

  const result = await tool.execute({}, { sessionID })
  assert.deepEqual(sessionGets, [{ sessionID }])
  assert.match(result.content, /OpenCode Loop: 1 loop job\(s\)\./)
  assert.match(result.content, /build: active, runs=2, intervalMs=5000/)
  assert.equal(result.metadata.sessionID, sessionID)
  assert.equal(result.metadata.directory, directory)
  assert.equal(result.metadata.jobCount, 1)

  const summary = summarizeOpenCode2LoopState({ version: 4, jobs: [] })
  assert.equal(summary.jobCount, 0)
  assert.equal(formatOpenCode2LoopStatus(summary), "OpenCode Loop: no loop jobs for this session.")

  let registeredTool
  let disposed = 0
  const registration = await registerOpenCode2StatusTool({
    session: ctx.session,
    tool: {
      transform: async (transform) => {
        transform({ add: (candidate) => { registeredTool = candidate } })
        return { dispose: async () => { disposed += 1 } }
      },
    },
  })
  assert.equal(registeredTool?.name, "opencode_loop_status")
  await registration.dispose()
  assert.equal(disposed, 1)

  assert.equal(await registerOpenCode2StatusTool({ session: ctx.session }), undefined)

  await assert.rejects(
    () => createOpenCode2StatusTool({ session: {} }).execute({}, { sessionID }),
    /session\.get capability is unavailable/,
  )
  await assert.rejects(
    () => createOpenCode2StatusTool(ctx).execute({}, {}),
    /requires a session ID/,
  )
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}

console.log("OpenCode 2 status tool contract passed")
