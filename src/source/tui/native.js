import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { LoopStatusRpc } from "../status-rpc.js"
import { createLoopStatusController } from "./status-controller.js"

export function setupNativeLoopTui(context) {
  if (
    typeof context.ui?.slot !== "function" ||
    typeof context.client?.rpc !== "function" ||
    typeof context.data?.session?.get !== "function" ||
    typeof context.data?.listen !== "function"
  ) {
    throw new Error("Loop sidebar requires the OpenCode 2 native CLI slot, data and RPC APIs.")
  }

  const status = context.client.rpc(LoopStatusRpc)
  const cleanups = new Set()
  let closed = false

  const unregister = context.ui.slot({
    append: "sidebar.content",
    render: (props) => {
      if (closed) return null

      // Public OpenTUI render primitives, so published JS needs no JSX compiler.
      const element = createElement("text")
      setProp(element, "fg", context.theme.text.base)
      const [text, setText] = createSignal("OpenCode Loop\nLoading server status...")
      insert(element, text)

      const controller = createLoopStatusController({
        read: (input, options) => status.read(input, options),
        publish: setText,
      })

      const stop = context.data.listen(({ details }) => {
        if (details.type === "server.connected") {
          controller.invalidate()
          return
        }
        const sessionID =
          details.data?.sessionID ??
          details.data?.session?.id ??
          (details.type === "session.deleted" ? details.data?.id : undefined)
        if (sessionID) controller.invalidate(sessionID)
      })

      let released = false
      const release = () => {
        if (released) return
        released = true
        controller.dispose()
        stop()
        cleanups.delete(release)
      }
      cleanups.add(release)
      onCleanup(release)

      createEffect(() => {
        const sessionID = props.sessionID
        const session = context.data.session.get(sessionID)
        // Never substitute the TUI process's own directory for a remote,
        // missing or differently located session.
        void controller.select(sessionID, session?.location)
      })

      return element
    },
  })

  return () => {
    if (closed) return
    closed = true
    const errors = []
    for (const release of [...cleanups]) {
      try {
        release()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      unregister()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, "Loop sidebar cleanup failed")
  }
}
