import { readFileSync, writeFileSync, existsSync } from "node:fs"
import assert from "node:assert/strict"
function edit(file, before, after) {
  const text = readFileSync(file, "utf8")
  if (text.includes(after)) return
  assert.equal(text.split(before).length, 2, `Expected one anchor in ${file}: ${before.slice(0, 100)}`)
  writeFileSync(file, text.replace(before, after))
}
writeFileSync("src/source/native.js", 'export { OpenCodeLoopNativePlugin as default, OpenCodeLoopNativePlugin } from "./opencode2/native-plugin.js"\n')
edit("src/source/opencode2/experimental.js", 'import { inspectOpenCode2Context }', 'import { OpenCodeLoopNativePlugin } from "./native-plugin.js"\nimport { inspectOpenCode2Context }')
edit("src/source/opencode2/experimental.js", '  async setup(ctx) {\n    const capabilities', '  async setup(ctx) {\n    if (typeof ctx?.session?.hook === "function") return OpenCodeLoopNativePlugin.setup(ctx)\n    const capabilities')
edit("src/source/opencode2/prompt-runtime.js", '      parsed.job.name = jobName(parsed.job)', '      parsed.job.createdAt = new Date(now()).toISOString()\n      parsed.job.lastRunAt = parsed.job.immediate === false ? now() : 0\n      parsed.job.name = jobName(parsed.job)')
edit("src/source/runtime/job-workspace.js", '    job.branchDone = true\n    await toast', '    job.branchDone = result.code === 0\n    await toast')
edit("src/source/runtime/job-workspace.js", 'if (inRepo.code !== 0) { job.branchDone = true; return job }', 'if (inRepo.code !== 0) { job.branchDone = false; job.branchUnavailable = true; return job }')
edit("src/source/runtime/job-workspace.js", '        const full = path.join(current, entry.name)\n        if (entry.isDirectory())', '        const full = path.join(current, entry.name)\n        // The control state contains the configured --until text; it is not completion evidence.\n        if (path.resolve(full) === path.resolve(stateDir(directory))) continue\n        if (entry.isDirectory())')
const processPath = "src/source/core/process.js"
let processSource = readFileSync(processPath, "utf8")
if (!processSource.includes("let timedOut = false")) {
  processSource = processSource.replaceAll('    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)', '    let timedOut = false\n    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM") } catch {} }, timeoutMs)').replaceAll('code: code ?? 0', 'code: timedOut ? 124 : (code ?? -1)')
  writeFileSync(processPath, processSource)
}
const events = "src/source/opencode2/events.js"
edit(events, '  if (type === "session.created") {', `  if (type === "session.inbox.delivered" || type === "session.inbox.cancelled") {\n    if (!sessionID || !text(data.inboxID)) return undefined\n    return Object.freeze({ kind: "inbox", action: type.endsWith("delivered") ? "delivered" : "cancelled", sessionID, directory, inboxID: data.inboxID })\n  }\n  if (["session.compaction.started", "session.compaction.ended", "session.compaction.failed"].includes(type)) {\n    if (!sessionID) return undefined\n    return Object.freeze({ kind: "compaction", action: type.split(".").at(-1), sessionID, directory })\n  }\n  if (["session.execution.failed", "session.execution.interrupted"].includes(type)) {\n    if (!sessionID) return undefined\n    return Object.freeze({ kind: "session", action: "error", sessionID, directory, reason: type })\n  }\n  if (["session.shell.started", "session.shell.ended"].includes(type)) {\n    if (!sessionID) return undefined\n    const shell = record(data.shell) || {}\n    return Object.freeze({ kind: "shell", action: type.endsWith("started") ? "started" : "ended", sessionID, directory, shellID: shell.id, command: shell.command, code: typeof shell.exit === "number" ? shell.exit : -1, status: shell.status, metadata: shell.metadata })\n  }\n\n  if (type === "session.created") {`)
edit("src/source/opencode2/event-bridge.js", '  const sessionDirectories = new Map()', '  const sessionDirectories = new Map()\n  const seenEventIDs = new Set()')
edit("src/source/opencode2/event-bridge.js", '    if (!event || !sameDirectory(directory, event.directory)) return undefined', '    if (!event || !sameDirectory(directory, event.directory)) return undefined\n    if (typeof raw?.id === "string") {\n      if (seenEventIDs.has(raw.id)) return undefined\n      seenEventIDs.add(raw.id)\n      if (seenEventIDs.size > 2048) seenEventIDs.delete(seenEventIDs.values().next().value)\n    }')
const policy = "src/source/opencode2/native-policy.js"
edit(policy, '  async function prepare(scope, job, isCurrent = () => true) {\n    const created', '  async function checkStop(scope, job) {\n    const created')
edit(policy, '    if (!isCurrent()) return false\n    if (job.dryRun) return true', '    return true\n  }\n\n  async function prepare(scope, job, isCurrent = () => true) {\n    if (!await checkStop(scope, job) || !isCurrent()) return false\n    if (job.dryRun) return true')
edit(policy, '    pause, prepare, finish, notify, shell,', '    pause, checkStop, prepare, finish, notify, shell,')
const native = "src/source/opencode2/native-runtime.js"
edit(native, '      if (dueAt(job) > now()) continue', '      if (!await policy.checkStop(scope, job)) {\n        await save(scope, state)\n        await policy.notify(scope, job, job.pauseReason)\n        return advance(scope)\n      }\n      if (dueAt(job) > now()) continue')
edit(native, 'if (job.paused || job.enabled === false) { await save(scope, state); await policy.notify(scope, job, job.pauseReason) }', 'if (job.paused || job.enabled === false) { await save(scope, state); await policy.notify(scope, job, job.pauseReason); return advance(scope) }')
edit(native, 'request = { sessionID: scope.sessionID, id: id() }', 'request = { sessionID: scope.sessionID, id: id(), delivery: "queue" }')
edit(native, 'request = { sessionID: scope.sessionID, command: String(job.action)', 'request = { sessionID: scope.sessionID, id: id(), command: String(job.action)')
edit(native, 'run.shellID = kind === "shell" ? (response?.id || response?.shell?.id) : undefined', 'run.shellID = kind === "shell" ? (response?.id || response?.shell?.id || request.id) : undefined')
// A cancelled event itself is transition evidence. Do not recursively cancel it.
edit(native, '          if (event.action === "cancelled") return pauseActive(scope, "inbox-cancelled", false)', `          if (event.action === "cancelled") {\n            const run = scope.active\n            const state = await read(scope)\n            const job = (state.jobs || []).find((entry) => entry.id === run.jobID)\n            if (job?.v2Run?.id === run.id && !run.delivered) {\n              Object.assign(job, run.previous)\n              policy.pause(job, "inbox-cancelled")\n              delete job.v2Run\n              await save(scope, state)\n            }\n            if (scope.active === run) delete scope.active\n            clear(scope, "deadline")\n            return result({ reason: "inbox-cancelled" })\n          }`)
// Only a terminal for delivered work can retire its durable ownership marker.
edit(native, '        return pauseActive(scope, event.reason || `${event.kind}-${event.action}`)', `        const run = scope.active\n        const paused = await pauseActive(scope, event.reason || \`\${event.kind}-\${event.action}\`)\n        if (run && (run.delivered || ["compact", "cadence", "shell"].includes(run.kind))) {\n          const state = await read(scope)\n          const job = (state.jobs || []).find((entry) => entry.id === run.jobID)\n          if (job?.v2Run?.id === run.id) { delete job.v2Run; await save(scope, state) }\n          if (scope.active === run) delete scope.active\n        }\n        return paused`)
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
pkg.version = "0.6.3"
pkg.main = "src/plugin.js"
pkg.exports = { ".": "./src/plugin.js", "./server": "./src/plugin.js", "./v2": "./src/v2.js", "./v1": "./src/index.js" }
if (!pkg.scripts["build:plugin"].includes("src/source/native.js")) pkg.scripts["build:plugin"] += " && bun build src/source/native.js --outfile=src/native.js --target=bun --format=esm"
for (const file of ["src/source/native.js", "src/source/opencode2/native-plugin.js", "src/source/opencode2/native-runtime.js", "src/source/opencode2/native-policy.js", "src/native.js"]) {
  if (!pkg.scripts.check.includes(`node --check ${file}`)) pkg.scripts.check += ` && node --check ${file}`
}
if (existsSync("scripts/native-v2-test.mjs") && !pkg.scripts.test.includes("scripts/native-v2-test.mjs")) pkg.scripts.test = "node scripts/native-v2-test.mjs && " + pkg.scripts.test
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"))
lock.version = pkg.version
lock.packages[""].version = pkg.version
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n")
console.log("Native source migration applied")
