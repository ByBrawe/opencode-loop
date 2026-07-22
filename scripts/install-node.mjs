#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const pluginDir = join(config, "plugins")
const commandDir = join(config, "commands")
const agentDir = join(config, "agents")
const packagePath = join(config, "package.json")
const packageName = "@bybrawe/opencode-loop"
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version
const packageSpec = `${packageName}@${packageVersion}`
const installerArgs = process.argv.slice(2)

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`OpenCode Loop installer

Usage:
  opencode-loop
  npx -y @bybrawe/opencode-loop@latest

Installs the plugin commands and local command agent into OPENCODE_CONFIG_DIR
or the default ~/.config/opencode directory.`)
  process.exit(0)
}

if (installerArgs.includes("--version") || installerArgs.includes("-v")) {
  console.log(packageVersion)
  process.exit(0)
}

function stripJsonComments(input) {
  let output = ""
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]
    if (lineComment) {
      if (char === "\n" || char === "\r") { lineComment = false; output += char }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index++ }
      else if (char === "\n" || char === "\r") output += char
      continue
    }
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') { quote = char; output += char; continue }
    if (char === "/" && next === "/") { lineComment = true; index++; continue }
    if (char === "/" && next === "*") { blockComment = true; index++; continue }
    output += char
  }
  return output
}

function stripTrailingCommas(input) {
  let output = ""
  let quote = ""
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"') { quote = char; output += char; continue }
    if (char === ",") {
      let lookahead = index + 1
      while (/\s/.test(input[lookahead] || "")) lookahead++
      if (input[lookahead] === "]" || input[lookahead] === "}") continue
    }
    output += char
  }
  return output
}

function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input)))
}

function isPackageSpec(value) {
  const spec = String(value || "").trim()
  return spec === packageName || spec.startsWith(`${packageName}@`)
}

async function configurePackagePlugin() {
  let configured = false
  const updatedFiles = []
  for (const name of ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]) {
    try {
      const target = join(config, name)
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      const specs = Array.isArray(parsed?.plugin) ? parsed.plugin.filter(isPackageSpec) : []
      if (!specs.length) continue
      configured = true

      // OpenCode caches package plugins by the literal config spec. A bare
      // package name or @latest can therefore keep loading an older cached
      // release after npm installs a newer one. Pin the config entry to the
      // installer package's exact version while preserving JSONC comments.
      let updated = source
      for (const spec of new Set(specs)) {
        if (spec === packageSpec) continue
        updated = updated.replaceAll(JSON.stringify(spec), JSON.stringify(packageSpec))
      }
      if (updated !== source) {
        await writeFile(target, updated, "utf8")
        updatedFiles.push(target)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`Could not inspect ${join(config, name)} for duplicate plugin entries: ${error.message}`)
    }
  }
  return { configured, updatedFiles }
}

async function ensureDependency() {
  let pkg = {}
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not update ${packagePath}: ${error.message}`)
      console.warn('Add "@opencode-ai/plugin": ">=1.4.0" to that package.json if OpenCode cannot load the local plugin.')
      return
    }
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) pkg = {}
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {}
  if (!pkg.dependencies["@opencode-ai/plugin"]) {
    pkg.dependencies["@opencode-ai/plugin"] = ">=1.4.0"
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  }
}

await mkdir(pluginDir, { recursive: true })
await mkdir(commandDir, { recursive: true })
await mkdir(agentDir, { recursive: true })
const packageConfig = await configurePackagePlugin()
const useConfiguredPackage = packageConfig.configured
if (useConfiguredPackage) {
  await rm(join(pluginDir, "opencode-loop.ts"), { force: true })
  await rm(join(pluginDir, "opencode-loop.js"), { force: true })
} else {
  await ensureDependency()
  await copyFile(join(root, "src", "index.js"), join(pluginDir, "opencode-loop.ts"))
  await rm(join(pluginDir, "opencode-loop.js"), { force: true })
}

for (const name of await readdir(join(root, "commands"))) {
  if (name.endsWith(".md")) {
    await copyFile(join(root, "commands", name), join(commandDir, name))
  }
}

for (const name of await readdir(join(root, "agents"))) {
  if (name.endsWith(".md")) {
    await copyFile(join(root, "agents", name), join(agentDir, name))
  }
}

if (useConfiguredPackage) {
  const pinResult = packageConfig.updatedFiles.length
    ? `pinned the config entry to ${packageSpec}`
    : `the config entry is already pinned to ${packageSpec}`
  console.log(`OpenCode Loop is already configured as a package in ${config}; ${pinResult} and removed the duplicate local plugin copy.`)
}
else console.log(`Installed OpenCode Loop plugin to ${config}`)
console.log(`Installed ${packageName} commands to ${commandDir}`)
console.log(`Installed ${packageName} local command agent to ${agentDir}`)
console.log("Restart OpenCode, then run: /loop-help")
