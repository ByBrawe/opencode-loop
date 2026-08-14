import { inspectOpenCode2Context } from "./capabilities.js"
import { setupOpenCode2Lifecycle } from "./runtime-bridge.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }
    await ctx.command.transform(() => {})
    return setupOpenCode2Lifecycle(ctx)
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
