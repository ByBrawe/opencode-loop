import assert from "node:assert/strict"
import OpenCodeLoopPlugin from "../src/source/v1.js"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(typeof plugin.server, "function")
assert.equal(plugin.server, OpenCodeLoopPlugin)

console.log("OpenCode 2 adapter contract passed")
