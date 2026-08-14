import { define } from "@opencode-ai/plugin"
import { inspectOpenCode2Context } from "./capabilities.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }
    await ctx.command.transform(() => {})
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
