import assert from "node:assert/strict"
import plugin, {
  OPENCODE_LOOP_PLUGIN_ID,
  OpenCodeLoopPlugin,
  OpenCodeLoopV2ExperimentalPlugin,
} from "../src/source/server.js"

assert.equal(plugin.id, OPENCODE_LOOP_PLUGIN_ID)
assert.equal(plugin.id, "@bybrawe/opencode-loop")
assert.equal(typeof plugin.server, "function", "OpenCode 1.x requires default.server()")
assert.equal(typeof plugin.setup, "function", "OpenCode 2.x requires default.setup()")
assert.strictEqual(plugin.server, OpenCodeLoopPlugin)
assert.equal(typeof OpenCodeLoopV2ExperimentalPlugin.setup, "function")

console.log("dual OpenCode 1/2 server entry contract passed")
