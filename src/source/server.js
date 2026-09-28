import OpenCodeLoopV2ExperimentalPlugin from "./opencode2/experimental.js"

// Load the legacy runtime only when a V1 host invokes its server contract.
// A runtime URL prevents bundlers from inlining the legacy implementation.
// Both source and package entries have a sibling v1.js; the package shim
// delegates to the standalone V1 bundle, without initializing it on V2.
async function OpenCodeLoopPlugin(...args) {
  const { default: legacy } = await import(new URL("./v1.js", import.meta.url).href)
  return legacy(...args)
}

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
