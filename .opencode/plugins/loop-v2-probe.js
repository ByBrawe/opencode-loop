console.error("LOOP_V2_MODULE_IMPORTED")

export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    console.error("LOOP_V2_SETUP_CALLED:" + Object.keys(ctx || {}).sort().join(","))
    if (!ctx?.command?.transform) {
      console.error("LOOP_V2_COMMAND_TRANSFORM_MISSING")
      return
    }
    await ctx.command.transform((draft) => {
      if (!draft.get("v2-probe")) return
      draft.update("v2-probe", (command) => {
        command.description = `${command.description || ""} LOOP_V2_PROBE_ACTIVE`.trim()
      })
    })
    console.error("LOOP_V2_SETUP_REGISTERED")
  },
}
