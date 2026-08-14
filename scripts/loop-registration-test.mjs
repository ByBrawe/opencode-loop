import assert from "node:assert/strict"
import { createLoopRegistration, normalizeActionForCompare, sameLoopDefinition } from "../src/source/opencode/loop-registration.js"

function harness(initialStates = {}, overrides = {}) {
  const states = new Map(Object.entries(initialStates).map(([key, value]) => [key, structuredClone(value)]))
  const writes = []
  const snapshots = []
  const due = []
  const idle = []
  const toasts = []
  const messages = []
  const logs = []
  const contexts = new Map(Object.entries(overrides.contexts || {}))

  const { addLoop } = createLoopRegistration({
    snapshotPaths: async (directory, files) => {
      snapshots.push({ directory, files: [...files] })
      return Object.fromEntries(files.map((file) => [file, `snapshot:${file}`]))
    },
    scheduleDueWork: async (...args) => { due.push(args) },
    scheduleIdleWork: (...args) => { idle.push(args) },
    toast: async (...args) => { toasts.push(args) },
    say: async (...args) => { messages.push(args) },
    readState: async (_directory, sessionID) => structuredClone(states.get(sessionID) || { jobs: [] }),
    writeState: async (_directory, sessionID, state) => {
      const copy = structuredClone(state)
      states.set(sessionID, copy)
      writes.push({ sessionID, state: copy })
    },
    appendLoopLog: async (...args) => { logs.push(args) },
    normalizedModelRef: (value) => value ? `normalized:${value}` : undefined,
    getSessionExecutionContext: (sessionID) => contexts.get(sessionID),
    defaultActiveGuardMs: overrides.defaultActiveGuardMs ?? 45_000,
  })

  return { addLoop, states, writes, snapshots, due, idle, toasts, messages, logs }
}

assert.throws(() => createLoopRegistration({}), /snapshotPaths/)
assert.throws(() => createLoopRegistration({ snapshotPaths() {} }), /scheduleDueWork/)
assert.equal(normalizeActionForCompare("  hello\n   world  "), "hello world")
assert.equal(sameLoopDefinition(
  { name: "dev", intervalMs: 1000, action: "hello   world", kind: "prompt", promptFile: "" },
  { name: "dev", intervalMs: 1000, action: " hello world ", kind: "prompt", promptFile: undefined },
), true)
assert.equal(sameLoopDefinition({ name: "a" }, { name: "b" }), false)
assert.equal(sameLoopDefinition(null, {}), false)

{
  const sessionID = "invalid"
  const h = harness()
  const client = {}
  await h.addLoop("/work", client, sessionID, "not-a-duration and no defaults")
  assert.equal(h.writes.length, 0)
  assert.equal(h.due.length, 0)
  assert.equal(h.idle.length, 0)
  assert.equal(h.logs.length, 0)
  assert.equal(h.toasts.length, 1)
  assert.equal(h.toasts[0][0], client)
  assert.equal(h.toasts[0][2], "warning")
  assert.match(h.toasts[0][1], /Usage: \/loop/)
}

{
  const sessionID = "basic"
  const client = { id: "client" }
  const h = harness({}, { contexts: { [sessionID]: { agent: "builder", model: "ctx-model" } } })
  await h.addLoop("/work", client, sessionID, "0s do useful work")
  const job = h.states.get(sessionID).jobs[0]
  assert.equal(job.name, "default")
  assert.equal(job.action, "do useful work")
  assert.equal(job.agent, "builder")
  assert.equal(job.model, "ctx-model")
  assert.equal(job.activeRecoveryMs, 45_000)
  assert.equal(job.immediate, true)
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.due, [["/work", client, sessionID]])
  assert.deepEqual(h.idle, [["/work", client, sessionID]])
  assert.equal(h.toasts[0][2], "success")
  assert.match(h.toasts[0][1], /^Loop added:/)
  assert.equal(h.logs[0][1], "add")
}

{
  const sessionID = "replace"
  const h = harness({}, { contexts: { [sessionID]: { agent: "build" } } })
  await h.addLoop("/work", {}, sessionID, "0s first action")
  await h.addLoop("/work", {}, sessionID, "0s second action")
  const jobs = h.states.get(sessionID).jobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].name, "default")
  assert.equal(jobs[0].action, "second action")
  assert.match(h.toasts.at(-1)[1], /^Loop replaced:/)
  assert.equal(h.logs.at(-1)[1], "replace")
}

{
  const sessionID = "multi"
  const h = harness({ [sessionID]: { jobs: [{ id: "old", name: "default", intervalMs: 0, action: "old" }] } })
  await h.addLoop("/work", {}, sessionID, "0s --multi another action")
  const jobs = h.states.get(sessionID).jobs
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].id, "old")
  assert.equal(jobs[1].action, "another action")
  assert.equal(jobs[1].multi, true)
  assert.match(h.toasts.at(-1)[1], /^Loop added:/)
}

{
  const sessionID = "watch"
  const h = harness()
  await h.addLoop("/repo", {}, sessionID, '0s --watch "src" --watch package.json inspect changes')
  const job = h.states.get(sessionID).jobs[0]
  assert.deepEqual(job.watchPaths, ["src", "package.json"])
  assert.deepEqual(job.watchSnapshot, { src: "snapshot:src", "package.json": "snapshot:package.json" })
  assert.deepEqual(h.snapshots, [{ directory: "/repo", files: ["src", "package.json"] }])
}

{
  const sessionID = "goal"
  const h = harness()
  await h.addLoop("/work", {}, sessionID, "ship the feature", {
    intervalMs: 0,
    kind: "goal",
    name: "goal",
    immediate: true,
    safe: true,
    askNever: true,
    noOverlap: true,
    goalStatus: "active",
  })
  const job = h.states.get(sessionID).jobs[0]
  assert.equal(job.kind, "goal")
  assert.equal(job.goalStatus, "active")
  assert.equal(job.safe, true)
  assert.equal(job.askNever, true)
  assert.equal(job.noOverlap, true)
  assert.equal(job.agent, "build")
  assert.equal(job.activeRecoveryMs, 180_000)
}

{
  const sessionID = "long-interval"
  const h = harness()
  await h.addLoop("/work", {}, sessionID, "5m recurring work")
  assert.equal(h.states.get(sessionID).jobs[0].activeRecoveryMs, 90_000)
}

{
  const sessionID = "explicit-owner"
  const h = harness({}, { contexts: { [sessionID]: { agent: "context-agent", model: "context-model" } } })
  await h.addLoop("/work", {}, sessionID, "explicit work", { intervalMs: 0, agent: "special-agent", model: "model-x" })
  const job = h.states.get(sessionID).jobs[0]
  assert.equal(job.agent, "special-agent")
  assert.equal(job.model, "normalized:model-x")
}

{
  const sessionID = "testfix-action"
  const defaults = {
    intervalMs: 0,
    name: "testfix",
    safe: true,
    askNever: true,
    verifyCommand: "npm test",
    testfixPreset: true,
    action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test",
  }
  const h = harness()
  await h.addLoop("/work", {}, sessionID, "pnpm test", defaults)
  const job = h.states.get(sessionID).jobs[0]
  assert.equal(job.verifyCommand, "pnpm test")
  assert.equal(job.action, "Run the project tests. Fix failures. Re-run the tests. Test command hint: pnpm test")
}

{
  const sessionID = "testfix-verify"
  const defaults = {
    intervalMs: 0,
    name: "testfix",
    safe: true,
    askNever: true,
    verifyCommand: "npm test",
    testfixPreset: true,
    action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test",
  }
  const h = harness()
  await h.addLoop("/work", {}, sessionID, '--verify "pnpm test"', defaults)
  const job = h.states.get(sessionID).jobs[0]
  assert.equal(job.verifyCommand, "pnpm test")
  assert.equal(job.action, "Run the project tests. Fix failures. Re-run the tests. Test command hint: pnpm test")
}

{
  const sessionID = "dry-run"
  const client = {}
  const h = harness()
  await h.addLoop("/work", client, sessionID, "0s --dry-run inspect only")
  assert.equal(h.writes.length, 0)
  assert.equal(h.due.length, 0)
  assert.equal(h.idle.length, 0)
  assert.equal(h.logs.length, 0)
  assert.equal(h.toasts.length, 1)
  assert.equal(h.toasts[0][2], "info")
  assert.match(h.toasts[0][1], /^Loop dry run:/)
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0][2], /OpenCode loop dry run:/)
  assert.match(h.messages[0][2], /"action": "inspect only"/)
}

{
  const sessionID = "no-now"
  const h = harness()
  await h.addLoop("/work", {}, sessionID, "1m --no-now later")
  assert.equal(h.states.get(sessionID).jobs[0].immediate, false)
  assert.equal(h.idle.length, 0)
  assert.equal(h.due.length, 1)
}

console.log("loop registration tests passed")
