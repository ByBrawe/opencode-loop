import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2HostContract } from "./host-contract.js"
import { handleOpenCode2LoopStatus } from "./status.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    await ctx.command.transform(() => {})
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) return undefined

    const subscribe = () => ctx.event.subscribe()
    const sendPrompt = (request) => ctx.session.prompt({
      sessionID: request.sessionID,
      noReply: request.noReply,
      ...(request.agent === undefined ? {} : { agent: request.agent }),
      ...(request.model === undefined ? {} : { model: request.model }),
      parts: [{ type: "text", text: request.text }],
    })

    let host
    const options = {
      subscribe,
      sendPrompt,
      onEvent: async (event) => {
        if (event.kind !== "command" || event.action !== "executed" || event.name !== "loop-status") return
        await handleOpenCode2LoopStatus({
          directory: event.directory,
          sessionID: event.sessionID,
          prompt: host.prompt,
        })
      },
    }
    host = createOpenCode2HostContract(options)
    const startHost = host.start.bind(host)
    const disposeHost = host.dispose.bind(host)
    await startHost()
    return disposeHost
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
