import { readFile, writeFile } from "node:fs/promises"

const file = new URL("../src/source/legacy-v1.js", import.meta.url)
let source = await readFile(file, "utf8")

const anchor = 'import { normalizedModelRef, updateSessionExecutionContext, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext, deleteSessionExecutionContext } from "./opencode/session-context.js"\n'
const hostImport = 'import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, activeRunCompletionFromMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"\n'
const startMarker = "\nfunction fireSdk(client, label, method, ...argsList) {"
const endMarker = "\nfunction guardLoopOwnedUserMessage(sessionID) {"

if (!source.includes(anchor)) throw new Error("session-context import anchor not found")
if (source.includes(hostImport)) throw new Error("host import already present")
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
if (start < 0 || end < 0 || end <= start) throw new Error("host helper block markers not found in expected order")
if (source.indexOf(startMarker, start + 1) !== -1) throw new Error("host helper start marker is not unique")
if (source.indexOf(endMarker, end + 1) !== -1) throw new Error("host helper end marker is not unique")

source = source.replace(anchor, anchor + hostImport)
const adjustedStart = source.indexOf(startMarker)
const adjustedEnd = source.indexOf(endMarker)
source = source.slice(0, adjustedStart) + "\n" + source.slice(adjustedEnd)

await writeFile(file, source)
