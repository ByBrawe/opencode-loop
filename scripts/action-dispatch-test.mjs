import assert from "node:assert/strict"
import { createActionDispatcher } from "../src/source/runtime/action-dispatch.js"

assert.throws(() => createActionDispatcher({}), /buildPrompt/)
assert.throws(() => createActionDispatcher({ buildPrompt: async () => "prompt" }), /compactionRuntime\.start/)

const sdkCalls = []
const fireCalls = []
const compactions = []
const guards = []
const logs = []
const toasts = []
const prompts = []

const dispatcher = createActionDispatcher({
  buildPrompt: async (_directory, job) => {
    prompts.push(job.id)
    return `BUILT:${job.action}`
  },
  compactionRuntime: {
    start: async (...args) => {
      compactions.push(args)
      return true
    },
  },
  appendLoopLog: async (...args) => { logs.push(args) },
  sdkCall: async (...args) => { sdkCalls.push(args); return {} },
  normalizedModelRef: (value) => value ? { providerID: "provider", modelID: String(value) } : undefined,
  fireSdk: (...args) => { fireCalls.push(args); return Promise.resolve({ ok: true }) },
  compactTuiCommandName: (command) => command === "compact" ? "compact" : undefined,
  toast: async (...args) => { toasts.push(args) },
  guardLoopOwnedUserMessage: (sessionID) => { guards.push(sessionID) },
  dangerousShell: (command) => /danger/.test(command),
})

const client = {
  session: {
    command: async () => ({ data: {} }),
    shell: async () => ({ data: {} }),
    prompt: async () => ({ data: {} }),
  },
}

const blockedShell = await dispatcher.fireAction("/repo", client, "shell-session", {
  id: "shell-job",
  action: "! danger --all",
  safe: true,
})
assert.deepEqual(blockedShell, { startsAssistantTurn: false, pause: true, reason: "safe_shell_blocked" })
assert.equal(fireCalls.length, 0)
assert.equal(logs.at(-1)[1], "blocked")
assert.match(toasts.at(-1)[1], /Blocked dangerous shell command/)

const commandResult = await dispatcher.fireAction("/repo", client, "command-session", {
  id: "command-job",
  action: "/review --quick",
  agent: "build",
  model: "model-a",
})
assert.deepEqual(commandResult, { startsAssistantTurn: true })
assert.equal(sdkCalls.length, 1)
assert.equal(guards.at(-1), "command-session")
assert.deepEqual(sdkCalls.at(-1)[1].body, {
  command: "review",
  arguments: "--quick",
  agent: "build",
  model: "provider/model-a",
})

const compactResult = await dispatcher.fireAction("/repo", client, "compact-session", {
  id: "compact-job",
  action: "/compact",
  agent: "build",
  model: "model-b",
})
assert.deepEqual(compactResult, { startsAssistantTurn: true, pause: false, reason: "compact_failed", compaction: true })
assert.equal(compactions.length, 1)
assert.equal(compactions.at(-1)[2], "compact-session")
assert.equal(compactions.at(-1)[3], "compact-job")
assert.deepEqual(compactions.at(-1)[4], { providerID: "provider", modelID: "model-b" })

const shellResult = await dispatcher.fireAction("/repo", client, "safe-shell-session", {
  id: "safe-shell-job",
  action: "! echo ok",
  safe: true,
  model: "model-c",
})
assert.equal(shellResult.startsAssistantTurn, true)
assert.ok(shellResult.dispatch instanceof Promise)
assert.equal(fireCalls.at(-1)[1], "session.shell")
assert.deepEqual(fireCalls.at(-1)[3].body, {
  command: "echo ok",
  agent: "build",
  model: { providerID: "provider", modelID: "model-c" },
})

const promptResult = await dispatcher.fireAction("/repo", client, "prompt-session", {
  id: "prompt-job",
  action: "keep working",
  agent: "build",
})
assert.equal(promptResult.startsAssistantTurn, true)
assert.ok(promptResult.dispatch instanceof Promise)
assert.equal(prompts.at(-1), "prompt-job")
assert.equal(fireCalls.at(-1)[1], "session.prompt")
assert.match(fireCalls.at(-1)[3].body.parts[0].text, /AUTONOMOUS OPENCODE LOOP ITERATION/)
assert.match(fireCalls.at(-1)[3].body.parts[0].text, /BUILT:keep working/)

const goalPromptResult = await dispatcher.fireAction("/repo", client, "goal-session", {
  id: "goal-job",
  kind: "goal",
  action: "finish objective",
})
assert.equal(goalPromptResult.startsAssistantTurn, true)
assert.match(fireCalls.at(-1)[3].body.parts[0].text, /EXPERIMENTAL GOAL MODE CONTINUATION/)

console.log("action dispatch runtime tests passed")
