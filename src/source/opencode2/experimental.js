import { inspectOpenCode2Context } from "./capabilities.js"
import { OPENCODE_LOOP_V2_COMMANDS, registerOpenCode2LoopCommands } from "./commands.js"
import { createOpenCode2DiagnosticsRuntime } from "./diagnostics.js"
import { createOpenCode2LogRuntime } from "./logging.js"
import { createOpenCode2PromptRuntime } from "./prompt-runtime.js"
import { createOpenCode2RuntimeAdapter } from "./runtime-adapter.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"
export { OPENCODE_LOOP_V2_COMMANDS }

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    let promptRuntime
    let diagnosticsRuntime
    const logRuntime = createOpenCode2LogRuntime()
    const runtimeDirectory = String(ctx?.location?.directory || ctx?.options?.directory || "").trim() || undefined

    const onRuntimeEvent = async (event) => {
      const promptResult = await promptRuntime?.onEvent(event)
      await logRuntime.record(event, promptResult)
      if (promptResult?.handled) return promptResult
      return await diagnosticsRuntime?.onEvent(event) ?? promptResult
    }

    const commandRegistration = await ctx.command.transform((draft) => registerOpenCode2LoopCommands(draft, {
      execute: async ({ name, sessionID, arguments: argumentsText, delivery }) => {
        if (!promptRuntime || !diagnosticsRuntime) {
          throw new Error("OpenCode Loop V2 runtime is not ready")
        }
        return await onRuntimeEvent(Object.freeze({
          kind: "command",
          action: "executed",
          sessionID: String(sessionID || ""),
          directory: runtimeDirectory,
          name,
          arguments: argumentsText,
          delivery,
        }))
      },
    }))

    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await commandRegistration?.dispose?.()
      return undefined
    }
    const runtime = createOpenCode2RuntimeAdapter(ctx, { directory: runtimeDirectory, onEvent: onRuntimeEvent })
    promptRuntime = createOpenCode2PromptRuntime({
      prompt: (request) => runtime.prompt(request),
      command: capabilities.sessionCommand ? (request) => runtime.command(request) : undefined,
    })
    diagnosticsRuntime = createOpenCode2DiagnosticsRuntime({
      prompt: (request) => runtime.prompt(request),
    })

    try {
      await runtime.start()
    } catch (error) {
      await promptRuntime?.dispose?.().catch(() => undefined)
      await commandRegistration?.dispose?.().catch(() => undefined)
      throw error
    }

    return async () => {
      await promptRuntime?.dispose?.()
      await runtime.dispose("plugin-cleanup")
      await commandRegistration?.dispose?.()
    }
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
