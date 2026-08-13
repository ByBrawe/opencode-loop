import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const sourcePath = path.resolve("src/source/legacy-v1.js")
const modulePath = path.resolve("src/source/core/state.js")
const source = await readFile(sourcePath, "utf8")

const osImport = 'import os from "node:os"\n'
const argsImport = 'import { DEFAULT_GOAL_MAX_NO_PROGRESS, now, safeID, parseDuration, durationToText, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"\n'
const stateDirConstant = 'const STATE_DIR = ".opencode/opencode-loop"\n'
const baselineConstant = 'const STATE_BASELINE = Symbol("opencode-loop-state-baseline")\n'
const writeLocksConstant = 'const stateWriteLocks = new Map()\n'
const startNeedle = "function stateDir(directory)"
const endNeedle = "\nfunction sdkError(result)"

for (const needle of [osImport, argsImport, stateDirConstant, baselineConstant, writeLocksConstant, startNeedle, endNeedle]) {
  if (!source.includes(needle)) throw new Error(`refactor guard failed: missing ${JSON.stringify(needle)}`)
}

const start = source.indexOf(startNeedle)
const end = source.indexOf(endNeedle, start)
if (start < 0 || end <= start) throw new Error("refactor guard failed: state block boundaries are invalid")

let stateBlock = source.slice(start, end).trimEnd()
const exported = [
  ["function stateDir(", "export function stateDir("],
  ["async function ensureDir(", "export async function ensureDir("],
  ["async function pathExists(", "export async function pathExists("],
  ["async function readState(", "export async function readState("],
  ["async function writeState(", "export async function writeState("],
  ["async function removeState(", "export async function removeState("],
]
for (const [needle, replacement] of exported) {
  if (!stateBlock.includes(needle)) throw new Error(`refactor guard failed: missing state function ${needle}`)
  stateBlock = stateBlock.replace(needle, replacement)
}

const moduleSource = [
  'import { promises as fs } from "node:fs"',
  'import os from "node:os"',
  'import path from "node:path"',
  'import { safeID } from "./args.js"',
  "",
  'const STATE_DIR = ".opencode/opencode-loop"',
  'const STATE_BASELINE = Symbol("opencode-loop-state-baseline")',
  'const stateWriteLocks = new Map()',
  "",
  stateBlock,
  "",
].join("\n")

const stateImport = 'import { stateDir, ensureDir, pathExists, readState, writeState, removeState } from "./core/state.js"\n'
let updated = source.slice(0, start) + source.slice(end)
updated = updated.replace(osImport, "")
updated = updated.replace(stateDirConstant, "")
updated = updated.replace(baselineConstant, "")
updated = updated.replace(writeLocksConstant, "")
updated = updated.replace(argsImport, argsImport + stateImport)

if (updated === source) throw new Error("refactor guard failed: source did not change")
if (updated.includes(startNeedle)) throw new Error("refactor guard failed: state block still exists in legacy source")
if (!updated.includes("function sdkError(result)")) throw new Error("refactor guard failed: SDK layer was damaged")

await mkdir(path.dirname(modulePath), { recursive: true })
await writeFile(modulePath, moduleSource)
await writeFile(sourcePath, updated)
console.log(`extracted state persistence to ${path.relative(process.cwd(), modulePath)}`)
