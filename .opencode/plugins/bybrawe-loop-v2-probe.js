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
    await writeFile("/tmp/bybrawe-loop-v2-context.json", JSON.stringify({ keys: Object.keys(ctx).sort(), shape }, null, 2), "utf8")
  },
}
