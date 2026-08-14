import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencode2 = process.platform === "win32" ? "opencode2.cmd" : "opencode2"

function append(current, chunk, limit = 120_000) {
  return (current + String(chunk)).slice(-limit)
}

async function stopProcess(child, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null) return
  try { child.kill() } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function run(command, args, { cwd, env, timeoutMs = 90_000, allowFailure = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      void stopProcess(child)
      finish(reject, new Error(`command timed out: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr }
      if (!allowFailure && code !== 0) {
        return finish(reject, new Error(`command exited ${code}: ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }
      finish(resolve, result)
    })
  })
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("failed to reserve server port"))
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

function contentText(value) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const direct = parts.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
  if (direct) return direct
  return contentText(message?.content)
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamText(res, text, sequence) {
  const id = `chatcmpl-v2-status-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  const stats = { chatRequests: 0, paths: [] }
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
    if (raw) JSON.parse(raw)
    stats.chatRequests += 1
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
      if (!address || typeof address === "string") throw new Error("failed to bind deterministic provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function waitFor(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return value
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-status-host-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const pluginDir = path.join(project, ".opencode", "plugins")
  const commandDir = path.join(project, ".opencode", "commands")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""

  const xdgConfig = path.join(home, ".config")
  const xdgData = path.join(home, ".local", "share")
  const xdgState = path.join(home, ".local", "state")
  const xdgCache = path.join(home, ".cache")
  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(commandDir, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    mkdir(xdgData, { recursive: true }),
    mkdir(xdgState, { recursive: true }),
    mkdir(xdgCache, { recursive: true }),
  ])

  const pluginURL = pathToFileURL(path.join(root, "src", "source", "opencode2", "experimental.js")).href
  await writeFile(path.join(pluginDir, "opencode-loop-v2.js"), `export { default } from ${JSON.stringify(pluginURL)}\n`)
  await writeFile(path.join(commandDir, "loop-status.md"), `---\ndescription: Show OpenCode Loop status\n---\n\nOpenCode Loop status command handled locally. Reply exactly: OK.\n`)
  await writeFile(path.join(project, "README.md"), "# OpenCode Loop V2 status canary\n")
  await writeFile(path.join(project, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic V2 Status Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic V2 Status Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    OPENCODE_DB: ":memory:",
    OPENCODE_LOG_LEVEL: "DEBUG",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  try {
    await run("git", ["init", "-q"], { cwd: project, env })
    await run("git", ["config", "user.name", "OpenCode Loop Canary"], { cwd: project, env })
    await run("git", ["config", "user.email", "opencode-loop-canary@example.invalid"], { cwd: project, env })
    await run("git", ["add", "."], { cwd: project, env })
    await run("git", ["commit", "-q", "-m", "initialize V2 status canary"], { cwd: project, env })

    const version = (await run(opencode2, ["--version"], { cwd: project, env, timeoutMs: 30_000 })).stdout.trim()
    assert.ok(version)

    const port = await reservePort()
    server = spawn(opencode2, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: project,
      env,
      windowsHide: true,
    })
    server.stdout?.on("data", (chunk) => { serverLog = append(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = append(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const request = async (method, paths, data) => {
      const candidates = Array.isArray(paths) ? paths : [paths]
      let last
      for (let index = 0; index < candidates.length; index++) {
        const pathname = candidates[index]
        const separator = pathname.includes("?") ? "&" : "?"
        const url = `${baseURL}${pathname}${separator}directory=${encodeURIComponent(project)}`
        const response = await fetch(url, {
          method,
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": project,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        last = { response, text, pathname }
        if (response.status === 404 && index < candidates.length - 1) continue
        if (!response.ok) throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${text}\nserver log:\n${serverLog}`)
        if (!text) return null
        try { return JSON.parse(text) } catch { return text }
      }
      throw new Error(`${method} ${candidates.join(" or ")} failed: ${last?.text ?? "no response"}`)
    }

    const commandCatalog = await request("GET", ["/api/command", "/command"])
    const commands = commandCatalog?.data ?? commandCatalog
    assert.ok(Array.isArray(commands), `command catalog was not an array: ${JSON.stringify(commandCatalog)}`)
    assert.ok(commands.some((item) => item?.name === "loop-status" || item?.id === "loop-status"), `loop-status was not discovered: ${JSON.stringify(commands)}`)

    const createdPayload = await request("POST", ["/api/session", "/session"], { title: "OpenCode Loop V2 status canary" })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `session creation failed: ${JSON.stringify(createdPayload)}`)

    await request("POST", [
      `/api/session/${encodeURIComponent(sessionID)}/command`,
      `/session/${encodeURIComponent(sessionID)}/command`,
    ], {
      agent: "build",
      model: "canary/canary",
      command: "loop-status",
      arguments: "",
    })

    const readMessages = async () => {
      const payload = await request("GET", [
        `/api/session/${encodeURIComponent(sessionID)}/message`,
        `/session/${encodeURIComponent(sessionID)}/message`,
      ])
      return payload?.data ?? payload
    }
    const messages = await waitFor(
      readMessages,
      (items) => Array.isArray(items) && items.some((message) => messageText(message).includes("OpenCode loop status:\nNo active loop jobs.")),
    )

    assert.ok(Array.isArray(messages), `session messages were not an array: ${JSON.stringify(messages)}`)
    const texts = messages.map(messageText)
    assert.ok(texts.some((text) => text.includes("OpenCode loop status:\nNo active loop jobs.")), `V2 status response was not persisted. Messages: ${JSON.stringify(texts)}\nserver log:\n${serverLog}`)
    assert.ok(provider.stats.chatRequests >= 1, `command did not reach deterministic provider: ${JSON.stringify(provider.stats)}`)

    console.log(JSON.stringify({
      ok: true,
      opencode2Version: version,
      sessionID,
      provider: provider.stats,
      messageTexts: texts,
      serverLog,
    }, null, 2))
  } catch (error) {
    let logTail = ""
    try {
      const logFile = path.join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log")
      logTail = (await readFile(logFile, "utf8")).slice(-30_000)
    } catch {}
    if (logTail) console.error(`OpenCode 2 log tail:\n${logTail}`)
    if (serverLog) console.error(`OpenCode 2 server output:\n${serverLog}`)
    throw error
  } finally {
    await stopProcess(server)
    await provider.close()
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
