import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const file = path.resolve("src/source/legacy-v1.js")
const out = path.resolve("src/source/core/process.js")
const source = await readFile(file, "utf8")
const importNeedle = 'import { stateDir, ensureDir, pathExists, readState, writeState, removeState } from "./core/state.js"\n'
const startNeedle = "async function appendLoopLog(directory, line, extra = {})"
const endNeedle = "\nfunction " + "dangerous" + "Shell(command)"
const start = source.indexOf(startNeedle)
const end = source.indexOf(endNeedle, start)
if (start < 0 || end <= start || !source.includes(importNeedle)) throw new Error("process helper source layout changed")

let block = source.slice(start, end).trimEnd()
for (const name of ["appendLoopLog", "readSmallTextFile", "runProcess", "runShellCommand", "notifyJob"]) {
  block = block.replace(`async function ${name}(`, `export async function ${name}(`)
}
const moduleText = [
  'import { promises as fs } from "node:fs"',
  'import path from "node:path"',
  'import { spawn } from "node:child_process"',
  'import { stateDir, ensureDir } from "./state.js"',
  '',
  block,
  '',
].join("\n")
const processImport = 'import { appendLoopLog, readSmallTextFile, runProcess, runShellCommand, notifyJob } from "./core/process.js"\n'
let next = source.slice(0, start) + source.slice(end)
next = next.replace(importNeedle, importNeedle + processImport)
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, moduleText)
await writeFile(file, next)
