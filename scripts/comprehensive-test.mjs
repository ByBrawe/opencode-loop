import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import OpenCodeLoopPlugin from "../src/index.js"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let harnessNumber = 0

async function createHarness(options = {}) {
  harnessNumber++
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `opencode-loop-comprehensive-${harnessNumber}-`))
  const sessionID = `ses_comprehensive_${harnessNumber}`
  const records = {
    aborts: [],
    commands: [],
    logs: [],
    prompts: [],
    shells: [],
    summaries: [],
    messageReads: [],
    toasts: [],
    tuiCommands: [],
  }
  const statuses = new Map([[sessionID, "idle"]])
  const messageHistory = Array.isArray(options.messages) ? structuredClone(options.messages) : []

  const client = {
    app: {
      log: async (args) => {
        assert.ok(args?.body, "app.log must use the SDK body shape")
        records.logs.push(args.body)
        return { data: true }
      },
    },
    tui: {
      executeCommand: async (args) => {
        assert.ok(args?.body?.command, "tui.executeCommand must use the SDK body shape")
        records.tuiCommands.push(args.body.command)
        if (options.failCompact || options.failTuiCompact) throw new Error("simulated TUI compact failure")
        return { data: true }
      },
      showToast: async (args) => {
        assert.ok(args?.body?.message, "tui.showToast must use the SDK body shape")
        records.toasts.push(args.body)
        return { data: true }
      },
    },
    session: {
      list: async (args) => {
        assert.equal(args?.query?.directory, directory)
        return {
          data: [...statuses.keys()].map((id) => ({
            id,
            directory,
            projectID: "comprehensive",
            title: id,
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          })),
        }
      },
      get: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        return { data: { id: sessionID, agent: "build", model: { id: "test-model", providerID: "test-provider" } } }
      },
      abort: async (args) => {
        records.aborts.push(args?.path?.id)
        return { data: true }
      },
      command: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        records.commands.push(args.body)
        return { data: true }
      },
      prompt: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        const text = args.body.parts.map((part) => part.text || "").join("\n")
        records.prompts.push({ text, noReply: args.body.noReply === true, agent: args.body.agent, model: args.body.model })
        if (options.failPrompt) {
          await delay(options.promptFailureDelayMs ?? 20)
          throw new Error(options.promptFailureMessage || "simulated prompt dispatch failure")
        }
        return { data: true }
      },
      shell: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        records.shells.push(args.body)
        return { data: true }
      },
      status: async (args) => {
        assert.equal(args?.query?.directory, directory)
        // Current OpenCode omits idle sessions from this response.
        return {
          data: Object.fromEntries(
            [...statuses].filter(([, type]) => type !== "idle").map(([id, type]) => [id, { type }]),
          ),
        }
      },
      messages: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        assert.equal(args?.query?.directory, directory)
        records.messageReads.push(args)
        return { data: structuredClone(messageHistory) }
      },
      summarize: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        records.summaries.push(args?.body)
        if (options.failCompact) throw new Error("simulated summarize failure")
        return { data: true }
      },
    },
  }

  const hooks = await OpenCodeLoopPlugin({ client, directory })
  const stateFile = path.join(directory, ".opencode", "opencode-loop", `${sessionID}.json`)
  return {
    client,
    directory,
    hooks,
    records,
    sessionID,
    stateFile,
    statuses,
    messageHistory,
    async command(command, argumentsText = "", output = { parts: [] }) {
      await hooks["command.execute.before"]({ command, sessionID, arguments: argumentsText }, output)
      return output
    },
    async commandEvent(command, argumentsText = "", messageID = `msg_${Date.now()}_${Math.random()}`) {
      await hooks.event({ event: { type: "command.executed", properties: { name: command, sessionID, arguments: argumentsText, messageID } } })
    },
    async idle() {
      statuses.set(sessionID, "idle")
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    },
    async readState() {
      try {
        return JSON.parse(await fs.readFile(stateFile, "utf8"))
      } catch (error) {
        if (error?.code === "ENOENT") return { version: 4, jobs: [] }
        throw error
      }
    },
    reportTexts() {
      return records.prompts.filter((item) => item.noReply).map((item) => item.text)
    },
    actionTexts() {
      return records.prompts.filter((item) => !item.noReply).map((item) => item.text)
    },
    async cleanup() {
      await hooks.dispose?.()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function jsonReport(harness) {
  const report = [...harness.reportTexts()].reverse().find((text) => text.includes("```json"))
  assert.ok(report, "expected a JSON report")
  const match = report.match(/```json\s*([\s\S]*?)\s*```/)
  assert.ok(match, "expected a fenced JSON object")
  return JSON.parse(match[1])
}

async function testParserAndPresets() {
  const h = await createHarness()
  try {
    await h.command("loop", "3m --name matrix --no-now --allow-overlap --safe --quiet --ask-never --git-checkpoint --checkpoint-only --pause-on-verify-fail --multi --prompt --max-runs 4 --max-no-progress 2 --timeout 7s --max-runtime 2h --max-failures 3 --until \"2030-01-01T00:00:00Z\" --stop-file stop.txt --progress-file progress.md --prompt-file prompt.md --goal-file goal.md --evidence-file evidence.md --test \"npm test\" --verify \"npm run verify\" --preflight \"npm run preflight\" --postrun \"npm run postrun\" --notify \"node notify.js\" --branch feature/test --batch 2 --compact-every 5 --watch one.txt --watch two.txt --include-file context.md --acceptance \"criterion A\" --success \"criterion B\" --check \"npm test\" --dry-run perform matrix work")
    const job = jsonReport(h)
    assert.equal(job.intervalMs, 180_000)
    assert.equal(job.name, "matrix")
    assert.equal(job.action, "perform matrix work")
    assert.equal(job.kind, "prompt")
    assert.equal(job.immediate, false)
    assert.equal(job.noOverlap, false)
    assert.equal(job.safe, true)
    assert.equal(job.quiet, true)
    assert.equal(job.askNever, true)
    assert.equal(job.gitCheckpoint, true)
    assert.equal(job.checkpointOnly, true)
    assert.equal(job.pauseOnVerifyFail, true)
    assert.equal(job.multi, true)
    assert.equal(job.maxRuns, 4)
    assert.equal(job.maxNoProgress, 2)
    assert.equal(job.timeoutMs, 7_000)
    assert.equal(job.maxRuntimeMs, 7_200_000)
    assert.equal(job.maxFailures, 3)
    assert.equal(job.stopFile, "stop.txt")
    assert.equal(job.testCommand, "npm test")
    assert.equal(job.verifyCommand, "npm run verify")
    assert.equal(job.preflightCommand, "npm run preflight")
    assert.equal(job.postrunCommand, "npm run postrun")
    assert.equal(job.notifyCommand, "node notify.js")
    assert.equal(job.branch, "feature/test")
    assert.equal(job.batch, 2)
    assert.equal(job.compactEveryRuns, 5)
    assert.deepEqual(job.watchPaths, ["one.txt", "two.txt"])
    assert.deepEqual(job.includeFiles, ["context.md"])
    assert.deepEqual(job.goalAcceptance, ["criterion A", "criterion B"])
    assert.deepEqual(job.goalChecks, ["npm test"])

    await h.command("loop-compact", "0s --dry-run")
    let preset = jsonReport(h)
    assert.equal(preset.intervalMs, 0, "explicit 0s must not become the 200m default")
    assert.equal(preset.action, "/compact")
    assert.equal(preset.kind, "compact")

    await h.command("loop-compact", "--dry-run")
    preset = jsonReport(h)
    assert.equal(preset.intervalMs, 12_000_000)
    assert.equal(preset.action, "/compact", "a flag-only preset must keep its real default action")

    await h.command("loop-safe-dev", "--dry-run --safe")
    preset = jsonReport(h)
    assert.match(preset.action, /Develop the project/)
    assert.notEqual(preset.action, "--safe")

    await h.command("loop-testfix", "5m pnpm test --dry-run")
    preset = jsonReport(h)
    assert.equal(preset.intervalMs, 300_000)
    assert.equal(preset.verifyCommand, "pnpm test")
    assert.match(preset.action, /Test command hint: pnpm test/)

    await h.command("loop-testfix", "--verify \"npm run ci\" --dry-run")
    preset = jsonReport(h)
    assert.equal(preset.verifyCommand, "npm run ci")
    assert.match(preset.action, /Test command hint: npm run ci/)

    const toastCount = h.records.toasts.length
    await h.command("loop", "nonsense")
    await h.command("loop", "5m")
    assert.equal(h.records.toasts.length, toastCount + 2)
    assert.ok(h.records.toasts.slice(-2).every((item) => item.variant === "warning"))
  } finally {
    await h.cleanup()
  }
}

async function testLifecycleAndCommandDedupe() {
  const h = await createHarness()
  try {
    await h.command("loop", "10m --no-now --name same first action")
    await h.command("loop", "10m --no-now --name same replacement action")
    let state = await h.readState()
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].action, "replacement action")

    await h.command("loop", "10m --no-now --multi --name extra additional action")
    state = await h.readState()
    assert.equal(state.jobs.length, 2)

    await h.command("loop-pause", "same")
    state = await h.readState()
    assert.equal(state.jobs.find((item) => item.name === "same").paused, true)
    await h.command("loop-resume", "same")
    state = await h.readState()
    assert.equal(state.jobs.find((item) => item.name === "same").paused, false)

    const beforeReports = h.reportTexts().length
    const statusOutput = { parts: [{ type: "text", text: "OpenCode Loop status command handled locally. Reply exactly: OK." }] }
    await h.command("loop-status", "", statusOutput)
    assert.equal(statusOutput.parts.length, 1, "handled commands must keep a valid acknowledgement prompt")
    assert.match(statusOutput.parts[0].text, /Reply exactly: OK/)
    await h.commandEvent("loop-status", "", "msg_status_1")
    assert.equal(h.reportTexts().length, beforeReports + 1, "command.executed must not duplicate the before hook")
    await h.command("loop-status")
    await h.commandEvent("loop-status", "", "msg_status_2")
    assert.equal(h.reportTexts().length, beforeReports + 2, "an intentional repeated command must not be swallowed")
    await h.commandEvent("loop-status", "", "msg_event_only")
    await h.commandEvent("loop-status", "", "msg_event_only")
    assert.equal(h.reportTexts().length, beforeReports + 3, "the same event message must only be handled once")

    await h.command("loop-stop", "same")
    state = await h.readState()
    assert.deepEqual(state.jobs.map((item) => item.name), ["extra"])
    await h.command("loop-clear")
    state = await h.readState()
    assert.equal(state.jobs.length, 0)

    await h.command("loop-init")
    const progress = path.join(h.directory, "progress.md")
    assert.match(await fs.readFile(progress, "utf8"), /Active TODO/)
    await fs.writeFile(progress, "custom progress", "utf8")
    await h.command("loop-init")
    assert.equal(await fs.readFile(progress, "utf8"), "custom progress", "loop-init must not overwrite user progress")

    for (const command of ["loop-help", "loop-doctor", "loop-export", "loop-logs"]) await h.command(command)
    assert.ok(h.reportTexts().some((text) => text.includes("OpenCode Loop help")))
    assert.ok(h.reportTexts().some((text) => text.includes("OpenCode Loop doctor")))
    assert.ok(h.reportTexts().some((text) => text.includes("state export")))
  } finally {
    await h.cleanup()
  }
}

async function testWatchScheduling() {
  const h = await createHarness()
  try {
    const watched = path.join(h.directory, "watched.txt")
    await fs.writeFile(watched, "one", "utf8")
    await h.command("loop", "0s --watch watched.txt --max-runs 1 react to watched file")
    await h.idle()
    await delay(1_400)
    assert.equal(h.actionTexts().length, 0, "watch loop must not run until a watched file changes")

    await fs.writeFile(watched, "two and changed size", "utf8")
    await h.idle()
    await delay(1_500)
    assert.equal(h.actionTexts().length, 1, "watch loop must run after a watched file changes")
    assert.match(h.actionTexts()[0], /react to watched file/)
    const actionPrompt = h.records.prompts.find((item) => !item.noReply)
    assert.equal(actionPrompt.agent, "build", "scheduled work must restore the normal coding agent")
    assert.deepEqual(actionPrompt.model, { providerID: "test-provider", modelID: "test-model" })
  } finally {
    await h.cleanup()
  }
}

async function testActionRoutingAndSafety() {
  let h = await createHarness()
  try {
    await h.command("loop-shell", "0s --safe npm run format")
    await h.command("loop-now", "shell")
    await delay(25)
    assert.equal(h.records.shells.length, 1)
    assert.equal(h.records.shells[0].command, "npm run format", "safe mode must allow a harmless format script")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop-shell", "0s --safe Remove-Item -Recurse ./important")
    await h.command("loop-now", "shell")
    await delay(25)
    assert.equal(h.records.shells.length, 0)
    const state = await h.readState()
    assert.equal(state.jobs[0].paused, true, "a blocked synchronous action must pause instead of retrying forever")
    assert.equal(state.jobs[0].failureCount, 1)
    assert.equal(state.jobs[0].lastFailureReason, "safe_shell_blocked")

    await h.command("loop-clear")
    await h.command("loop-shell", "0s --safe rm -r -f ./important")
    await h.command("loop-now", "shell")
    const separateFlagsState = await h.readState()
    assert.equal(h.records.shells.length, 0)
    assert.equal(separateFlagsState.jobs[0].lastFailureReason, "safe_shell_blocked", "separate rm -r -f flags must be blocked")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await fs.writeFile(path.join(h.directory, "empty.md"), "fallback context", "utf8")
    await h.command("loop-command", "0s --prompt-file empty.md")
    await h.command("loop-now", "command")
    const state = await h.readState()
    assert.equal(state.jobs[0].paused, true)
    assert.equal(state.jobs[0].lastFailureReason, "empty_command")
  } finally {
    await h.cleanup()
  }

  h = await createHarness({ failCompact: true })
  try {
    await h.command("loop-compact", "0s")
    await h.command("loop-now", "compact")
    const state = await h.readState()
    assert.equal(state.jobs[0].paused, true)
    assert.equal(state.jobs[0].lastFailureReason, "compact_failed")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop-command", "0s /custom-command alpha beta")
    await h.command("loop-now", "command")
    await delay(25)
    assert.deepEqual(h.records.commands[0], {
      command: "custom-command",
      arguments: "alpha beta",
      agent: "build",
      model: "test-provider/test-model",
    })
  } finally {
    await h.cleanup()
  }
}

async function testNativeCompactionLifecycleAndFallback() {
  let h = await createHarness({ failTuiCompact: true })
  try {
    await h.command("loop-compact", "0s --no-now")
    await h.command("loop-now", "compact")
    assert.deepEqual(h.records.summaries[0], {
      providerID: "test-provider",
      modelID: "test-model",
      auto: false,
    }, "headless compact fallback must satisfy the current OpenCode summarize payload")
    assert.equal(typeof h.hooks["experimental.session.compacting"], "function")
    const compactOutput = { context: [], prompt: undefined }
    await h.hooks["experimental.session.compacting"]({ sessionID: h.sessionID }, compactOutput)
    assert.deepEqual(compactOutput, { context: [], prompt: undefined }, "loop lifecycle tracking must not rewrite OpenCode's compaction prompt")
    await h.hooks.event({ event: { type: "session.compacted", properties: { sessionID: h.sessionID } } })
    await delay(20)
    const state = await h.readState()
    assert.ok(state.jobs[0].lastFinishedAt > 0, "session.compacted must finalize an explicit compact job without waiting for stale status recovery")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name compact-chain --compact-every 1 --verify 'node -e process.exitCode=7' --pause-on-verify-fail continue after compaction")
    const seeded = await h.readState()
    seeded.jobs[0].runCount = 1
    seeded.jobs[0].lastRunAt = 0
    await fs.writeFile(h.stateFile, JSON.stringify(seeded, null, 2), "utf8")

    await h.command("loop-now", "compact-chain")
    assert.equal(h.records.tuiCommands.length, 1, "compact-every must start compaction")
    assert.equal(h.actionTexts().length, 0, "the scheduled action must not overlap a pending compaction")
    assert.equal((await h.readState()).jobs[0].runCount, 1, "compaction-only phase must not count as a normal loop run")

    await h.hooks["experimental.session.compacting"]({ sessionID: h.sessionID }, { context: [], prompt: undefined })
    await h.hooks.event({ event: { type: "session.compacted", properties: { sessionID: h.sessionID } } })
    await delay(20)
    assert.equal((await h.readState()).jobs[0].runCount, 1, "native compaction completion must only release the deferred action")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name compact-idle-fallback --compact-every 1 --verify 'node -e process.exitCode=7' --pause-on-verify-fail continue after fallback compaction")
    const seeded = await h.readState()
    seeded.jobs[0].runCount = 1
    seeded.jobs[0].lastRunAt = 0
    await fs.writeFile(h.stateFile, JSON.stringify(seeded, null, 2), "utf8")
    await h.command("loop-now", "compact-idle-fallback")
    assert.equal(h.actionTexts().length, 0)
    h.statuses.set(h.sessionID, "idle")
    await h.command("loop-now", "compact-idle-fallback")
    const fallbackState = await h.readState()
    assert.equal(fallbackState.jobs[0].failureCount || 0, 0, "idle-only compaction fallback must not run normal verify logic")
    assert.equal(fallbackState.jobs[0].paused, false, "idle-only compaction fallback must not pause the job through normal run finalization")
  } finally {
    await h.cleanup()
  }
}

async function testStaleBusyUsesCompletedAssistantTail() {
  let h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name stale-complete continue safely")
    await h.command("loop-now", "stale-complete")
    h.statuses.set(h.sessionID, "busy")
    const completedAt = Date.now() + 5
    h.messageHistory.splice(0, h.messageHistory.length,
      { info: { id: "usr_tail", sessionID: h.sessionID, role: "user", time: { created: completedAt - 2 } }, parts: [] },
      { info: { id: "asst_tail", sessionID: h.sessionID, role: "assistant", time: { created: completedAt - 1, completed: completedAt } }, parts: [] },
    )
    await h.command("loop-now", "stale-complete")
    const state = await h.readState()
    assert.ok(state.jobs[0].lastFinishedAt > 0, "a completed assistant tail must override a stale busy status")
    assert.ok(h.records.messageReads.length > 0, "busy recovery must cross-check message history")
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name stale-incomplete continue safely")
    const seeded = await h.readState()
    seeded.jobs[0].staleActiveRecoveryMs = 1
    await fs.writeFile(h.stateFile, JSON.stringify(seeded, null, 2), "utf8")
    await h.command("loop-now", "stale-incomplete")
    await delay(10)
    h.statuses.set(h.sessionID, "busy")
    const createdAt = Date.now()
    h.messageHistory.splice(0, h.messageHistory.length,
      { info: { id: "usr_running", sessionID: h.sessionID, role: "user", time: { created: createdAt - 1 } }, parts: [] },
      { info: { id: "asst_running", sessionID: h.sessionID, role: "assistant", time: { created: createdAt } }, parts: [] },
    )
    await h.command("loop-now", "stale-incomplete")
    const state = await h.readState()
    assert.equal(state.jobs[0].lastFinishedAt, undefined, "an unfinished assistant tail must never be force-finalized just because the active-run timeout elapsed")
    assert.equal(h.actionTexts().length, 1, "unfinished work must not be overlapped by a replacement prompt")
  } finally {
    await h.cleanup()
  }
}

async function testPromptDispatchFailureRecovery() {
  const h = await createHarness({ failPrompt: true, promptFailureDelayMs: 25 })
  try {
    await h.command("loop", "0s --no-now --name dispatch-failure --max-failures 1 recover from a rejected prompt dispatch")
    await h.command("loop-now", "dispatch-failure")

    let state
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await h.readState()
      if (state.jobs[0]?.lastFailureReason === "dispatch_failed") break
      await delay(25)
    }

    const job = state.jobs[0]
    assert.equal(job.failureCount, 1, "a rejected prompt dispatch must count as a scheduler failure")
    assert.equal(job.paused, true, "--max-failures must pause after a rejected prompt dispatch")
    assert.equal(job.lastFailureReason, "dispatch_failed")
    assert.match(job.lastDispatchFailure, /simulated prompt dispatch failure/)
    assert.ok(job.lastDispatchFailureAt > 0)
    assert.equal(h.actionTexts().length, 1, "dispatch recovery must never replay the prompt automatically")
    assert.ok(h.records.logs.some((entry) => entry.message === "session.prompt failed"), "the SDK rejection must remain observable")
  } finally {
    await h.cleanup()
  }
}

async function testStopsPreflightAndGoalLifecycle() {
  let h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --stop-file STOP continue")
    await fs.writeFile(path.join(h.directory, "STOP"), "stop", "utf8")
    await h.command("loop-now")
    assert.equal((await h.readState()).jobs.length, 0)
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --preflight \"node -e process.exitCode=7\" continue")
    await h.command("loop-now")
    const state = await h.readState()
    assert.equal(state.jobs[0].paused, true)
    assert.equal(state.jobs[0].failureCount, 1)
    assert.match(state.jobs[0].lastPreflightFailure, /exit=7/)
  } finally {
    await h.cleanup()
  }

  h = await createHarness()
  try {
    await h.command("loop-goal", "Ship the feature --acceptance \"tests pass\" --max-turns 3")
    await h.command("loop-now", "goal")
    await delay(25)
    assert.match(h.actionTexts()[0], /Goal objective:\nShip the feature/)
    const progress = await h.hooks.tool.opencode_loop_goal_progress.execute(
      { summary: "Implemented the first part", next: "Run verification" },
      { directory: h.directory, sessionID: h.sessionID },
    )
    assert.equal(progress.title, "Goal progress")
    let state = await h.readState()
    assert.equal(state.jobs[0].goalProgress.length, 1)
    const blocked = await h.hooks.tool.opencode_loop_goal_blocked.execute(
      { reason: "Credential is missing", needed: "Provide a test credential" },
      { directory: h.directory, sessionID: h.sessionID },
    )
    assert.equal(blocked.title, "Goal blocked")
    state = await h.readState()
    assert.equal(state.jobs[0].goalStatus, "blocked")
    assert.equal(state.jobs[0].paused, true)
    await h.command("loop-goal-resume")
    state = await h.readState()
    assert.equal(state.jobs[0].goalStatus, "active")
    assert.equal(state.jobs[0].paused, false)
    await h.command("loop-goal-clear")
    assert.equal((await h.readState()).jobs.length, 0)
  } finally {
    await h.cleanup()
  }
}

async function testLoopOwnedGoalMessageUpdatesDoNotSelfInterrupt() {
  const h = await createHarness()
  const originalDateNow = Date.now
  let fakeNow = originalDateNow()
  Date.now = () => fakeNow
  try {
    await h.command("loop-goal", "--no-now Keep working until the objective is complete")
    const synthetic = {
      type: "message.updated",
      properties: { info: { id: "msg_loop_owned", sessionID: h.sessionID, role: "user" } },
    }
    await h.hooks.event({ event: synthetic })

    fakeNow += 60_000
    await h.hooks.event({ event: synthetic })
    let state = await h.readState()
    assert.equal(state.jobs[0].paused, false, "a delayed update for the same loop-owned user message must remain ignored")

    await h.hooks.event({ event: {
      type: "message.updated",
      properties: { info: { id: "msg_real_user", sessionID: h.sessionID, role: "user" } },
    } })
    state = await h.readState()
    assert.equal(state.jobs[0].paused, true, "a distinct real user message must still pause an active goal")
  } finally {
    Date.now = originalDateNow
    await h.cleanup()
  }
}

async function testInitializationDoesNotWaitForLocalApi() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-init-deadlock-"))
  const never = new Promise(() => {})
  const client = {
    app: { log: async () => never },
    tui: { showToast: async () => ({ data: true }) },
    session: { list: async () => never },
  }
  try {
    const hooks = await Promise.race([
      OpenCodeLoopPlugin({ client, directory }),
      delay(500).then(() => { throw new Error("plugin initialization waited for the local OpenCode API") }),
    ])
    assert.equal(typeof hooks.event, "function")
    await hooks.dispose?.()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function testWindowsSafeStatePersistence() {
  const h = await createHarness()
  try {
    const stateDir = path.join(h.directory, ".opencode", "opencode-loop")

    // Rapid replacements exercise atomic overwrite of an existing state file.
    // On Windows this used to fail with EPERM when rename targeted a locked file
    // next to a project-local *.tmp, leaving jobs empty and the heartbeat stuck.
    for (let index = 0; index < 25; index++) {
      await h.command("loop", `10m --no-now --name sticky action-${index}`)
    }

    const state = await h.readState()
    assert.equal(state.jobs.length, 1)
    assert.equal(state.jobs[0].name, "sticky")
    assert.equal(state.jobs[0].action, "action-24")

    // Temp payloads must live outside the project so OpenCode git snapshots and
    // Windows file locks do not see opencode-loop/*.tmp pathspecs.
    const leftovers = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp"))
    assert.deepEqual(leftovers, [], "state writes must not leave project-local temp files")

    await h.command("loop-clear")
    const cleared = await h.readState()
    assert.equal(cleared.jobs.length, 0)
  } finally {
    await h.cleanup()
  }
}

async function testWindowsStateRenameRetriesBeforeFallback() {
  const h = await createHarness()
  const originalRename = fs.rename
  const originalCopyFile = fs.copyFile
  let renameAttempts = 0
  let fallbackCopies = 0
  fs.rename = async (source, target) => {
    if (target === h.stateFile && renameAttempts++ < 2) {
      const error = new Error("simulated Windows destination lock")
      error.code = "EPERM"
      throw error
    }
    return await originalRename(source, target)
  }
  fs.copyFile = async (source, target, ...rest) => {
    if (target === h.stateFile) fallbackCopies++
    return await originalCopyFile(source, target, ...rest)
  }
  try {
    await h.command("loop", "10m --no-now --name retry-safe keep-state")
    const state = await h.readState()
    assert.equal(state.jobs[0]?.name, "retry-safe")
    assert.equal(renameAttempts, 3, "transient EPERM should retry rename")
    assert.equal(fallbackCopies, 0, "successful rename retry should avoid non-atomic copy fallback")
  } finally {
    fs.rename = originalRename
    fs.copyFile = originalCopyFile
    await h.cleanup()
  }
}

async function testStateReadRetriesTransientPartialJson() {
  const h = await createHarness()
  const originalReadFile = fs.readFile
  try {
    await h.command("loop", "10m --no-now --name sticky survive-partial-read")
    let partialReads = 0
    fs.readFile = async (filePath, ...rest) => {
      if (filePath === h.stateFile && partialReads++ < 2) return "{"
      return await originalReadFile(filePath, ...rest)
    }
    await h.command("loop-status")
    assert.equal(partialReads, 3, "partial JSON should be retried before treating state as corrupt")
    assert.equal(h.records.toasts.at(-1)?.message, "1 loop job(s).")
  } finally {
    fs.readFile = originalReadFile
    await h.cleanup()
  }
}

await testParserAndPresets()
await testLifecycleAndCommandDedupe()
await testWatchScheduling()
await testActionRoutingAndSafety()
await testNativeCompactionLifecycleAndFallback()
await testStaleBusyUsesCompletedAssistantTail()
await testPromptDispatchFailureRecovery()
await testStopsPreflightAndGoalLifecycle()
await testLoopOwnedGoalMessageUpdatesDoNotSelfInterrupt()
await testInitializationDoesNotWaitForLocalApi()
await testWindowsSafeStatePersistence()
await testWindowsStateRenameRetriesBeforeFallback()
await testStateReadRetriesTransientPartialJson()

console.log("OpenCode Loop comprehensive test passed")
