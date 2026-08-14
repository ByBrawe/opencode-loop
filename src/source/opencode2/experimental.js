import { inspectOpenCode2Context, startOpenCode2CanaryRuntime } from "./capabilities.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const OpenCodeLoopV2ExperimentalPlugin = {
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  async setup(ctx) {
    const capabilities = inspectOpenCode2Context(ctx)
    if (!capabilities.eventSubscribe || !capabilities.sessionPrompt) {
      throw new Error("OpenCode 2 event.subscribe and session.prompt capabilities are required")
    }
    startOpenCode2CanaryRuntime(ctx)
  },
}

export default OpenCodeLoopV2ExperimentalPlugin
