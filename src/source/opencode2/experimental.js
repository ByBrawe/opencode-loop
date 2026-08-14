import { define } from "@opencode-ai/plugin/v2/promise"
import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)

    if (capabilities.commandTransform) {
      await ctx.command.transform(() => {})
    }

    const bridge = createOpenCode2EventBridge()
    if (capabilities.eventSubscribe) {
      await bridge.attach(ctx.event.subscribe.bind(ctx.event))
    }

    return async () => {
      await bridge.dispose("plugin-cleanup")
    }
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
