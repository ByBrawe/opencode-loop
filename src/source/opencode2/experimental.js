import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2PromptRuntime } from "./prompt-runtime.js"
import { createOpenCode2RuntimeAdapter } from "./runtime-adapter.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OPENCODE_LOOP_V2_COMMANDS = Object.freeze({
  loop: Object.freeze({
    description: "Start an OpenCode auto-continue loop. Usage: /loop 5m <task>",
    template: "OpenCode Loop local command handled. Reply exactly: OK.",
  }),
  "loop-pause": Object.freeze({
    description: "Pause OpenCode Loop jobs.",
    template: "OpenCode Loop pause command handled locally. Reply exactly: OK.",
  }),
  "loop-resume": Object.freeze({
    description: "Resume OpenCode Loop jobs.",
    template: "OpenCode Loop resume command handled locally. Reply exactly: OK.",
  }),
  "loop-stop": Object.freeze({
    description: "Stop OpenCode Loop jobs.",
    template: "OpenCode Loop stop command handled locally. Reply exactly: OK.",
  }),
  "loop-remove": Object.freeze({
    description: "Remove OpenCode Loop jobs.",
    template: "OpenCode Loop remove command handled locally. Reply exactly: OK.",
  }),
  "loop-clear": Object.freeze({
    description: "Clear all OpenCode Loop jobs.",
    template: "OpenCode Loop clear command handled locally. Reply exactly: OK.",
  }),
})

function registerCommands(draft) {
  if (!draft || typeof draft.update !== "function") {
    throw new Error("OpenCode 2 command draft.update capability is unavailable")
  }
  for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
    draft.update(name, (command) => {
      command.template = definition.template
      command.description = definition.description
    })
  }
}

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    const commandRegistration = await ctx.command.transform(registerCommands)
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      await commandRegistration?.dispose?.()
      return undefined
    }

    let promptRuntime
    const onRuntimeEvent = async (event) => promptRuntime?.onEvent(event)
    const runtime = createOpenCode2RuntimeAdapter(ctx, { onEvent: onRuntimeEvent })
    promptRuntime = createOpenCode2PromptRuntime({
      prompt: (request) => runtime.prompt(request),
      command: capabilities.sessionCommand ? (request) => runtime.command(request) : undefined,
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
