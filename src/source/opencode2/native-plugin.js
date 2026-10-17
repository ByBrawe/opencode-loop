import path from "node:path"
import { createNativeSessionLocationGuard } from "./session-location.js"
import { createNativeShellHost } from "./native-shell.js"
import { createNativeLoopRuntime } from "./native-runtime.js"
import { createOpenCode2EventBridge } from "./event-bridge.js"
import { registerOpenCode2LoopCommands, OPENCODE_LOOP_V2_PRESET_NAMES, commandArguments } from "./commands.js"
import { registerLoopStatusRpc } from "./status-rpc.js"
import { readSmallTextFile, appendLoopLog } from "../core/process.js"
import { stateDir } from "../core/state.js"
import { initializeProgressFile } from "../core/progress.js"

const HELP = `OpenCode Loop: native OpenCode 2 runtime
/loop 0s <task> --max-runs 3
/loop 5m <task> --verify "npm test" --pause-on-verify-fail
/loop --watch progress.md <task>
/loop 0s <task> --prompt-file instructions.md --include-file progress.md
/loop 0s <task> --compact-every 3
/loop 5m --shell npm test
/loop 15m --compact /compact
Presets: /loop-dev, /loop-testfix, /loop-progress, /loop-safe-dev, /loop-ask, /loop-prompt, /loop-command, /loop-cmd, /loop-shell, /loop-compact.
/loop-init [progress.md] creates a missing project-local progress file without overwriting existing data.
Controls: /loop-now, /loop-pause, /loop-resume, /loop-stop, /loop-remove, /loop-clear, /loop-status, /loop-export.
Preflight, postrun, notifications, stop files, completion markers, runtime/failure/run limits, branches and checkpoints are supported.
Scheduled shell commands run as bounded local child processes managed by Loop; OpenCode 2's ctx.shell surface is a hook API, not a shell-execution method.
Manual /loop-compact, --compact and --compact-every use public session.compact when the V2 host exposes it. Loop matches the admitted manual compaction inputID and waits for host completion; older hosts without this capability reject the job before creation. Automatic compaction stays host-owned.
An unfinished dedicated Goal reserves its session; Loop will not override it.
--timeout pauses future iterations without aborting the current native model/tool/compaction operation.
--safe is a command heuristic, not a sandbox. --dry-run does not dispatch or run hooks.
Native sessions stay serialized; --allow-overlap is rejected.
Use @bybrawe/opencode-goal and /goal for native Goal contracts. Legacy Loop Goal state is not silently migrated.
An uncertain admission after a restart is paused for review instead of being replayed automatically.`

async function cleanup(value) {
  if (typeof value === "function") await value()
  else if (typeof value?.dispose === "function") await value.dispose()
  else if (typeof value?.unsubscribe === "function") await value.unsubscribe()
}

export const OpenCodeLoopNativePlugin = Object.freeze({
  id: "@bybrawe/opencode-loop",
  async setup(ctx) {
    for (const [label, fn] of [["session.get", ctx?.session?.get], ["session.prompt", ctx?.session?.prompt], ["session.hook", ctx?.session?.hook], ["event.subscribe", ctx?.event?.subscribe], ["command.transform", ctx?.command?.transform]]) {
      if (typeof fn !== "function") throw new Error(`Native OpenCode Loop requires ${label}; use OpenCode 2.0.18 or newer.`)
    }
    const directory = String(ctx.location?.directory || "").trim()
    if (!directory) throw new Error("Native OpenCode Loop requires a project directory")
    const ownsSession = createNativeSessionLocationGuard({
      directory, workspaceID: ctx.location?.workspaceID,
      getSession: (input) => ctx.session.get(input),
    })
    const registrations = []
    // Read-only sidebar telemetry. Presentation never participates in the
    // scheduling lifecycle, so it is registered and released independently.
    // Unlike the Goal companion this stays fail-open: a host that cannot serve
    // the panel must not lose the scheduler itself.
    let stopStatusRpc = async () => {}
    let statusRpcState = "unsupported"
    try {
      stopStatusRpc = await registerLoopStatusRpc(ctx)
      statusRpcState = typeof ctx?.rpc?.register === "function" ? "registered" : "unsupported"
    } catch (error) {
      statusRpcState = "unavailable"
      await appendLoopLog(directory, "v2-status-rpc-unavailable", { message: String(error?.message || error) }).catch(() => {})
    }
    if (statusRpcState === "registered") {
      await appendLoopLog(directory, "v2-status-rpc-ready", { host: ctx.app?.version || "unknown" }).catch(() => {})
    }
    registrations.push(() => stopStatusRpc())
    const lifecycleAbort = new AbortController()
    const prompt = (request) => ctx.session.prompt({ ...request, delivery: request.delivery || "queue", metadata: { ...request.metadata, opencode_loop_v2: true } })
    const shellHost = createNativeShellHost({
      directory,
      onTerminal: (event) => runtime.onEvent(event),
      onError: (error) => { void appendLoopLog(directory, "v2-shell-error", { message: String(error?.message || error) }).catch(() => {}) },
    })
    const runtime = createNativeLoopRuntime({
      directory,
      scopeAllowed: (scope) => ownsSession(scope.sessionID),
      prompt,
      command: typeof ctx.session.command === "function" ? (request) => ctx.session.command(request) : undefined,
      wait: typeof ctx.session.wait === "function" ? (request) => ctx.session.wait(request) : undefined,
      // Current V2 exposes public session.compact; older hosts may not.
      // Shell execution and inbox cancellation remain separate from SessionDomain.
      compact: typeof ctx.session.compact === "function" ? (request) => ctx.session.compact(request) : undefined,
      shell: (request) => shellHost.dispatch(request),
      cancel: undefined,
      onError: (error) => { void appendLoopLog(directory, "v2-native-error", { message: String(error?.message || error) }).catch(() => {}) },
    })
    const bridge = createOpenCode2EventBridge({ directory, allowInboxCommands: false, onEvent: async (event) => {
      if (event.sessionID && !(event.kind === "session" && event.action === "deleted") && !await ownsSession(event.sessionID)) return
      return runtime.onEvent(event)
    }, onError: (error) => { void appendLoopLog(directory, "v2-native-event-error", { message: String(error?.message || error) }).catch(() => {}) } })
    let closed = false
    let disposeTask
    function dispose() {
      if (disposeTask) return disposeTask
      closed = true
      disposeTask = Promise.resolve().then(async () => {
        const errors = []
        // Stop accepting events before aborting next(); iterator.return() alone
        // cannot wake an async generator blocked on a public server stream.
        const stopped = bridge.dispose("native-plugin-disposed").catch((error) => { errors.push(error) })
        lifecycleAbort.abort()
        for (const action of [() => runtime.dispose(), () => shellHost.dispose()]) {
          try { await action() } catch (error) { errors.push(error) }
        }
        await stopped
        for (const registration of [...registrations].reverse()) {
          try { await cleanup(registration) } catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, "Native Loop cleanup failed")
      })
      return disposeTask
    }
    async function execute({ name, sessionID, arguments: argumentsText }) {
      if (closed) throw new Error("Native Loop is disposed")
      if (!await ownsSession(sessionID)) throw new Error("Native Loop cannot resolve this session in the plugin location; use its own project/worktree.")
      if (closed) throw new Error("Native Loop is disposed")
      if (name === "loop-init") {
        const output = await initializeProgressFile(directory, argumentsText)
        await prompt({ sessionID, text: output.created ? `Created ${output.file}.` : `${output.file} already exists; preserved unchanged.`, resume: false })
        return { handled: true, accepted: true, ...output }
      }
      if (["loop-help", "loop-doctor", "loop-logs"].includes(name)) {
        const text = name === "loop-logs"
          ? (await readSmallTextFile(path.join(stateDir(directory), "loop.log"), 2_000_000)).split("\n").slice(-60).join("\n") || "No Loop log entries."
          : name === "loop-doctor"
            ? `Native OpenCode Loop\nHost: ${ctx.app?.version || "unknown"}\nDirectory: ${directory}\nPrompt hooks: enabled\nCompaction ownership: native host\nDelivery: durable queue\nScheduled timers: ${runtime.scheduledCount()}\nSidebar status RPC: ${statusRpcState}\nUse /loop-status for paused/admitted job state.`
            : HELP
        await prompt({ sessionID, text, resume: false })
        return { handled: true, accepted: true }
      }
      const event = { kind: "command", action: "executed", directory, sessionID, name, arguments: argumentsText }
      const result = await runtime.onEvent(event)
      if (result?.accepted === false) throw new Error(result.error || result.blockers?.join(" ") || "Loop command rejected")
      const shouldWake = result?.job ? result.job.immediate !== false : ["loop-now", "loop-resume"].includes(name)
      if (result?.accepted && shouldWake) await runtime.wake(event)
      return result
    }
    try {
      registrations.push(await ctx.session.hook("prompt", async (event) => {
        if (closed || event.metadata?.opencode_loop_v2 === true || !await ownsSession(event.sessionID)) return
        if (closed) return
        return runtime.onEvent({ kind: "foreground", directory, sessionID: event.sessionID })
      }))
      registrations.push(await ctx.session.hook("compaction", async (event) => {
      if (closed || !await ownsSession(event.sessionID)) return
      if (!closed) return runtime.onEvent({ kind: "compaction", action: "started", directory, sessionID: event.sessionID })
    }))
      registrations.push(await ctx.command.transform((draft) => {
        registerOpenCode2LoopCommands(draft, { execute })
        if (typeof draft.add !== "function") return
        for (const name of [...OPENCODE_LOOP_V2_PRESET_NAMES, "loop-init"]) {
          draft.add({
            name,
            description: name === "loop-init" ? "Create a missing project-local progress file." : `Native Loop ${name.slice(5)} preset`,
            execute: (input) => execute({ name, sessionID: input.sessionID, arguments: commandArguments(input) }),
          })
        }
      }))
      await bridge.attach(() => ctx.event.subscribe({ signal: lifecycleAbort.signal }))
      await appendLoopLog(directory, "v2-native-ready", { host: ctx.app?.version || "unknown" })
      return dispose
    } catch (error) {
      await dispose().catch(() => {})
      throw error
    }
  },
})

export default OpenCodeLoopNativePlugin
