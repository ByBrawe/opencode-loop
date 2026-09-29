import { Plugin } from "@opencode/plugin"
import bundled from "./server.js"

export * from "./server.js"

const native = Plugin.define({
  id: "@bybrawe/opencode-loop",
  setup: (context) => bundled.setup(context),
})

export const OpenCodeLoopPluginModule = Object.freeze({
  ...native,

  // OpenCode 1.x compatibility remains a separate implementation. V2 uses
  // id/setup; V1 1.18.29+ uses server().
  server: bundled.server,
})

export default OpenCodeLoopPluginModule
