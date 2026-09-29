import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCLI = process.env.npm_execpath
assert.ok(npmCLI, "run this through npm run package:smoke")
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 360_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
  return result.stdout
}
const temp = await mkdtemp(path.join(tmpdir(), "loop native package "))
try {
  const packed = JSON.parse(run(process.execPath, [npmCLI, "pack", root, "--json", "--ignore-scripts"], temp))
  assert.equal(packed.length, 1)
  const files = new Set(packed[0].files.map((entry) => entry.path))
  for (const entry of ["src/plugin.js", "src/v2.js", "src/server.js", "src/native.js", "src/v1.js", "src/index.js"]) assert.ok(files.has(entry), `missing ${entry}`)
  const consumer = path.join(temp, "consumer with spaces")
  await mkdir(consumer)
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(process.execPath, [npmCLI, "install", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", path.join(temp, packed[0].filename)], consumer)
  console.log(run(process.execPath, [path.join(root, "scripts/native-entry-test.mjs"), consumer], root).trim())
  console.log("Production tarball native entry isolation and lazy legacy delegation PASS")
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
