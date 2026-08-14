import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export function mapOpenCode2PromptRequest(input = {}) {
  if (input.agent !== undefined || input.model !== undefined || input.noReply === true) {
    throw new Error("OpenCode 2 experimental prompt bridge does not yet support agent, model, or noReply overrides")
  }
  return Object.freeze({
    sessionID: input.sessionID,
    prompt: Object.freeze({ text: input.text }),
    resume: true,
  })
}

export function createOpenCode2ExperimentalHost(ctx, options = {}) {
  const capabilities = inspectOpenCode2Context(ctx)
  if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event.subscribe capability is unavailable")
  if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session.prompt capability is unavailable")

  return createOpenCode2HostContract({
    directory: options.directory,
    onEvent: options.onEvent,
    onError: options.onError,
    subscribe: () => ctx.event.subscribe(),
    sendPrompt: (request) => ctx.session.prompt(mapOpenCode2PromptRequest(request)),
  })
}

export const OpenCodeLoopV2ExperimentalPlugin = Object.freeze({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const host = createOpenCode2ExperimentalHost(ctx)
    await host.start()
    if (typeof ctx.command?.transform === "function") await ctx.command.transform(() => {})
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
