import { define } from "@opencode-ai/plugin/v2/promise"

export const V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export function detectV2Capabilities(ctx) {
  return {
    commandTransform: typeof ctx?.command?.transform === "function",
    sessionPrompt: typeof ctx?.session?.prompt === "function",
    sessionHook: typeof ctx?.session?.hook === "function",
    sessionWait: typeof ctx?.session?.wait === "function",
    eventSubscribe: typeof ctx?.event?.subscribe === "function",
    toolTransform: typeof ctx?.tool?.transform === "function",
  }
}

export function missingLoopV2Capabilities(capabilities) {
  const required = ["commandTransform", "sessionPrompt", "sessionHook", "sessionWait", "eventSubscribe"]
  return required.filter((name) => capabilities?.[name] !== true)
}

async function registerStatusCommand(ctx, capabilities) {
  if (!capabilities.commandTransform) return
  const missing = missingLoopV2Capabilities(capabilities)
  const summary = Object.entries(capabilities)
    .map(([name, available]) => `${name}=${available ? "yes" : "no"}`)
    .join(", ")

  await ctx.command.transform((commands) => {
    commands.update("loop-v2-status", (command) => {
      command.description = "Report the experimental OpenCode Loop V2 adapter status."
      command.template = [
        "OpenCode Loop V2 experimental adapter is active.",
        `Capabilities: ${summary}.`,
        missing.length
          ? `Full autonomous Loop V2 support is gated on: ${missing.join(", ")}.`
          : "The host exposes the capabilities required for the next Loop V2 implementation slice.",
        "Report this status without claiming that stable V1 behavior changed.",
      ].join("\n")
    })
  })
}

export const OpenCodeLoopV2Experimental = define({
  id: V2_PLUGIN_ID,
  setup: async (ctx) => {
    const capabilities = detectV2Capabilities(ctx)
    await registerStatusCommand(ctx, capabilities)
  },
})

export default OpenCodeLoopV2Experimental
