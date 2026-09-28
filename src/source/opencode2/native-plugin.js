import path from "node:path"
import { createNativeLoopRuntime } from "./native-runtime.js"
import { createOpenCode2EventBridge } from "./event-bridge.js"
import { registerOpenCode2LoopCommands } from "./commands.js"
import { readSmallTextFile, appendLoopLog } from "../core/process.js"
import { stateDir } from "../core/state.js"
import { splitFirst } from "../core/args.js"

const HELP = `OpenCode Loop: native OpenCode 2 runtime
/loop 0s <task> --max-runs 3
/loop 5m <task> --verify "npm test" --pause-on-verify-fail
/loop --watch progress.md <task>
/loop 0s <task> --prompt-file instructions.md --include-file progress.md
/loop 0s <task> --compact-every 3
/loop 5m --shell npm test
/loop 15m --compact /compact
Controls: /loop-now, /loop-pause, /loop-resume, /loop-stop, /loop-remove, /loop-clear, /loop-status, /loop-export.
Preflight, postrun, notifications, stop files, completion markers, runtime/failure/run limits, branches and checkpoints are supported.
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
  id: "bybrawe.opencode-loop.native",
  async setup(ctx) {
    for (const [label, fn] of [["session.prompt", ctx?.session?.prompt], ["session.hook", ctx?.session?.hook], ["event.subscribe", ctx?.event?.subscribe], ["command.transform", ctx?.command?.transform]]) {
      if (typeof fn !== "function") throw new Error(`Native OpenCode Loop requires ${label}; use OpenCode 2.0.18 or newer.`)
    }
    const directory = String(ctx.location?.directory || ctx.options?.directory || "").trim()
    if (!directory) throw new Error("Native OpenCode Loop requires a project directory")
    const registrations = []
    const prompt = (request) => ctx.session.prompt({ ...request, delivery: request.delivery || "queue", metadata: { ...request.metadata, opencode_loop_v2: true } })
    const runtime = createNativeLoopRuntime({
      directory,
      prompt,
      command: typeof ctx.session.command === "function" ? (request) => ctx.session.command(request) : undefined,
      wait: typeof ctx.session.wait === "function" ? (request) => ctx.session.wait(request) : undefined,
      compact: typeof ctx.session.compact === "function" ? (request) => ctx.session.compact({ ...request, delivery: "queue" }) : undefined,
      shell: typeof ctx.session.shell === "function" ? (request) => ctx.session.shell(request) : undefined,
      // cancel() returns void. The durable inbox.cancelled event, not this
      // response alone, proves that an undelivered input can be refunded.
      cancel: typeof ctx.session.inbox?.cancel === "function" ? async (request) => { await ctx.session.inbox.cancel(request); return false } : undefined,
      onError: (error) => { void appendLoopLog(directory, "v2-native-error", { message: String(error?.message || error) }) },
    })
    const bridge = createOpenCode2EventBridge({ directory, onEvent: (event) => runtime.onEvent(event), onError: (error) => { void appendLoopLog(directory, "v2-native-event-error", { message: String(error?.message || error) }) } })
    let closed = false
    async function dispose() {
      if (closed) return
      closed = true
      await runtime.dispose()
      await bridge.dispose("native-plugin-disposed")
      for (const registration of registrations.reverse()) await cleanup(registration)
    }
    async function execute({ name, sessionID, arguments: argumentsText }) {
      if (closed) throw new Error("Native Loop is disposed")
      if (["loop-help", "loop-doctor", "loop-logs"].includes(name)) {
        const text = name === "loop-logs"
          ? (await readSmallTextFile(path.join(stateDir(directory), "loop.log"), 2_000_000)).split("\n").slice(-60).join("\n") || "No Loop log entries."
          : name === "loop-doctor"
            ? `Native OpenCode Loop\nHost: ${ctx.app?.version || "unknown"}\nDirectory: ${directory}\nPrompt hooks: enabled\nCompaction ownership: native host\nDelivery: durable queue\nScheduled timers: ${runtime.scheduledCount()}\nUse /loop-status for paused/admitted job state.`
            : HELP
        await prompt({ sessionID, text, resume: false })
        return { handled: true, accepted: true }
      }
      const event = { kind: "command", action: "executed", directory, sessionID, name, arguments: argumentsText }
      const result = await runtime.onEvent(event)
      if (result?.accepted === false) throw new Error(result.error || result.blockers?.join(" ") || "Loop command rejected")
      if (result?.accepted && ["loop", "loop-now", "loop-resume"].includes(name) && !(name === "loop" && result.job?.immediate === false)) await runtime.wake(event)
      return result
    }
    try {
      registrations.push(await ctx.session.hook("prompt", (event) => {
        if (event.metadata?.opencode_loop_v2 === true) return
        return runtime.onEvent({ kind: "foreground", directory, sessionID: event.sessionID })
      }))
      registrations.push(await ctx.session.hook("compaction", (event) => runtime.onEvent({ kind: "compaction", action: "started", directory, sessionID: event.sessionID })))
      registrations.push(await ctx.command.transform((draft) => {
        registerOpenCode2LoopCommands(draft, { execute })
        if (typeof draft.add !== "function") return
        for (const [name, flag] of [["loop-shell", "--shell"], ["loop-command", "--command"], ["loop-compact", "--compact"]]) {
          draft.add({ name, description: `Native Loop ${flag.slice(2)} schedule`, execute: (input) => {
            const [duration, rest] = splitFirst(input.prompt?.text || input.arguments || "")
            return execute({ name: "loop", sessionID: input.sessionID, arguments: `${duration || "0s"} ${flag} ${rest || (flag === "--compact" ? "/compact" : "")}` })
          } })
        }
      }))
      await bridge.attach(() => ctx.event.subscribe())
      await appendLoopLog(directory, "v2-native-ready", { host: ctx.app?.version || "unknown" })
      return dispose
    } catch (error) {
      await dispose().catch(() => {})
      throw error
    }
  },
})

export default OpenCodeLoopNativePlugin
