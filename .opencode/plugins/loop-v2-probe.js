export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await ctx.agent.transform((draft) => {
      if (!draft.get("build")) return
      draft.update("build", (agent) => {
        agent.description = `${agent.description || ""} LOOP_V2_PROBE_ACTIVE`.trim()
      })
    })
  },
}
