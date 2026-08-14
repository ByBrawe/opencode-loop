function hasFunction(value, key) {
  return Boolean(value && typeof value[key] === "function")
}

function frozenRecord(value) {
  return Object.freeze(value)
}

function commandName(value) {
  if (!value || typeof value !== "object") return undefined
  for (const key of ["name", "id", "command"]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return undefined
}

export const OPENCODE_LOOP_V2_COMMAND_SOURCE = "command-files"

export const OPENCODE_LOOP_V2_REQUIRED_COMMANDS = Object.freeze([
  "loop",
  "loop-now",
  "loop-pause",
  "loop-resume",
  "loop-stop",
  "loop-status",
  "loop-clear",
  "loop-help",
])

export const OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS = Object.freeze([
  "command.files",
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
  })
}

export function inspectOpenCode2CommandFiles(draft, requiredCommands = OPENCODE_LOOP_V2_REQUIRED_COMMANDS) {
  const command = inspectOpenCode2CommandDraft(draft)
  const required = [...requiredCommands].map((value) => String(value || "").trim()).filter(Boolean)
  const available = new Set()

  if (command.list) {
    try {
      for (const item of draft.list() || []) {
        const name = commandName(item)
        if (name) available.add(name)
      }
    } catch {}
  }

  if (command.get) {
    for (const name of required) {
      if (available.has(name)) continue
      try {
        if (draft.get(name)) available.add(name)
      } catch {}
    }
  }

  const missing = required.filter((name) => !available.has(name))
  return frozenRecord({
    source: OPENCODE_LOOP_V2_COMMAND_SOURCE,
    ready: missing.length === 0,
    required: Object.freeze(required),
    available: Object.freeze([...available].filter((name) => required.includes(name))),
    missing: Object.freeze(missing),
  })
}

export function openCode2LoopRuntimeStatus(ctx, commandDraft) {
  const context = inspectOpenCode2Context(ctx)
  const command = inspectOpenCode2CommandDraft(commandDraft)
  const commandFiles = inspectOpenCode2CommandFiles(commandDraft)
  const blockers = []

  if (!commandFiles.ready) blockers.push("command.files")
  if (!context.sessionEvents) blockers.push("session.events")
  if (!context.sessionPrompt) blockers.push("session.prompt")

  return frozenRecord({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    context,
    command,
    commandFiles,
  })
}
