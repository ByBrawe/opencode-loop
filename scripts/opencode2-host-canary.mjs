import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.opencode-loop.v2.experimental"
const sentinelID = "bybrawe.opencode-loop.v2-canary-sentinel"
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
    shell: process.platform === "win32" && command === "opencode2",
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

async function waitForScopedPlugins(project, env, attempts = 20, intervalMs = 250) {
  const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
  let last

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const response = parseJSONOutput(result, "GET /api/plugin at project Location")
    if (response?._tag) {
      throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(response)}`)
    }
    if (response?.location?.directory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(response?.location?.directory)}`)
    }

    const ids = uniquePluginIDs(response)
    last = { attempt, result, response, ids }
    if (ids.includes(sentinelID) && ids.includes(pluginID)) return last
    if (attempt < attempts) await delay(intervalMs)
  }

  return last
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
  const sentinelURL = pathToFileURL(sentinelFile).href
  const adapterURL = pathToFileURL(adapterBridge).href

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(sentinelFile, `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {} }\n`)
  await writeFile(adapterBridge, `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
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

    const scoped = await waitForScopedPlugins(project, env)
    const scopedIDs = scoped?.ids ?? []
    const ids = [...new Set([...plainIDs, ...scopedIDs])]

    if (!ids.includes(sentinelID)) {
      throw new Error([
        `OpenCode 2 did not activate the minimal sentinel after ${scoped?.attempt ?? 0} scoped probes. Active IDs: ${JSON.stringify(ids)}`,
        `Plain /api/plugin IDs: ${JSON.stringify(plainIDs)}`,
        `Scoped /api/plugin IDs: ${JSON.stringify(scopedIDs)}`,
        `Plain response: ${String(plainPluginResult.stdout ?? "")}`,
        `Scoped response: ${String(scoped?.result?.stdout ?? "")}`,
      ].join("\n"))
    }
    if (!ids.includes(pluginID)) {
      throw new Error([
        `OpenCode 2 activated the sentinel but not ${pluginID} after ${scoped?.attempt ?? 0} scoped probes. Active IDs: ${JSON.stringify(ids)}`,
        `Plain /api/plugin IDs: ${JSON.stringify(plainIDs)}`,
        `Scoped /api/plugin IDs: ${JSON.stringify(scopedIDs)}`,
        `Plain response: ${String(plainPluginResult.stdout ?? "")}`,
        `Scoped response: ${String(scoped?.result?.stdout ?? "")}`,
      ].join("\n"))
    }

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      health,
      projectDirectory: scoped.response.location.directory,
      activationProbeAttempts: scoped.attempt,
      sentinelID,
      pluginID,
      plainPluginIDs: plainIDs,
      scopedPluginIDs: scopedIDs,
      activePluginIDs: ids,
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
