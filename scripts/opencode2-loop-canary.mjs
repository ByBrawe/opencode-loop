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
const EXPECTED_COMMANDS = ["loop", "loop-pause", "loop-resume", "loop-stop", "loop-remove", "loop-clear"]
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

async function waitFor(predicate, description, diagnostics, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
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

function bridgePluginSource() {
  return `import { writeFile } from "node:fs/promises"

export default {
  id: "bybrawe.opencode-loop.v2.loop-canary-bridge",
  async setup(ctx) {
    const module = await import(process.env.OPENCODE_LOOP_V2_PLUGIN_URL)
    const cleanup = await module.default.setup(ctx)
    await writeFile(process.env.OPENCODE_LOOP_V2_MARKER, JSON.stringify({ activated: true }, null, 2), "utf8")
    return async () => {
      if (typeof cleanup === "function") await cleanup()
    }
  }
}
`
}

function commandNames(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return new Set(data.map((item) => item?.name).filter((name) => typeof name === "string"))
}

async function main() {
  assert.equal(process.platform, "linux", "the real OpenCode 2 Loop canary is intentionally Ubuntu-only")

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-e2e-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const marker = path.join(workspace, "v2-real-adapter-marker.json")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""
  let apiPrefix = null
  let latestCommands = new Set()
  let sessionID = ""
  let commandError = null

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-loop-v2-real.js"), bridgePluginSource(), "utf8")
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
    if (sessionID) {
      try { state = await readFile(path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`), "utf8") } catch {}
    }
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `commands=${JSON.stringify([...latestCommands])}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `sessionID=${sessionID || "none"}`,
      `commandError=${String(commandError ?? "none")}`,
      `state=${state}`,
      `serverExit=${server?.exitCode}`,
      `serverLog=${serverLog}`,
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
    const request = async (pathname, init = {}, timeoutMs = 30_000) => {
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
      let body = null
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      return { ok: response.ok, status: response.status, body, text }
    }

    for (const prefix of ["/api", ""]) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        let response
        try { response = await request(`${prefix}/command`, { method: "GET" }, 5_000) } catch {}
        if (response?.ok) {
          apiPrefix = prefix
          break
        }
        if (response && ![404, 503].includes(response.status)) {
          throw new Error(`command registry probe failed with HTTP ${response.status}: ${response.text}\n${await diagnostics()}`)
        }
        if (response?.status === 404) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (apiPrefix !== null) break
    }
    assert.notEqual(apiPrefix, null, `OpenCode 2 command API never became ready\n${await diagnostics()}`)

    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(marker, "utf8"))?.activated) } catch { return false }
    }, "experimental V2 plugin activation", diagnostics, 30_000)

    await waitFor(async () => {
      const response = await request(`${apiPrefix}/command`, { method: "GET" }, 5_000)
      if (!response.ok) return false
      latestCommands = commandNames(response.body)
      return EXPECTED_COMMANDS.every((name) => latestCommands.has(name))
    }, "plugin-registered Loop commands to enter the real V2 registry", diagnostics, 30_000)

    const createdResponse = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode 2 Loop canary" }),
    })
    if (!createdResponse.ok) throw new Error(`session create failed: HTTP ${createdResponse.status} ${createdResponse.text}\n${await diagnostics()}`)
    const session = createdResponse.body?.data ?? createdResponse.body
    sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${createdResponse.text}\n${await diagnostics()}`)

    const commandPromise = request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: "loop", arguments: `0s --max-runs ${EXPECTED_TURNS} ${LOOP_OBJECTIVE}` }),
    }, 120_000).catch((error) => {
      commandError = error
      return null
    })

    await waitFor(() => provider.stats.loopRequests >= EXPECTED_TURNS, `${EXPECTED_TURNS} autonomous OpenCode 2 Loop turns`, diagnostics, 90_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(provider.stats.loopRequests, EXPECTED_TURNS, `V2 Loop exceeded --max-runs ${EXPECTED_TURNS}\n${await diagnostics()}`)

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const persisted = JSON.parse(await readFile(stateFile, "utf8"))
    const loop = persisted.jobs?.find((job) => job.name === "default")
    assert.ok(loop, `persisted V2 Loop job was missing\n${await diagnostics()}`)
    assert.equal(loop.runCount, EXPECTED_TURNS)
    assert.equal(loop.enabled, false)

    const commandResponse = await commandPromise
    if (commandError) throw commandError
    assert.ok(commandResponse?.ok, `Loop command request failed: ${commandResponse?.status} ${commandResponse?.text}\n${await diagnostics()}`)
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      apiPrefix,
      sessionID,
      registeredCommands: [...latestCommands],
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
