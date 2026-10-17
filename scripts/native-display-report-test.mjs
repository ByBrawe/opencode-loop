import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/source/opencode2/native-plugin.js"
import { withoutLoopDisplayReports } from "../src/source/opencode2/display-report.js"
import { readState } from "../src/source/core/state.js"

async function fixture({ canWait = true, missingHook } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-native-report-"))
  const sessionID = "ses_loop_report"
  const commands = new Map(), hooks = new Map(), prompts = [], waits = []
  const ctx = {
    location: { directory }, app: { version: "2.0.30" },
    session: {
      get: async ({ sessionID: id }) => ({ id, location: { directory } }),
      prompt: async input => { prompts.push(input); return { id: "msg_report" } },
      hook: async (name, callback) => {
        if (name === missingHook) throw Error("unsupported hook")
        const group = hooks.get(name) || []
        group.push(callback)
        hooks.set(name, group)
      },
      ...(canWait ? { wait: async ({ sessionID: id }) => { waits.push(id) } } : {}),
    },
    command: { transform: async callback => callback({ add(command) {
      assert.ok(!commands.has(command.name))
      commands.set(command.name, command.execute)
    } }) },
    event: { subscribe: () => (async function*() {})() },
  }
  let dispose
  try { dispose = await plugin.setup(ctx) }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  return {
    directory, sessionID, commands, hooks, prompts, waits,
    execute: (name, text = "") => commands.get(name)({ sessionID, prompt: { text } }),
    async dispose() { await dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) },
  }
}

test("native Loop read-only reports use the V2 model-free display path", async () => {
  const h = await fixture()
  try {
    for (const name of ["loop-help", "loop-doctor", "loop-status", "loop-export", "loop-logs", "loop-init"]) {
      await h.execute(name)
      const report = h.prompts.at(-1)
      assert.equal(report.resume, false, name)
      assert.equal(report.delivery, "steer", name)
      assert.equal(report.metadata?.opencode_loop_v2, true, name)
      assert.equal(report.metadata?.opencode_loop_display_only, true, name)
      assert.match(report.text, /^\[OpenCode Loop display-only report\]\n/)
      assert.match(report.text, /\n\[End OpenCode Loop display-only report\]$/)
    }
    assert.equal(h.waits.length, 6)
    assert.deepEqual((await readState(h.directory, h.sessionID)).jobs, [])
    assert.match(await readFile(path.join(h.directory, "progress.md"), "utf8"), /^# Progress/)
  } finally { await h.dispose() }
})

test("only marked Loop reports are removed from context, compaction, generate and title", async () => {
  const h = await fixture()
  try {
    await h.execute("loop-help")
    const report = h.prompts[0].text
    const ordinary = { role: "user", content: [{ type: "text", text: "Continue real work" }] }
    const own = { role: "user", metadata: { opencode_loop_display_only: true }, content: [{ type: "text", text: report }] }
    const copy = { role: "user", content: [{ type: "text", text: "Before\n" + report + "\nAfter" }] }
    const goal = { role: "user", metadata: { opencode_goal_v2_autonomous: true }, content: [{ type: "text", text: "Goal admission must survive" }] }
    const assistant = { role: "assistant", content: [{ type: "text", text: "Existing answer" }] }
    const untouched = [ordinary, goal]
    assert.strictEqual(withoutLoopDisplayReports(untouched), untouched)
    for (const name of ["context", "compaction", "generate", "title"]) {
      const event = { messages: [ordinary, own, copy, goal, assistant], result: "keep-title" }
      await h.hooks.get(name)[0](event)
      assert.equal(event.messages.length, 4, name)
      assert.equal(event.messages[0], ordinary)
      assert.equal(event.messages[1].content[0].text, "Before\n\nAfter")
      assert.equal(event.messages[2], goal)
      assert.equal(event.messages[3], assistant)
      assert.equal(event.result, "keep-title")
    }
    const onlyReport = { messages: [own], result: "bad title" }
    await h.hooks.get("title")[0](onlyReport)
    assert.deepEqual(onlyReport.messages, [])
    assert.equal(onlyReport.result, "")
  } finally { await h.dispose() }
})

test("old hosts and incomplete hook surfaces retain the legacy queued report", async () => {
  for (const options of [{ canWait: false }, { missingHook: "generate" }]) {
    const h = await fixture(options)
    try {
      await h.execute("loop-help")
      const report = h.prompts[0]
      assert.equal(report.resume, false)
      assert.equal(report.delivery, "queue")
      assert.equal(report.metadata?.opencode_loop_display_only, undefined)
      assert.doesNotMatch(report.text, /OpenCode Loop display-only report/)
      assert.deepEqual(h.waits, [])
    } finally { await h.dispose() }
  }
})
