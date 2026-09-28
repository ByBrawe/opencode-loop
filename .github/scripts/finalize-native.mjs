import { readFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
function edit(file, before, after) {
  const text = readFileSync(file, "utf8")
  if (text.includes(after)) return
  assert.equal(text.split(before).length, 2, `Expected one anchor in ${file}: ${before.slice(0, 100)}`)
  writeFileSync(file, text.replace(before, after))
}
const plugin = "src/source/opencode2/native-plugin.js"
edit(plugin, 'import path from "node:path"', 'import path from "node:path"\nimport { createNativeShellHost } from "./native-shell.js"')
edit(plugin, '    const runtime = createNativeLoopRuntime({', `    const shellHost = createNativeShellHost({
      directory,
      onTerminal: (event) => runtime.onEvent(event),
      onError: (error) => { void appendLoopLog(directory, "v2-shell-error", { message: String(error?.message || error) }).catch(() => {}) },
    })
    const runtime = createNativeLoopRuntime({`)
edit(plugin, 'shell: typeof ctx.session.shell === "function" ? (request) => ctx.session.shell(request) : undefined,', 'shell: typeof ctx.session.shell === "function" ? (request) => ctx.session.shell(request) : (request) => shellHost.dispatch(request),')
edit(plugin, 'createOpenCode2EventBridge({ directory, onEvent:', 'createOpenCode2EventBridge({ directory, allowInboxCommands: false, onEvent:')
edit(plugin, '      await runtime.dispose()\n      await bridge.dispose', '      await runtime.dispose()\n      await shellHost.dispose()\n      await bridge.dispose')
edit(plugin, 'Preflight, postrun, notifications, stop files, completion markers, runtime/failure/run limits, branches and checkpoints are supported.', 'Preflight, postrun, notifications, stop files, completion markers, runtime/failure/run limits, branches and checkpoints are supported.\nScheduled shell commands run as bounded local child processes when the plugin context has no session.shell.\nScheduled/manual compaction requires session.compact on the host; unavailable capability is rejected before creating a job. Native automatic compaction is always left to OpenCode.\nAn unfinished dedicated Goal reserves its session; Loop will not override it.')
const native = "src/source/opencode2/native-runtime.js"
edit(native, 'import { randomUUID } from "node:crypto"', 'import { randomUUID } from "node:crypto"\nimport { nativeGoalReservesSession } from "./native-companion.js"')
edit(native, 'if (!run || scope.compaction) return result({ reason: "no-terminal-boundary" })', 'if (!run || scope.compaction || scope.busy) return result({ reason: "no-terminal-boundary" })')
edit(native, 'command: String(job.action).replace(/^[!$]\\s*/, "") }', 'command: String(job.action).replace(/^[!$]\\s*/, ""), timeoutMs: job.timeoutMs }')
edit(native, '      scope.active.shellFinished = true\n        scope.busy = false', '      scope.active.shellFinished = true\n        // A local shell terminal is not the terminal of a foreground model turn.')
edit(native, '        if (event.status !== "exited" || event.code !== 0) return pauseActive(scope, "shell-failed")', `        if (event.status !== "exited" || event.code !== 0) {
          const run = scope.active
          const paused = await pauseActive(scope, "shell-failed")
          const state = await read(scope)
          const job = (state.jobs || []).find((entry) => entry.id === run.jobID)
          if (job?.v2Run?.id === run.id) { delete job.v2Run; await save(scope, state) }
          if (scope.active === run) delete scope.active
          return paused
        }`)
edit(native, '    const epoch = scope.epoch\n    const state = await read(scope)\n    for (const job', `    const epoch = scope.epoch
    const state = await read(scope)
    clear(scope, "companionTimer")
    if (!(state.jobs || []).some(eligible)) return result()
    if (await nativeGoalReservesSession(scope.directory, scope.sessionID)) {
      if (current(scope)) {
        scope.companionTimer = setTimer(() => {
          delete scope.companionTimer
          return enqueue(scope, () => advance(scope)).catch(report)
        }, 1000)
        scope.companionTimer?.unref?.()
      }
      return result({ reason: "dedicated-goal-owns-session" })
    }
    for (const job`)
let runtimeSource = readFileSync(native, "utf8")
runtimeSource = runtimeSource.replaceAll('clear(scope, "timer"); clear(scope, "deadline")', 'clear(scope, "timer"); clear(scope, "deadline"); clear(scope, "companionTimer")')
writeFileSync(native, runtimeSource)
const bridge = "src/source/opencode2/event-bridge.js"
edit(bridge, '  directory,\n  onEvent', '  directory,\n  allowInboxCommands = true,\n  onEvent')
edit(bridge, '    const event = normalize(raw)', '    if (!allowInboxCommands && raw?.type === "session.inbox.enqueued") return undefined\n    const event = normalize(raw)')
const events = "src/source/opencode2/events.js"
edit(events, '  if (type === "session.created") {', '  if (type === "location.shutdown") return Object.freeze({ kind: "server", action: "disposed", directory })\n\n  if (type === "session.created") {')
const canary = "scripts/opencode2-loop-canary.mjs"
edit(canary, '    const cleanup = await module.default.setup(pluginContext)', `    const goalURL = process.env.OPENCODE_GOAL_V2_PLUGIN_URL
    const goalCleanup = goalURL ? await (await import(goalURL)).default.setup(ctx) : undefined
    const cleanup = await module.default.setup(pluginContext)`)
edit(canary, '      if (typeof cleanup === "function") await cleanup()', '      if (typeof cleanup === "function") await cleanup()\n      if (typeof goalCleanup === "function") await goalCleanup()')
edit(canary, '    const createdResponse = await request', '    if (process.env.OPENCODE_GOAL_V2_PLUGIN_URL) assert.ok(latestCommands.has("goal"), "both native plugin command registries must load")\n\n    const createdResponse = await request')
edit(canary, '    OPENCODE_LOOP_V2_PLUGIN_URL: pathToFileURL(path.join(repoRoot, "src", "source", "opencode2", "experimental.js")).href,', '    OPENCODE_LOOP_V2_PLUGIN_URL: pathToFileURL(path.join(repoRoot, "src", ...(process.env.OPENCODE2_NATIVE_REQUIRED === "1" ? ["native.js"] : ["source", "opencode2", "experimental.js"]))).href,')
edit(canary, '                    const line = JSON.stringify(event) + "\\\\n"', '                    const line = JSON.stringify(String(event?.type || "").startsWith("session.") ? event : { id: event?.id, type: event?.type }) + "\\\\n"')
edit(canary, '  execFileSync("git", ["init", "--quiet", workspace]', '  await writeFile(path.join(workspace, ".gitignore"), ".home/\\n.opencode/\\n*v2*events.jsonl\\n")\n  execFileSync("git", ["init", "--quiet", workspace]')
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
for (const test of ["native-shell-test", "native-coexistence-test"]) {
  if (!pkg.scripts.test.includes(`scripts/${test}.mjs`)) pkg.scripts.test = `node scripts/${test}.mjs && ` + pkg.scripts.test
}
pkg.scripts.prepack = 'node --check src/index.js && node --check src/server.js && node --check src/native.js'
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
const notice = `## Native OpenCode 2 (0.6.0)

The installer now defaults to the standalone native V2 plugin. It needs no V1 SDK or legacy command files for a local installation. Existing npm registrations migrate from \`plugin\` to \`plugins\` without dropping object options. Use \`--legacy-v1\` explicitly for the compatibility installation.

V2 prompt admission and durable inbox/execution/compaction events own scheduling. Core-generated user-role messages never authorize a session abort. An unfinished dedicated Goal reserves its session, including paused and handed-off states; Loop does not wake or replace that Goal. Soft iteration timeouts do not abort a native model/tool/compaction turn.

Scheduled shell commands use bounded local child processes when OpenCode does not expose \`session.shell\` to plugins. Automatic compaction stays host-owned. **Scheduled compaction requires a host exposing \`session.compact\`; OpenCode 2.0.18's published plugin Context does not expose it, and those commands are rejected before job creation rather than silently ignored.** Use OpenCode's built-in manual/automatic compaction on that host.

Prompt/command timers, watch and stop conditions, verification, preflight/postrun, notifications, checkpoints and diagnostic commands use the V2 runtime. Uncertain restart admissions pause for review rather than replaying potentially admitted work. The dedicated \`@bybrawe/opencode-goal\` plugin owns \`/goal\`; legacy Loop Goal records are preserved and are not silently reinterpreted as new Goal contracts.

`
const readme = readFileSync("README.md", "utf8")
if (!readme.includes("## Native OpenCode 2 (0.6.0)")) {
  const split = readme.indexOf("\n") + 1
  writeFileSync("README.md", readme.slice(0, split) + "\n" + notice + readme.slice(split))
}
const changelog = readFileSync("CHANGELOG.md", "utf8")
if (!changelog.includes("## 0.6.0")) {
  const split = changelog.indexOf("\n") + 1
  writeFileSync("CHANGELOG.md", changelog.slice(0, split) + '\n## 0.6.0 - 2026-09-29\n\n- Fix #164: persisted core user-message events cannot abort compaction; trusted admission hooks alone may steer legacy turns.\n- Activate native V2 queued scheduling and default local installation, preserving explicit V1 compatibility.\n- Correct unsupported plugin shell assumptions with a bounded local process lifecycle and correlated terminals.\n- Preserve dedicated Goal ownership, native compaction barriers, uncertain-admission safety, and configuration options.\n- Fix branch success reporting, timeout exit codes and self-matching completion markers.\n- Explicitly report the OpenCode 2.0.18 scheduled-compaction capability gap.\n\n' + changelog.slice(split))
}
console.log("Native V2 source finalization applied")
