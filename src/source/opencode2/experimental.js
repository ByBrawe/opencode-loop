import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2PromptRuntime } from "./prompt-runtime.js"
import { createOpenCode2RuntimeAdapter } from "./runtime-adapter.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    const commandRegistration = await ctx.command.transform(() => {})
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await commandRegistration?.dispose?.()
      return undefined
    }

    let promptRuntime
    const onRuntimeEvent = async (event) => promptRuntime?.onEvent(event)
    const runtime = createOpenCode2RuntimeAdapter(ctx, { onEvent: onRuntimeEvent })
    promptRuntime = createOpenCode2PromptRuntime({
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
