import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const legacyPath = path.resolve("src/source/legacy-v1.js")
const modulePath = path.resolve("src/source/runtime/session-activity.js")
const source = await readFile(legacyPath, "utf8")

const blockStart = source.indexOf("\nfunction hasActiveToolCalls(sessionID)")
const blockEnd = source.indexOf("\nfunction startHeartbeat()", blockStart)
if (blockStart < 0 || blockEnd < 0) throw new Error("session activity block layout changed")

let extracted = source.slice(blockStart + 1, blockEnd).trim()
for (const name of [
  "hasActiveToolCalls",
  "markToolCallActive",
  "markToolCallFinished",
  "updateSessionRelationship",
  "updateSessionRelationshipFromEvent",
  "isDescendantSession",
  "hasBusyDescendant",
  "refreshSessionRelationships",
  "updateToolActivityFromEvent",
]) {
  extracted = extracted.replace(`${name === "refreshSessionRelationships" ? "async " : ""}function ${name}(`, `${name === "refreshSessionRelationships" ? "export async " : "export "}function ${name}(`)
}

const moduleSource = `import { now } from "../core/args.js"\nimport { sdkCall } from "../opencode/sdk.js"\nimport { updateSessionExecutionContext, deleteSessionExecutionContext } from "../opencode/session-context.js"\n\nexport const activeToolCalls = new Map()\nexport const sessionParents = new Map()\nexport const sessionStatuses = new Map()\nexport const sessionStatusSeenAt = new Map()\n\n${extracted}\n\nexport function clearSessionActivity(sessionID) {\n  activeToolCalls.delete(sessionID)\n  sessionParents.delete(sessionID)\n  sessionStatuses.delete(sessionID)\n  sessionStatusSeenAt.delete(sessionID)\n  deleteSessionExecutionContext(sessionID)\n}\n`

let next = source.slice(0, blockStart) + source.slice(blockEnd)
for (const line of [
  "const activeToolCalls = new Map()\n",
  "const sessionParents = new Map()\n",
  "const sessionStatuses = new Map()\n",
  "const sessionStatusSeenAt = new Map()\n",
]) {
  if (!next.includes(line)) throw new Error(`missing state declaration: ${line.trim()}`)
  next = next.replace(line, "")
}

const contextImportOld = 'import { normalizedModelRef, updateSessionExecutionContext, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext, deleteSessionExecutionContext } from "./opencode/session-context.js"\n'
const contextImportNew = 'import { normalizedModelRef, updateSessionExecutionContext, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"\n'
if (!next.includes(contextImportOld)) throw new Error("session context import layout changed")
next = next.replace(contextImportOld, contextImportNew)

const activityImport = 'import { activeToolCalls, sessionParents, sessionStatuses, sessionStatusSeenAt, hasActiveToolCalls, markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, isDescendantSession, hasBusyDescendant, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"\n'
const commandImport = 'import { markHandled, consumeHandled, hasHandledCommandEvent, markHandledCommandEvent, forgetHandledCommandEvent, clearCommandLifecycle, commandName, isPreset, isLoopCommandName, commandArgsText } from "./opencode/commands.js"\n'
if (!next.includes(commandImport)) throw new Error("command import layout changed")
next = next.replace(commandImport, commandImport + activityImport)

const cleanupOld = "    activeToolCalls.delete(sessionID)\n    sessionParents.delete(sessionID)\n    sessionStatuses.delete(sessionID)\n    sessionStatusSeenAt.delete(sessionID)\n    deleteSessionExecutionContext(sessionID)\n"
if (!next.includes(cleanupOld)) throw new Error("session cleanup layout changed")
next = next.replace(cleanupOld, "    clearSessionActivity(sessionID)\n")

await mkdir(path.dirname(modulePath), { recursive: true })
await writeFile(modulePath, moduleSource)
await writeFile(legacyPath, next)
