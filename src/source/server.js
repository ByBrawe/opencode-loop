import OpenCodeLoopPlugin from "./v1.js"
import OpenCodeLoopV2ExperimentalPlugin from "./opencode2/experimental.js"

export const OPENCODE_LOOP_PLUGIN_ID = "@bybrawe/opencode-loop"

export const OpenCodeLoopPluginModule = Object.freeze({
  id: OPENCODE_LOOP_PLUGIN_ID,

  // OpenCode 1.x PluginModule contract.
  server: OpenCodeLoopPlugin,

  // OpenCode 2.x promise-plugin contract.
  setup: (context) => OpenCodeLoopV2ExperimentalPlugin.setup(context),
})

export { OpenCodeLoopPlugin, OpenCodeLoopV2ExperimentalPlugin }

export default OpenCodeLoopPluginModule
