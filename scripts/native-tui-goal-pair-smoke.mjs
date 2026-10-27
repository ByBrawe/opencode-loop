import assert from "node:assert/strict"
import { testRender, createElement, insert } from "@opentui/solid"
import { createSignal } from "solid-js"
import loopPlugin from "../src/source/tui/index.js"
import goalPlugin from "@bybrawe/opencode-goal/tui"

// A native CLI TUI displays both independently contributed sidebar slots:
// Loop only reads persisted scheduler state; Goal keeps its own authority.
const slots = new Map()
const listeners = new Set()
const unregistered = []
const calls = []
const [selected, select] = createSignal("ses_one")
const directoryFor = (id) => `/remote/worktree/${id}`

const context = {
  theme: { text: { base: "#ffffff" } },
  data: {
    session: { get: (id) => ({ id, location: { directory: directoryFor(id), workspaceID: "w1" } }) },
    listen(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  },
  client: {
    rpc(definition) {
      assert.ok(["bybrawe-opencode-loop-status", "opencode-goal-status"].includes(definition.id))
      return {
        read: async ({ sessionID }, options) => {
          calls.push({ id: definition.id, sessionID, location: options?.location })
          return {
            schemaVersion: 1,
            sessionID,
            directory: options.location.directory,
            text: definition.id === "opencode-goal-status"
              ? `OpenCode Goals\nGoal status for ${sessionID}`
              : `OpenCode Loop\nLoop status for ${sessionID}`,
          }
        },
      }
    },
  },
  ui: {
    slot(definition) {
      assert.equal(definition.append, "sidebar.content")
      const id = slots.size + 1
      slots.set(id, definition)
      return () => {
        assert.ok(slots.delete(id), "unregister each slot only once")
        unregistered.push(id)
      }
    },
  },
}

const stopLoop = await loopPlugin.setup(context)
const stopGoal = await goalPlugin.setup(context)
assert.equal(slots.size, 2, "both native sidebar slots must register independently")
const view = await testRender(() => {
  const container = createElement("box")
  for (const slot of slots.values()) {
    insert(container, slot.render({ get sessionID() { return selected() } }))
  }
  return container
}, { width: 78, height: 16 })

try {
  await new Promise((resolve) => setTimeout(resolve, 140))
  await view.renderOnce()
  const first = view.captureCharFrame()
  assert.match(first, /OpenCode Loop/, "Loop slot paints visible text")
  assert.match(first, /OpenCode Goals/, "Goal slot paints visible text")
  assert.match(first, /Loop status for ses_one/)
  assert.match(first, /Goal status for ses_one/)

  select("ses_two")
  await new Promise((resolve) => setTimeout(resolve, 140))
  await view.renderOnce()
  const next = view.captureCharFrame()
  assert.match(next, /Loop status for ses_two/)
  assert.match(next, /Goal status for ses_two/)
  for (const id of ["bybrawe-opencode-loop-status", "opencode-goal-status"]) {
    assert.ok(calls.some((x) => x.id === id && x.sessionID === "ses_two" && x.location.directory === directoryFor("ses_two")),
      `independent ${id} request must track the new session and project`)
  }

  stopLoop()
  assert.equal(slots.size, 1, "Loop teardown must not unregister the Goal panel")
  const loopCount = calls.filter((x) => x.id === "bybrawe-opencode-loop-status").length
  for (const listener of [...listeners]) listener({ details: { type: "server.connected" } })
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.equal(calls.filter((x) => x.id === "bybrawe-opencode-loop-status").length, loopCount,
    "disposed Loop sidebar must not make another RPC while Goal remains active")

  stopGoal()
  assert.equal(slots.size, 0)
  assert.equal(unregistered.length, 2)
  assert.equal(listeners.size, 0, "both controllers must unsubscribe")
  console.log("Loop + published Goal native TUI slots render together and dispose independently: PASS")
} finally {
  stopLoop()
  stopGoal()
  view.renderer.destroy()
}
