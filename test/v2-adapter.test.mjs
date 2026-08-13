import assert from "node:assert/strict"
import plugin, { V2_PLUGIN_ID, inspectLoopV2Readiness } from "../src/source/opencode2/experimental.js"

assert.equal(plugin.id, V2_PLUGIN_ID)
assert.equal(typeof plugin.setup, "function")

const readiness = inspectLoopV2Readiness({})
assert.equal(readiness.autonomousReady, false)
assert.ok(readiness.missing.length > 0)

console.log("V2 adapter contract passed")
