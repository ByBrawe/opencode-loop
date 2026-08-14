function hasFunction(value, key) {
  return Boolean(value && typeof value[key] === "function")
}

function frozenRecord(value) {
  return Object.freeze(value)
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function unwrapEvent(value) {
  if (!value || typeof value !== "object") return value
  if (value.event?.type) return value.event
  if (value.data?.type) return value.data
  return value
}

function eventField(event, key) {
  return event?.[key] ?? event?.data?.[key] ?? event?.properties?.[key] ?? event?.payload?.[key]
}

function continuationText(iteration, maxRuns, objective) {
  return [
    "AUTONOMOUS OPENCODE LOOP ITERATION",
    `Iteration: ${iteration}/${maxRuns}`,
    `Objective: ${objective}`,
    "Continue from the current session state and do not repeat completed work.",
  ].join("\n")
}

const STEP_ENDED_EVENTS = new Set([
  "session.step.ended",
  "session.next.step.ended",
])

export const OPENCODE_LOOP_V2_HOST_REQUIREMENTS = Object.freeze([
  "event.subscribe",
  "session.prompt",
])

export const OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED = true

export const OPENCODE_LOOP_V2_RUNTIME_REQUIREMENTS = Object.freeze([
  ...OPENCODE_LOOP_V2_HOST_REQUIREMENTS,
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

  return frozenRecord({
    ready: hostBlockers.length === 0,
    hostReady: hostBlockers.length === 0,
    implementationReady: OPENCODE_LOOP_V2_RUNTIME_IMPLEMENTED,
    blockers: Object.freeze([...hostBlockers]),
    hostBlockers: Object.freeze(hostBlockers),
    commandSource: OPENCODE_LOOP_V2_COMMAND_SOURCE,
    context,
    command,
  })
}

export function startOpenCode2CanaryRuntime(ctx, options = {}) {
  const maxRuns = positiveInteger(options.maxRuns ?? process.env.OPENCODE_LOOP_V2_CANARY_MAX_RUNS)
  if (!maxRuns) return frozenRecord({ active: false, done: Promise.resolve(), sent: new Map() })

  const objective = String(options.objective ?? process.env.OPENCODE_LOOP_V2_CANARY_OBJECTIVE ?? "OpenCode Loop V2 canary")
  const sent = new Map()
  const seen = new Set()
  const dispatching = new Set()
  const trace = process.env.OPENCODE_LOOP_V2_CANARY_TRACE === "1"
  let traced = 0

  const done = (async () => {
    const events = await ctx.event.subscribe()
    for await (const raw of events) {
      const event = unwrapEvent(raw)
      if (trace && traced < 80) {
        traced += 1
        console.error("[opencode-loop-v2-event]", JSON.stringify({
          type: event?.type,
          sessionID: eventField(event, "sessionID"),
          assistantMessageID: eventField(event, "assistantMessageID"),
          rawType: raw?.type,
          rawDataType: raw?.data?.type,
          rawKeys: raw && typeof raw === "object" ? Object.keys(raw) : [],
          dataKeys: raw?.data && typeof raw.data === "object" ? Object.keys(raw.data) : [],
        }))
      }
      if (!STEP_ENDED_EVENTS.has(event?.type)) continue

      const sessionID = eventField(event, "sessionID")
      if (!sessionID) continue
      const stepID = eventField(event, "assistantMessageID") ?? eventField(event, "timestamp") ?? "unknown"
      const dedupeKey = `${sessionID}:${stepID}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const completed = sent.get(sessionID) ?? 0
      if (completed >= maxRuns || dispatching.has(sessionID)) continue

      const iteration = completed + 1
      dispatching.add(sessionID)
      try {
        if (trace) console.error("[opencode-loop-v2-dispatch]", JSON.stringify({ sessionID, iteration, maxRuns }))
        await ctx.session.prompt({
          sessionID,
          text: continuationText(iteration, maxRuns, objective),
        })
        sent.set(sessionID, iteration)
      } finally {
        dispatching.delete(sessionID)
      }
    }
  })()

  return frozenRecord({ active: true, done, sent })
}
