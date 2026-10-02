import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goalInstaller = process.env.OPENCODE_GOAL_INSTALLER
assert.ok(goalInstaller && path.isAbsolute(goalInstaller), "Set OPENCODE_GOAL_INSTALLER to the built companion dist/install.js")
await access(goalInstaller)
const temp = await mkdtemp(path.join(os.tmpdir(), "loop-goal-native-install-"))
const npm = path.join(temp, "npm-test-driver.cjs")
const targetLog = path.join(temp, "target.jsonl")
await writeFile(npm, `const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['exec','--yes','--package=@bybrawe/opencode-goal@latest','--','opencode-goal'])) throw new Error('unexpected npm arguments');
fs.appendFileSync(process.env.TARGET_LOG, JSON.stringify(process.env.OPENCODE_GOAL_HOST_VERSION) + '\\n');
const result = spawnSync(process.execPath, [process.env.OPENCODE_GOAL_INSTALLER], { env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`)
const exists = (file) => access(file).then(() => true, () => false)
function run(config, args, hostTarget = "1.18.15") {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/install-with-goals.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, npm_execpath: npm, OPENCODE_CONFIG_DIR: config, OPENCODE_GOAL_HOST_VERSION: hostTarget, OPENCODE_GOAL_INSTALLER: goalInstaller, TARGET_LOG: targetLog },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ""}`)
  return result
}
try {
  const config = path.join(temp, "config")
  await mkdir(path.join(config, "commands"), { recursive: true })
  const options = { autonomous: false, nested: { retained: true } }
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({ plugin: [
    { package: "@bybrawe/opencode-goal@1.0.0", options },
    { package: "@bybrawe/opencode-loop@0.1.0", options: { quiet: true } },
    "other-plugin",
  ] }))
  await writeFile(path.join(config, "commands/goal.md"), "Custom Goal command\n")
  await writeFile(path.join(config, "commands/loop-goal.md"), "Custom Loop Goal command\n")
  const state = path.join(config, "project/.opencode/goals/keep.json")
  await mkdir(path.dirname(state), { recursive: true })
  await writeFile(state, '{"evidence":"unchanged"}\n')

  run(config, ["--with-goals", "--without-loop-goals"])
  let source = await readFile(path.join(config, "opencode.json"), "utf8")
  let parsed = JSON.parse(source)
  assert.equal("plugin" in parsed, false)
  assert.equal(parsed.plugins.length, 3)
  assert.ok(parsed.plugins.includes("other-plugin"))
  assert.deepEqual(parsed.plugins.find((item) => item.package?.startsWith("@bybrawe/opencode-goal@")).options, options)
  assert.deepEqual(parsed.plugins.find((item) => item.package?.startsWith("@bybrawe/opencode-loop@")).options, { quiet: true })
  assert.equal(await readFile(path.join(config, "commands/goal.md"), "utf8"), "Custom Goal command\n")
  assert.equal(await readFile(path.join(config, "commands/loop-goal.md"), "utf8"), "Custom Loop Goal command\n")
  run(config, ["--with-goals", "--without-loop-goals"])
  assert.equal(await readFile(path.join(config, "opencode.json"), "utf8"), source)
  assert.equal(await readFile(state, "utf8"), '{"evidence":"unchanged"}\n')

  const legacy = path.join(temp, "legacy")
  run(legacy, ["--legacy-v1", "--with-goals"], "2.0.18")
  parsed = JSON.parse(await readFile(path.join(legacy, "opencode.json"), "utf8"))
  assert.ok(parsed.plugin.some((item) => String(item).startsWith("@bybrawe/opencode-goal@")))
  assert.equal(await exists(path.join(legacy, "commands/goal.md")), true)
  assert.equal(await exists(path.join(legacy, "commands/loop.md")), true)
  assert.deepEqual((await readFile(targetLog, "utf8")).trim().split('\n').map((line) => JSON.parse(line)), ["2.0.0", "2.0.0", "1.0.0"])
  run(config, ["--uninstall"])
  parsed = JSON.parse(await readFile(path.join(config, "opencode.json"), "utf8"))
  assert.equal(parsed.plugins.length, 2, "Loop uninstall cannot remove the companion or unrelated plugins")
  assert.ok(parsed.plugins.includes("other-plugin"))
  assert.ok(parsed.plugins.some((item) => item?.package?.startsWith("@bybrawe/opencode-goal@")))
  assert.equal(await readFile(state, "utf8"), '{"evidence":"unchanged"}\n')
  console.log("Native Goal+Loop installer pair: dialect, options, idempotence, custom files and uninstall PASS")
} finally { await rm(temp, { recursive: true, force: true }) }
