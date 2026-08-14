import { missingOpenCode2Contract } from "./contract.js"

export const OPENCODE2_PLUGIN_ID = "bybrawe.opencode-loop.v2"

export const OpenCode2LoopExperimental = {
  id: OPENCODE2_PLUGIN_ID,
  setup: async (ctx) => {
    const missing = missingOpenCode2Contract(ctx)
    if (missing.length) {
      throw new Error(`OpenCode Loop V2 host contract unavailable: ${missing.join(", ")}`)
    }
  },
}

export default OpenCode2LoopExperimental
