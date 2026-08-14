import { Plugin } from "@opencode-ai/plugin"
import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = Plugin.define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }

    await ctx.command.transform(() => {})

    const bridge = createOpenCode2EventBridge()
    if (typeof ctx?.event?.subscribe === "function") {
      await bridge.attach(ctx.event.subscribe.bind(ctx.event))
    }

    return async () => {
      await bridge.dispose("plugin-cleanup")
    }
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
