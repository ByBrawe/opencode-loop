export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    console.log("LOOP_V2_CONTEXT_KEYS=" + Object.keys(ctx || {}).sort().join(","))
  },
}
