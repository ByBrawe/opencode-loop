export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await ctx.reference.transform((draft) => {
      draft.add("loop-v2-probe", {
        type: "local",
        path: process.cwd(),
        description: "LOOP_V2_PROBE_ACTIVE",
      })
    })
  },
}
