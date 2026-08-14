export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await ctx.command.transform((draft) => {
      if (!draft.get("v2-probe")) return
      draft.update("v2-probe", (command) => {
        command.description = `${command.description || ""} LOOP_V2_PROBE_ACTIVE`.trim()
      })
    })
  },
}
