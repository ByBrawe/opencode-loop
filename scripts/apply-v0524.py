from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected block in {path}: {old[:120]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"expected one match in {path}, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))


def insert_after(path, marker, addition):
    replace_once(path, marker, marker + addition)


# Runtime tracking for native compaction lifecycle.
insert_after(
    "src/index.js",
    "const sessionStatusSeenAt = new Map()\n",
    "const loopCompactionRequests = new Map()\n",
)

# Current OpenCode summarize requires providerID/modelID. Also centralize recent
# message reads so stale-busy recovery can cross-check actual assistant completion.
old_compact = '''async function compactSession(client, sessionID) {
  // OpenCode's TUI API accepts legacy keybind aliases (session_compact) in
  // current builds, while some older docs/examples mention the event value
  // (session.compact). Try the alias first, then the event value, then the
  // session summarize endpoint as a last resort.
  for (const command of ["session.compact", "session_compact"]) {
    try {
      await executeTuiCommand(client, command)
      return true
    } catch (error) {
      await log(client, "warn", `tui ${command} failed`, { error: sdkErrorMessage(error) })
    }
  }
  try {
    await sdkCall(
      client.session.summarize.bind(client.session),
      { path: { id: sessionID }, body: {} },
      { path: { sessionID }, body: {} },
      { sessionID },
    )
    return true
  } catch (error) {
    await log(client, "warn", "session.summarize fallback failed", { error: sdkErrorMessage(error) })
  }
  await toast(client, "Could not run /compact from loop. Check OpenCode version and active TUI session.", "error")
  return false
}
'''
new_compact = '''async function readRecentSessionMessages(client, sessionID, directory, limit = 20) {
  if (!client?.session?.messages) return undefined
  const query = { limit }
  if (directory) query.directory = directory
  try {
    const messages = await sdkCall(
      client.session.messages.bind(client.session),
      { path: { id: sessionID }, query },
      { path: { sessionID }, query },
      { sessionID, ...query },
    )
    return Array.isArray(messages) ? messages : undefined
  } catch {
    return undefined
  }
}

function orderedSessionMessages(messages) {
  return (messages || [])
    .map((message, index) => {
      const info = message?.info || message || {}
      const created = Number(info?.time?.created || 0)
      return { message, index, created: Number.isFinite(created) ? created : 0 }
    })
    .sort((a, b) => a.created - b.created || a.index - b.index)
    .map((entry) => entry.message)
}

async function activeRunCompletionFromMessages(directory, client, sessionID, active) {
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  if (!messages) return "unknown"
  const tail = orderedSessionMessages(messages).at(-1)
  const info = tail?.info || tail
  if (!info || info.role !== "assistant") return "incomplete"
  const completed = Number(info?.time?.completed || 0)
  const created = Number(info?.time?.created || 0)
  if (!Number.isFinite(completed) || completed <= 0) return "incomplete"
  const startedAt = Number(active?.startedAt || 0)
  if (startedAt > 0 && completed < startedAt && (!Number.isFinite(created) || created < startedAt)) return "incomplete"
  return "completed"
}

async function resolveCompactionModel(directory, client, sessionID, preferredModel) {
  const preferred = normalizedModelRef(preferredModel)
  if (preferred) return preferred
  const cached = normalizedModelRef(sessionExecutionContexts.get(sessionID)?.model)
  if (cached) return cached
  const captured = await captureSessionExecutionContext(client, sessionID)
  const capturedModel = normalizedModelRef(captured?.model)
  if (capturedModel) return capturedModel
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  for (const message of orderedSessionMessages(messages).reverse()) {
    const info = message?.info || message
    const model = normalizedModelRef(info?.model) || normalizedModelRef(info)
    if (!model) continue
    const previous = sessionExecutionContexts.get(sessionID) || {}
    sessionExecutionContexts.set(sessionID, { ...previous, model })
    return model
  }
  return undefined
}

async function compactSession(directory, client, sessionID, preferredModel) {
  // Prefer the native TUI command when a TUI is present. Headless/server hosts
  // fall back to session.summarize, whose current API requires an explicit
  // provider/model pair.
  for (const command of ["session.compact", "session_compact"]) {
    try {
      await executeTuiCommand(client, command)
      return true
    } catch (error) {
      await log(client, "warn", `tui ${command} failed`, { error: sdkErrorMessage(error) })
    }
  }
  try {
    if (!client?.session?.summarize) throw new Error("client.session.summarize is not available")
    const model = await resolveCompactionModel(directory, client, sessionID, preferredModel)
    if (!model) throw new Error("could not resolve a provider/model for session.summarize")
    const body = { providerID: model.providerID, modelID: model.modelID, auto: false }
    await sdkCall(
      client.session.summarize.bind(client.session),
      { path: { id: sessionID }, body },
      { path: { sessionID }, body },
      { sessionID, ...body },
    )
    return true
  } catch (error) {
    await log(client, "warn", "session.summarize fallback failed", { error: sdkErrorMessage(error) })
  }
  await toast(client, "Could not run /compact from loop. Check OpenCode version and active session model.", "error")
  return false
}
'''
replace_once("src/index.js", old_compact, new_compact)

# Automatic compact-every must wait for compaction to finish before starting the
# actual scheduled action. Returning a structured result lets the scheduler hold
# the job until OpenCode emits session.compacted/idle.
old_maybe_compact = '''async function maybeCompact(client, sessionID, job) {
  const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
  const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
  if (!dueRuns && !dueTime) return job
  if (await compactSession(client, sessionID)) {
    job.lastCompactAt = now()
    job.lastCompactRunCount = job.runCount || 0
  }
  return job
}
'''
new_maybe_compact = '''async function maybeCompact(directory, client, sessionID, job) {
  const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
  const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
  if (!dueRuns && !dueTime) return { job, started: false }
  beginLoopCompaction(sessionID, job.id, true)
  if (await compactSession(directory, client, sessionID, job.model)) {
    job.lastCompactAt = now()
    job.lastCompactRunCount = job.runCount || 0
    return { job, started: true }
  }
  loopCompactionRequests.delete(sessionID)
  return { job, started: false }
}
'''
replace_once("src/index.js", old_maybe_compact, new_maybe_compact)

# Clear lifecycle state with the rest of the session runtime.
replace_once(
    "src/index.js",
    "    sessionStatusSeenAt.delete(sessionID)\n    sessionExecutionContexts.delete(sessionID)\n",
    "    sessionStatusSeenAt.delete(sessionID)\n    sessionExecutionContexts.delete(sessionID)\n    loopCompactionRequests.delete(sessionID)\n",
)

# Confirm stale busy/retry with the completed assistant tail. Preserve the old
# timeout-only recovery only when message history is unavailable, not when the
# history explicitly shows an unfinished turn.
old_can_finalize = '''async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
  if (!options.requireIdle && !options.forceStale) return true
  if (options.forceStale && staleActiveRun(sessionID)) return true
  if (!options.requireIdle) return false

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type) return live.type === "idle"

  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0
  return cached === "idle" && seenAt > (active.startedAt || 0)
}
'''
new_can_finalize = '''async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
  if (!options.requireIdle && !options.forceStale) return true

  const completion = options.forceStale
    ? await activeRunCompletionFromMessages(directory, client, sessionID, active)
    : undefined
  if (completion === "completed") return true
  if (!options.requireIdle) return completion === "unknown" && staleActiveRun(sessionID)

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type === "idle") return true
  if (live?.type) {
    if ((live.type === "busy" || live.type === "retry") && options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
    return false
  }

  if (options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0
  return cached === "idle" && seenAt > (active.startedAt || 0)
}
'''
replace_once("src/index.js", old_can_finalize, new_can_finalize)

old_status_recovery = '''    if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false && staleActiveRun(sessionID)) {
      sessionStatuses.set(sessionID, "idle")
      sessionStatusSeenAt.set(sessionID, now())
      return "idle"
    }
'''
new_status_recovery = '''    if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false) {
      const active = activeRuns.get(sessionID)
      if (active) {
        const completion = await activeRunCompletionFromMessages(directory, client, sessionID, active)
        if (completion === "completed" || (completion === "unknown" && staleActiveRun(sessionID))) {
          sessionStatuses.set(sessionID, "idle")
          sessionStatusSeenAt.set(sessionID, now())
          await appendLoopLog(directory, completion === "completed" ? "status-message-complete-recovery" : "status-stale-recovery", {
            sessionID,
            job: active.job?.name || active.jobId,
            startedAt: active.startedAt,
          })
          return "idle"
        }
      }
    }
'''
replace_once("src/index.js", old_status_recovery, new_status_recovery)

# Native compaction tracking and token-safe finalization.
old_clear_active = '''function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  activeRuns.delete(sessionID)
}
'''
new_clear_active = '''function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  const compact = loopCompactionRequests.get(sessionID)
  if (!compact || !active || compact.jobId === active.jobId) loopCompactionRequests.delete(sessionID)
  activeRuns.delete(sessionID)
}

function beginLoopCompaction(sessionID, jobId, resumeAfter = false) {
  loopCompactionRequests.set(sessionID, {
    jobId,
    resumeAfter,
    requestedAt: now(),
    startedAt: 0,
    completedAt: 0,
  })
}

async function noteLoopCompactionStarted(directory, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  if (!pending.startedAt) {
    pending.startedAt = now()
    loopCompactionRequests.set(sessionID, pending)
    await appendLoopLog(directory, "compact-started", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  }
  return true
}

async function finalizeLoopCompaction(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  const active = activeRuns.get(sessionID)
  if (!pending || !active || pending.jobId !== active.jobId) return false
  if (active.compactionOnly) {
    clearActiveRun(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
    await appendLoopLog(directory, "compact-finished", { sessionID, job: pending.jobId, resumeAfter: true })
    await scheduleDueWork(directory, client, sessionID)
    return true
  }
  return await finalizeActiveRun(directory, client, sessionID)
}

async function noteLoopCompactionCompleted(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  pending.completedAt = now()
  loopCompactionRequests.set(sessionID, pending)
  await appendLoopLog(directory, "compact-event", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  const timer = setTimeout(() => {
    finalizeLoopCompaction(directory, client, sessionID)
      .catch((error) => log(client, "error", "compaction finalization failed", { error: sdkErrorMessage(error) }))
  }, 0)
  timer.unref?.()
  return true
}
'''
replace_once("src/index.js", old_clear_active, new_clear_active)

# Route explicit compact jobs/commands through the lifecycle tracker and ensure a
# failed compact command does not masquerade as a started assistant turn.
old_fire_compact = '''  if (kind === "compact") {
    const ok = await compactSession(client, sessionID)
    return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed" }
  }
'''
new_fire_compact = '''  if (kind === "compact") {
    beginLoopCompaction(sessionID, job.id, false)
    const ok = await compactSession(directory, client, sessionID, model)
    if (!ok) loopCompactionRequests.delete(sessionID)
    return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
  }
'''
replace_once("src/index.js", old_fire_compact, new_fire_compact)

old_command_compact = '''    const tuiCommand = compactTuiCommandName(command)
    if (tuiCommand) {
      guardLoopOwnedUserMessage(sessionID)
      await compactSession(client, sessionID)
      return { startsAssistantTurn: true }
    }
'''
new_command_compact = '''    const tuiCommand = compactTuiCommandName(command)
    if (tuiCommand) {
      guardLoopOwnedUserMessage(sessionID)
      beginLoopCompaction(sessionID, job.id, false)
      const ok = await compactSession(directory, client, sessionID, model)
      if (!ok) loopCompactionRequests.delete(sessionID)
      return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
    }
'''
replace_once("src/index.js", old_command_compact, new_command_compact)

# Split automatic pre-action compaction into its own active phase so the actual
# prompt/shell action cannot overlap the compaction turn.
old_prepare = '''    job = await ensureBranch(directory, job, client, sessionID)
    job = await maybeCompact(client, sessionID, job)
    job.watchTriggered = false
    job.lastRunAt = now()
    job.runCount = (job.runCount || 0) + 1
'''
new_prepare = '''    job = await ensureBranch(directory, job, client, sessionID)
    const compactResult = await maybeCompact(directory, client, sessionID, job)
    job = compactResult.job
    if (compactResult.started) {
      state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
      await writeState(directory, sessionID, state)
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop compact timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:compact:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionOnly: true })
      const pending = loopCompactionRequests.get(sessionID)
      if (pending?.jobId === job.id && pending.completedAt) {
        await finalizeLoopCompaction(directory, client, sessionID)
        return
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
      return
    }
    job.watchTriggered = false
    job.lastRunAt = now()
    job.runCount = (job.runCount || 0) + 1
'''
replace_once("src/index.js", old_prepare, new_prepare)

old_active_set = '''      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken })
      if (result.dispatch) {
'''
new_active_set = '''      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionAction: result.compaction === true })
      if (result.compaction) {
        const pending = loopCompactionRequests.get(sessionID)
        if (pending?.jobId === job.id && pending.completedAt) {
          await finalizeLoopCompaction(directory, client, sessionID)
          return
        }
      }
      if (result.dispatch) {
'''
replace_once("src/index.js", old_active_set, new_active_set)

# Wire the latest native OpenCode compaction hook/event. Older hosts simply never
# invoke the extra hook/event, leaving the existing idle/status fallback intact.
old_hooks = '''    tool: goalTools(directory),
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    event: async ({ event }) => {
'''
new_hooks = '''    tool: goalTools(directory),
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    "experimental.session.compacting": async (input) => { await noteLoopCompactionStarted(directory, input?.sessionID) },
    event: async ({ event }) => {
      if (event.type === "session.compacted") await noteLoopCompactionCompleted(directory, client, event?.properties?.sessionID)
'''
replace_once("src/index.js", old_hooks, new_hooks)

# Test harness: message history + summarize request capture + TUI-only failure.
replace_once(
    "scripts/comprehensive-test.mjs",
    '''    shells: [],
    toasts: [],
    tuiCommands: [],
  }
  const statuses = new Map([[sessionID, "idle"]])
''',
    '''    shells: [],
    summaries: [],
    messageReads: [],
    toasts: [],
    tuiCommands: [],
  }
  const statuses = new Map([[sessionID, "idle"]])
  const messageHistory = Array.isArray(options.messages) ? structuredClone(options.messages) : []
''',
)
replace_once(
    "scripts/comprehensive-test.mjs",
    '''        records.tuiCommands.push(args.body.command)
        if (options.failCompact) throw new Error("simulated TUI compact failure")
        return { data: true }
''',
    '''        records.tuiCommands.push(args.body.command)
        if (options.failCompact || options.failTuiCompact) throw new Error("simulated TUI compact failure")
        return { data: true }
''',
)
replace_once(
    "scripts/comprehensive-test.mjs",
    '''      status: async (args) => {
        assert.equal(args?.query?.directory, directory)
        // Current OpenCode omits idle sessions from this response.
        return {
          data: Object.fromEntries(
            [...statuses].filter(([, type]) => type !== "idle").map(([id, type]) => [id, { type }]),
          ),
        }
      },
      summarize: async () => {
        if (options.failCompact) throw new Error("simulated summarize failure")
        return { data: true }
      },
''',
    '''      status: async (args) => {
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
''',
)
replace_once(
    "scripts/comprehensive-test.mjs",
    '''    records,
    sessionID,
    stateFile,
    statuses,
''',
    '''    records,
    sessionID,
    stateFile,
    statuses,
    messageHistory,
''',
)

# Add focused regressions after action routing.
marker = '''async function testPromptDispatchFailureRecovery() {
'''
new_tests = '''async function testNativeCompactionLifecycleAndFallback() {
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
    await h.command("loop", "5m --no-now --name compact-chain --compact-every 1 continue after compaction")
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

'''
replace_once("scripts/comprehensive-test.mjs", marker, new_tests + marker)
replace_once(
    "scripts/comprehensive-test.mjs",
    '''await testActionRoutingAndSafety()
await testPromptDispatchFailureRecovery()
''',
    '''await testActionRoutingAndSafety()
await testNativeCompactionLifecycleAndFallback()
await testStaleBusyUsesCompletedAssistantTail()
await testPromptDispatchFailureRecovery()
''',
)

# Release metadata/docs.
replace_once("package.json", '"version": "0.5.23"', '"version": "0.5.24"')
replace_once(
    "CHANGELOG.md",
    "# Changelog\n\n",
    "# Changelog\n\n## 0.5.24\n\n- Cross-check stale OpenCode `busy`/`retry` status against the chronological session tail and only recover early when the latest assistant message has a real `time.completed`; an explicitly unfinished assistant tail is never force-finalized.\n- Track scheduled compaction through OpenCode's native `experimental.session.compacting` hook and `session.compacted` event, while retaining idle/status fallbacks for older hosts.\n- Serialize `--compact-every` as its own compaction phase so the next loop prompt/shell action cannot overlap an in-progress compaction.\n- Fix headless/server compact fallback for current OpenCode by supplying the required `providerID`, `modelID`, and `auto: false` payload to `session.summarize`.\n- Add deterministic regressions for completed-vs-running assistant tails, native compaction completion, compact/action serialization, and current summarize payloads.\n\n",
)
replace_once(
    "README.md",
    "**v0.5.23 adds immediate, token-safe recovery when a scheduler prompt/shell dispatch is rejected, without automatically replaying the prompt.**",
    "**v0.5.24 uses OpenCode's native compaction lifecycle, serializes compact-before-run work, fixes current headless summarize payloads, and validates stale `busy` recovery against a genuinely completed assistant tail.** **v0.5.23 adds immediate, token-safe recovery when a scheduler prompt/shell dispatch is rejected, without automatically replaying the prompt.**",
)

print("v0.5.24 patch applied")
