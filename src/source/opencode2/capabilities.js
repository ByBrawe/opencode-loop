function hasFunction(value, key) {
  return Boolean(value && typeof value[key] === "function")
}

function frozenRecord(value) {
  return Object.freeze(value)
}

export const OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS = Object.freeze([
  "command.update",
  "session.events",
  "session.prompt",
])

export function inspectOpenCode2Context(ctx) {
  const command = ctx?.command
  const session = ctx?.session
  const event = ctx?.event
  const clientSession = ctx?.client?.session

  return frozenRecord({
    commandTransform: hasFunction(command, "transform"),
    sessionEvents: hasFunction(session, "hook") || hasFunction(event, "hook") || hasFunction(event, "subscribe"),
    sessionPrompt: hasFunction(session, "prompt") || hasFunction(clientSession, "prompt"),
  })
}

export function inspectOpenCode2CommandDraft(draft) {
  return frozenRecord({
    list: hasFunction(draft, "list"),
    get: hasFunction(draft, "get"),
    update: hasFunction(draft, "update"),
    remove: hasFunction(draft, "remove"),
    add: hasFunction(draft, "add") || hasFunction(draft, "create"),
  })
}

export function openCode2LoopRuntimeStatus(ctx, commandDraft) {
  const context = inspectOpenCode2Context(ctx)
  const command = inspectOpenCode2CommandDraft(commandDraft)
  const blockers = []

  if (!context.commandTransform) blockers.push("command.transform")
  if (!command.update) blockers.push("command.update")
  if (!context.sessionEvents) blockers.push("session.events")
  if (!context.sessionPrompt) blockers.push("session.prompt")

  return frozenRecord({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    context,
    command,
  })
}
