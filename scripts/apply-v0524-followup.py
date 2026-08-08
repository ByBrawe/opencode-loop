from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected block in {path}")
    if text.count(old) != 1:
        raise SystemExit(f"expected one match in {path}, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/index.js",
    '''async function finalizeLoopCompaction(directory, client, sessionID) {
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
''',
    '''async function finalizeLoopCompaction(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  const active = activeRuns.get(sessionID)
  if (!pending || !active || pending.jobId !== active.jobId) return false
  return await finalizeActiveRun(directory, client, sessionID)
}
''',
)

replace_once(
    "src/index.js",
    '''async function finalizeActiveRun(directory, client, sessionID, options = {}) {
  const active = activeRuns.get(sessionID)
  if (!active) return
  if (!await canFinalizeActiveRun(directory, client, sessionID, active, options)) return false
  const recoveredStale = staleActiveRun(sessionID)
  clearActiveRun(sessionID)
  const state = await readState(directory, sessionID)
''',
    '''async function finalizeActiveRun(directory, client, sessionID, options = {}) {
  const active = activeRuns.get(sessionID)
  if (!active) return
  if (!await canFinalizeActiveRun(directory, client, sessionID, active, options)) return false
  const recoveredStale = staleActiveRun(sessionID)
  if (active.compactionOnly) {
    const pending = loopCompactionRequests.get(sessionID)
    clearActiveRun(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
    await appendLoopLog(directory, pending?.completedAt ? "compact-finished" : "compact-idle-fallback", {
      sessionID,
      job: active.job?.name || active.jobId,
      startedAt: active.startedAt,
      nativeEvent: Boolean(pending?.completedAt),
    })
    await scheduleDueWork(directory, client, sessionID)
    return true
  }
  clearActiveRun(sessionID)
  const state = await readState(directory, sessionID)
''',
)

# Make the fallback regression prove that a compaction-only phase cannot run
# verify/postrun logic even when an older host only reports idle and never emits
# session.compacted.
needle = '''  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name compact-chain --compact-every 1 continue after compaction")
'''
replacement = '''  h = await createHarness()
  try {
    await h.command("loop", "5m --no-now --name compact-chain --compact-every 1 --verify 'node -e process.exitCode=7' --pause-on-verify-fail continue after compaction")
'''
replace_once("scripts/comprehensive-test.mjs", needle, replacement)

replace_once(
    "scripts/comprehensive-test.mjs",
    '''    assert.equal((await h.readState()).jobs[0].runCount, 1, "native compaction completion must only release the deferred action")
  } finally {
    await h.cleanup()
  }
}
''',
    '''    assert.equal((await h.readState()).jobs[0].runCount, 1, "native compaction completion must only release the deferred action")
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
''',
)

replace_once(
    "CHANGELOG.md",
    "- Serialize `--compact-every` as its own compaction phase so the next loop prompt/shell action cannot overlap an in-progress compaction.\n",
    "- Serialize `--compact-every` as its own compaction phase so the next loop prompt/shell action cannot overlap an in-progress compaction; older hosts that only report idle also finalize this phase without running normal verify/postrun hooks.\n",
)

print("v0.5.24 follow-up applied")
