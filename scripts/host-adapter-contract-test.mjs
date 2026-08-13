import assert from "node:assert/strict"
import {
  activeRunCompletionFromMessages,
  compactSession,
  compactTuiCommandName,
  executeTuiCommand,
  orderedSessionMessages,
  readRecentSessionMessages,
  resolveCompactionModel,
} from "../src/source/opencode/host.js"
import {
  deleteSessionExecutionContext,
  getSessionExecutionContext,
} from "../src/source/opencode/session-context.js"

function messagesClient(messages) {
  return { session: { messages: async () => ({ data: structuredClone(messages) }) } }
}

assert.equal(compactTuiCommandName("/compact"), "session_compact")
assert.equal(compactTuiCommandName("summarize"), "session_compact")
assert.equal(compactTuiCommandName("other"), undefined)

{
  const calls = []
  const client = { tui: { executeCommand: async (args) => {
    calls.push(args)
    if (args?.body) return { error: { message: "body shape rejected" } }
    return { data: args.command }
  } } }
  assert.equal(await executeTuiCommand(client, "session_compact"), "session_compact")
  assert.deepEqual(calls, [
    { body: { command: "session_compact" } },
    { command: "session_compact" },
  ])
}

{
  const calls = []
  const client = { session: { messages: async (args) => {
    calls.push(args)
    if (args?.path?.id) throw new Error("id shape rejected")
    return { data: [{ info: { id: "m1", role: "assistant" } }] }
  } } }
  const result = await readRecentSessionMessages(client, "ses_messages", "/tmp/project", 7)
  assert.equal(result[0].info.id, "m1")
  assert.equal(calls.length, 2)
}

{
  const ordered = orderedSessionMessages([
    { info: { id: "b", time: { created: 20 } } },
    { info: { id: "a", time: { created: 10 } } },
    { info: { id: "c", time: { created: 20 } } },
  ])
  assert.deepEqual(ordered.map((item) => item.info.id), ["a", "b", "c"])

  assert.equal(await activeRunCompletionFromMessages("/tmp", {}, "missing", { startedAt: 100 }), "unknown")
  assert.equal(await activeRunCompletionFromMessages(
    "/tmp", messagesClient([{ info: { role: "assistant", time: { created: 50, completed: 90 } } }]), "old", { startedAt: 100 },
  ), "incomplete")
  assert.equal(await activeRunCompletionFromMessages(
    "/tmp", messagesClient([{ info: { role: "assistant", time: { created: 110, completed: 120 } } }]), "done", { startedAt: 100 },
  ), "completed")
}

{
  const sessionID = "ses_message_model_contract"
  deleteSessionExecutionContext(sessionID)
  const client = messagesClient([
    { info: { role: "assistant", time: { created: 10 }, model: { providerID: "old", modelID: "old" } } },
    { info: { role: "assistant", time: { created: 20 }, model: { providerID: "provider", modelID: "model" } } },
  ])
  assert.deepEqual(await resolveCompactionModel("/tmp", client, sessionID), { providerID: "provider", modelID: "model" })
  assert.deepEqual(getSessionExecutionContext(sessionID)?.model, { providerID: "provider", modelID: "model" })
  deleteSessionExecutionContext(sessionID)
}

{
  const tuiCalls = []
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { executeCommand: async (args) => {
      const command = args?.body?.command || args?.command
      tuiCalls.push(command)
      if (command === "session.compact") return { error: { message: "unsupported" } }
      return { data: true }
    } },
  }
  assert.equal(await compactSession("/tmp", client, "ses_tui"), true)
  assert.ok(tuiCalls.includes("session.compact"))
  assert.ok(tuiCalls.includes("session_compact"))
}

{
  const summaries = []
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    session: { summarize: async (args) => { summaries.push(args); return { data: true } } },
  }
  assert.equal(await compactSession("/tmp", client, "ses_summary", "provider/model"), true)
  assert.deepEqual(summaries[0], {
    path: { id: "ses_summary" },
    body: { providerID: "provider", modelID: "model", auto: false },
  })
}

console.log("OpenCode host adapter contract test passed")
