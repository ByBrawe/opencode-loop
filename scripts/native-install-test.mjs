import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installer = path.join(root, "scripts/install-node.mjs")
const temp = await mkdtemp(path.join(tmpdir(), "native-loop-installer-"))
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
const spec = `@bybrawe/opencode-loop@${version}`
let cases = 0
const exists = async (file) => { try { await access(file); return true } catch { return false } }
function run(config, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [installer, ...args], { cwd: root, env: { ...process.env, OPENCODE_CONFIG_DIR: config }, encoding: "utf8", timeout: 20_000 })
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error || ""}`)
  return result
}
async function config(name, content) {
  const directory = path.join(temp, name)
  await mkdir(directory, { recursive: true })
  if (content !== undefined) await writeFile(path.join(directory, "opencode.json"), typeof content === "string" ? content : JSON.stringify(content))
  return directory
}
try {
  const fresh = await config("fresh")
  run(fresh)
  const native = await readFile(path.join(root, "src/native.js"), "utf8")
  assert.equal(await readFile(path.join(fresh, "plugins/opencode-loop.ts"), "utf8"), native)
  assert.doesNotMatch(native, /(?:from\s*|import\s*\()["']@opencode-ai\/plugin/)
  assert.equal(await exists(path.join(fresh, "package.json")), false)
  assert.equal(await exists(path.join(fresh, "commands/loop.md")), false)
  assert.equal(await exists(path.join(fresh, "agents/opencode-loop-local.md")), false)
  run(fresh)
  cases++

  const options = { package: "@bybrawe/opencode-loop@0.5.38", options: { quiet: true, nested: { value: "preserved" } }, enabled: true }
  const obj = await config("object", { plugins: ["other-plugin", options] })
  run(obj)
  const readConfig = async (directory) => JSON.parse(await readFile(path.join(directory, "opencode.json"), "utf8"))
  assert.deepEqual((await readConfig(obj)).plugins, ["other-plugin", { ...options, package: spec }])
  const before = await readFile(path.join(obj, "opencode.json"), "utf8")
  run(obj)
  assert.equal(await readFile(path.join(obj, "opencode.json"), "utf8"), before)
  assert.equal(await exists(path.join(obj, "plugins/opencode-loop.ts")), false)
  cases++

  const both = await config("both", { plugin: ["legacy-unrelated", "@bybrawe/opencode-loop@old"], plugins: [options, "native-unrelated"] })
  run(both)
  assert.deepEqual(await readConfig(both), { plugin: ["legacy-unrelated"], plugins: ["native-unrelated", { ...options, package: spec }] })
  cases++

  const jsonc = await config("jsonc", '{\r\n  // keep-before\r\n  "theme": "url://example",\r\n  "plugin": ["@bybrawe/opencode-loop@old"] // keep-after\r\n}\r\n')
  run(jsonc)
  const text = await readFile(path.join(jsonc, "opencode.json"), "utf8")
  assert.match(text, /keep-before/)
  assert.match(text, /keep-after/)
  assert.match(text, /"plugins"/)
  assert.match(text, /url:\/\/example/)
  run(jsonc)
  assert.equal(await readFile(path.join(jsonc, "opencode.json"), "utf8"), text)
  cases++

  const conflict = await config("conflict", { plugins: [options, { ...options, enabled: false }] })
  const conflictBefore = await readFile(path.join(conflict, "opencode.json"), "utf8")
  assert.match(run(conflict, [], 1).stderr, /Conflicting/)
  assert.equal(await readFile(path.join(conflict, "opencode.json"), "utf8"), conflictBefore)
  cases++

  const invalid = await config("invalid", { plugin: ["@bybrawe/opencode-loop@old"] })
  await writeFile(path.join(invalid, "config.jsonc"), '{ "plugins": "not-an-array" }')
  const invalidBefore = await readFile(path.join(invalid, "opencode.json"), "utf8")
  run(invalid, [], 1)
  assert.equal(await readFile(path.join(invalid, "opencode.json"), "utf8"), invalidBefore)
  assert.equal(await exists(path.join(invalid, "plugins/opencode-loop.ts")), false)
  cases++

  const upgrade = await config("upgrade")
  run(upgrade, ["--legacy-v1"])
  assert.equal(await exists(path.join(upgrade, "commands/loop.md")), true)
  await writeFile(path.join(upgrade, "commands/loop-help.md"), "This is a custom user command; keep it.")
  run(upgrade)
  assert.equal(await exists(path.join(upgrade, "commands/loop.md")), false)
  assert.equal(await readFile(path.join(upgrade, "commands/loop-help.md"), "utf8"), "This is a custom user command; keep it.")
  assert.equal(await readFile(path.join(upgrade, "plugins/opencode-loop.ts"), "utf8"), native)
  cases++

  await mkdir(path.join(obj, ".opencode/opencode-loop"), { recursive: true })
  await writeFile(path.join(obj, ".opencode/opencode-loop/keep.json"), "{}")
  run(obj, ["--uninstall"])
  assert.deepEqual((await readConfig(obj)).plugins, ["other-plugin"])
  assert.equal(await exists(path.join(obj, ".opencode/opencode-loop/keep.json")), true)
  run(obj, ["--uninstall"])
  run(upgrade, ["--uninstall"])
  assert.equal(await exists(path.join(upgrade, "commands/loop-help.md")), true)
  cases++

  const info = path.join(temp, "informational-no-mutation")
  run(info, ["--help"])
  run(info, ["--version"])
  assert.equal(await exists(info), false)
  cases++
  console.log(`Native installer: ${cases} scenarios passed`)
} finally { await rm(temp, { recursive: true, force: true }) }
