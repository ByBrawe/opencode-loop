import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"
import { handleOpenCode2LoopStatus } from "./status.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) throw new Error("OpenCode 2 command.transform capability is unavailable")
    if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event.subscribe capability is unavailable")
    if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session.prompt capability is unavailable")

    await ctx.command.transform(() => {})

    let host
    host = createOpenCode2HostContract({
      subscribe: ctx.event.subscribe.bind(ctx.event),
      sendPrompt: async (request) => await ctx.session.prompt({
        sessionID: request.sessionID,
        noReply: request.noReply,
        parts: [{ type: "text", text: request.text }],
      }),
      onEvent: async (event) => {
        if (event.kind !== "command" || event.action !== "executed" || event.name !== "loop-status") return
        await handleOpenCode2LoopStatus({
          directory: event.directory,
          sessionID: event.sessionID,
          prompt: host.prompt,
        })
      },
    })
    await host.start()
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
