import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOOP_OBJECTIVE = "real OpenCode 2 loop canary"
const EXPECTED_TURNS = 2

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

async function stopProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
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

  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(commandDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(path.join(home, ".config"), { recursive: true }),
    mkdir(path.join(home, ".local", "share"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
  ])

  await writeFile(path.join(pluginDir, "opencode-loop-v2-real.js"), await readFile(path.join(repoRoot, "scripts", "fixtures", "opencode2-real-adapter-probe.js"), "utf8"))
  await writeFile(path.join(commandDir, "loop.md"), await readFile(path.join(repoRoot, "commands", "loop.md"), "utf8"))
  await writeFile(path.join(agentDir, "opencode-loop-local.md"), await readFile(path.join(repoRoot, "agents", "opencode-loop-local.md"), "utf8"))
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic OpenCode 2 Loop Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic OpenCode 2 Loop Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
  }, null, 2)}\n`)

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
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
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
    const api = async (pathname, init = {}) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(60_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    }

    const created = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "OpenCode 2 Loop canary",
        model: { providerID: "canary", id: "canary" },
        location: { directory: workspace },
      }),
    })
    const session = created?.data ?? created
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(created)}`)

    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(marker, "utf8"))?.activated) } catch { return false }
    }, "real V2 adapter activation", async () => `provider=${JSON.stringify(provider.stats)}\nserver log:\n${serverLog}`)

    const commandPromise = api(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        command: "loop",
        arguments: `0s --max-runs ${EXPECTED_TURNS} ${LOOP_OBJECTIVE}`,
        model: { providerID: "canary", id: "canary" },
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch((error) => ({ error }))

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const diagnostics = async () => {
      let state = "missing"
      try { state = await readFile(stateFile, "utf8") } catch {}
      return `provider=${JSON.stringify(provider.stats)}\nstate=${state}\nserver log:\n${serverLog}`
    }

    await waitFor(() => provider.stats.loopRequests >= EXPECTED_TURNS, `${EXPECTED_TURNS} autonomous OpenCode 2 Loop turns`, diagnostics, 90_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(provider.stats.loopRequests, EXPECTED_TURNS, `V2 Loop must stop at --max-runs ${EXPECTED_TURNS}\n${await diagnostics()}`)
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during canary\n${await diagnostics()}`)

    const persisted = JSON.parse(await readFile(stateFile, "utf8"))
    const loop = persisted.jobs?.find((job) => job.name === "default")
    assert.ok(loop, `persisted V2 Loop job was missing\n${await diagnostics()}`)
    assert.equal(loop.runCount, EXPECTED_TURNS)
    assert.equal(loop.enabled, false)

    const commandResult = await commandPromise
    if (commandResult?.error) throw commandResult.error

    console.log(JSON.stringify({
      ok: true,
      opencode2: true,
      sessionID,
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
