function hasFunction(value, key) {
  return Boolean(value && typeof value[key] === "function")
}

function frozenRecord(value) {
  return Object.freeze(value)
}

export const OPENCODE_LOOP_V2_HOST_REQUIREMENTS = Object.freeze([
  "event.subscribe",
  "session.prompt",
])

export const OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED = false

export const OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS = Object.freeze([
  ...OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
  "runtime.adapter",
])

export const OPENCODE_LOOP_V2_COMMAND_SOURCE = "file-definitions"

export function inspectOpenCode2Context(ctx) {
  const command = ctx?.command
  const session = ctx?.session
  const event = ctx?.event
  const tool = ctx?.tool

  return frozenRecord({
    commandTransform: hasFunction(command, "transform"),
    eventSubscribe: hasFunction(event, "subscribe"),
    sessionHook: hasFunction(session, "hook"),
    sessionPrompt: hasFunction(session, "prompt"),
    toolTransform: hasFunction(tool, "transform"),
    toolHook: hasFunction(tool, "hook"),
  })
}

export function inspectOpenCode2CommandDraft(draft) {
  return frozenRecord({
    list: hasFunction(draft, "list"),
    get: hasFunction(draft, "get"),
    update: hasFunction(draft, "update"),
    remove: hasFunction(draft, "remove"),
  })
}

export function openCode2LoopRuntimeStatus(ctx, commandDraft) {
  const context = inspectOpenCode2Context(ctx)
  const command = inspectOpenCode2CommandDraft(commandDraft)
  const hostBlockers = []

  if (!context.eventSubscribe) hostBlockers.push("event.subscribe")
  if (!context.sessionPrompt) hostBlockers.push("session.prompt")

  const blockers = [...hostBlockers]
  if (!OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED) blockers.push("runtime.adapter")

  return frozenRecord({
    ready: blockers.length === 0,
    hostReady: hostBlockers.length === 0,
    implementationReady: OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED,
    blockers: Object.freeze(blockers),
    hostBlockers: Object.freeze(hostBlockers),
    commandSource: OPENCODE_LOOP_V2_COMMAND_SOURCE,
    context,
    command,
  })
}
