export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await ctx.agent.transform((draft) => {
      const first = draft.list()[0]
      if (!first) return
      draft.update(first.id, (agent) => {
        agent.description = `${agent.description || ""} LOOP_V2_PROBE_ACTIVE`.trim()
      })
    })
  },
}
