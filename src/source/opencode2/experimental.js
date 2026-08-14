import { inspectOpenCode2Context } from "./capabilities.js"
import { createOpenCode2EventBridge } from "./event-bridge.js"

export const OPENCODE_LOOP_V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export async function setupOpenCodeLoopV2(ctx) {
  const capabilities = inspectOpenCode2Context(ctx)
  if (!capabilities.eventSubscribe) throw new Error("OpenCode 2 event subscription is unavailable")
  if (!capabilities.sessionPrompt) throw new Error("OpenCode 2 session prompt is unavailable")

  if (capabilities.commandTransform) await ctx.command.transform(() => {})

  const bridge = createOpenCode2EventBridge({ directory: ctx?.options?.directory })
  await bridge.attach(ctx.event.subscribe.bind(ctx.event))
}

export const OpenCodeLoopV2ExperimentalPlugin = Object.freeze({
  id: OPENCODE_LOOP_V2_PLUGIN_ID,
  setup: setupOpenCodeLoopV2,
})

export default OpenCodeLoopV2ExperimentalPlugin
