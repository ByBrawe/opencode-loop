import { define } from "@opencode-ai/plugin/v2/promise"
import { createOpenCode2Adapter } from "./adapter.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = define({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const adapter = createOpenCode2Adapter(ctx)
    await adapter.start()
  },
})

export default OpenCodeLoopV2ExperimentalPlugin
