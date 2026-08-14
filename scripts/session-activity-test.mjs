import assert from "node:assert/strict"
import {
  activeToolCalls,
  sessionParents,
  sessionStatuses,
  sessionStatusSeenAt,
  hasActiveToolCalls,
  markToolCallActive,
  markToolCallFinished,
  updateSessionRelationship,
  updateSessionRelationshipFromEvent,
  isDescendantSession,
  hasBusyDescendant,
  refreshSessionRelationships,
  updateToolActivityFromEvent,
  clearSessionActivity,
} from "../src/source/runtime/session-activity.js"

const parentID = "ses_parent"
const childID = "ses_child"
const listedChildID = "ses_listed_child"

for (const sessionID of [parentID, childID, listedChildID]) clearSessionActivity(sessionID)

updateSessionRelationship({ id: childID, parentID })
assert.equal(sessionParents.get(childID), parentID)
assert.equal(isDescendantSession(childID, parentID), true)
assert.equal(isDescendantSession(parentID, childID), false)

markToolCallActive({ sessionID: childID, callID: "call_1" })
assert.equal(hasActiveToolCalls(childID), true)
assert.equal(sessionStatuses.get(childID), "busy")
assert.ok((sessionStatusSeenAt.get(childID) || 0) > 0)
assert.equal(hasBusyDescendant(parentID), true)

markToolCallFinished({ sessionID: childID, callID: "call_1" })
assert.equal(hasActiveToolCalls(childID), false)
sessionStatuses.set(childID, "idle")
assert.equal(hasBusyDescendant(parentID), false)

updateToolActivityFromEvent({
  type: "message.part.updated",
  properties: {
    part: {
      type: "tool",
      sessionID: childID,
      callID: "call_2",
      id: "part_2",
      state: { status: "running" },
    },
  },
})
assert.equal(activeToolCalls.get(childID)?.has("call_2"), true)

updateToolActivityFromEvent({
  type: "message.part.updated",
  properties: {
    part: {
      type: "tool",
      sessionID: childID,
      callID: "call_2",
      id: "part_2",
      state: { status: "completed" },
    },
  },
})
assert.equal(hasActiveToolCalls(childID), false)

await refreshSessionRelationships({
  session: {
    list: async () => [{ id: listedChildID, parentID }],
  },
}, "/tmp/opencode-loop-session-activity")
assert.equal(sessionParents.get(listedChildID), parentID)

updateSessionRelationshipFromEvent({
  type: "session.deleted",
  properties: { info: { id: listedChildID, parentID } },
})
assert.equal(sessionParents.has(listedChildID), false)

sessionParents.set(parentID, childID)
sessionParents.set(childID, parentID)
assert.equal(isDescendantSession(parentID, "ses_missing"), false)
sessionParents.delete(parentID)

clearSessionActivity(childID)
assert.equal(activeToolCalls.has(childID), false)
assert.equal(sessionParents.has(childID), false)
assert.equal(sessionStatuses.has(childID), false)
assert.equal(sessionStatusSeenAt.has(childID), false)
clearSessionActivity(parentID)
clearSessionActivity(listedChildID)

console.log("session activity runtime tests passed")
