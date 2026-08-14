import { createOpenCode2EventBridge } from "./event-bridge.js"

export async function setupOpenCode2Lifecycle(ctx) {
  if (typeof ctx?.event?.subscribe !== "function") {
    throw new Error("OpenCode 2 event.subscribe capability is unavailable")
  }

  const bridge = createOpenCode2EventBridge()
  await bridge.attach(() => ctx.event.subscribe())

  return async () => {
    await bridge.dispose("plugin-disposed")
  }
}
