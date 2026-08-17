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
const GOAL_OBJECTIVE = "queued steering real host goal objective"
const USER_STEERING = "queued user steering must run before goal continuation"
const SESSION_BOOTSTRAP_TIMEOUT_MS = 90_000

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
      name: "opencode-loop-goal-steering-canary-config",
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

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return contentText(messages[index]?.content)
  }
  return ""
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
  const id = `chatcmpl-loop-goal-steering-${sequence}`
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
  const stats = {
    chatRequests: 0,
    goalStarted: 0,
    goalClosed: 0,
    steeringStarted: 0,
    paths: [],
  }
  const heldGoalResponses = new Set()

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
    const text = lastUserText(body)

    if (text.includes(USER_STEERING)) {
      stats.steeringStarted += 1
      streamText(res, "USER_STEERING_ACK", stats.chatRequests)
      return
    }

    if (text.includes("EXPERIMENTAL GOAL MODE CONTINUATION") && text.includes(GOAL_OBJECTIVE)) {
      stats.goalStarted += 1
      const id = `chatcmpl-loop-goal-held-${stats.chatRequests}`
      const created = Math.floor(Date.now() / 1000)
      heldGoalResponses.add(res)
      res.once("close", () => {
        if (heldGoalResponses.delete(res)) stats.goalClosed += 1
      })
      streamHeaders(res)
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: "canary",
        choices: [{ index: 0, delta: { role: "assistant", content: `GOAL_WORK_${stats.goalStarted}` }, finish_reason: null }],
      })
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
      if (!address || typeof address === "string") throw new Error("failed to start deterministic Goal steering provider")
      return address.port
    },
    async close() {
      for (const response of heldGoalResponses) response.destroy()
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
  throw new Error(`timed out waiting for ${description}\n${await diagnostics()}`)
}

async function readGoalJob(stateFile) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"))
    return (state.jobs || []).find((job) => String(job?.kind || "").toLowerCase() === "goal") || null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-goal-steering-host-"))
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
  await writeFile(path.join(commandDir, "loop-goal.md"), `---\ndescription: Start a Goal steering host canary\nagent: opencode-loop-local\n---\n\nOpenCode Loop Goal command handled. Reply exactly: OK.\n`)
  await writeFile(path.join(agentDir, "opencode-loop-local.md"), `---\ndescription: Local Goal steering command acknowledgement\nmode: primary\npermission:\n  "*": deny\n---\n\nReply exactly: OK\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Loop Goal Steering Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Loop Goal Steering Canary", limit: { context: 100000, output: 4096 } } },
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

    let sessionsPayload
    try {
      sessionsPayload = await api("/session", { method: "GET", signal: AbortSignal.timeout(SESSION_BOOTSTRAP_TIMEOUT_MS) })
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      throw new Error(`OpenCode session bootstrap failed after ${SESSION_BOOTSTRAP_TIMEOUT_MS}ms: ${message}\nserver log:\n${serverLog}`)
    }
    assert.ok(Array.isArray(sessionsPayload?.data ?? sessionsPayload), "GET /session bootstrap did not return an array")
    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "opencode-loop Goal steering canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const command = api(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: "loop-goal", arguments: GOAL_OBJECTIVE }),
      signal: AbortSignal.timeout(90_000),
    }).catch((error) => {
      commandError = error
      return null
    })

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const diagnostics = async () => {
      let state = "missing"
      try { state = await readFile(stateFile, "utf8") } catch {}
      return `provider=${JSON.stringify(provider.stats)}\ncommandError=${String(commandError ?? "none")}\nstate=${state}\nserver log:\n${serverLog}`
    }

    await waitFor(
      async () => {
        const goal = await readGoalJob(stateFile)
        return provider.stats.goalStarted === 1 && goal?.action === GOAL_OBJECTIVE && goal?.goalStatus === "active" && goal?.paused === false
      },
      "first autonomous Goal stream to become active",
      diagnostics,
    )

    await api(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "canary", modelID: "canary" },
        parts: [{ type: "text", text: USER_STEERING }],
      }),
      signal: AbortSignal.timeout(20_000),
    })

    await waitFor(() => provider.stats.goalClosed >= 1, "active Goal provider stream to be cancelled for queued steering", diagnostics)
    await waitFor(() => provider.stats.steeringStarted === 1, "queued user steering to reach the provider", diagnostics)
    await waitFor(
      async () => {
        const goal = await readGoalJob(stateFile)
        return goal?.action === GOAL_OBJECTIVE && goal?.goalStatus === "active" && goal?.paused === false
      },
      "Goal state to remain active and unchanged during steering",
      diagnostics,
    )
    await waitFor(() => provider.stats.goalStarted >= 2, "Goal autonomous continuation to resume after steering", diagnostics)

    const goal = await readGoalJob(stateFile)
    assert.equal(provider.stats.goalStarted, 2, `Goal should start once before and once after queued steering\n${await diagnostics()}`)
    assert.equal(provider.stats.goalClosed, 1, `only the pre-steering Goal stream should be cancelled before cleanup\n${await diagnostics()}`)
    assert.equal(provider.stats.steeringStarted, 1, `queued steering must execute exactly one foreground model turn\n${await diagnostics()}`)
    assert.equal(goal?.action, GOAL_OBJECTIVE)
    assert.equal(goal?.goalStatus, "active")
    assert.equal(goal?.paused, false)
    assert.equal(server.exitCode, null, `OpenCode server exited during Goal steering canary\n${await diagnostics()}`)

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      goalStarted: provider.stats.goalStarted,
      goalClosed: provider.stats.goalClosed,
      steeringStarted: provider.stats.steeringStarted,
      goalStatus: goal.goalStatus,
      paused: goal.paused,
      objective: goal.action,
      commandError: commandError ? String(commandError) : null,
    }, null, 2))
    void command
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