from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)

src_path = Path("src/index.js")
src = src_path.read_text()

src = replace_once(src, '''function fireSdk(client, label, method, ...argsList) {
  Promise.resolve()
    .then(() => sdkCall(method, ...argsList))
    .catch((error) => log(client, "warn", `${label} failed`, { error: sdkErrorMessage(error) }))
}
''', '''function fireSdk(client, label, method, ...argsList) {
  const pending = Promise.resolve().then(() => sdkCall(method, ...argsList))
  void pending.catch((error) => {
    log(client, "warn", `${label} failed`, { error: sdkErrorMessage(error) }).catch(() => {})
  })
  return pending
}
''', "fireSdk")

src = replace_once(src, '''function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  activeRuns.delete(sessionID)
}
''', '''function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  activeRuns.delete(sessionID)
}

async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {
  const active = activeRuns.get(sessionID)
  if (!active || active.jobId !== jobId || active.runToken !== runToken) return false

  clearActiveRun(sessionID)
  sessionStatuses.delete(sessionID)
  sessionStatusSeenAt.delete(sessionID)

  const message = sdkErrorMessage(error)
  const state = await readState(directory, sessionID)
  const job = (state.jobs || []).find((candidate) => candidate.id === jobId)
  if (job) {
    job.failureCount = (job.failureCount || 0) + 1
    job.lastFailureReason = "dispatch_failed"
    job.lastDispatchFailure = message.slice(0, 4000)
    job.lastDispatchFailureAt = now()
    if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
      job.paused = true
      await notifyJob(directory, job, "dispatch_failed")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
  }

  await appendLoopLog(directory, "dispatch-error", { sessionID, job: job?.name || jobId, error: message })
  await toast(client, `Loop dispatch failed${job?.paused ? " and paused" : ""}: ${message}`, job?.paused ? "error" : "warning")
  await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
  return true
}
''', "dispatch recovery helper")

src = replace_once(src, '''    fireSdk(
      client,
      "session.shell",
      client.session.shell.bind(client.session),
      { path: { id: sessionID }, body: shellBody },
      { path: { sessionID }, body: shellBody },
      { sessionID, ...shellBody },
    )
    return { startsAssistantTurn: true }
''', '''    const dispatch = fireSdk(
      client,
      "session.shell",
      client.session.shell.bind(client.session),
      { path: { id: sessionID }, body: shellBody },
      { path: { sessionID }, body: shellBody },
      { sessionID, ...shellBody },
    )
    return { startsAssistantTurn: true, dispatch }
''', "shell dispatch")

src = replace_once(src, '''  fireSdk(
    client,
    "session.prompt",
    client.session.prompt.bind(client.session),
    { path: { id: sessionID }, body: promptBody },
    { path: { sessionID }, body: promptBody },
    { sessionID, ...promptBody },
  )
  return { startsAssistantTurn: true }
''', '''  const dispatch = fireSdk(
    client,
    "session.prompt",
    client.session.prompt.bind(client.session),
    { path: { id: sessionID }, body: promptBody },
    { path: { sessionID }, body: promptBody },
    { sessionID, ...promptBody },
  )
  return { startsAssistantTurn: true, dispatch }
''', "prompt dispatch")

src = replace_once(src, '''      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer })
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
''', '''      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken })
      if (result.dispatch) {
        void result.dispatch.catch((error) => {
          recoverActiveDispatchFailure(directory, client, sessionID, job.id, runToken, error)
            .catch((recoveryError) => log(client, "error", "dispatch recovery failed", { error: sdkErrorMessage(recoveryError) }))
        })
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
''', "active dispatch tracking")

src_path.write_text(src)

test_path = Path("scripts/comprehensive-test.mjs")
test = test_path.read_text()
test = replace_once(test, '''      prompt: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        const text = args.body.parts.map((part) => part.text || "").join("\\n")
        records.prompts.push({ text, noReply: args.body.noReply === true, agent: args.body.agent, model: args.body.model })
        return { data: true }
      },
''', '''      prompt: async (args) => {
        assert.equal(args?.path?.id, sessionID)
        const text = args.body.parts.map((part) => part.text || "").join("\\n")
        records.prompts.push({ text, noReply: args.body.noReply === true, agent: args.body.agent, model: args.body.model })
        if (options.failPrompt) {
          await delay(options.promptFailureDelayMs ?? 20)
          throw new Error(options.promptFailureMessage || "simulated prompt dispatch failure")
        }
        return { data: true }
      },
''', "prompt failure harness")

anchor = '''async function testStopsPreflightAndGoalLifecycle() {'''
new_test = '''async function testPromptDispatchFailureRecovery() {
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

'''
test = replace_once(test, anchor, new_test + anchor, "dispatch recovery test")
test = replace_once(test, '''await testActionRoutingAndSafety()
await testStopsPreflightAndGoalLifecycle()
''', '''await testActionRoutingAndSafety()
await testPromptDispatchFailureRecovery()
await testStopsPreflightAndGoalLifecycle()
''', "dispatch recovery test invocation")
test_path.write_text(test)

package_path = Path("package.json")
package = json.loads(package_path.read_text())
if package.get("version") != "0.5.22":
    raise SystemExit(f"package.json: expected 0.5.22, got {package.get('version')}")
package["version"] = "0.5.23"
package_path.write_text(json.dumps(package, indent=2) + "\n")

lock_path = Path("package-lock.json")
lock = json.loads(lock_path.read_text())
if lock.get("version") != "0.5.22" or lock.get("packages", {}).get("", {}).get("version") != "0.5.22":
    raise SystemExit("package-lock.json: expected root version 0.5.22")
lock["version"] = "0.5.23"
lock["packages"][""]["version"] = "0.5.23"
lock_path.write_text(json.dumps(lock, indent=2) + "\n")

changelog_path = Path("CHANGELOG.md")
changelog = changelog_path.read_text()
entry = '''## 0.5.23

- Track non-blocking `session.prompt` and `session.shell` dispatch promises instead of treating every fire-and-forget request as successfully started.
- Recover a rejected scheduler dispatch immediately: clear only the matching active run token, invalidate cached busy status, persist the failure, honor `--max-failures`, and reschedule through the normal scheduler path.
- Never replay a rejected prompt automatically; this avoids duplicate turns when OpenCode status/events are delayed or multiple instances are involved.
- Added a deterministic regression test for delayed prompt rejection and verified the error remains observable in plugin logs.

'''
changelog = replace_once(changelog, "# Changelog\n\n", "# Changelog\n\n" + entry, "changelog")
changelog_path.write_text(changelog)

readme_path = Path("README.md")
readme = readme_path.read_text()
readme = replace_once(
    readme,
    "**v0.5.22 adds forward-compatible OpenCode command handling plus Bun and peer-range compatibility CI.**",
    "**v0.5.23 adds immediate, token-safe recovery when a scheduler prompt/shell dispatch is rejected, without automatically replaying the prompt.** **v0.5.22 adds forward-compatible OpenCode command handling plus Bun and peer-range compatibility CI.**",
    "README current status",
)
readme_path.write_text(readme)

print("Applied v0.5.23 dispatch recovery patch")
