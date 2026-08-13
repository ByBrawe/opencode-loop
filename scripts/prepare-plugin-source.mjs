import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const sourcePath = path.resolve("src/source/legacy-v1.js")
const outputPath = path.resolve("build/plugin-v1.js")
const importAnchor = 'import { tool } from "@opencode-ai/plugin/tool"\n'
const startMarker = "function safeID(value) {"
const endMarker = "function parseLoopArgs(raw, defaults = {}) {"

const parserImport = `import {
  durationToText,
  parseCompactEvery,
  parseDuration,
  parseNonNegativeInt,
  parsePositiveInt,
  safeID,
  splitFirst,
  stripOuterQuotes,
  takeAllFlagValues,
  takeFlag,
  takeFlagValue,
} from "../src/source/core/parse-utils.js"
`

function requireSingle(input, marker, label) {
  const first = input.indexOf(marker)
  if (first < 0) throw new Error(`${label} marker was not found`)
  if (input.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label} marker appeared more than once`)
  }
  return first
}

const source = await readFile(sourcePath, "utf8")
const anchor = requireSingle(source, importAnchor, "plugin import anchor")
const start = requireSingle(source, startMarker, "parser block start")
const end = requireSingle(source, endMarker, "parser block end")
if (end <= start) throw new Error("parser block markers were not in the expected order")

const withoutParserHelpers = source.slice(0, start) + source.slice(end)
const insertAt = anchor + importAnchor.length
const composed = withoutParserHelpers.slice(0, insertAt)
  + parserImport
  + withoutParserHelpers.slice(insertAt)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, composed, "utf8")
console.log(`Composed ${path.relative(process.cwd(), outputPath)} from legacy V1 source + parser module`)
