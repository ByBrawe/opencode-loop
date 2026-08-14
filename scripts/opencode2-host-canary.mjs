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
    shell: process.platform === "win32",
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  }
  return result
}

function parseJSON(result, label) {
  try { return JSON.parse(String(result.stdout ?? "").trim()) }
  catch { throw new Error(`${label} did not return JSON.\n${result.stdout ?? ""}\n${result.stderr ?? ""}`) }
}

function collectIDs(value) {
  if (Array.isArray(value)) return value.flatMap(collectIDs)
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  return [value.id, value.pluginID, value.name, ...collectIDs(value.data), ...collectIDs(value.plugins), ...collectIDs(value.items)]
    .filter((item) => typeof item === "string")
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function failureLog(env) {
  for (const file of [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]) {
    try { return (await readFile(file, "utf8")).slice(-30_000) } catch {}
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
  const adapterBridge = path.join(pluginDirectory, "opencode-loop-v2-canary.js")
  const sentinelFile = path.join(pluginDirectory, "opencode-loop-v2-sentinel.js")
  const pluginFile = path.join(root, "src", "source", "opencode2", "experimental.js")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(sentinelFile, `export default { id: ${JSON.stringify(sentinelID)}, setup: async () => {} }\n`)
  await writeFile(adapterBridge, `export { default } from ${JSON.stringify(pathToFileURL(pluginFile).href)}\n`)
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
    CI: "true",
  }

  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Loop Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-loop-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize canary workspace"], { cwd: project, env })

  try {
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const version = String(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }).stdout ?? "").trim()
    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    let response
    let ids = []

    for (let attempt = 0; attempt < 30; attempt++) {
      response = parseJSON(run("opencode2", ["api", "get", pluginPath], { cwd: project, env }), "GET /api/plugin")
      ids = [...new Set(collectIDs(response))]
      if (response?.location?.directory === project && ids.includes(sentinelID) && ids.includes(pluginID)) break
      await delay(250)
    }

    if (response?.location?.directory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: ${String(response?.location?.directory)}`)
    }
    if (!ids.includes(sentinelID) || !ids.includes(pluginID)) {
      throw new Error(`OpenCode 2 plugin activation timed out. Active IDs: ${JSON.stringify(ids)}`)
    }

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      projectDirectory: response.location.directory,
      sentinelID,
      pluginID,
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
