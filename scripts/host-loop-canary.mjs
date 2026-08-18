import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const LOOP_OBJECTIVE = "real host loop canary"
const RUN_NOW_NATURAL_OBJECTIVE = "real host loop-now natural canary"
const RUN_NOW_TARGET_OBJECTIVE = "real host loop-now target canary"

function resolveOpenCodeBinary() {
  if (!isWindows) return path.join(repoRoot, "node_modules", ".bin", "opencode")
  const candidates = [
    path.join(repoRoot, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe"),
    path.join(repoRoot, "node_modules", "opencode-windows-arm64", "bin", "opencode.exe"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`OpenCode native Windows binary was not installed. Checked: ${candidates.join(", ")}`)
  return found
}

const opencodeBin = resolveOpenCodeBinary()

function appendLog(current, chunk, limit = 80_000) {
  return (current + String(chunk)).slice(-limit)
}

async function seedConfigDependencies(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "*" }
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`)
  await writeFile(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "opencode-loop-host-canary-config",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies } },
    }, null, 2)}\n`,
  )
  await writeFile(path.join(dir, ".gitignore"), "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n")
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
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before ready.\n${logs()}`)
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for OpenCode server on ${port}\n${logs()}`)
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

function spawnOpenCode(args, options = {}) {
  return spawn(opencodeBin, args, { ...options, windowsHide: true })
}

async function runOpenCode(args, { cwd, env, timeoutMs = 60_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawnOpenCode(args, { cwd, env })
    let stdout = ""
    let stderr = ""
    let settled = false
    child.stdout?.on("data", (chunk) => { stdout = appendLog(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = appendLog(stderr, chunk) })
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      void stopProcess(child)
      finish(reject, new Error(`OpenCode command timed out: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      if (code !== 0) return finish(reject, new Error(`OpenCode command exited ${code}: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      finish(resolve, { stdout, stderr })
    })
  })
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("\n")
}

function lastUserMessageText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return contentText(messages[index]?.content)
  }
  return contentText(messages.at(-1)?.content)
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
  const id = `chatcmpl-loop-${sequence}`
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
  const stats = { chatRequests: 0, loopRequests: 0, runNowSequence: [], paths: [] }
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
    const text = lastUserMessageText(body)
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION") && text.includes(LOOP_OBJECTIVE)) {
      stats.loopRequests += 1
      streamText(res, `LOOP_TURN_${stats.loopRequests}`, stats.chatRequests)
      return
    }
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION") && text.includes(RUN_NOW_TARGET_OBJECTIVE)) {
      stats.runNowSequence.push("target")
      streamText(res, "RUN_NOW_TARGET", stats.chatRequests)
      return
    }
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION") && text.includes(RUN_NOW_NATURAL_OBJECTIVE)) {
      stats.runNowSequence.push("natural")
      streamText(res, "RUN_NOW_NATURAL", stats.chatRequests)
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
      if (!address || typeof address === "string") throw new Error("failed to start deterministic loop provider")
      return address.port
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

async function waitFor(predicate, description, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const detail = typeof diagnostics === "function" ? await diagnostics() : diagnostics
  throw new Error(`timed out waiting for ${description}\n${detail}`)
}

function isFetchTimeout(error) {
  return error?.name === "TimeoutError" || /aborted due to timeout/i.test(String(error?.message ?? error))
}

async function bootstrapSessions(api, diagnostics) {
  try {
    return await api("/session", { method: "GET", signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    if (!isFetchTimeout(error)) throw error
    console.error(`OpenCode session API was not ready after 30s; retrying once.\n${diagnostics()}`)
    return await api("/session", { method: "GET", signal: AbortSignal.timeout(45_000) })
  }
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-host-canary-"))
  const home = path.join(workspace, ".home")
  const projectConfig = path.join(workspace, ".opencode")
  const globalConfig = path.join(home, ".config", "opencode")
  const pluginDir = path.join(projectConfig, "plugins")
  const commandDir = path.join(projectConfig, "commands")
  const agentDir = path.join(projectConfig, "agents")
  const provider = startProvider()
  const providerPort = await provider.listen()
  let server
  let serverLog = ""
  let commandError = null

  await mkdir(pluginDir, { recursive: true })
  await mkdir(commandDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)
  const pluginEntry = pathToFileURL(path.join(repoRoot, "src", "index.js")).href
  await writeFile(path.join(pluginDir, "opencode-loop.js"), `export { default as OpenCodeLoopPlugin } from ${JSON.stringify(pluginEntry)}\n`)
  await writeFile(path.join(commandDir, "loop.md"), `---\ndescription: Start a host canary loop\nagent: opencode-loop-local\n---\n\nOpenCode Loop local command handled. Reply exactly: OK.\n`)
  await writeFile(path.join(commandDir, "loop-now.md"), `---\ndescription: Run a host canary loop now\nagent: opencode-loop-local\n---\n\nOpenCode Loop run-now command handled locally. Reply exactly: OK.\n`)
  await writeFile(path.join(agentDir, "opencode-loop-local.md"), `---\ndescription: Local Loop command acknowledgement\nmode: primary\npermission:\n  "*": deny\n---\n\nReply exactly: OK\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Loop Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Loop Canary", limit: { context: 100000, output: 4096 } } },
      },
    },
  }, null, 2)}\n`)

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    CI: "true",
  }

  try {
    await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
    const port = await reservePort()
    server = spawnOpenCode(["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
    server.stdout?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    server.stderr?.on("data", (chunk) => { serverLog = appendLog(serverLog, chunk) })
    await waitForTcp(port, server, () => serverLog)

    const baseURL = `http://127.0.0.1:${port}`
    const directoryQuery = `directory=${encodeURIComponent(workspace)}`
    const api = async (pathname, init = {}) => {
      const separator = pathname.includes("?") ? "&" : "?"
      const response = await fetch(`${baseURL}${pathname}${separator}${directoryQuery}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
      if (!text) return null
      try { return JSON.parse(text) } catch { return text }
    }

    const sessionsBefore = await bootstrapSessions(api, () => `server log:\n${serverLog}`)
    assert.ok(Array.isArray(sessionsBefore?.data ?? sessionsBefore), "GET /session bootstrap did not return an array")
    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "opencode-loop host canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const commandPath = `/session/${encodeURIComponent(sessionID)}/command`
    const sendCommand = async (name, argumentsText, timeoutMs = 90_000) => await api(commandPath, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: name, arguments: argumentsText }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const command = sendCommand("loop", `0s --max-runs 3 ${LOOP_OBJECTIVE}`).catch((error) => {
      commandError = error
      return null
    })

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const diagnostics = async () => {
      let state = "missing"
      let loopLog = "missing"
      try { state = await readFile(stateFile, "utf8") } catch {}
      try { loopLog = await readFile(path.join(workspace, ".opencode", "opencode-loop", "loop.log"), "utf8") } catch {}
      return `provider=${JSON.stringify(provider.stats)}\ncommandError=${String(commandError ?? "none")}\nstate=${state}\nloop log:\n${loopLog}\nserver log:\n${serverLog}`
    }

    await waitFor(() => provider.stats.loopRequests >= 3, "three real autonomous Loop turns", () => `provider=${JSON.stringify(provider.stats)}\nserver log:\n${serverLog}`)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.equal(provider.stats.loopRequests, 3, `Loop must stop at --max-runs 3; got extra real-host turn(s)\n${await diagnostics()}`)
    assert.equal(server.exitCode, null, `OpenCode server exited during canary\n${await diagnostics()}`)
    await command

    let persisted = null
    try { persisted = JSON.parse(await readFile(stateFile, "utf8")) } catch {}
    if (persisted?.jobs?.length) {
      const loop = persisted.jobs.find((item) => item.name === "default" || item.action === LOOP_OBJECTIVE)
      if (loop) assert.ok((loop.runCount || 0) >= 3, `persisted Loop run count was lower than provider turn count: ${JSON.stringify(loop)}`)
    }

    await sendCommand("loop", `10m --no-now --name natural --multi --max-runs 1 ${RUN_NOW_NATURAL_OBJECTIVE}`)
    await sendCommand("loop", `10m --no-now --name target --multi --max-runs 1 ${RUN_NOW_TARGET_OBJECTIVE}`)
    await waitFor(async () => {
      try {
        const state = JSON.parse(await readFile(stateFile, "utf8"))
        const names = new Set((state.jobs || []).map((job) => job.name))
        return names.has("natural") && names.has("target")
      } catch {
        return false
      }
    }, "two delayed real-host Loop jobs", () => `provider=${JSON.stringify(provider.stats)}\nserver log:\n${serverLog}`)

    provider.stats.runNowSequence.length = 0
    await sendCommand("loop-now", "target")
    await waitFor(() => provider.stats.runNowSequence.length >= 1, "targeted real-host loop-now turn", diagnostics)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.deepEqual(provider.stats.runNowSequence, ["target"], `loop-now target must not run the earlier delayed natural job\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      loopRequests: provider.stats.loopRequests,
      runNowSequence: provider.stats.runNowSequence,
      chatRequests: provider.stats.chatRequests,
      commandError: commandError ? String(commandError) : null,
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
