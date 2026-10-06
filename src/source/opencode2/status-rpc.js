import path from "node:path"
import { readState } from "../core/state.js"
import { LoopStatusRpc } from "../status-rpc.js"
import { formatLoopSidebar } from "../tui/format.js"

const unavailable = () => new Error("Loop status is unavailable for this session location.")
const record = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined)
// Panel text crosses a process boundary into a TUI renderer; strip C0/C1
// control characters so a persisted action string can never corrupt the frame.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// Presentation only. This handler never dispatches work, never mutates Loop
// state and never takes continuation ownership of the session it reports.
export async function registerLoopStatusRpc(ctx) {
  // Historical prototype hosts remain usable for lifecycle tests; their
  // missing RPC is not emulated by client-local filesystem reads.
  if (typeof ctx?.rpc?.register !== "function") return async () => {}

  const directory = ctx?.location?.directory
  if (!directory || !path.isAbsolute(directory) || typeof ctx?.session?.get !== "function") throw unavailable()

  let closed = false
  let disposal

  const registration = await ctx.rpc.register(LoopStatusRpc, {
    read: async (input, context) => {
      const request = record(input)
      const sessionID = request?.sessionID
      if (
        !request ||
        Object.keys(request).some((key) => key !== "sessionID") ||
        typeof sessionID !== "string" ||
        !sessionID ||
        sessionID.length > 256
      ) {
        throw unavailable()
      }
      if (closed || context?.signal?.aborted) throw unavailable()

      const session = record(await ctx.session.get({ sessionID }))
      if (closed || context?.signal?.aborted || session?.id !== sessionID) throw unavailable()

      // Only this server instance reports on a session it actually owns.
      const location = record(session?.location)
      const actual = location?.directory
      if (
        typeof actual !== "string" ||
        !path.isAbsolute(actual) ||
        path.relative(path.resolve(directory), path.resolve(actual)) !== ""
      ) {
        throw unavailable()
      }
      if ((location?.workspaceID ?? "") !== (ctx?.location?.workspaceID ?? "")) throw unavailable()

      let text
      try {
        const state = await readState(actual, sessionID)
        if (closed || context?.signal?.aborted) throw unavailable()
        text = formatLoopSidebar(state, Date.now())
      } catch (error) {
        if (error?.message === unavailable().message) throw error
        text = "OpenCode Loop\n! Loop storage unavailable"
      }
      text = text.replace(CONTROL_CHARS, "").slice(0, 4096)
      return { schemaVersion: 1, sessionID, directory: actual, text }
    },
  })

  return () => {
    if (disposal) return disposal
    closed = true
    disposal = Promise.resolve().then(async () => {
      await registration.dispose()
    })
    return disposal
  }
}

export default registerLoopStatusRpc