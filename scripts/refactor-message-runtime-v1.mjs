import { readFile, writeFile } from "node:fs/promises"

const file = new URL("../src/source/legacy-v1.js", import.meta.url)
let source = await readFile(file, "utf8")

const hostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, activeRunCompletionFromMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"\n'
const messageImport = 'import { guardLoopOwnedUserMessage, loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"\n'
const guardConstants = 'const LOOP_OWNED_USER_MESSAGE_GUARD_MS = 10_000\nconst LOOP_OWNED_USER_MESSAGE_RETENTION_MS = 10 * 60_000\n'
const guardMap = 'const loopOwnedUserMessageGuards = new Map()\n'
const blockStart = '\nfunction guardLoopOwnedUserMessage(sessionID) {'
const blockEnd = '\nfunction commandKey(sessionID, name, args) {'
const cleanupOld = '    loopOwnedUserMessageGuards.delete(sessionID)\n'
const cleanupNew = '    clearLoopOwnedUserMessageGuard(sessionID)\n'

for (const [label, needle] of [
  ["host import", hostImport],
  ["guard constants", guardConstants],
  ["guard map", guardMap],
  ["guard block start", blockStart],
  ["guard block end", blockEnd],
  ["guard cleanup", cleanupOld],
]) {
  if (!source.includes(needle)) throw new Error(`${label} not found`)
}
if (source.includes(messageImport)) throw new Error("message lifecycle import already present")

source = source.replace(hostImport, hostImport + messageImport)
source = source.replace(guardConstants, "")
source = source.replace(guardMap, "")
const start = source.indexOf(blockStart)
const end = source.indexOf(blockEnd)
if (start < 0 || end < 0 || end <= start) throw new Error("message lifecycle block markers not found in expected order")
source = source.slice(0, start) + "\n" + source.slice(end)
source = source.replace(cleanupOld, cleanupNew)

if (source.includes("const loopOwnedUserMessageGuards = new Map()")) throw new Error("inline message guard map remains")
if (source.includes("function guardLoopOwnedUserMessage(sessionID)")) throw new Error("inline guard helper remains")
if (source.includes("async function say(client, sessionID, text)")) throw new Error("inline say helper remains")

await writeFile(file, source)
