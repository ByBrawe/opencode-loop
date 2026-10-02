import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temp = await mkdtemp(path.join(tmpdir(), "loop-guide-config-"))
const file = path.join(temp, "opencode.json")
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
const spec = `@bybrawe/opencode-loop@${version}`
function run(args = []) {
  return spawnSync(process.execPath, [path.join(root, "scripts/install-node.mjs"), ...args], {
    cwd: root, env: { ...process.env, OPENCODE_CONFIG_DIR: temp }, encoding: "utf8", timeout: 20_000,
  })
}
try {
  const options = { quiet: false, nested: { count: 3 } }
  const other = ["other-plugin", { enabled: false }]
  await writeFile(file, JSON.stringify({ plugin: [["@bybrawe/opencode-loop@0.1.0", options], other] }))
  let result = run(["--legacy-v1"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [other, [spec, options]])
  result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { plugins: [
    { package: "other-plugin", options: { enabled: false } },
    { package: spec, options },
  ] })
  const migrated = await readFile(file, "utf8")
  assert.equal(run().status, 0)
  assert.equal(await readFile(file, "utf8"), migrated)
  for (const entries of [
    [[spec, false]], [[spec, {}, "extra"]],
    [[spec, { quiet: false }], { package: spec, options: { quiet: true } }],
  ]) {
    const before = JSON.stringify({ plugin: entries })
    await writeFile(file, before)
    result = run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Invalid Loop package\/options tuple|Conflicting Loop object registrations/)
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal(run(["--uninstall"]).status, 0)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [])
  }
  console.log("Official V1-to-V2 guide config regression passed")
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
