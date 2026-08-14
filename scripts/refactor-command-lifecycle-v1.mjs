import { readFile, writeFile } from "node:fs/promises"

const file = new URL("../src/source/legacy-v1.js", import.meta.url)
let source = await readFile(file, "utf8")

const messageImport = 'import { guardLoopOwnedUserMessage, loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"\n'
const commandImport = 'import { markHandled, consumeHandled, hasHandledCommandEvent, markHandledCommandEvent, forgetHandledCommandEvent, clearCommandLifecycle, commandName, isPreset, isLoopCommandName, commandArgsText } from "./opencode/commands.js"\n'
const maps = 'const handledCommands = new Map()\nconst handledCommandEvents = new Map()\n'
const blockStart = '\nfunction commandKey(sessionID, name, args) {'
const blockEnd = '\nfunction rememberSession(directory, client, sessionID) {'
const cleanupOld = '    for (const key of handledCommands.keys()) if (key.startsWith(`${sessionID}:`)) handledCommands.delete(key)\n    for (const key of handledCommandEvents.keys()) if (key.startsWith(`${sessionID}:`)) handledCommandEvents.delete(key)\n'
const cleanupNew = '    clearCommandLifecycle(sessionID)\n'
const eventOld = '    const eventKey = commandEventKey(sessionID, input?.messageID)\n    if (handledCommandEvents.has(eventKey)) return true\n    handledCommandEvents.set(eventKey, now())\n'
const eventNew = '    if (hasHandledCommandEvent(sessionID, input?.messageID)) return true\n    markHandledCommandEvent(sessionID, input?.messageID)\n'
const forgetOld = '  if (source === "event") handledCommandEvents.delete(commandEventKey(sessionID, input?.messageID))\n'
const forgetNew = '  if (source === "event") forgetHandledCommandEvent(sessionID, input?.messageID)\n'

for (const [label, needle] of [
  ["message import", messageImport],
  ["command maps", maps],
  ["command block start", blockStart],
  ["command block end", blockEnd],
  ["command cleanup", cleanupOld],
  ["event dedupe block", eventOld],
  ["event forget block", forgetOld],
]) {
  if (!source.includes(needle)) throw new Error(`${label} not found`)
}
if (source.includes(commandImport)) throw new Error("command lifecycle import already present")

source = source.replace(messageImport, messageImport + commandImport)
source = source.replace(maps, "")
const start = source.indexOf(blockStart)
const end = source.indexOf(blockEnd)
if (start < 0 || end < 0 || end <= start) throw new Error("command lifecycle block markers not found in expected order")
source = source.slice(0, start) + "\n" + source.slice(end)
source = source.replace(cleanupOld, cleanupNew)
source = source.replace(eventOld, eventNew)
source = source.replace(forgetOld, forgetNew)

if (source.includes("const handledCommands = new Map()")) throw new Error("inline handled command map remains")
if (source.includes("const handledCommandEvents = new Map()")) throw new Error("inline handled event map remains")
if (source.includes("function markHandled(sessionID")) throw new Error("inline markHandled helper remains")
if (source.includes("function commandArgsText(args)")) throw new Error("inline command args helper remains")

await writeFile(file, source)
