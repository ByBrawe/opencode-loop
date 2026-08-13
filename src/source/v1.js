import LegacyOpenCodeLoopPlugin from "./legacy-v1.js"

const clientGenerations = new WeakMap()

function reserveClientGeneration(client, directory) {
  if (!client || typeof client !== "object") return () => true
  let generations = clientGenerations.get(client)
  if (!generations) {
    generations = new Map()
    clientGenerations.set(client, generations)
  }
  const key = String(directory || "")
  const generation = (generations.get(key) || 0) + 1
  generations.set(key, generation)
  return () => generations.get(key) === generation
}

function scopedClient(client) {
  if (!client || typeof client !== "object") return client
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function scheduleLegacyCleanup(dispose, isCurrentGeneration) {
  for (const delay of [0, 25, 100, 500, 2_000, 10_000, 30_000]) {
    const timer = setTimeout(() => {
      if (!isCurrentGeneration()) return
      Promise.resolve(dispose()).catch(() => {})
    }, delay)
    timer.unref?.()
  }
}

export const OpenCodeLoopPlugin = async (input = {}) => {
  const realClient = input?.client
  const isCurrentGeneration = reserveClientGeneration(realClient, input?.directory)
  const client = scopedClient(realClient)
  const hooks = await LegacyOpenCodeLoopPlugin({ ...input, client })
  const legacyDispose = typeof hooks?.dispose === "function" ? hooks.dispose.bind(hooks) : undefined
  if (!legacyDispose) return hooks

  let disposed = false
  return {
    ...hooks,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await legacyDispose()
      scheduleLegacyCleanup(legacyDispose, isCurrentGeneration)
    },
  }
}

export default OpenCodeLoopPlugin
