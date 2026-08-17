import { writeFile } from "node:fs/promises"

const COMMAND_SENTINEL = "__opencode_loop_missing_command_probe__"

function functionShape(value) {
  return typeof value === "function"
    ? { type: "function", length: value.length, source: String(value).slice(0, 800) }
    : { type: typeof value, length: null, source: null }
}

export default {
  id: "bybrawe.opencode-loop.v2.real-adapter-probe",
  async setup(ctx) {
    const pluginURL = process.env.OPENCODE_LOOP_V2_PLUGIN_URL
    const marker = process.env.OPENCODE_LOOP_V2_MARKER
    if (!pluginURL) throw new Error("OPENCODE_LOOP_V2_PLUGIN_URL is required")
    if (!marker) throw new Error("OPENCODE_LOOP_V2_MARKER is required")

    const module = await import(pluginURL)
    const plugin = module.default
    if (!plugin || typeof plugin.setup !== "function") throw new Error("experimental V2 plugin has no setup function")
    const cleanup = await plugin.setup(ctx)

    const sessionMethods = Object.fromEntries(
      Object.keys(ctx?.session || {})
        .sort()
        .map((key) => [key, typeof ctx.session[key]]),
    )
    const eventMethods = Object.fromEntries(
      Object.keys(ctx?.event || {})
        .sort()
        .map((key) => [key, typeof ctx.event[key]]),
    )
    const eventSubscribe = functionShape(ctx?.event?.subscribe)
    const sessionHook = functionShape(ctx?.session?.hook)
    const sessionPromptShape = functionShape(ctx?.session?.prompt)
    const sessionCommandShape = functionShape(ctx?.session?.command)

    let commandFieldProbe = { matched: false, error: "session command probe did not run" }
    if (typeof ctx?.session?.create === "function" && typeof ctx?.session?.command === "function") {
      try {
        const created = await ctx.session.create()
        const sessionID = String(created?.id || created?.data?.id || created?.sessionID || "")
        if (!sessionID) throw new Error("session.create returned no session id")
        try {
          await ctx.session.command({ sessionID, command: COMMAND_SENTINEL })
          commandFieldProbe = {
            matched: false,
            sessionID,
            error: "missing command unexpectedly succeeded",
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          commandFieldProbe = {
            matched: message.includes(`Command not found: ${COMMAND_SENTINEL}`),
            sessionID,
            error: message,
          }
        }
      } catch (error) {
        commandFieldProbe = {
          matched: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    await writeFile(marker, JSON.stringify({
      id: plugin.id,
      activated: true,
      commandTransform: typeof ctx?.command?.transform === "function",
      eventSubscribe: typeof ctx?.event?.subscribe === "function",
      eventSubscribeLength: eventSubscribe.length,
      eventSubscribeSource: eventSubscribe.source,
      eventMethods,
      sessionHook,
      sessionPrompt: typeof ctx?.session?.prompt === "function",
      sessionPromptShape,
      sessionCommand: typeof ctx?.session?.command === "function",
      sessionCommandShape,
      sessionShell: typeof ctx?.session?.shell === "function",
      sessionMethods,
      commandFieldProbe,
      toolTransform: typeof ctx?.tool?.transform === "function",
    }, null, 2), "utf8")

    return async () => {
      if (typeof cleanup === "function") await cleanup()
    }
  },
}