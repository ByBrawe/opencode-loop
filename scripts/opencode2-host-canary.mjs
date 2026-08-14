import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import net from "node:net"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginID = "bybrawe.opencode-loop.v2.experimental"
const sentinelID = "bybrawe.opencode-loop.v2-canary-sentinel"
const objective = "real OpenCode 2 loop canary"
const isWindows = process.platform === "win32"

function run(command, args, { cwd, env, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
    shell: isWindows,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  }
  return result
}

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, { ...options, windowsHide: true, shell: isWindows })
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

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTcp(port, child, logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode 2 server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await delay(100)
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    delay(2_000),
  ])
}

function messageText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.map((message) => {
    const content = message?.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
  }).join("\n")
}

function sendSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, text, sequence) {
  const id = `chatcmpl-v2-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  sendSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "test-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  sendSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { chatRequests: 0, loopRequests: 0, paths: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    stats.paths.push(`${req.method} ${url.pathname}`)
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model", owned_by: "canary" }] }))
      return
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `unexpected endpoint: ${req.method} ${url.pathname}` } }))
      return
    }

    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    stats.chatRequests += 1
    const text = messageText(body)
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION") && text.includes(objective)) stats.loopRequests += 1
    streamText(res, `V2_TURN_${stats.chatRequests}`, stats.chatRequests)
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic V2 provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for ${description}\n${diagnostics()}`)
}

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
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""

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
    model: "test/test-model",
    small_model: "test/test-model",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${providerPort}/v1` },
      },
    },
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
    OPENCODE_LOOP_V2_CANARY_MAX_RUNS: "3",
    OPENCODE_LOOP_V2_CANARY_OBJECTIVE: objective,
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
    if (response?.location?.directory !== project) throw new Error(`OpenCode 2 resolved the wrong Location: ${String(response?.location?.directory)}`)
    if (!ids.includes(sentinelID) || !ids.includes(pluginID)) throw new Error(`OpenCode 2 plugin activation timed out. Active IDs: ${JSON.stringify(ids)}`)

    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    const port = await reservePort()
    server = spawnCommand("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env })
    server.stdout?.on("data", (chunk) => { serverLog = (serverLog + String(chunk)).slice(-80_000) })
    server.stderr?.on("data", (chunk) => { serverLog = (serverLog + String(chunk)).slice(-80_000) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(project)}`
    const api = async (pathname, init = {}) => {
      const separator = pathname.includes("?") ? "&" : "?"
      const result = await fetch(`${baseURL}${pathname}${separator}${locationQuery}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(45_000),
      })
      const text = await result.text()
      if (!result.ok) throw new Error(`HTTP ${result.status}: ${text}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    }

    const createdPayload = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: project } }),
    })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(createdPayload)}`)

    await api(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: { text: "Start the real OpenCode 2 Loop canary. Reply exactly OK." }, resume: true }),
      signal: AbortSignal.timeout(60_000),
    })

    await waitFor(() => provider.stats.loopRequests >= 3, "three real OpenCode 2 continuation turns", () => `provider=${JSON.stringify(provider.stats)}\nserver log:\n${serverLog}`)
    await delay(1_000)
    assert.equal(provider.stats.loopRequests, 3, `V2 Loop must stop after three continuations; got ${provider.stats.loopRequests}\n${serverLog}`)
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during canary\n${serverLog}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      node: process.version,
      opencode2Version: version,
      projectDirectory: project,
      sessionID,
      sentinelID,
      pluginID,
      activePluginIDs: ids,
      chatRequests: provider.stats.chatRequests,
      loopRequests: provider.stats.loopRequests,
    }, null, 2))
  } catch (error) {
    const logs = await failureLog(env)
    if (logs) console.error(`OpenCode 2 server log tail:\n${logs}`)
    if (serverLog) console.error(`OpenCode 2 direct server log tail:\n${serverLog}`)
    throw error
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    run("opencode2", ["service", "stop"], { cwd: project, env, allowFailure: true, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
