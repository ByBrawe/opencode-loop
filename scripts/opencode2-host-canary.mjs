import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForMarker(file, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      lastError = error
      await delay(50)
    }
  }
  throw new Error(`${label} marker was not written: ${String(lastError ?? "timeout")}`)
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
  const sentinelFile = path.join(pluginDirectory, "opencode-loop-v2-sentinel.js")
  const markerFile = path.join(temp, "sentinel-loaded.json")

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])

  await writeFile(sentinelFile, [
    `import { writeFile } from "node:fs/promises"`,
    `export default {`,
    `  id: "bybrawe.opencode-loop.v2-native-sentinel",`,
    `  setup: async (ctx) => {`,
    `    const snapshot = {`,
    `      loaded: true,`,
    `      contextKeys: Object.keys(ctx || {}).sort(),`,
    `      commandKeys: Object.keys(ctx?.command || {}).sort(),`,
    `      agentKeys: Object.keys(ctx?.agent || {}).sort(),`,
    `      aisdkKeys: Object.keys(ctx?.aisdk || {}).sort(),`,
    `    }`,
    `    await writeFile(${JSON.stringify(markerFile)}, JSON.stringify(snapshot), "utf8")`,
    `  },`,
    `}`,
    ``,
  ].join("\n"))

  await writeFile(path.join(project, "README.md"), "# OpenCode Loop V2 native activation canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: ["./.opencode/plugins/opencode-loop-v2-sentinel.js"],
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

    const version = output(run("opencode2", ["--version"], { cwd: project, env, timeout: 30_000 }))
    if (!version) throw new Error("opencode2 --version returned no output")

    const health = output(run("opencode2", ["api", "get", "/api/health"], { cwd: project, env }))
    if (!health) throw new Error("OpenCode 2 health API returned no output")

    const pluginPath = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const pluginResult = run("opencode2", ["api", "get", pluginPath], { cwd: project, env })
    const response = parseJSONOutput(pluginResult, "GET /api/plugin at project Location")
    if (response?._tag) throw new Error(`project-scoped /api/plugin rejected the Location: ${JSON.stringify(response)}`)
    if (response?.location?.directory !== project) {
      throw new Error(`OpenCode 2 resolved the wrong Location: expected ${project}, got ${String(response?.location?.directory)}`)
    }

    const marker = await waitForMarker(markerFile, "native V2 setup sentinel")
    if (marker?.loaded !== true) throw new Error("native V2 setup sentinel did not finish initialization")

    console.log(JSON.stringify({
      ok: true,
      compatibility: "native-v2-setup-activation",
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      health,
      projectDirectory: response.location.directory,
      ...marker,
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
