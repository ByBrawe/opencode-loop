#!/usr/bin/env node
import { isDeepStrictEqual } from "node:util"
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const pluginDir = join(config, "plugins")
const nativePluginDir = join(pluginDir, "opencode-loop")
const commandDir = join(config, "commands")
const agentDir = join(config, "agents")
const packagePath = join(config, "package.json")
const packageName = "@bybrawe/opencode-loop"
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version
const packageSpec = `${packageName}@${packageVersion}`
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const rawInstallerArgs = process.argv.slice(2)
const legacyV1 = rawInstallerArgs.includes("--legacy-v1")
const installerArgs = rawInstallerArgs.filter((arg) => arg !== "--legacy-v1")
const uninstallRequested = installerArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(installerArgs[0] || "")

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`OpenCode Loop installer/updater\n\nUsage:\n  opencode-loop\n  npx -y @bybrawe/opencode-loop@latest\n  npx -y @bybrawe/opencode-loop@latest --uninstall\n\nInstall/update defaults to native OpenCode 2: the exact package version is registered in the plural plugins config so OpenCode resolves the package and its V2 runtime dependencies together. No loose local V2 plugin copy, V1 SDK, or legacy command files are needed. Existing npm registrations are pinned to the exact version and migrated to plugins while retaining object options. Use --legacy-v1 to install the compatibility loader and legacy command files explicitly.\nUninstall removes Loop package registrations plus known local plugin/command/agent files while preserving project Loop state.\n\nSet OPENCODE_CONFIG_DIR to target a non-default OpenCode config directory.`)
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
  if (Array.isArray(value)) value = value[0]
  const spec = String(typeof value === "object" && value !== null ? value.package || "" : value || "").trim()
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

function rewriteExistingPluginArray(source, nextPlugins, key = "plugin") {
  const property = findRootProperty(source, key)
  if (!property) return source
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const replacement = formatPluginArray(nextPlugins, property.indent, eol)
  return `${source.slice(0, property.valueStart)}${replacement}${source.slice(property.valueEnd)}`
}

function appendPluginProperty(source, values, key) {
  const parsed = parseJsonc(source)
  const keys = Object.keys(parsed)
  if (keys.length) {
    const last = findRootProperty(source, keys.at(-1))
    const after = skipTrivia(source, last.valueEnd)
    if (source[after] !== ",") source = source.slice(0, last.valueEnd) + "," + source.slice(last.valueEnd)
  }
  const end = skipJsonValue(source, 0) - 1
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  return source.slice(0, end) + `${eol}  ${JSON.stringify(key)}: ${formatPluginArray(values, "  ", eol)}${eol}` + source.slice(end)
}

function pinRegistration(entries) {
  const objects = entries.map((entry) => {
    if (!Array.isArray(entry)) return entry
    if (entry.length !== 2 || !entry[1] || typeof entry[1] !== "object" || Array.isArray(entry[1])) {
      throw new Error("Invalid Loop package/options tuple; no configuration was changed")
    }
    return { package: entry[0], options: entry[1] }
  }).filter((entry) => typeof entry === "object" && entry !== null)
  const optionsOf = (entry) => { const { package: _package, ...options } = entry; return options }
  const configured = objects.filter((entry) => Object.keys(optionsOf(entry)).length > 0)
  const preferred = configured[0]
  if (!preferred) return packageSpec
  if (configured.some((entry) => !isDeepStrictEqual(optionsOf(entry), optionsOf(preferred)))) {
    throw new Error("Conflicting Loop object registrations; reconcile their options before updating")
  }
  const legacyTuple = entries.some((entry) => Array.isArray(entry) && isDeepStrictEqual(entry[1], preferred.options))
  return legacyV1 && legacyTuple ? [packageSpec, preferred.options] : { ...preferred, package: packageSpec }
}

async function configurePackagePlugin() {
  const plans = []
  let configured = false
  for (const name of configCandidates) {
    const target = join(config, name)
    try {
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      for (const key of ["plugin", "plugins"]) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error(`OpenCode config '${key}' must be an array`)
      }
      let updated = source
      const own = [...(parsed.plugins || []), ...(parsed.plugin || [])].filter(isPackageSpec)
      if (own.length) {
        configured = true
        if (legacyV1) {
          for (const key of ["plugin", "plugins"]) {
            const entries = parsed[key] || []
            const matching = entries.filter(isPackageSpec)
            if (!matching.length) continue
            const pinned = pinRegistration(matching)
            updated = rewriteExistingPluginArray(updated, [...entries.filter((entry) => !isPackageSpec(entry)), pinned], key)
          }
        } else {
          const pinned = pinRegistration(own)
          if (Array.isArray(parsed.plugin) && parsed.plugin.some(isPackageSpec)) {
            updated = rewriteExistingPluginArray(updated, parsed.plugin.filter((entry) => !isPackageSpec(entry)), "plugin")
          }
          const next = [...(parsed.plugins || []).filter((entry) => !isPackageSpec(entry)), pinned]
          updated = parsed.plugins === undefined
            ? appendPluginProperty(updated, next, "plugins")
            : rewriteExistingPluginArray(updated, next, "plugins")
        }
      }
      parseJsonc(updated)
      plans.push({ target, source, updated })
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${error.message}`)
    }
  }

  // Native V2 installs are package registrations, not loose discovered copies.
  // The published package owns @opencode/plugin as a production dependency, so
  // OpenCode resolves the entrypoint and SDK from the same package install.
  // This also migrates broken 0.6.1/0.6.2 loose installs on the next update.
  if (!configured && !legacyV1) {
    if (plans.length) {
      const plan = plans[0]
      const parsed = parseJsonc(plan.updated)
      const entries = parsed.plugins || []
      if (!Array.isArray(entries)) throw new Error("OpenCode config 'plugins' must be an array")
      plan.updated = parsed.plugins === undefined
        ? appendPluginProperty(plan.updated, [...entries, packageSpec], "plugins")
        : rewriteExistingPluginArray(plan.updated, [...entries, packageSpec], "plugins")
      parseJsonc(plan.updated)
    } else {
      const target = join(config, "opencode.json")
      const updated = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: [packageSpec],
      }, null, 2) + "\n"
      plans.push({ target, source: "", updated })
    }
    configured = true
  }

  // Validate every candidate before writing any config. Malformed later files
  // must not leave an earlier file migrated and the plugin half-installed.
  for (const plan of plans) parseJsonc(plan.updated)
  for (const plan of plans) if (plan.source !== plan.updated) await writeFile(plan.target, plan.updated, "utf8")
  return { configured, updatedFiles: plans.filter((plan) => plan.source !== plan.updated).map((plan) => plan.target) }
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
    if (!name.endsWith(".md")) continue
    try {
      const installed = await readFile(join(targetDir, name), "utf8")
      const packaged = await readFile(join(sourceDir, name), "utf8")
      const recognized = /OpenCode Loop[^\n]{0,120}handled (?:locally|exactly)/.test(installed) || /OpenCode Loop local command handled/.test(installed)
      if (installed === packaged || recognized) await rm(join(targetDir, name), { force: true })
    } catch (error) { if (error?.code !== "ENOENT") throw error }
  }
}

async function uninstall() {
  const plans = []
  for (const name of configCandidates) {
    const target = join(config, name)
    try {
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      let updated = source
      for (const key of ["plugin", "plugins"]) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error(`OpenCode config '${key}' must be an array`)
        const entries = parsed[key] || []
        if (entries.some(isPackageSpec)) updated = rewriteExistingPluginArray(updated, entries.filter((entry) => !isPackageSpec(entry)), key)
      }
      plans.push({ target, source, updated })
    } catch (error) { if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${error.message}`) }
  }
  for (const plan of plans) if (plan.updated !== plan.source) await writeFile(plan.target, plan.updated, "utf8")
  await rm(join(pluginDir, "opencode-loop.ts"), { force: true })
  await rm(join(pluginDir, "opencode-loop.js"), { force: true })
  await rm(nativePluginDir, { recursive: true, force: true })
  await removePackagedFiles(join(root, "commands"), commandDir)
  await removePackagedFiles(join(root, "agents"), agentDir)
  const changed = plans.filter((plan) => plan.source !== plan.updated).length
  console.log(`Removed ${packageName} registrations from ${changed} OpenCode config file(s).`)
  console.log("Removed known local Loop plugin and managed legacy command/agent files; custom files are preserved.")
  console.log("Project state under .opencode/opencode-loop is preserved.")
  console.log("Restart OpenCode to finish unloading OpenCode Loop.")
}

async function installOrUpdate() {
  await mkdir(pluginDir, { recursive: true })
  const packageConfig = await configurePackagePlugin()
  if (packageConfig.configured) {
    await rm(join(pluginDir, "opencode-loop.ts"), { force: true })
    await rm(join(pluginDir, "opencode-loop.js"), { force: true })
    await rm(nativePluginDir, { recursive: true, force: true })
  } else if (legacyV1) {
    await ensureDependency()
    await rm(nativePluginDir, { recursive: true, force: true })
    await copyFile(join(root, "src", "index.js"), join(pluginDir, "opencode-loop.ts"))
    await rm(join(pluginDir, "opencode-loop.js"), { force: true })
  } else {
    throw new Error("Native OpenCode 2 package registration was not created")
  }
  if (legacyV1) {
    await mkdir(commandDir, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    for (const name of await readdir(join(root, "commands"))) if (name.endsWith(".md")) await copyFile(join(root, "commands", name), join(commandDir, name))
    for (const name of await readdir(join(root, "agents"))) if (name.endsWith(".md")) await copyFile(join(root, "agents", name), join(agentDir, name))
  } else {
    await removePackagedFiles(join(root, "commands"), commandDir)
    await removePackagedFiles(join(root, "agents"), agentDir)
  }
  if (packageConfig.configured) {
    const pinResult = packageConfig.updatedFiles.length ? `pinned the config entry to ${packageSpec}` : `the config entry is already pinned to ${packageSpec}`
    console.log(`OpenCode Loop is already configured as a package in ${config}; ${pinResult} and removed the duplicate local plugin copy.`)
  } else console.log(`Installed OpenCode Loop compatibility plugin to ${join(pluginDir, "opencode-loop.ts")}`)
  if (legacyV1) {
    console.log(`Installed ${packageName} commands to ${commandDir}`)
    console.log(`Installed ${packageName} local command agent to ${agentDir}`)
  } else console.log("Native OpenCode 2 is registered as an exact package plugin; OpenCode resolves @opencode/plugin from the package dependency graph. No loose local plugin copy, legacy command files, or V1 SDK are needed.")
  console.log("Restart OpenCode, then run: /loop-help")
}

if (uninstallRequested) await uninstall()
else await installOrUpdate()
