import { writeFile } from "node:fs/promises"

export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    const describe = (value) => {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return typeof value
      try { return Object.keys(value).sort() } catch { return [] }
    }
    const shape = Object.fromEntries(
      Object.keys(ctx).sort().map((key) => [key, describe(ctx[key])]),
    )
    const inspect = (fn) => ({
      length: typeof fn === "function" ? fn.length : null,
      source: typeof fn === "function" ? String(fn).slice(0, 4000) : null,
    })
    const calls = {
      eventSubscribe: inspect(ctx.event?.subscribe),
      sessionPrompt: inspect(ctx.session?.prompt),
      sessionHook: inspect(ctx.session?.hook),
      sessionGet: inspect(ctx.session?.get),
      toolTransform: inspect(ctx.tool?.transform),
      toolHook: inspect(ctx.tool?.hook),
    }
    await writeFile(
      "/tmp/bybrawe-loop-v2-context.json",
      JSON.stringify({ keys: Object.keys(ctx).sort(), shape, calls }, null, 2),
      "utf8",
    )
  },
}
