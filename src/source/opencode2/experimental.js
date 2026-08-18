import { inspectOpenCode2Context } from "./capabilities.js"
import { OPENCODE_LOOP_V2_COMMANDS, registerOpenCode2LoopCommands } from "./commands.js"
import { createOpenCode2DiagnosticsRuntime } from "./diagnostics.js"
import { createOpenCode2LogRuntime } from "./logging.js"
import { createOpenCode2PromptRuntime } from "./prompt-runtime.js"
import { createOpenCode2RuntimeAdapter } from "./runtime-adapter.js"
import { createOpenCode2ShellBoundary } from "./shell-boundary.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"
export { OPENCODE_LOOP_V2_COMMANDS }

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    const commandRegistration = await ctx.command.transform(registerOpenCode2LoopCommands)
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await commandRegistration?.dispose?.()
      return undefined
    }

    let promptRuntime
    let diagnosticsRuntime
    let shellBoundaryRuntime
    const logRuntime = createOpenCode2LogRuntime()
    const onRuntimeEvent = async (event) => {
      const shellResult = await shellBoundaryRuntime?.onEvent(event)
      if (shellResult?.handled) {
        await logRuntime.record(event, shellResult)
        return shellResult
      }

      const promptResult = await promptRuntime?.onEvent(event)
      await logRuntime.record(event, promptResult)
      if (promptResult?.handled) return promptResult
      return await diagnosticsRuntime?.onEvent(event) ?? promptResult
    }
    const runtime = createOpenCode2RuntimeAdapter(ctx, { onEvent: onRuntimeEvent })
    shellBoundaryRuntime = createOpenCode2ShellBoundary({
      prompt: (request) => runtime.prompt(request),
      capabilities,
    })
    promptRuntime = createOpenCode2PromptRuntime({
      prompt: (request) => runtime.prompt(request),
      command: capabilities.sessionCommand ? (request) => runtime.command(request) : undefined,
    })
    diagnosticsRuntime = createOpenCode2DiagnosticsRuntime({
      prompt: (request) => runtime.prompt(request),
      capabilities,
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
