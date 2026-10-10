// Shared, implementation-free RPC contract.
//
// Deliberately dependency-free: the server plugin bundle must not pull in
// @opencode/schema (and its effect/zod/ai-sdk graph) just to describe one
// read-only method. The host types this structurally as
// `Rpc.PortableDefinition`, so a plain frozen object satisfies both
// `ctx.rpc.register` on the server and `context.client.rpc` in the TUI, and the
// TUI process never loads Loop's scheduler, filesystem or ownership code.
//
// The reserved-name check mirrors @opencode/schema's Rpc.define so a future
// `rpc.`-prefixed error name still fails here rather than at runtime.
const RESERVED_ERROR_PREFIX = "rpc."

function assertNoReservedErrors(definition) {
  for (const method of Object.values(definition.methods)) {
    for (const name of Object.keys(method?.errors ?? {})) {
      if (name.startsWith(RESERVED_ERROR_PREFIX)) {
        throw new Error(`RPC error names starting with "${RESERVED_ERROR_PREFIX}" are reserved: ${name}`)
      }
    }
  }
}

export const LoopStatusRpc = Object.freeze({
  id: "bybrawe-opencode-loop-status",
  methods: Object.freeze({
    read: Object.freeze({
      input: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({ sessionID: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }) }),
        required: Object.freeze(["sessionID"]),
      }),
      output: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({
          schemaVersion: Object.freeze({ type: "integer", const: 1 }),
          sessionID: Object.freeze({ type: "string" }),
          directory: Object.freeze({ type: "string" }),
          text: Object.freeze({ type: "string", maxLength: 4096 }),
        }),
        required: Object.freeze(["schemaVersion", "sessionID", "directory", "text"]),
      }),
    }),
  }),
  events: Object.freeze({}),
})

assertNoReservedErrors(LoopStatusRpc)
