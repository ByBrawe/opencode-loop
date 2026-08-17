import assert from "node:assert/strict"
import plugin, {
  OPENCODE_LOOP_V2_COMMANDS,
  OPENCODE_LOOP_V2_PLUGIN_ID,
} from "../src/source/opencode2/experimental.js"
import {
  OPENCODE_LOOP_V2_COMMAND_SOURCE,
  OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
  OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED,
  OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS,
  inspectOpenCode2CommandDraft,
  inspectOpenCode2Context,
  openCode2LoopRuntimeStatus,
} from "../src/source/opencode2/capabilities.js"

assert.equal(plugin.id, OPENCODE_LOOP_V2_PLUGIN_ID)
assert.equal(plugin.id, "bybrawe.opencode-loop.v2.experimental")
assert.equal(typeof plugin.setup, "function")
assert.equal(OPENCODE_LOOP_V2_COMMAND_SOURCE, "plugin-transform")
assert.equal(OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED, false)
assert.deepEqual(OPENCODE_LOOP_V2_HOST_REQUIREMENTS, ["event.subscribe", "session.prompt"])
assert.deepEqual(OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS, ["event.subscribe", "session.prompt", "runtime.adapter"])
assert.deepEqual(Object.keys(OPENCODE_LOOP_V2_COMMANDS), [
  "loop",
  "loop-pause",
  "loop-resume",
  "loop-stop",
  "loop-remove",
  "loop-clear",
])

let transforms = 0
let registered
const currentContext = {
  command: {
    transform: async (callback) => {
      transforms += 1
      registered = callback
    },
  },
}
const setupResult = await plugin.setup(currentContext)
assert.equal(setupResult, undefined)
assert.equal(transforms, 1)
assert.equal(typeof registered, "function")

const commands = new Map()
const currentDraft = {
  list: () => [...commands.values()],
  get: (name) => commands.get(name),
  update: (name, update) => {
    const command = commands.get(name) ?? { name, template: "" }
    update(command)
    command.name = name
    commands.set(name, command)
  },
  remove: (name) => commands.delete(name),
}
await registered(currentDraft)

assert.deepEqual([...commands.keys()], Object.keys(OPENCODE_LOOP_V2_COMMANDS))
for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
  const command = commands.get(name)
  assert.equal(command?.name, name)
  assert.equal(command?.template, definition.template)
  assert.equal(command?.description, definition.description)
}

let missingDraftUpdateFailed = false
try {
  await registered({})
} catch (error) {
  missingDraftUpdateFailed = /command draft\.update capability is unavailable/.test(String(error))
}
assert.equal(missingDraftUpdateFailed, true)

assert.deepEqual(inspectOpenCode2Context(currentContext), {
  commandTransform: true,
  eventSubscribe: false,
  sessionHook: false,
  sessionPrompt: false,
  sessionCommand: false,
  sessionShell: false,
  toolTransform: false,
  toolHook: false,
})
assert.deepEqual(inspectOpenCode2CommandDraft(currentDraft), {
  list: true,
  get: true,
  update: true,
  remove: true,
})

const currentStatus = openCode2LoopRuntimeStatus(currentContext, currentDraft)
assert.deepEqual(currentStatus.hostBlockers, ["event.subscribe", "session.prompt"])
assert.deepEqual(currentStatus.blockers, ["event.subscribe", "session.prompt", "runtime.adapter"])
assert.equal(currentStatus.hostReady, false)
assert.equal(currentStatus.implementationReady, false)
assert.equal(currentStatus.ready, false)
assert.equal(currentStatus.commandSource, "plugin-transform")

const futureContext = {
  command: { transform: async () => {} },
  event: { subscribe: async () => {} },
  session: {
    prompt: async () => ({}),
    command: async () => ({}),
  },
}
const futureCapabilities = inspectOpenCode2Context(futureContext)
assert.equal(futureCapabilities.sessionCommand, true)
assert.equal(futureCapabilities.sessionShell, false)
const futureStatus = openCode2LoopRuntimeStatus(futureContext, currentDraft)
assert.deepEqual(futureStatus.hostBlockers, [])
assert.deepEqual(futureStatus.blockers, ["runtime.adapter"])
assert.equal(futureStatus.hostReady, true)
assert.equal(futureStatus.implementationReady, false)
assert.equal(futureStatus.ready, false)
assert.equal(futureStatus.commandSource, "plugin-transform")

let missingCapabilityFailed = false
try {
  await plugin.setup({})
} catch (error) {
  missingCapabilityFailed = /command\.transform capability is unavailable/.test(String(error))
}
assert.equal(missingCapabilityFailed, true)

console.log("OpenCode 2 plugin sentinel contract passed")
