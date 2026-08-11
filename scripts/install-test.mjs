import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installer = path.join(root, "scripts", "install-node.mjs")
const packageVersion = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version
const expectedPackageSpec = `@bybrawe/opencode-loop@${packageVersion}`
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-installer-"))
const packagedCommandCount = (await fs.readdir(path.join(root, "commands"))).filter((name) => name.endsWith(".md")).length

async function runInstaller(config, cliArgs = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, ...cliArgs], {
      cwd: root,
      env: { ...process.env, OPENCODE_CONFIG_DIR: config },
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", reject)
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

async function commandCount(config) {
  try {
    return (await fs.readdir(path.join(config, "commands"))).filter((name) => name.endsWith(".md")).length
  } catch (error) {
    if (error?.code === "ENOENT") return 0
    throw error
  }
}

async function exists(target) {
  try { await fs.access(target); return true } catch { return false }
}

try {
  const helpConfig = path.join(temporaryRoot, "help-must-not-install")
  const helpResult = await runInstaller(helpConfig, ["--help"])
  assert.equal(helpResult.code, 0, helpResult.stderr)
  assert.match(helpResult.stdout, /OpenCode Loop installer\/updater/)
  assert.match(helpResult.stdout, /--uninstall/)
  assert.equal(await exists(helpConfig), false, "--help must not mutate the OpenCode config directory")

  const versionResult = await runInstaller(helpConfig, ["--version"])
  assert.equal(versionResult.code, 0, versionResult.stderr)
  assert.equal(versionResult.stdout.trim(), packageVersion)
  assert.equal(await exists(helpConfig), false, "--version must not mutate the OpenCode config directory")

  const local = path.join(temporaryRoot, "local")
  const localResult = await runInstaller(local)
  assert.equal(localResult.code, 0, localResult.stderr)
  assert.equal(await exists(path.join(local, "plugins", "opencode-loop.ts")), true)
  assert.equal(await commandCount(local), packagedCommandCount)
  assert.equal(await exists(path.join(local, "agents", "opencode-loop-local.md")), true)
  const localPackage = JSON.parse(await fs.readFile(path.join(local, "package.json"), "utf8"))
  assert.equal(localPackage.dependencies["@opencode-ai/plugin"], ">=1.4.0")

  const configured = path.join(temporaryRoot, "configured")
  await fs.mkdir(path.join(configured, "plugins"), { recursive: true })
  await fs.writeFile(path.join(configured, "opencode.json"), JSON.stringify({ plugin: ["@bybrawe/opencode-loop@latest"] }), "utf8")
  await fs.writeFile(path.join(configured, "plugins", "opencode-loop.ts"), "duplicate", "utf8")
  await fs.writeFile(path.join(configured, "plugins", "opencode-loop.js"), "legacy duplicate", "utf8")
  const configuredResult = await runInstaller(configured)
  assert.equal(configuredResult.code, 0, configuredResult.stderr)
  assert.match(configuredResult.stdout, /removed the duplicate local plugin copy/i)
  assert.equal(await exists(path.join(configured, "plugins", "opencode-loop.ts")), false)
  assert.equal(await exists(path.join(configured, "plugins", "opencode-loop.js")), false)
  assert.equal(await commandCount(configured), packagedCommandCount)
  assert.equal(await exists(path.join(configured, "agents", "opencode-loop-local.md")), true)
  const configuredJson = JSON.parse(await fs.readFile(path.join(configured, "opencode.json"), "utf8"))
  assert.deepEqual(configuredJson.plugin, [expectedPackageSpec], "the installer must bust OpenCode's stale package cache with an exact version spec")

  const jsonc = path.join(temporaryRoot, "jsonc")
  await fs.mkdir(jsonc, { recursive: true })
  await fs.writeFile(path.join(jsonc, "opencode.jsonc"), `{
    // A configured package is authoritative; a local copy would load twice.
    "plugin": [
      "other-plugin",
      "@bybrawe/opencode-loop",
    ],
  }`, "utf8")
  const jsoncResult = await runInstaller(jsonc)
  assert.equal(jsoncResult.code, 0, jsoncResult.stderr)
  assert.equal(await exists(path.join(jsonc, "plugins", "opencode-loop.ts")), false)
  const updatedJsonc = await fs.readFile(path.join(jsonc, "opencode.jsonc"), "utf8")
  assert.match(updatedJsonc, /A configured package is authoritative/, "pinning must preserve JSONC comments")
  assert.match(updatedJsonc, new RegExp(expectedPackageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const lookalike = path.join(temporaryRoot, "lookalike")
  await fs.mkdir(lookalike, { recursive: true })
  await fs.writeFile(path.join(lookalike, "opencode.json"), JSON.stringify({ plugin: ["@bybrawe/opencode-loop-extra"] }), "utf8")
  const lookalikeResult = await runInstaller(lookalike)
  assert.equal(lookalikeResult.code, 0, lookalikeResult.stderr)
  assert.equal(await exists(path.join(lookalike, "plugins", "opencode-loop.ts")), true)

  const uninstallConfig = path.join(temporaryRoot, "uninstall")
  await fs.mkdir(path.join(uninstallConfig, "plugins"), { recursive: true })
  await fs.mkdir(path.join(uninstallConfig, "commands"), { recursive: true })
  await fs.mkdir(path.join(uninstallConfig, "agents"), { recursive: true })
  await fs.writeFile(path.join(uninstallConfig, "opencode.jsonc"), `{
    // Keep unrelated OpenCode configuration.
    "plugin": [
      "other-plugin",
      "@bybrawe/opencode-loop@0.5.1",
    ],
    "permission": { "read": "allow" },
  }`, "utf8")
  await fs.writeFile(path.join(uninstallConfig, "plugins", "opencode-loop.ts"), "local", "utf8")
  for (const name of await fs.readdir(path.join(root, "commands"))) {
    if (name.endsWith(".md")) await fs.copyFile(path.join(root, "commands", name), path.join(uninstallConfig, "commands", name))
  }
  for (const name of await fs.readdir(path.join(root, "agents"))) {
    if (name.endsWith(".md")) await fs.copyFile(path.join(root, "agents", name), path.join(uninstallConfig, "agents", name))
  }
  const stateFile = path.join(temporaryRoot, "project", ".opencode", "opencode-loop", "state.json")
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  await fs.writeFile(stateFile, "preserve", "utf8")

  const uninstallResult = await runInstaller(uninstallConfig, ["--uninstall"])
  assert.equal(uninstallResult.code, 0, uninstallResult.stderr)
  assert.match(uninstallResult.stdout, /Project state .* is preserved/)
  const uninstallJsonc = await fs.readFile(path.join(uninstallConfig, "opencode.jsonc"), "utf8")
  assert.match(uninstallJsonc, /Keep unrelated OpenCode configuration/)
  assert.match(uninstallJsonc, /"other-plugin"/)
  assert.match(uninstallJsonc, /"permission"/)
  assert.doesNotMatch(uninstallJsonc, /@bybrawe\/opencode-loop/)
  assert.equal(await exists(path.join(uninstallConfig, "plugins", "opencode-loop.ts")), false)
  assert.equal(await commandCount(uninstallConfig), 0)
  assert.equal(await exists(path.join(uninstallConfig, "agents", "opencode-loop-local.md")), false)
  assert.equal(await fs.readFile(stateFile, "utf8"), "preserve")

  const uninstallAgain = await runInstaller(uninstallConfig, ["--uninstall"])
  assert.equal(uninstallAgain.code, 0, uninstallAgain.stderr)

  console.log("OpenCode Loop installer test passed")
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
