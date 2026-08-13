import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const file = path.resolve("src/source/legacy-v1.js")
const out = path.resolve("src/source/opencode/session-context.js")
const text = await readFile(file, "utf8")
const sdkImport = 'import { sdkErrorMessage, sdkCall } from "./opencode/sdk.js"\n'
const localAgent = 'const LOCAL_COMMAND_AGENT = "opencode-loop-local"\n'
const cacheLine = 'const sessionExecutionContexts = new Map()\n'
const before = "function normalizedModelRef(model)"
const after = "\nfunction hasActiveToolCalls(sessionID)"
const a = text.indexOf(before)
const b = text.indexOf(after, a)
if (a < 0 || b <= a || !text.includes(sdkImport) || !text.includes(localAgent) || !text.includes(cacheLine)) throw new Error("source layout changed")

let block = text.slice(a, b).trimEnd()
block = block.replace("function normalizedModelRef(", "export function normalizedModelRef(")
block = block.replace("function updateSessionExecutionContext(", "export function updateSessionExecutionContext(")
block = block.replace("async function captureSessionExecutionContext(", "export async function captureSessionExecutionContext(")
const moduleText = [
  'import { sdkCall } from "./sdk.js"',
  '',
  'const LOCAL_COMMAND_AGENT = "opencode-loop-local"',
  'const sessionExecutionContexts = new Map()',
  '',
  block,
  '',
  'export function getSessionExecutionContext(sessionID) { return sessionExecutionContexts.get(sessionID) }',
  'export function setSessionExecutionContext(sessionID, context) { sessionExecutionContexts.set(sessionID, context); return context }',
  'export function deleteSessionExecutionContext(sessionID) { sessionExecutionContexts.delete(sessionID) }',
  '',
].join('\n')

const sessionImport = 'import { normalizedModelRef, updateSessionExecutionContext, captureSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext, deleteSessionExecutionContext } from "./opencode/session-context.js"\n'
let next = text.slice(0, a) + text.slice(b)
next = next.replace(localAgent, "")
next = next.replace(cacheLine, "")
next = next.replace(sdkImport, sdkImport + sessionImport)
next = next.replace('normalizedModelRef(sessionExecutionContexts.get(sessionID)?.model)', 'normalizedModelRef(getSessionExecutionContext(sessionID)?.model)')
next = next.replaceAll('const previous = sessionExecutionContexts.get(sessionID) || {}', 'const previous = getSessionExecutionContext(sessionID) || {}')
next = next.replace('sessionExecutionContexts.set(sessionID, { ...previous, model })', 'setSessionExecutionContext(sessionID, { ...previous, model })')
next = next.replaceAll('sessionExecutionContexts.delete(sessionID)', 'deleteSessionExecutionContext(sessionID)')
next = next.replace('const executionContext = sessionExecutionContexts.get(sessionID) || { agent: "build" }', 'const executionContext = getSessionExecutionContext(sessionID) || { agent: "build" }')
if (next.includes('sessionExecutionContexts')) throw new Error("session cache reference remained in legacy source")

await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, moduleText)
await writeFile(file, next)
