import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.opencode-loop.v2.experimental"
const sentinelID = "bybrawe.opencode-loop.v2-canary-sentinel"

function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `command failed (${result.status}): ${command} ${args.join(" ")}`,
      String(result.stdout ?? ""),
      String(result.stderr ?? ""),
    ].filter(Boolean).join("\n"))
  }
  return result
}

function output(result) {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim()
}

function parseJSONOutput(result, label) {
  const text = String(result.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON on stdout.\nstdout:\n${text}\nstderr:\n${String(result.stderr ?? "")}`)
  }
}

function collectPluginIDs(value) {
  if (Array.isArray(value)) return value.flatMap(collectPluginIDs)
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  const direct = [value.id, value.pluginID, value.name].filter((item) => typeof item === "string")
  const nested = [value.data, value.plugins, value.items].flatMap((item) => collectPluginIDs(item))
  return [...direct, ...nested]
}

function uniquePluginIDs(value) {
  return [...new Set(collectPluginIDs(value))]
}

async function markerExists(file) {
  try {
    return (await readFile(file, "utf8")).trim() === "ok"
  } catch {
    return false
  }
}

async function failureLog(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8")
      return raw.slice(-30_000)
    } catch {}
  }
  return ""
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const pluginFile = path.join(root, "src", "source", "opencode2", "experimental.js")
  const adapterBridge = path.join(pluginDirectory, "opencode-loop-v2-canary.js")
  const sentinelFile = path.join(pluginDirectory, "opencode-loop-v2-sentinel.js")
  const sentinelMarker = path.join(temp, "sentinel-activated.txt")
  const adapterMarker = path.join(temp, "adapter-activated.txt")
  const sentinelURL = pathToFileURL(sentinelFile).href
  const adapterURL = pathToFileURL(adapterBridge).href

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(sentinelFile, [
    `import { writeFile } from "node:fs/promises"`,
    `export default {`,
    `  id: ${JSON.stringify(sentinelID)},`,
    `  setup: async () => { await writeFile(${JSON.stringify(sentinelMarker)}, "ok", "utf8") },`,
    `}`,
    ``,
  ].join("\n"))

  await writeFile(adapterBridge, [
    `import { writeFile } from "node:fs/promises"`,
    `import plugin from ${JSON.stringify(pathToFileURL(pluginFile).href)}`,
    `export default {`,
    `  id: plugin.id,`,
    `  setup: async (ctx) => {`,
    `    const cleanup = await plugin.setup(ctx)`,
    `    await writeFile(${JSON.stringify(adapterMarker)}, "ok", "utf8")`,
    `    return cleanup`,
    `  },`,
    `}`,
    ``,
  ].join("\n"))

  await writeFile(path.join(project, "README.md"), "# OpenCode Loop V2 host canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      "./.opencode/plugins/opencode-loop-v2-sentinel.js",
      "./.opencode/plugins/opencode-loop-v2-canary.js",
    ],
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-loop-v2-canary.db"),
    OPENCODE_LOG_LEVEL: "DEBUG",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [sentinelURL, adapterURL] }),
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Loop Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-loop-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize canary workspace"], { cwd: project, env })

  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })

    const version = output(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }))
    if (!version) throw new Error("opencode2 --version returned no output")

    const health = output(run("opencode2", ["api", "get", "/api/health"], { cwd: project, env }))
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const plainPluginResult = run("opencode2", ["api", "get", "/api/plugin"], { cwd: project, env })
    const plainResponse = parseJSONOutput(plainPluginResult, "GET /api/plugin from project cwd")
    const plainIDs = uniquePluginIDs(plainResponse)

    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const scopedPluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const scopedResponse = parseJSONOutput(scopedPluginResult, "GET /api/plugin at project Location")

    if (scopedResponse?._tag) {
      throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(scopedResponse)}`)
    }
    if (scopedResponse?.location?.directory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(scopedResponse?.location?.directory)}`)
    }

    const scopedIDs = uniquePluginIDs(scopedResponse)
    const ids = [...new Set([...plainIDs, ...scopedIDs])]
    const sentinelActivated = await markerExists(sentinelMarker)
    const adapterActivated = await markerExists(adapterMarker)

    if (!sentinelActivated) {
      throw new Error([
        "OpenCode 2 discovered the canary project but did not execute the minimal sentinel setup.",
        `Plain /api/plugin IDs: ${JSON.stringify(plainIDs)}`,
        `Scoped /api/plugin IDs: ${JSON.stringify(scopedIDs)}`,
        `Plain response: ${String(plainPluginResult.stdout ?? "")}`,
        `Scoped response: ${String(scopedPluginResult.stdout ?? "")}`,
      ].join("\n"))
    }
    if (!adapterActivated) {
      throw new Error([
        `OpenCode 2 executed the sentinel but did not complete setup for ${pluginID}.`,
        `Plain /api/plugin IDs: ${JSON.stringify(plainIDs)}`,
        `Scoped /api/plugin IDs: ${JSON.stringify(scopedIDs)}`,
      ].join("\n"))
    }

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      health,
      projectDirectory: scopedResponse.location.directory,
      sentinelID,
      pluginID,
      sentinelActivated,
      adapterActivated,
      plainPluginIDs: plainIDs,
      scopedPluginIDs: scopedIDs,
      diagnosticPluginIDs: ids,
    }, null, 2))
  } catch (error) {
    const logs = await failureLog(env)
    if (logs) console.error(`OpenCode 2 server log tail:\n${logs}`)
    throw error
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
