export default {
  id: "bybrawe.loop.v2-probe",
  setup: async (ctx) => {
    await ctx.command.transform((commands) => {
      commands.update("loop-v2-probe", (command) => {
        command.description = "OpenCode Loop V2 activation probe"
        command.template = "Reply exactly: LOOP_V2_PROBE"
      })
    })
  },
}
