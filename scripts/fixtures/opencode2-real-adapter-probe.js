import { writeFile } from "node:fs/promises"

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

    await writeFile(marker, JSON.stringify({
      id: plugin.id,
      activated: true,
      commandTransform: typeof ctx?.command?.transform === "function",
      eventSubscribe: typeof ctx?.event?.subscribe === "function",
      sessionPrompt: typeof ctx?.session?.prompt === "function",
      sessionCommand: typeof ctx?.session?.command === "function",
      sessionShell: typeof ctx?.session?.shell === "function",
      sessionMethods,
      toolTransform: typeof ctx?.tool?.transform === "function",
    }, null, 2), "utf8")

    return async () => {
      if (typeof cleanup === "function") await cleanup()
    }
  },
}
