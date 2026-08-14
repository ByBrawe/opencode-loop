import { writeFile } from "node:fs/promises"

export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await writeFile("v2-probe-loaded.txt", "loaded\n", "utf8")
    console.log("LOOP_V2_CONTEXT_KEYS=" + Object.keys(ctx || {}).sort().join(","))
  },
}
