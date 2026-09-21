export const OPENCODE_LOOP_V2_COMMANDS = Object.freeze({
  loop: Object.freeze({
    description: "Start an OpenCode auto-continue loop. Usage: /loop 5m <task>",
    template: "OpenCode Loop local command handled. Reply exactly: OK.",
  }),
  "loop-pause": Object.freeze({
    description: "Pause OpenCode Loop jobs.",
    template: "OpenCode Loop pause command handled locally. Reply exactly: OK.",
  }),
  "loop-resume": Object.freeze({
    description: "Resume OpenCode Loop jobs.",
    template: "OpenCode Loop resume command handled locally. Reply exactly: OK.",
  }),
  "loop-stop": Object.freeze({
    description: "Stop OpenCode Loop jobs.",
    template: "OpenCode Loop stop command handled locally. Reply exactly: OK.",
  }),
  "loop-remove": Object.freeze({
    description: "Remove OpenCode Loop jobs.",
    template: "OpenCode Loop remove command handled locally. Reply exactly: OK.",
  }),
  "loop-clear": Object.freeze({
    description: "Clear all OpenCode Loop jobs.",
    template: "OpenCode Loop clear command handled locally. Reply exactly: OK.",
  }),
  "loop-status": Object.freeze({
    description: "Show OpenCode Loop status for the current session.",
    template: "OpenCode Loop status command handled locally. Reply exactly: OK.",
  }),
  "loop-now": Object.freeze({
    description: "Run matching OpenCode Loop jobs on the next idle boundary.",
    template: "OpenCode Loop run-now command handled locally. Reply exactly: OK.",
  }),
  "loop-export": Object.freeze({
    description: "Export OpenCode Loop state for the current session.",
    template: "OpenCode Loop export command handled locally. Reply exactly: OK.",
  }),
  "loop-help": Object.freeze({
    description: "Show the experimental OpenCode 2 Loop command help.",
    template: "OpenCode Loop help command handled locally. Reply exactly: OK.",
  }),
  "loop-doctor": Object.freeze({
    description: "Show experimental OpenCode 2 Loop diagnostics.",
    template: "OpenCode Loop doctor command handled locally. Reply exactly: OK.",
  }),
  "loop-logs": Object.freeze({
    description: "Show recent experimental OpenCode 2 Loop runtime events.",
    template: "OpenCode Loop logs command handled locally. Reply exactly: OK.",
  }),
})

function commandArguments(input) {
  const prompt = input?.prompt
  if (typeof prompt?.text === "string") return prompt.text.trim()
  if (typeof input?.arguments === "string") return input.arguments.trim()
  return ""
}

export function registerOpenCode2LoopCommands(draft, options = {}) {
  if (!draft || typeof draft !== "object") {
    throw new Error("OpenCode 2 command transform draft is unavailable")
  }

  // OpenCode 2.0.11 exposes CommandEditor.add({ name, execute }). Earlier
  // beta hosts exposed update(name, mutate) over command-file definitions.
  // Support both without guessing the host version.
  if (typeof draft.add === "function") {
    const execute = options.execute
    if (typeof execute !== "function") {
      throw new Error("OpenCode 2 command draft.add requires a local Loop command executor")
    }
    for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
      draft.add({
        name,
        description: definition.description,
        execute: async (input) => await execute({
          name,
          sessionID: input?.sessionID,
          arguments: commandArguments(input),
          delivery: input?.delivery,
        }),
      })
    }
    return
  }

  if (typeof draft.update === "function") {
    for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
      draft.update(name, (command) => {
        command.template = definition.template
        command.description = definition.description
      })
    }
    return
  }

  throw new Error("OpenCode 2 command transform exposes neither add() nor update()")
}

export function parseOpenCode2LoopCommandText(value) {
  if (typeof value !== "string") return undefined
  for (const [name, definition] of Object.entries(OPENCODE_LOOP_V2_COMMANDS)) {
    const template = definition.template
    if (value === template) return Object.freeze({ name, arguments: "" })
    if (!value.startsWith(`${template}\n\n`)) continue
    return Object.freeze({
      name,
      arguments: value.slice(template.length + 2).trim(),
    })
  }
  return undefined
}
