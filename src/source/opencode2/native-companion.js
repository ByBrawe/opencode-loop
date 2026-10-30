import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

// Read-only interoperation with Goal's session-sharded store. An unreadable or
// unsafe live shard is not permission to take over autonomous continuation.
export async function nativeGoalReservesSession(directory, sessionID) {
  const shard = createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
  const root = path.resolve(directory)
  const parts = [".opencode", "goals", `${shard}.json`]
  let file = root
  try {
    for (const part of parts) {
      file = path.join(file, part)
      const info = await lstat(file)
      if (info.isSymbolicLink()) return true
    }
    const goal = JSON.parse(await readFile(file, "utf8"))
    if (goal?.schemaVersion !== 1 || goal?.sessionID !== sessionID || typeof goal?.id !== "string") return true
    return !["completed", "cleared"].includes(goal.status)
  } catch (error) {
    return error?.code !== "ENOENT"
  }
}

// This is OpenCode's BUILT-IN Goal contract, not ByBrawe Goal's filesystem
// contract. Cross-plugin storage is private. Use the public, read-only RPC.
export const nativeGoalRPC = Object.freeze({
  id: "opencode.goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { anyOf: [{ type: "null" }, { type: "object" }] },
    },
  },
  events: {},
})

function expectsBuiltInGoal(version) {
  const match = String(version || "").match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:$|[^0-9])/)
  if (!match) return false
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3])
  return major > 2 || (major === 2 && (minor > 2 || (minor === 2 && patch >= 1)))
}

export async function nativeOpenCodeGoalReservesSession(ctx, sessionID) {
  // OpenCode 2.0/2.1 never shipped built-in Goal. A modern host missing the
  // public RPC cannot safely prove that no native Goal owns this session.
  if (typeof ctx?.rpc !== "function") return expectsBuiltInGoal(ctx?.app?.version)
  try {
    const goal = await ctx.rpc(nativeGoalRPC).get({ sessionID })
    if (goal === null) return false
    if (!goal || typeof goal !== "object" || Array.isArray(goal)) return true
    // Paused Goals still reserve the session; only an explicit completion
    // releases it to Loop. An unknown state must never authorize takeover.
    return goal.status !== "complete"
  } catch (error) {
    const type = error?.type || error?.data?.type || error?.error?.type
    if (type !== "rpc.unavailable") return true
    // The host may intentionally disable its built-in Goal. In that case
    // the RPC is absent, and Loop is allowed to run normally.
    if (typeof ctx?.plugin?.list !== "function") return expectsBuiltInGoal(ctx?.app?.version)
    try {
      const plugins = await ctx.plugin.list()
      if (!Array.isArray(plugins)) return true
      return plugins.some((plugin) => plugin?.id === "opencode.goal")
    } catch {
      return true
    }
  }
}
