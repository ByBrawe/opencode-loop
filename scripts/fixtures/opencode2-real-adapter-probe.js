import { writeFile } from "node:fs/promises"

const COMMAND_SENTINEL = "__opencode_loop_missing_command_probe__"
const REQUIRED_COMMAND = "loop-status"

export default {
  id: "bybrawe.opencode-loop.v2.real-adapter-probe",
  async setup(ctx) {
    const pluginURL = process.env.OPENCODE_LOOP_V2_PLUGIN_URL
    const marker = process.env.OPENCODE_LOOP_V2_MARKER
    if (!pluginURL) throw new Error("OPENCODE_LOOP_V2_PLUGIN_URL is required")
    if (!marker) throw new Error("OPENCODE_LOOP_V2_MARKER is required")

    const registeredCommands = []
    const commandProxy = ctx?.command && typeof ctx.command.transform === "function"
      ? new Proxy(ctx.command, {
          get(target, property, receiver) {
            if (property !== "transform") return Reflect.get(target, property, receiver)
            return async (callback) => target.transform((draft) => {
              const draftProxy = new Proxy(draft, {
                get(draftTarget, draftProperty, draftReceiver) {
                  if (draftProperty !== "update") return Reflect.get(draftTarget, draftProperty, draftReceiver)
                  return (name, update) => {
                    registeredCommands.push(String(name))
                    return draftTarget.update(name, update)
                  }
                },
              })
              return callback(draftProxy)
            })
          },
        })
      : ctx?.command
    const pluginContext = new Proxy(ctx, {
      get(target, property, receiver) {
        if (property === "command") return commandProxy
        return Reflect.get(target, property, receiver)
      },
    })

    const module = await import(pluginURL)
    const plugin = module.default
    if (!plugin || typeof plugin.setup !== "function") throw new Error("experimental V2 plugin has no setup function")
    const cleanup = await plugin.setup(pluginContext)
    if (!registeredCommands.includes(REQUIRED_COMMAND)) {
      throw new Error(`real OpenCode 2 command transform did not register ${REQUIRED_COMMAND}: ${JSON.stringify(registeredCommands)}`)
    }

    const sessionMethods = Object.fromEntries(
      Object.keys(ctx?.session || {})
        .sort()
        .map((key) => [key, typeof ctx.session[key]]),
    )

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
      registeredCommands: [...new Set(registeredCommands)],
      eventSubscribe: typeof ctx?.event?.subscribe === "function",
      sessionPrompt: typeof ctx?.session?.prompt === "function",
      sessionCommand: typeof ctx?.session?.command === "function",
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
