import { inspectOpenCode2Context } from "./capabilities.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

// OpenCode's V2 define() helper is an identity function. Keeping the descriptor
// dependency-free lets the experimental adapter load across beta package layouts
// where the Promise API moved from ./v2/promise to the package root.
export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.commandTransform) {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }
    await ctx.command.transform(() => {})
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
