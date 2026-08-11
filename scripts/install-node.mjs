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
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const installerArgs = process.argv.slice(2)
const uninstallRequested = installerArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(installerArgs[0] || "")

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`OpenCode Loop installer/updater\n\nUsage:\n  opencode-loop\n  npx -y @bybrawe/opencode-loop@latest\n  npx -y @bybrawe/opencode-loop@latest --uninstall\n\nInstall/update copies the Loop command files and local command agent, and keeps an existing npm package entry pinned to the exact version.\nUninstall removes Loop package registrations plus known local plugin/command/agent files while preserving project Loop state.\n\nSet OPENCODE_CONFIG_DIR to target a non-default OpenCode config directory.`)
  process.exit(0)
}

if (installerArgs.includes("--version") || installerArgs.includes("-v")) {
  console.log(packageVersion)
  process.exit(0)
}

if (installerArgs.length && !uninstallRequested) {
  console.error(`Unknown installer option: ${installerArgs[0]}`)
  process.exit(2)
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
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(input)))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenCode config root must be a JSON object")
  return parsed
}

function isPackageSpec(value) {
  const spec = String(value || "").trim()
  return spec === packageName || spec.startsWith(`${packageName}@`)
}

function skipTrivia(source, start) {
  let index = start
  while (index < source.length) {
    const char = source[index] || ""
    const next = source[index + 1] || ""
    if (/\s/.test(char)) { index++; continue }
    if (char === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end < 0) throw new Error("unterminated block comment in OpenCode config")
      index = end + 2
      continue
    }
    break
  }
  return index
}

function readJsonString(source, start) {
  if (source[start] !== '"') throw new Error("expected JSON string")
  let escaped = false
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index] || ""
    if (escaped) { escaped = false; continue }
    if (char === "\\") { escaped = true; continue }
    if (char === '"') {
      const end = index + 1
      return { value: JSON.parse(source.slice(start, end)), end }
    }
  }
  throw new Error("unterminated JSON string in OpenCode config")
}

function skipJsonValue(source, start) {
  const valueStart = skipTrivia(source, start)
  const first = source[valueStart]
  if (first === '"') return readJsonString(source, valueStart).end
  if (first === "{" || first === "[") {
    const stack = []
    let quoted = false
    let escaped = false
    let lineComment = false
    let blockComment = false
    for (let index = valueStart; index < source.length; index++) {
      const char = source[index] || ""
      const next = source[index + 1] || ""
      if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; continue }
      if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index++ }; continue }
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') { quoted = true; continue }
      if (char === "/" && next === "/") { lineComment = true; index++; continue }
      if (char === "/" && next === "*") { blockComment = true; index++; continue }
      if (char === "{" || char === "[") stack.push(char)
      else if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "["
        if (stack.at(-1) !== expected) throw new Error("mismatched JSON delimiters in OpenCode config")
        stack.pop()
        if (!stack.length) return index + 1
      }
    }
    throw new Error("unterminated JSON value in OpenCode config")
  }
  let index = valueStart
  while (index < source.length && ![",", "}", "]"].includes(source[index])) index++
  return index
}

function findRootProperty(source, propertyName) {
  let index = skipTrivia(source, 0)
  if (source[index] !== "{") throw new Error("OpenCode config must contain one root object")
  index++
  while (true) {
    index = skipTrivia(source, index)
    if (source[index] === "}") return null
    const key = readJsonString(source, index)
    index = skipTrivia(source, key.end)
    if (source[index] !== ":") throw new Error(`expected ':' after config property ${key.value}`)
    const valueStart = skipTrivia(source, index + 1)
    const valueEnd = skipJsonValue(source, valueStart)
    if (key.value === propertyName) {
      const lineStart = Math.max(source.lastIndexOf("\n", valueStart - 1), source.lastIndexOf("\r", valueStart - 1)) + 1
      const keyLineStart = Math.max(source.lastIndexOf("\n", key.end - 1), source.lastIndexOf("\r", key.end - 1)) + 1
      const indent = source.slice(keyLineStart, key.end - key.value.length - 2).match(/^[\t ]*/)?.[0] || "  "
      return { valueStart, valueEnd, indent, lineStart }
    }
    const afterValue = skipTrivia(source, valueEnd)
    if (source[afterValue] === ",") index = afterValue + 1
    else if (source[afterValue] === "}") return null
    else throw new Error(`expected ',' or '}' after config property ${key.value}`)
  }
}

function formatPluginArray(values, indent, eol) {
  if (!values.length) return "[]"
  const childIndent = `${indent}  `
  return `[${eol}${values.map((value) => `${childIndent}${JSON.stringify(value)}`).join(`,${eol}`)}${eol}${indent}]`
}

function rewriteExistingPluginArray(source, nextPlugins) {
  const property = findRootProperty(source, "plugin")
  if (!property) return source
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const replacement = formatPluginArray(nextPlugins, property.indent, eol)
  return `${source.slice(0, property.valueStart)}${replacement}${source.slice(property.valueEnd)}`
}

async function configurePackagePlugin() {
  let configured = false
  const updatedFiles = []
  for (const name of configCandidates) {
    const target = join(config, name)
    try {
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) throw new Error("OpenCode config 'plugin' must be an array")
      const plugins = parsed.plugin || []
      if (!plugins.some(isPackageSpec)) continue
      configured = true
      const nextPlugins = plugins.filter((value) => !isPackageSpec(value))
      nextPlugins.push(packageSpec)
      const updated = rewriteExistingPluginArray(source, nextPlugins)
      if (updated !== source) {
        await writeFile(target, updated, "utf8")
        updatedFiles.push(target)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${error.message}`)
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

async function removePackagedFiles(sourceDir, targetDir) {
  for (const name of await readdir(sourceDir)) {
    if (name.endsWith(".md")) await rm(join(targetDir, name), { force: true })
  }
}

async function uninstall() {
  const plans = []
  for (const name of configCandidates) {
    const target = join(config, name)
    try {
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) throw new Error("OpenCode config 'plugin' must be an array")
      const plugins = parsed.plugin || []
      const nextPlugins = plugins.filter((value) => !isPackageSpec(value))
      const updated = nextPlugins.length === plugins.length ? source : rewriteExistingPluginArray(source, nextPlugins)
      plans.push({ target, source, updated })
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${error.message}`)
    }
  }

  for (const plan of plans) {
    if (plan.updated !== plan.source) await writeFile(plan.target, plan.updated, "utf8")
  }
  await rm(join(pluginDir, "opencode-loop.ts"), { force: true })
  await rm(join(pluginDir, "opencode-loop.js"), { force: true })
  await removePackagedFiles(join(root, "commands"), commandDir)
  await removePackagedFiles(join(root, "agents"), agentDir)

  const changedConfigs = plans.filter((plan) => plan.updated !== plan.source).length
  console.log(changedConfigs
    ? `Removed ${packageName} package registrations from ${changedConfigs} OpenCode config file(s).`
    : `${packageName} was not registered as an npm package in the inspected OpenCode config files.`)
  console.log("Removed known local OpenCode Loop plugin, slash-command, and local-agent files when present.")
  console.log("Project state under .opencode/opencode-loop is preserved.")
  console.log("Restart OpenCode to finish unloading OpenCode Loop.")
}

async function installOrUpdate() {
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
    if (name.endsWith(".md")) await copyFile(join(root, "commands", name), join(commandDir, name))
  }

  for (const name of await readdir(join(root, "agents"))) {
    if (name.endsWith(".md")) await copyFile(join(root, "agents", name), join(agentDir, name))
  }

  if (useConfiguredPackage) {
    const pinResult = packageConfig.updatedFiles.length
      ? `pinned the config entry to ${packageSpec}`
      : `the config entry is already pinned to ${packageSpec}`
    console.log(`OpenCode Loop is already configured as a package in ${config}; ${pinResult} and removed the duplicate local plugin copy.`)
  } else {
    console.log(`Installed OpenCode Loop plugin to ${config}`)
  }
  console.log(`Installed ${packageName} commands to ${commandDir}`)
  console.log(`Installed ${packageName} local command agent to ${agentDir}`)
  console.log("Restart OpenCode, then run: /loop-help")
}

if (uninstallRequested) await uninstall()
else await installOrUpdate()
