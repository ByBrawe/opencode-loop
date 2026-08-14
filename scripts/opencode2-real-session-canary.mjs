import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencode2Bin = process.env.OPENCODE2_BIN || "opencode2"

function appendLog(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
}

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
    if (child.exitCode !== null) throw new Error(`OpenCode 2 exited before ready\n${logs()}`)
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode 2 server\n${logs()}`)
}

async function stopProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return
  child.kill()
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

function messageText(body) {
  return (body.messages || []).map((message) => contentText(message?.content)).join("\n")
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

function startProvider() {
  const stats = { requests: 0, canaryPrompts: 0, paths: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
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
    stats.requests += 1
    if (messageText(body).includes("V2_REAL_SESSION_CANARY")) stats.canaryPrompts += 1
    const content = "V2_CANARY_OK"
    const id = `chatcmpl-v2-${stats.requests}`
    const created = Math.floor(Date.now() / 1000)

    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: "canary",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }))
      return
    }

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
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    })
    res.end("data: [DONE]\n\n")
  })

  return {
    stats,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start provider")
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-session-"))
  const home = path.join(workspace, ".home")
  const pluginDir = path.join(workspace, ".opencode", "plugins")
  const marker = path.join(workspace, "v2-session-marker.json")
  const provider = startProvider()
  const providerPort = await provider.listen()
  const port = await reservePort()
  let server
  let serverLog = ""

  await mkdir(pluginDir, { recursive: true })
  await mkdir(home, { recursive: true })
  await copyFile(
    path.join(repoRoot, "scripts", "fixtures", "opencode2-real-session-probe.js"),
    path.join(pluginDir, "opencode-loop-v2-session-probe.js"),
  )
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic V2 Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic V2 Canary", limit: { context: 100000, output: 4096 } } },
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
    OPENCODE_SERVER_PASSWORD: "probe",
    OPENCODE_LOOP_V2_RUNTIME_URL: pathToFileURL(path.join(repoRoot, "src", "source", "opencode2", "runtime-adapter.js")).href,
    OPENCODE_LOOP_V2_SESSION_MARKER: marker,
    CI: "true",
  }

  const diagnostics = async () => {
    let markerText = "missing"
    try { markerText = await readFile(marker, "utf8") } catch {}
    return `provider=${JSON.stringify(provider.stats)}\nmarker=${markerText}\nserver log:\n${serverLog}`
  }

  try {
    server = spawn(opencode2Bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const auth = `Basic ${Buffer.from("opencode:probe").toString("base64")}`
    const api = async (pathname, init = {}) => {
      const response = await fetch(`${baseURL}${pathname}`, {
        ...init,
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "x-opencode-directory": workspace,
          ...(init.headers || {}),
        },
        signal: init.signal || AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      return text ? JSON.parse(text) : null
    }

    await api("/api/command")
    await waitFor(async () => {
      try { return JSON.parse(await readFile(marker, "utf8")).ready === true } catch { return false }
    }, "V2 probe plugin readiness", diagnostics)

    const created = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ location: { directory: workspace } }),
    })
    const session = created?.data ?? created
    assert.ok(session?.id, `V2 session creation failed: ${JSON.stringify(created)}`)

    await waitFor(() => provider.stats.canaryPrompts >= 1, "runtime-adapter session.prompt dispatch", diagnostics)
    await waitFor(async () => {
      try {
        const value = JSON.parse(await readFile(marker, "utf8"))
        return value.rawTypes.includes("session.next.step.ended") && value.normalized.includes("session:step-ended")
      } catch { return false }
    }, "V2 step-ended event normalization", diagnostics)

    const finalMarker = JSON.parse(await readFile(marker, "utf8"))
    assert.equal(finalMarker.promptStarted, true)
    assert.equal(finalMarker.promptCompleted, true)
    assert.ok(finalMarker.rawTypes.includes("session.created"))
    assert.ok(finalMarker.rawTypes.includes("session.next.step.ended"))
    assert.ok(finalMarker.normalized.includes("session:step-ended"))
    console.log("OpenCode 2 real session runtime canary passed")
  } finally {
    await stopProcess(server)
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

await main()
