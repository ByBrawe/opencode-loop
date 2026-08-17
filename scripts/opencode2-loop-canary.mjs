import assert from "node:assert/strict"
import { createServer } from "node:http"
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

async function runOpenCode2(args, { cwd, env, timeoutMs = 60_000, allowFailure = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode2", args, { cwd, env, windowsHide: true })
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
      try { child.kill("SIGTERM") } catch {}
      finish(reject, new Error(`opencode2 timed out: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)

    child.once("error", (error) => finish(reject, error))
    child.once("close", (code) => {
      const result = { code: code ?? -1, stdout, stderr }
      if (!allowFailure && code !== 0) {
        finish(reject, new Error(`opencode2 exited ${code}: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      finish(resolve, result)
    })
  })
}

function parseJSONResult(result, label) {
  const text = String(result?.stdout ?? "").trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON.\nstdout:\n${text}\nstderr:\n${String(result?.stderr ?? "")}`)
  }
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
  let commandResult = null

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
    await runOpenCode2(["service", "stop"], { cwd: workspace, env, timeoutMs: 15_000, allowFailure: true })

    const commandRegistryResult = await runOpenCode2([
      "api",
      "get",
      "/api/command",
      "-H",
      `x-opencode-directory: ${workspace}`,
    ], { cwd: workspace, env, timeoutMs: 60_000 })
    const commandRegistry = parseJSONResult(commandRegistryResult, "GET /api/command")
    const commandNames = collectCommandNames(commandRegistry)
    assert.ok(commandNames.has("loop"), `OpenCode 2 did not register the project loop command: ${JSON.stringify(commandRegistry)}`)

    const createBody = {
      title: "OpenCode 2 Loop canary",
      model: { providerID: "canary", id: "canary" },
      location: { directory: workspace },
    }
    const createdResult = await runOpenCode2([
      "api",
      "v2.session.create",
      "-d",
      JSON.stringify(createBody),
    ], { cwd: workspace, env, timeoutMs: 60_000 })
    const created = parseJSONResult(createdResult, "v2.session.create")
    const session = created?.data ?? created
    const sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${JSON.stringify(created)}`)

    const commandBody = {
      command: "loop",
      arguments: `0s --max-runs ${EXPECTED_TURNS} ${LOOP_OBJECTIVE}`,
      model: { providerID: "canary", id: "canary" },
    }
    const commandPromise = runOpenCode2([
      "api",
      "v2.session.command",
      "--param",
      `sessionID=${sessionID}`,
      "-d",
      JSON.stringify(commandBody),
    ], { cwd: workspace, env, timeoutMs: 120_000 })
      .then((result) => { commandResult = result; return result })
      .catch((error) => { commandResult = { error }; return commandResult })

    const stateFile = path.join(workspace, ".opencode", "opencode-loop", `${sessionID}.json`)
    const diagnostics = async () => {
      let state = "missing"
      try { state = await readFile(stateFile, "utf8") } catch {}
      const log = await readOpenCodeLogTail(env)
      return [
        `commands=${JSON.stringify([...commandNames])}`,
        `provider=${JSON.stringify(provider.stats)}`,
        `command=${commandResult?.error ? String(commandResult.error) : JSON.stringify(commandResult)}`,
        `state=${state}`,
        `log=${log}`,
      ].join("\n")
    }

    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(marker, "utf8"))?.activated) } catch { return false }
    }, "real V2 adapter activation on the shared OpenCode service", diagnostics, 30_000)

    await waitFor(() => provider.stats.loopRequests >= EXPECTED_TURNS, `${EXPECTED_TURNS} autonomous OpenCode 2 Loop turns`, diagnostics, 90_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(provider.stats.loopRequests, EXPECTED_TURNS, `V2 Loop must stop at --max-runs ${EXPECTED_TURNS}\n${await diagnostics()}`)

    const persisted = JSON.parse(await readFile(stateFile, "utf8"))
    const loop = persisted.jobs?.find((job) => job.name === "default")
    assert.ok(loop, `persisted V2 Loop job was missing\n${await diagnostics()}`)
    assert.equal(loop.runCount, EXPECTED_TURNS)
    assert.equal(loop.enabled, false)

    const finalCommand = await commandPromise
    if (finalCommand?.error) throw finalCommand.error
    const finalCommandPayload = parseJSONResult(finalCommand, "v2.session.command")
    if (finalCommandPayload?._tag) {
      throw new Error(`v2.session.command returned ${finalCommandPayload._tag}: ${JSON.stringify(finalCommandPayload)}`)
    }

    console.log(JSON.stringify({
      ok: true,
      opencode2: true,
      sessionID,
      registeredCommands: [...commandNames],
      loopRequests: provider.stats.loopRequests,
      chatRequests: provider.stats.chatRequests,
      runCount: loop.runCount,
      enabled: loop.enabled,
    }, null, 2))
  } finally {
    await runOpenCode2(["service", "stop"], { cwd: workspace, env, timeoutMs: 15_000, allowFailure: true }).catch(() => undefined)
    await provider.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
