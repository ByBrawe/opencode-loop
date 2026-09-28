import { readFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
function edit(file, before, after) {
  const text = readFileSync(file, "utf8")
  if (text.includes(after)) return
  assert.equal(text.split(before).length, 2, `Expected one anchor in ${file}: ${before.slice(0, 80)}`)
  writeFileSync(file, text.replace(before, after))
}
function replaceFunction(file, start, next, replacement) {
  const source = readFileSync(file, "utf8")
  const a = source.indexOf(start), b = source.indexOf(next, a + start.length)
  assert.ok(a >= 0 && b > a, `Function bounds missing: ${start}`)
  writeFileSync(file, source.slice(0, a) + replacement + "\n\n" + source.slice(b))
}
const file = "scripts/install-node.mjs"
edit(file, 'import { copyFile, mkdir, readdir, readFile, rm, writeFile }', 'import { isDeepStrictEqual } from "node:util"\nimport { copyFile, mkdir, readdir, readFile, rm, writeFile }')
edit(file, 'const installerArgs = process.argv.slice(2)', 'const rawInstallerArgs = process.argv.slice(2)\nconst legacyV1 = rawInstallerArgs.includes("--legacy-v1")\nconst installerArgs = rawInstallerArgs.filter((arg) => arg !== "--legacy-v1")')
edit(file, 'const spec = String(value || "").trim()', 'const spec = String(typeof value === "object" && value !== null ? value.package || "" : value || "").trim()')
edit(file, 'function rewriteExistingPluginArray(source, nextPlugins) {\n  const property = findRootProperty(source, "plugin")', 'function rewriteExistingPluginArray(source, nextPlugins, key = "plugin") {\n  const property = findRootProperty(source, key)')
edit(file, 'Install/update copies the dual OpenCode 1/2 Loop plugin plus command files and local command agent, and keeps an existing npm package entry pinned to the exact version.', 'Install/update defaults to native OpenCode 2: no V1 SDK or legacy command files are needed for a local install. Existing npm registrations are pinned to the exact version and migrated to plugins while retaining object options. Use --legacy-v1 to install the compatibility loader and legacy command files explicitly.')

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
            const preferred = matching.find((entry) => typeof entry === "object")
            const pinned = preferred ? { ...preferred, package: packageSpec } : packageSpec
            updated = rewriteExistingPluginArray(updated, [...entries.filter((entry) => !isPackageSpec(entry)), pinned], key)
          }
        } else {
          const objects = own.filter((entry) => typeof entry === "object" && entry !== null)
          const preferred = objects[0]
          const optionsOf = (entry) => { const { package: _package, ...options } = entry; return options }
          if (objects.some((entry) => !isDeepStrictEqual(optionsOf(entry), optionsOf(preferred)))) throw new Error("Conflicting Loop object registrations; reconcile their options before updating")
          const pinned = preferred ? { ...preferred, package: packageSpec } : packageSpec
          if (Array.isArray(parsed.plugin) && parsed.plugin.some(isPackageSpec)) updated = rewriteExistingPluginArray(updated, parsed.plugin.filter((entry) => !isPackageSpec(entry)), "plugin")
          const next = [...(parsed.plugins || []).filter((entry) => !isPackageSpec(entry)), pinned]
          updated = parsed.plugins === undefined ? appendPluginProperty(updated, next, "plugins") : rewriteExistingPluginArray(updated, next, "plugins")
        }
      }
      parseJsonc(updated)
      plans.push({ target, source, updated })
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${error.message}`)
    }
  }
  // Validate every candidate before writing any config. Malformed later files
  // must not leave the earlier file migrated and the plugin half-installed.
  for (const plan of plans) if (plan.source !== plan.updated) await writeFile(plan.target, plan.updated, "utf8")
  return { configured, updatedFiles: plans.filter((plan) => plan.source !== plan.updated).map((plan) => plan.target) }
}
replaceFunction(file, "async function configurePackagePlugin()", "async function ensureDependency()", appendPluginProperty.toString() + "\n\n" + configurePackagePlugin.toString())

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
replaceFunction(file, "async function removePackagedFiles(", "async function uninstall()", removePackagedFiles.toString())

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
  await removePackagedFiles(join(root, "commands"), commandDir)
  await removePackagedFiles(join(root, "agents"), agentDir)
  const changed = plans.filter((plan) => plan.source !== plan.updated).length
  console.log(`Removed ${packageName} registrations from ${changed} OpenCode config file(s).`)
  console.log("Removed known local Loop plugin and managed legacy command/agent files; custom files are preserved.")
  console.log("Project state under .opencode/opencode-loop is preserved.")
  console.log("Restart OpenCode to finish unloading OpenCode Loop.")
}
replaceFunction(file, "async function uninstall()", "async function installOrUpdate()", uninstall.toString())

async function installOrUpdate() {
  await mkdir(pluginDir, { recursive: true })
  const packageConfig = await configurePackagePlugin()
  if (packageConfig.configured) {
    await rm(join(pluginDir, "opencode-loop.ts"), { force: true })
    await rm(join(pluginDir, "opencode-loop.js"), { force: true })
  } else {
    if (legacyV1) await ensureDependency()
    await copyFile(join(root, "src", legacyV1 ? "server.js" : "native.js"), join(pluginDir, "opencode-loop.ts"))
    await rm(join(pluginDir, "opencode-loop.js"), { force: true })
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
  } else console.log(`Installed OpenCode Loop plugin to ${config}`)
  if (legacyV1) {
    console.log(`Installed ${packageName} commands to ${commandDir}`)
    console.log(`Installed ${packageName} local command agent to ${agentDir}`)
  } else console.log("Native OpenCode 2 commands are registered by the plugin; no legacy command files or V1 SDK are needed for a local install.")
  console.log("Restart OpenCode, then run: /loop-help")
}
replaceFunction(file, "async function installOrUpdate()", "if (uninstallRequested)", installOrUpdate.toString())
for (const testFile of ["scripts/install-test.mjs", "scripts/goal-companion-test.mjs"]) edit(testFile, '[installer, ...cliArgs]', '[installer, "--legacy-v1", ...cliArgs]')
const companion = "scripts/install-with-goals.mjs"
edit(companion, 'const uninstallRequested = loopArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(loopArgs[0] || "")', 'const commandArgs = loopArgs.filter((arg) => arg !== "--legacy-v1")\nconst uninstallRequested = commandArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(commandArgs[0] || "")')
edit(companion, 'function isGoalPluginSpec(value) {\n  if (typeof value !== "string") return false', 'function isGoalPluginSpec(value) {\n  if (value && typeof value === "object") value = value.package\n  if (typeof value !== "string") return false')
edit(companion, 'if (Array.isArray(parsed.plugin) && parsed.plugin.some(isGoalPluginSpec)) return true', 'if ([parsed.plugin, parsed.plugins].some((entries) => Array.isArray(entries) && entries.some(isGoalPluginSpec))) return true')
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (!pkg.scripts.test.includes("scripts/native-install-test.mjs")) pkg.scripts.test = "node scripts/native-install-test.mjs && " + pkg.scripts.test
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log("Native installer migration applied")
