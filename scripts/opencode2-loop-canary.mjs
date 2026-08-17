import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOOP_OBJECTIVE = "real OpenCode 2 loop canary"
const EXPECTED_TURNS = 2
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-loop-v2-canary"

function appendLog(current, chunk, limit = 100_000) {
  return (current + String(chunk)).slice(-limit)
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve TCP port"))
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server on ${port}\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

function collectCommandNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectCommandNames(item, names)
    return names
  }
  if (!value || typeof value !== "object") return names
  for (const [key, item] of Object.entries(value)) {
    if (key === "name" || key === "command" || key === "id") {
      if (typeof item === "string") names.add(item)
    } else if (item && typeof item === "object") {
      collectCommandNames(item, names)
    }
  }
  return names
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function allMessageText(body) {
  return (body.messages ?? []).map((message) => contentText(message?.content)).join("\n")
}

function streamHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, content, sequence) {
  const id = `chatcmpl-v2-loop-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  streamHeaders(res)
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
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
      res.end(JSON.stringify({ object: "list", data: [{ id: "canary", object: "model", owned_by: "canary" }] }))
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
    const text = allMessageText(body)
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION") && text.includes(LOOP_OBJECTIVE)) {
      stats.loopRequests += 1
      streamText(res, `V2_LOOP_TURN_${stats.loopRequests}`, stats.chatRequests)
      return
    }
    streamText(res, "OK", stats.chatRequests)
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
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

async function readOpenCodeLogTail(env) {
  const candidates = [
    path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"),
    path.join(env.XDG_STATE_HOME, "opencode", "log", "opencode.log"),
  ]
  for (const file of candidates) {
    try { return (await readFile(file, "utf8")).slice(-30_000) } catch {}
  }
  return ""
}

function bridgePluginSource() {
  return `import { writeFile } from "node:fs/promises"

export default {
  id: "bybrawe.opencode-loop.v2.loop-canary-bridge",
  async setup(ctx) {
    const pluginURL = process.env.OPENCODE_LOOP_V2_PLUGIN_URL
    const marker = process.env.OPENCODE_LOOP_V2_MARKER
    if (!pluginURL) throw new Error("OPENCODE_LOOP_V2_PLUGIN_URL is required")
    if (!marker) throw new Error("OPENCODE_LOOP_V2_MARKER is required")
    const module = await import(pluginURL)
    const plugin = module.default
    if (!plugin || typeof plugin.setup !== "function") throw new Error("experimental V2 plugin has no setup function")
    const cleanup = await plugin.setup(ctx)
    await writeFile(marker, JSON.stringify({
      activated: true,
      commandTransform: typeof ctx?.command?.transform === "function",
      eventSubscribe: typeof ctx?.event?.subscribe === "function",
      sessionPrompt: typeof ctx?.session?.prompt === "function",
      sessionCommand: typeof ctx?.session?.command === "function"
    }, null, 2), "utf8")
    return async () => {
      if (typeof cleanup === "function") await cleanup()
    }
  }
}
`
}

async function main() {
  assert.equal(process.platform, "linux", "the first real OpenCode 2 loop canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-e2e-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const commandDir = path.join(workspace, ".opencode", "commands")
  const agentDir = path.join(workspace, ".opencode", "agents")
  const marker = path.join(workspace, "v2-real-adapter-marker.json")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""
  let commandResult = null
  let apiPrefix = null
  let commandNames = new Set()

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(commandDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-loop-v2-real.js"), bridgePluginSource(), "utf8")
  await writeFile(path.join(commandDir, "loop.md"), await readFile(path.join(repoRoot, "commands", "loop.md"), "utf8"))
  await writeFile(path.join(agentDir, "opencode-loop-local.md"), await readFile(path.join(repoRoot, "agents", "opencode-loop-local.md"), "utf8"))
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    providers: {
      canary: {
        name: "Deterministic OpenCode 2 Loop Canary",
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
        models: {
          canary: {
            name: "Deterministic OpenCode 2 Loop Canary",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 4096 },
          },
        },
      },
    },
  }, null, 2)}\n`)
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" })
  execFileSync("git", ["-C", workspace, "config", "user.email", "opencode-loop-ci@example.invalid"], { stdio: "ignore" })
execFileSync("git", ["-C", workspace, "config", "user.name", "OpenCode Loop CI"], { stdio: "ignore" })
execFileSync("git", ["-C", workspace, "add", "."], { stdio: "ignore" })
execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "init"], { stdio: "ignore" })

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_LOOP_V2_PLUGIN_URL: pathToFileURL(path.join(repoRoot, "src", "source", "opencode2", "experimental.js")).href,
    OPENCODE_LOOP_V2_MARKER: marker,
    OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  const diagnostics = async () => {
    let state = "missing"
    let stateFile = "unknown"
    try {
      if (commandResult?.sessionID) {
        stateFile = path.join(workspace, ".opencode", "opencode-loop", `${commandResult.sessionID}.json`)
        state = await readFile(stateFile, "utf8")
      }
    } catch {}
    const diskLog = await readOpenCodeLogTail(env)
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `commands=${JSON.stringify([...commandNames])}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `command=${commandResult?.error ? String(commandResult.error) : JSON.stringify(commandResult)}`,
      `stateFile=${stateFile}`,
      `state=${state}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
      `diskLog=${diskLog}`,
    ].join("\n")
  }

  try {
    const port = await reservePort()
    server = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${SERVER_PASSWORD}`).toString("base64")}`
    const request = async (pathname, init = {}, { timeoutMs = 30_000, allowHttpError = false } = {}) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          authorization,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let body = text
      if (text) {
        try { body = JSON.parse(text) } catch {}
      } else {
        body = null
      }
      if (!response.ok && !allowHttpError) {
        throw new Error(`HTTP ${response.status} ${pathname}: ${text}\n${await diagnostics()}`)
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    let registryResponse
    for (const prefix of ["/api", ""]) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && apiPrefix === null) {
        let candidate
        try {
          candidate = await request(`${prefix}/command`, { method: "GET" }, { timeoutMs: 5_000, allowHttpError: true })
        } catch (error) {
          serverLog = appendLog(serverLog, `\ncommand registry probe ${prefix || "/"} failed: ${String(error)}\n`)
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        if (candidate.ok) {
          apiPrefix = prefix
          registryResponse = candidate
          break
        }
        if (candidate.status === 503) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        if (candidate.status === 404) break
        throw new Error(`command registry probe failed with HTTP ${candidate.status}: ${candidate.text}\n${await diagnostics()}`)
      }
      if (apiPrefix !== null) break
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 exposed neither /api/command nor /command after readiness wait\n${await diagnostics()}`)

    commandNames = collectCommandNames(registryResponse.body)
    assert.ok(commandNames.has("loop"), `OpenCode 2 did not register the project loop command: ${registryResponse.text}\n${await diagnostics()}`)

    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(marker, "utf8"))?.activated) } catch { return false }
    }, "real V2 adapter activation on the explicit serve process", diagnostics, 30_000)

    const createBody = {
      title: "OpenCode 2 Loop canary",
      model: { providerID: "canary", id: "canary" },
    }
    const createdResponse = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify(createBody),
    }, { timeoutMs: 30_000 })
    const created = createdResponse.body?.data ?? createdResponse.body
    const sessionID = String(created?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${createdResponse.text}\n${await diagnostics()}`)

    commandResult = { sessionID, pending: true }
    const commandBody = {
      command: "loop",
      arguments: `0s --max-runs ${EXPECTED_TURNS} ${LOOP_OBJECTIVE}`,
    }
    const commandPromise = request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify(commandBody),
    }, { timeoutMs: 120_000 })
      .then((response) => {
        commandResult = { sessionID, response: response.body }
        return response
      })
      .catch((error) => {
        commandResult = { sessionID, error }
        return null
      })

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    await waitFor(() => provider.stats.loopRequests >= EXPECTED_TURNS, `${EXPECTED_TURNS} autonomous OpenCode 2 Loop turns`, diagnostics, 90_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(provider.stats.loopRequests, EXPECTED_TURNS, `V2 Loop must stop at --max-runs ${EXPECTED_TURNS}\n${await diagnostics()}`)

    const persisted = JSON.parse(await readFile(stateFile, "utf8"))
    const loop = persisted.jobs?.find((job) => job.name === "default")
    assert.ok(loop, `persisted V2 Loop job was missing\n${await diagnostics()}`)
    assert.equal(loop.runCount, EXPECTED_TURNS)
    assert.equal(loop.enabled, false)

    const finalCommand = await commandPromise
    if (commandResult?.error) throw commandResult.error
    assert.ok(finalCommand?.ok, `OpenCode 2 command request did not complete successfully\n${await diagnostics()}`)
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      opencode2: true,
      apiPrefix,
      sessionID,
      registeredCommands: [...commandNames],
      loopRequests: provider.stats.loopRequests,
      chatRequests: provider.stats.chatRequests,
      runCount: loop.runCount,
      enabled: loop.enabled,
    }, null, 2))
  } finally {
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
