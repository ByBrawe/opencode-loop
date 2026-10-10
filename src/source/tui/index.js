import { Plugin } from "@opencode/plugin/tui"

const native = Plugin.define({
  id: "@bybrawe/opencode-loop",
  async setup(context) {
    const { setupNativeLoopTui } = await import("./native.js")
    return setupNativeLoopTui(context)
  },
})

export default native