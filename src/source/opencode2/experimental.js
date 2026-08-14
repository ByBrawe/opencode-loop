import { define } from "@opencode-ai/plugin/v2/promise"
import { inspectOpenCode2CommandFiles, inspectOpenCode2Context } from "./capabilities.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export async function registerOpenCode2CommandProbe(ctx) {
  if (!inspectOpenCode2Context(ctx).commandTransform) return undefined
  return await ctx.command.transform((draft) => {
    inspectOpenCode2CommandFiles(draft)
  })
}

export const OpenCodeLoopV2ExperimentalPlugin = define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    await registerOpenCode2CommandProbe(ctx)
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
