import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import plugin from "../src/source/tui/index.js"
import { formatLoopSidebar } from "../src/source/tui/format.js"

// Renders the real published ./tui entry against the real OpenTUI primitives,
// asserting visible text rather than internal state. This is the gate that a
// unit test cannot cover: whether the slot claim actually paints.
let contribution
let listener
let requests = []
let unregisters = 0
let unsubscribes = 0

const [sessionID, selectSession] = createSignal("ses_one")

const context = {
  client: {
    rpc: () => ({
      read: async (input, options) => {
        requests.push({ input, options })
        // Render the real formatter output rather than a placeholder, so this
        // smoke covers format -> RPC payload -> painted frame.
        return {
          schemaVersion: 1,
          sessionID: input.sessionID,
          directory: options.location.directory,
          text: formatLoopSidebar({
            jobs: [
              {
                id: "job-1",
                name: input.sessionID,
                kind: "prompt",
                intervalMs: 300_000,
                immediate: false,
                createdAt: new Date(Date.now() - 600_000).toISOString(),
                lastRunAt: Date.now(),
                runCount: 12,
                failureCount: 0,
                enabled: true,
              },
            ],
          }),
        }
      },
    }),
  },
  theme: { text: { base: "#ffffff" } },
  data: {
    session: { get: (id) => ({ id, location: { directory: `/remote/${id}`, workspaceID: id } }) },
    listen: (callback) => {
      listener = callback
      return () => {
        unsubscribes++
      }
    },
  },
  ui: {
    slot(definition) {
      assert.equal(definition.append, "sidebar.content")
      contribution = definition
      return () => {
        unregisters++
      }
    },
  },
}

const close = await plugin.setup(context)
const view = await testRender(
  () => contribution.render({ get sessionID() { return sessionID() } }),
  { width: 60, height: 12 },
)

try {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await view.renderOnce()
  const first = view.captureCharFrame()
  // Real user-visible panel content, not just plumbing.
  assert.match(first, /OpenCode Loop/)
  assert.match(first, /1 job · 1 runnable/)
  assert.match(first, /ses_one · prompt · every 5m/)
  assert.match(first, /runs 12 · fail 0/)
  assert.doesNotMatch(first, /unavailable/i)

  // Switching session must repaint and must request the new remote location
  // rather than reusing the previous session's directory.
  selectSession("ses_two")
  await new Promise((resolve) => setTimeout(resolve, 100))
  await view.renderOnce()
  assert.match(view.captureCharFrame(), /ses_two · prompt/)
  assert.doesNotMatch(view.captureCharFrame(), /ses_one/)
  assert.equal(requests.at(-1).options.location.directory, "/remote/ses_two")

  // Cleanup must be idempotent and must detach both the slot and the listener.
  close()
  close()
  const count = requests.length
  listener({ details: { type: "server.connected" } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(requests.length, count, "a released panel must not keep polling")
  assert.equal(unregisters, 1)
  assert.equal(unsubscribes, 1)

  console.log("Native OpenCode Loop slot renders and switches remote sessions; cleanup is idempotent: PASS")
} finally {
  close()
  view.renderer.destroy()
}