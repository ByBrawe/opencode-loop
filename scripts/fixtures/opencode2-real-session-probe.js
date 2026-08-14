import { writeFile } from "node:fs/promises"

function eventStream(registration) {
  const stream = registration?.stream ?? registration
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new TypeError("V2 event subscription did not return an async stream")
  }
  return stream
}

function rawType(value) {
  return value?.payload?.type || value?.event?.type || value?.type
}

function rawSessionID(value) {
  const event = value?.payload || value?.event || value
  return event?.properties?.sessionID || event?.properties?.info?.id
}

export default {
  id: "bybrawe.opencode-loop.v2.real-session-probe",
  async setup(ctx) {
    const runtimeURL = process.env.OPENCODE_LOOP_V2_RUNTIME_URL
    const marker = process.env.OPENCODE_LOOP_V2_SESSION_MARKER
    if (!runtimeURL) throw new Error("OPENCODE_LOOP_V2_RUNTIME_URL is required")
    if (!marker) throw new Error("OPENCODE_LOOP_V2_SESSION_MARKER is required")

    const { createOpenCode2RuntimeAdapter } = await import(runtimeURL)
    const state = {
      ready: false,
      promptStarted: false,
      promptCompleted: false,
      rawTypes: [],
      normalized: [],
    }
    let markerWrite = Promise.resolve()
    const persist = () => {
      markerWrite = markerWrite.then(() => writeFile(marker, JSON.stringify(state, null, 2), "utf8"))
      return markerWrite
    }

    const adapter = createOpenCode2RuntimeAdapter(ctx, {
      onEvent: async (event) => {
        state.normalized.push(`${event.kind}:${event.action}`)
        if (state.normalized.length > 80) state.normalized.shift()
        await persist()
      },
      onError: (error) => {
        state.error = String(error?.stack || error)
        void persist()
      },
    })
    await adapter.start()

    const registration = await ctx.event.subscribe()
    const iterator = eventStream(registration)[Symbol.asyncIterator]()
    let stopped = false
    const pump = (async () => {
      while (!stopped) {
        const next = await iterator.next()
        if (next?.done) break
        const type = rawType(next.value)
        if (type) {
          state.rawTypes.push(type)
          if (state.rawTypes.length > 120) state.rawTypes.shift()
        }
        const sessionID = rawSessionID(next.value)
        if (!state.promptStarted && type === "session.created" && sessionID) {
          state.promptStarted = true
          await persist()
          try {
            await adapter.prompt({ sessionID, text: "V2_REAL_SESSION_CANARY", delivery: "queue", resume: true })
            state.promptCompleted = true
          } catch (error) {
            state.promptError = String(error?.stack || error)
          }
        }
        await persist()
      }
    })().catch((error) => {
      state.streamError = String(error?.stack || error)
      void persist()
    })

    state.ready = true
    await persist()

    return async () => {
      stopped = true
      await iterator.return?.().catch?.(() => undefined)
      await adapter.dispose("real-session-probe-cleanup")
      await pump.catch(() => undefined)
      await markerWrite.catch(() => undefined)
    }
  },
}
