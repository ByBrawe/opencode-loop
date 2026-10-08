import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCLI = process.env.npm_execpath
assert.ok(npmCLI, "run this through npm run package:smoke")
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, npm_config_fetch_retries: "1", npm_config_fetch_timeout: "90000" },
  })
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
  if (result.error) throw new Error(`npm smoke subprocess failed: ${result.error.message}\n${output}`, { cause: result.error })
  assert.equal(result.status, 0, output)
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
  const packedTarball = path.join(temp, packed[0].filename)
  const installArgs = ["install", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund"]
  try {
    // npm ci populated this job's npm cache from the lockfile. A cache-only
    // install remains an exact, clean npm consumer when all metadata is present.
    run(process.execPath, [npmCLI, ...installArgs, "--offline", packedTarball], consumer)
    console.log("Clean tarball npm install from local cache PASS")
  } catch (error) {
    if (!/ENOTCACHED|cache mode is .only-if-cached./i.test(String(error))) throw error
    if (process.platform !== "win32" || process.env.OPENCODE_PACKAGE_SMOKE_REQUIRE_INSTALL === "1") {
      console.warn("Offline cache incomplete: performing strict bounded online npm consumer install")
      run(process.execPath, [npmCLI, ...installArgs, "--prefer-offline", packedTarball], consumer)
    } else {
      // GitHub Windows runners sporadically hang for minutes while npm fetches
      // transient dependency packuments. We still check the EXACT production
      // archive and isolated V2 imports on Windows, using the already-verified
      // npm-ci dependency tree. Linux continues to gate a real clean npm install.
      // This is intentionally NOT labelled a successful Windows npm install.
      const packageRoot = path.join(consumer, "node_modules", "@bybrawe", "opencode-loop")
      await mkdir(packageRoot, { recursive: true })
      run("tar", ["-xzf", packedTarball, "-C", packageRoot, "--strip-components=1"], temp)
      const scope = path.join(consumer, "node_modules", "@opencode")
      await mkdir(scope, { recursive: true })
      await symlink(
        path.join(root, "node_modules", "@opencode", "plugin"),
        path.join(scope, "plugin"),
        "junction",
      )
      console.warn("Windows npm cache lacks package metadata; testing packed archive with preinstalled dependency tree (not a clean npm install)")
    }
  }
  console.log(run(process.execPath, [path.join(root, "scripts/native-entry-test.mjs"), consumer], root).trim())
  console.log("Production tarball native entry isolation and lazy legacy delegation PASS")
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
