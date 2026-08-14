import { define } from "@opencode-ai/plugin/v2/promise"
import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    if (typeof ctx?.command?.transform !== "function") {
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
