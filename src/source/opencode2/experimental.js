import { inspectOpenCode2Context } from "./capabilities.js"

async function loadDefine() {
  const current = await import("@opencode-ai/plugin")
  if (typeof current?.define === "function") return current.define

  const legacy = await import("@opencode-ai/plugin/v2/promise")
  if (typeof legacy?.define === "function") return legacy.define
  throw new Error("OpenCode 2 plugin define() API is unavailable")
}

const define = await loadDefine()

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
