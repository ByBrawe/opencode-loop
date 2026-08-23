import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"
const GOAL_OBJECTIVE = "prove dedicated Goal owns continuation over Loop"
const GOAL_PROMPT_MARKER = "Continue working toward the active OpenCode goal."
const LOOP_PROMPT_MARKER = "AUTONOMOUS OPENCODE LOOP ITERATION"

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
      name: "opencode-loop-goal-coexistence-config",
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

function streamText(res, content, sequence) {
  const id = `chatcmpl-loop-goal-coexistence-${sequence}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  send({
    id,
    object: "chat.completion.chunk",
    created,
    model: "canary",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
  })
  res.end("data: [DONE]\n\n")
}

function startProvider() {
  let releaseGoal
  const goalRelease = new Promise((resolve) => { releaseGoal = resolve })
  const stats = { chatRequests: 0, goalRequests: 0, loopRequests: 0, otherRequests: 0, paths: [] }
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
    const text = lastUserMessageText(body)
    stats.chatRequests += 1
    const sequence = stats.chatRequests

    if (text.includes(GOAL_PROMPT_MARKER) && text.includes(GOAL_OBJECTIVE)) {
      stats.goalRequests += 1
      if (stats.goalRequests === 1) await goalRelease
      streamText(res, `GOAL_TURN_${stats.goalRequests}`, sequence)
      return
    }
    if (text.includes(LOOP_PROMPT_MARKER)) {
      stats.loopRequests += 1
      streamText(res, `UNEXPECTED_LOOP_TURN_${stats.loopRequests}`, sequence)
      return
    }

    stats.otherRequests += 1
    streamText(res, `OTHER_TURN_${stats.otherRequests}`, sequence)
  })

  return {
    stats,
    releaseGoal() { releaseGoal() },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start deterministic coexistence provider")
      return address.port
    },
    async close() {
      releaseGoal()
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

async function readActiveGoal(workspace, sessionID) {
  const dir = path.join(workspace, ".opencode", "goals")
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue
      try {
        const value = JSON.parse(await readFile(path.join(dir, name), "utf8"))
        if (value?.sessionID === sessionID) return value
      } catch {}
    }
  } catch {}
  return undefined
}

async function main() {
  const goalPackageRoot = path.join(repoRoot, "node_modules", "@bybrawe", "opencode-goal")
  const goalPackageJson = path.join(goalPackageRoot, "package.json")
  assert.ok(existsSync(goalPackageJson), "@bybrawe/opencode-goal must be installed before the coexistence canary")
  const goalPackage = JSON.parse(await readFile(goalPackageJson, "utf8"))

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-goal-coexistence-"))
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
  let goalCommandError = null
  let loopCommandError = null

  await mkdir(pluginDir, { recursive: true })
  await mkdir(commandDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await seedConfigDependencies(projectConfig)
  await seedConfigDependencies(globalConfig)

  const loopPluginEntry = pathToFileURL(path.join(repoRoot, "src", "index.js")).href
  const goalPackageSpec = pathToFileURL(goalPackageRoot).href
  await writeFile(path.join(pluginDir, "opencode-loop.js"), `export { default as OpenCodeLoopPlugin } from ${JSON.stringify(loopPluginEntry)}\n`)
  await writeFile(path.join(commandDir, "loop.md"), `---\ndescription: Start a coexistence Loop\nagent: opencode-loop-local\n---\n\nOpenCode Loop local command handled. Reply exactly: OK.\n`)
  await writeFile(path.join(agentDir, "opencode-loop-local.md"), `---\ndescription: Local Loop coexistence acknowledgement\nmode: primary\npermission:\n  "*": deny\n---\n\nReply exactly: OK\n`)
  await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [goalPackageSpec],
    model: "canary/canary",
    small_model: "canary/canary",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Deterministic Loop Goal Coexistence Canary",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "canary-key" },
        models: { canary: { name: "Deterministic Loop Goal Coexistence Canary", limit: { context: 100000, output: 4096 } } },
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
    const prewarm = await runOpenCode(["debug", "config"], { cwd: workspace, env, timeoutMs: 60_000 })
    assert.match(prewarm.stdout, /\{[\s\S]*\}/, `OpenCode config prewarm returned no JSON\n${prewarm.stdout}\n${prewarm.stderr}`)

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

    const sessionsPayload = await api("/session", { method: "GET" })
    assert.ok(Array.isArray(sessionsPayload?.data ?? sessionsPayload), "GET /session bootstrap did not return an array")
    const createdPayload = await api("/session", { method: "POST", body: JSON.stringify({ title: "Loop + Goal ownership canary" }) })
    const session = createdPayload?.data ?? createdPayload
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode did not create a session: ${JSON.stringify(createdPayload)}`)

    const commandPath = `/session/${encodeURIComponent(sessionID)}/command`
    const sendCommand = async (name, argumentsText, signal) => await api(commandPath, {
      method: "POST",
      body: JSON.stringify({ agent: "build", model: "canary/canary", command: name, arguments: argumentsText }),
      signal: signal ?? AbortSignal.timeout(90_000),
    })

    const goalController = new AbortController()
    const goalCommand = sendCommand("goal", `${GOAL_OBJECTIVE} --max-turns 5`, goalController.signal).catch((error) => {
      goalCommandError = error
      return null
    })

    const loopStateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const loopLogFile = path.join(workspace, ".opencode", "opencode-loop", "loop.log")
    const diagnostics = async () => {
      let goal = "missing"
      let loopState = "missing"
      let loopLog = "missing"
      try { goal = JSON.stringify(await readActiveGoal(workspace, sessionID), null, 2) } catch {}
      try { loopState = await readFile(loopStateFile, "utf8") } catch {}
      try { loopLog = await readFile(loopLogFile, "utf8") } catch {}
      return `goal package=${goalPackage.version}\nprovider=${JSON.stringify(provider.stats)}\ngoalCommandError=${String(goalCommandError ?? "none")}\nloopCommandError=${String(loopCommandError ?? "none")}\ngoal=${goal}\nloopState=${loopState}\nloopLog=${loopLog}\nserver log:\n${serverLog}`
    }

    await waitFor(() => provider.stats.goalRequests === 1, "the first dedicated Goal provider turn to be held open", diagnostics)
    await waitFor(async () => {
      const goal = await readActiveGoal(workspace, sessionID)
      return goal?.status === "active" && goal?.objective === GOAL_OBJECTIVE
    }, "released Goal package to persist an active same-session Goal", diagnostics)

    const loopController = new AbortController()
    const loopCommand = sendCommand("loop", "devam et", loopController.signal).catch((error) => {
      loopCommandError = error
      return null
    })

    await waitFor(async () => {
      try {
        return (await readFile(loopLogFile, "utf8")).includes("goal-overlap-blocked")
      } catch {
        return false
      }
    }, "Loop to reject prompt ownership while the dedicated Goal is active", diagnostics, 20_000)

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(provider.stats.goalRequests, 1, `Goal provider turn should remain the only autonomous request while overlap is rejected\n${await diagnostics()}`)
    assert.equal(provider.stats.loopRequests, 0, `Loop must not dispatch while dedicated Goal owns continuation\n${await diagnostics()}`)
    assert.equal(provider.stats.otherRequests, 0, `command bridge must not leak to the model during ownership rejection\n${await diagnostics()}`)

    try {
      const loopState = JSON.parse(await readFile(loopStateFile, "utf8"))
      assert.equal(Array.isArray(loopState.jobs) ? loopState.jobs.length : 0, 0, `blocked prompt Loop must not persist a job: ${JSON.stringify(loopState)}`)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }

    const activeGoal = await readActiveGoal(workspace, sessionID)
    assert.equal(activeGoal?.status, "active", `Goal must remain active after Loop overlap rejection\n${await diagnostics()}`)

    loopController.abort()
    goalController.abort()
    await Promise.allSettled([loopCommand, goalCommand])

    console.log(JSON.stringify({
      ok: true,
      platform: process.platform,
      sessionID,
      goalPackageVersion: goalPackage.version,
      provider: provider.stats,
      dedicatedGoal: { id: activeGoal?.id, status: activeGoal?.status },
      loop: { blocked: true, persistedJobs: 0 },
    }, null, 2))
  } finally {
    provider.releaseGoal()
    await stopProcess(server)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
