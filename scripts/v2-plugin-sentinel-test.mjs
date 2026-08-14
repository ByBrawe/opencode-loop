import assert from "node:assert/strict"
import plugin, { OPENCODE_LOOP_V2_PLUGIN_ID } from "../src/source/opencode2/experimental.js"
import {
  OPENCODE_LOOP_V2_REQUIRED_COMMANDS,
  OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS,
  inspectOpenCode2CommandDraft,
  inspectOpenCode2CommandFiles,
  openCode2LoopRuntimeStatus,
} from "../src/source/opencode2/capabilities.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(typeof plugin.setup, "function")
assert.deepEqual(OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS, ["command.files", "session.events", "session.prompt"])

let registered
const context = {
  command: {
    transform: async (callback) => {
      registered = callback
      return { dispose: async () => {} }
    },
  },
}
await plugin.setup(context)
assert.equal(typeof registered, "function")

const commands = OPENCODE_LOOP_V2_REQUIRED_COMMANDS.map((name) => ({ name }))
const draft = {
  list: () => commands,
  get: (name) => commands.find((item) => item.name === name),
  update: () => {},
  remove: () => {},
}
await registered(draft)
assert.deepEqual(inspectOpenCode2CommandDraft(draft), { list: true, get: true, update: true, remove: true })
assert.equal(inspectOpenCode2CommandFiles(draft).ready, true)
assert.deepEqual(inspectOpenCode2CommandFiles(draft).missing, [])
assert.deepEqual(openCode2LoopRuntimeStatus(context, draft).blockers, ["session.events", "session.prompt"])

await plugin.setup({})
console.log("OpenCode 2 plugin sentinel contract passed")
