import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2RuntimeAdapter } from "./runtime-adapter.js"
import { registerOpenCode2StatusTool } from "./status-tool.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

async function disposeRegistration(registration) {
  if (typeof registration?.dispose === "function") await registration.dispose()
}

async function disposeRegistrations(registrations) {
  const errors = []
  for (const registration of registrations) {
    try { await disposeRegistration(registration) } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "OpenCode 2 registration cleanup failed")
}

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    const commandRegistration = await ctx.command.transform(() => {})
    let toolRegistration
    try {
      toolRegistration = await registerOpenCode2StatusTool(ctx)
    } catch (error) {
      await disposeRegistration(commandRegistration).catch(() => undefined)
      throw error
    }

    const registrations = [toolRegistration, commandRegistration]
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await disposeRegistrations(registrations)
      return undefined
    }

    const runtime = createOpenCode2RuntimeAdapter(ctx)
    try {
      await runtime.start()
    } catch (error) {
      await disposeRegistrations(registrations).catch(() => undefined)
      throw error
    }

    return async () => {
      const errors = []
      try { await runtime.dispose("plugin-cleanup") } catch (error) { errors.push(error) }
      try { await disposeRegistrations(registrations) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, "OpenCode 2 plugin cleanup failed")
    }
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
