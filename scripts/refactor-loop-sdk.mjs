import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const file = path.resolve("src/source/legacy-v1.js")
const out = path.resolve("src/source/opencode/sdk.js")
const text = await readFile(file, "utf8")
const before = "function sdkError(result)"
const after = "\nfunction fireSdk(client, label, method, ...argsList)"
const importAfter = 'import { stateDir, ensureDir, pathExists, readState, writeState, removeState } from "./core/state.js"\n'
const a = text.indexOf(before)
const b = text.indexOf(after, a)
if (a < 0 || b <= a || !text.includes(importAfter)) throw new Error("source layout changed")
let block = text.slice(a, b).trimEnd()
block = block.replace("function sdkError(", "export function sdkError(")
block = block.replace("function sdkData(", "export function sdkData(")
block = block.replace("function sdkErrorMessage(", "export function sdkErrorMessage(")
block = block.replace("async function sdkCall(", "export async function sdkCall(")
const moduleText = `// OpenCode SDK compatibility helpers.\n${block}\n`
let next = text.slice(0, a) + text.slice(b)
next = next.replace(importAfter, importAfter + 'import { sdkErrorMessage, sdkCall } from "./opencode/sdk.js"\n')
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, moduleText)
await writeFile(file, next)
