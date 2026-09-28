import { readFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
function edit(path, before, after) {
  const text = readFileSync(path, "utf8")
  assert.equal(text.split(before).length, 2, `Expected one anchor in ${path}: ${before.slice(0, 80)}`)
  writeFileSync(path, text.replace(before, after))
}
const path = "src/source/runtime/goal-steering.js"
edit(path, "  const pendingSteering = new Map()", "  const compactingSessions = new Set()\n  const pendingSteering = new Map()")
edit(path, "const canPreempt = active && activeGoalIDs", "const canPreempt = !compactingSessions.has(sessionID) && active && activeGoalIDs")
edit(path, "        clearActiveRun(sessionID)\n        preempted = true", "        // A foreground turn can replace the active run while abort settles.\n        if (getActiveRun(sessionID) === active) clearActiveRun(sessionID)\n        preempted = true")
edit(path, "    return await handleUserMessage(directory, client, user)", `    // Persisted user-role events include core compaction markers, synthetic\n    // continuations and replayed history. Parts may not even be persisted yet.\n    // Only the pre-dispatch chat.message admission hook is steering authority.\n    if (alreadyHandled(user.sessionID, user.messageID)) return { handled: false, duplicate: true, ...user }\n    return { handled: false, reason: "untrusted-message-event", ...user }`)
edit(path, "  function clearSession(sessionID) {\n    pendingSteering.delete(sessionID)", `  function setCompacting(sessionID, value = true) {\n    if (typeof sessionID !== "string" || !sessionID) return\n    if (value) compactingSessions.add(sessionID)\n    else compactingSessions.delete(sessionID)\n  }\n\n  function clearSession(sessionID) {\n    compactingSessions.delete(sessionID)\n    pendingSteering.delete(sessionID)`)
edit(path, "    pendingForSession,\n    clearSession,", "    pendingForSession,\n    setCompacting,\n    clearSession,")
edit("src/source/legacy-v1.js", '"experimental.session.compacting": async (input) => { await noteLoopCompactionStarted(directory, input?.sessionID) },', '"experimental.session.compacting": async (input) => {\n      goalSteeringRuntime.setCompacting(input?.sessionID)\n      await noteLoopCompactionStarted(directory, input?.sessionID)\n    },')
edit("src/source/legacy-v1.js", '    event: async ({ event }) => {\n      if (event.type === "session.compacted")', '    event: async ({ event }) => {\n      if (["session.compacted", "session.error", "session.deleted"].includes(event?.type)) {\n        goalSteeringRuntime.setCompacting(event?.properties?.sessionID || event?.properties?.info?.id, false)\n      }\n      if (event.type === "session.compacted")')
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
pkg.scripts.test = "node scripts/goal-compaction-safety-test.mjs && " + pkg.scripts.test
pkg.scripts.check += " && node --check scripts/goal-compaction-safety-test.mjs"
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
