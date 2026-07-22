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

async function packagePluginConfigured() {
  for (const name of ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]) {
    try {
      const parsed = parseJsonc(await readFile(join(config, name), "utf8"))
      if (Array.isArray(parsed?.plugin) && parsed.plugin.some(isPackageSpec)) return true
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`Could not inspect ${join(config, name)} for duplicate plugin entries: ${error.message}`)
    }
  }
  return false
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
const useConfiguredPackage = await packagePluginConfigured()
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

if (useConfiguredPackage) console.log(`OpenCode Loop is already configured as a package in ${config}; removed the duplicate local plugin copy.`)
else console.log(`Installed OpenCode Loop plugin to ${config}`)
console.log(`Installed ${packageName} commands to ${commandDir}`)
console.log(`Installed ${packageName} local command agent to ${agentDir}`)
console.log("Restart OpenCode, then run: /loop-help")
