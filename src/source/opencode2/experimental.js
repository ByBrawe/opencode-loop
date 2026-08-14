export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    if (typeof ctx?.command?.transform !== "function") {
      throw new Error("OpenCode 2 command.transform capability is unavailable")
    }
    await ctx.command.transform(() => {})
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
