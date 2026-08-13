import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptsDir, "..")
const sourcePath = path.join(scriptsDir, "comprehensive-test.mjs")
const timeoutMs = Math.max(5_000, Number(process.env.OPENCODE_LOOP_COMPREHENSIVE_TIMEOUT_MS) || 60_000)
const tempPath = path.join(os.tmpdir(), `opencode-loop-comprehensive-watchdog-${process.pid}-${Date.now()}.mjs`)

const source = await fs.readFile(sourcePath, "utf8")
const pluginURL = pathToFileURL(path.join(rootDir, "src", "index.js")).href
let instrumented = source.replace('import OpenCodeLoopPlugin from "../src/index.js"', `import OpenCodeLoopPlugin from ${JSON.stringify(pluginURL)}`)
instrumented = instrumented.replace(
  /^await (test[A-Za-z0-9_]+)\(\)$/gm,
  'globalThis.__opencodeLoopActiveCase = "$1"; await $1(); globalThis.__opencodeLoopActiveCase = undefined',
)
if (instrumented === source) throw new Error("failed to instrument comprehensive test")

await fs.writeFile(tempPath, instrumented, "utf8")
const watchdog = setTimeout(() => {
  const active = globalThis.__opencodeLoopActiveCase
  throw new Error(`OpenCode Loop comprehensive test timed out after ${timeoutMs}ms${active ? ` while running ${active}` : ""}`)
}, timeoutMs)

try {
  await import(`${pathToFileURL(tempPath).href}?run=${Date.now()}`)
} finally {
  clearTimeout(watchdog)
  try { await fs.rm(tempPath, { force: true }) } catch {}
}
