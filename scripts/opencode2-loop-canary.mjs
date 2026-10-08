import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { execFileSync, spawn } from "node:child_process"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOOP_OBJECTIVE = "real OpenCode 2 loop canary"
const EXPECTED_TURNS = 2
const NATIVE_PRESETS = ["loop-dev", "loop-testfix", "loop-compact", "loop-progress", "loop-safe-dev", "loop-command", "loop-cmd", "loop-prompt", "loop-ask", "loop-shell"]
const EXPECTED_COMMANDS = ["loop", "loop-pause", "loop-resume", "loop-stop", "loop-remove", "loop-clear", ...(process.env.OPENCODE2_NATIVE_REQUIRED === "1" ? [...NATIVE_PRESETS, "loop-init"] : [])]
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "opencode-loop-v2-canary"
const OPENCODE_BINARY = process.env.OPENCODE2_BINARY || "opencode2"
const CURRENT_COMMAND_FIELDS = process.env.OPENCODE2_CURRENT_COMMAND_FIELDS === "1"

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
    const text = lastUserText(body)
    if (text.includes("AUTONOMOUS OPENCODE LOOP ITERATION")) {
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
  return `import { appendFile, writeFile } from "node:fs/promises"

export default {
  id: "bybrawe.opencode-loop.v2.loop-canary-bridge",
  async setup(ctx) {
    const module = await import(process.env.OPENCODE_LOOP_V2_PLUGIN_URL)
    const traceFile = process.env.OPENCODE_LOOP_V2_EVENT_TRACE
    const pluginTraceFile = process.env.OPENCODE_LOOP_V2_PLUGIN_EVENT_TRACE
    const pluginContext = typeof ctx?.event?.subscribe === "function"
      ? {
          ...ctx,
          event: {
            ...ctx.event,
            subscribe(options) {
              const source = ctx.event.subscribe(options)
              return {
                async *[Symbol.asyncIterator]() {
                  for await (const event of source) {
                    const line = JSON.stringify(String(event?.type || "").startsWith("session.") ? event : { id: event?.id, type: event?.type }) + "\\n"
                    if (traceFile) await appendFile(traceFile, line, "utf8")
                    if (pluginTraceFile) await appendFile(pluginTraceFile, line, "utf8")
                    yield event
                  }
                },
              }
            },
          },
        }
      : ctx
    const goalURL = process.env.OPENCODE_GOAL_V2_PLUGIN_URL
    const goalCleanup = goalURL ? await (await import(goalURL)).default.setup(ctx) : undefined
    const cleanup = await module.default.setup(pluginContext)
    await writeFile(process.env.OPENCODE_LOOP_V2_MARKER, JSON.stringify({ activated: true }, null, 2), "utf8")
    return async () => {
      if (typeof cleanup === "function") await cleanup()
      if (typeof goalCleanup === "function") await goalCleanup()
    }
  },
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
  const pluginDir = path.join(home, ".config", "opencode", "plugins")
  const marker = path.join(workspace, "v2-real-adapter-marker.json")
  const eventTrace = path.join(workspace, "v2-native-events.jsonl")
  const pluginEventTrace = path.join(workspace, "v2-plugin-events.jsonl")
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

  await writeFile(path.join(workspace, ".gitignore"), ".home/\n.opencode/\n*v2*events.jsonl\n")
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
    OPENCODE_LOOP_V2_PLUGIN_URL: pathToFileURL(path.join(repoRoot, "src", ...(process.env.OPENCODE2_NATIVE_REQUIRED === "1" ? ["native.js"] : ["source", "opencode2", "experimental.js"]))).href,
    OPENCODE_LOOP_V2_MARKER: marker,
    OPENCODE_LOOP_V2_EVENT_TRACE: eventTrace,
    OPENCODE_LOOP_V2_PLUGIN_EVENT_TRACE: pluginEventTrace,
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
    let nativeEvents = "missing"
    let pluginEvents = "missing"
    try { nativeEvents = await readFile(eventTrace, "utf8") } catch {}
    try { pluginEvents = await readFile(pluginEventTrace, "utf8") } catch {}
    return [
      `apiPrefix=${String(apiPrefix)}`,
      `commands=${JSON.stringify([...latestCommands])}`,
      `provider=${JSON.stringify(provider.stats)}`,
      `sessionID=${sessionID || "none"}`,
      `commandError=${String(commandError ?? "none")}`,
      `state=${state}`,
      `binary=${OPENCODE_BINARY}`,
      `currentCommandFields=${CURRENT_COMMAND_FIELDS}`,
      `serverExit=${server?.exitCode}`,
      `nativeEvents=${nativeEvents.slice(-40_000)}`,
      `pluginEvents=${pluginEvents.slice(-40_000)}`,
      `serverLog=${serverLog}`,
    ].join("\n")
  }

  try {
    const port = await reservePort()
    server = spawn(OPENCODE_BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
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

    if (process.env.OPENCODE_GOAL_V2_PLUGIN_URL) assert.ok(latestCommands.has("goal"), "both native plugin command registries must load")

    const createdResponse = await request(`${apiPrefix}/session`, {
      method: "POST",
      body: JSON.stringify({ title: "OpenCode 2 Loop canary" }),
    })
    if (!createdResponse.ok) throw new Error(`session create failed: HTTP ${createdResponse.status} ${createdResponse.text}\n${await diagnostics()}`)
    const session = createdResponse.body?.data ?? createdResponse.body
    sessionID = String(session?.id ?? "")
    assert.ok(sessionID, `OpenCode 2 did not create a session: ${createdResponse.text}\n${await diagnostics()}`)

    const commandBody = (command, argumentsText = "") => CURRENT_COMMAND_FIELDS
      ? { name: command, text: argumentsText }
      : { command, arguments: argumentsText }

    const commandPromise = request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify(commandBody("loop", `0s --max-runs ${EXPECTED_TURNS} ${LOOP_OBJECTIVE}`)),
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

    const readPersisted = async () => {
      try { return JSON.parse(await readFile(stateFile, "utf8")) }
      catch (error) {
        if (error?.code === "ENOENT") return { jobs: [] }
        throw error
      }
    }
    const jobNamed = async (name) => (await readPersisted()).jobs?.find((job) => String(job?.name || "default") === name)
    const sendControl = async (command, argumentsText = "") => {
      const response = await request(`${apiPrefix}/session/${encodeURIComponent(sessionID)}/command`, {
        method: "POST",
        body: JSON.stringify(commandBody(command, argumentsText)),
      }, 120_000)
      if (!response.ok) throw new Error(`${command} failed: HTTP ${response.status} ${response.text}\n${await diagnostics()}`)
      return response
    }

    await sendControl("loop-pause", "default")
    await waitFor(async () => (await jobNamed("default"))?.paused === true, "real V2 loop-pause state mutation", diagnostics, 30_000)

    await sendControl("loop-resume", "default")
    await waitFor(async () => {
      const job = await jobNamed("default")
      return job?.paused === false && (job?.lastRunAt === 0 || job?.runNowRequestedAt > 0)
    }, "real V2 loop-resume state mutation", diagnostics, 30_000)

    await sendControl("loop-stop", "default")
    await waitFor(async () => !(await jobNamed("default")), "real V2 loop-stop removal", diagnostics, 30_000)

    const beforeRemoveTurn = provider.stats.loopRequests
    await sendControl("loop", "0s --max-runs 1 --name removable removable control lifecycle task")
    await waitFor(() => provider.stats.loopRequests === beforeRemoveTurn + 1, "real V2 removable Loop turn", diagnostics, 60_000)
    await waitFor(async () => {
      const job = await jobNamed("removable")
      return job?.runCount === 1 && job?.enabled === false
    }, "real V2 removable Loop persisted completion", diagnostics, 30_000)
    await sendControl("loop-remove", "removable")
    await waitFor(async () => !(await jobNamed("removable")), "real V2 loop-remove removal", diagnostics, 30_000)

    const beforeClearTurn = provider.stats.loopRequests
    await sendControl("loop", "0s --max-runs 1 --name clearable clearable control lifecycle task")
    await waitFor(() => provider.stats.loopRequests === beforeClearTurn + 1, "real V2 clearable Loop turn", diagnostics, 60_000)
    await waitFor(async () => Boolean(await jobNamed("clearable")), "real V2 clearable Loop persistence", diagnostics, 30_000)
    await sendControl("loop-clear")
    await waitFor(async () => (await readPersisted()).jobs?.length === 0, "real V2 loop-clear state removal", diagnostics, 30_000)

    assert.equal(provider.stats.loopRequests, EXPECTED_TURNS + 2, `control lifecycle should add exactly two autonomous Loop turns\n${await diagnostics()}`)
    assert.equal(server.exitCode, null, `OpenCode 2 server exited during control lifecycle canary\n${await diagnostics()}`)

    if (process.env.OPENCODE2_NATIVE_REQUIRED === "1") {
      const nativeLog = await readFile(path.join(workspace, ".opencode/opencode-loop/loop.log"), "utf8")
      assert.match(nativeLog, /v2-native-ready/, "the real host must load the native implementation")
      assert.match(nativeLog, /v2-native-admitted/, "the native implementation must own the admissions")
      await writeFile(path.join(workspace, "native-preflight.cjs"), 'require("node:fs").appendFileSync("native-preflight.txt", "P")')
      await writeFile(path.join(workspace, "native-verify.cjs"), 'require("node:fs").appendFileSync("native-verify.txt", "V")')
      await sendControl("loop", '0s native verified task --max-runs 1 --name verified --preflight "node native-preflight.cjs" --verify "node native-verify.cjs"')
      await waitFor(async () => {
        const job = await jobNamed("verified")
        return job?.runCount === 1 && !job.v2Run && job.lastVerifyCode === 0
      }, "native preflight and post-turn verification", diagnostics, 30_000)
      assert.equal(await readFile(path.join(workspace, "native-preflight.txt"), "utf8"), "P")
      assert.equal(await readFile(path.join(workspace, "native-verify.txt"), "utf8"), "V")
      await sendControl("loop-clear")
      await sendControl("loop-shell", '0s node native-preflight.cjs --max-runs 1 --name native-shell')
      await waitFor(async () => {
        const job = await jobNamed("native-shell")
        return job?.runCount === 1 && !job.v2Run
      }, "native shell terminal correlation", diagnostics, 20_000)
      assert.equal(await readFile(path.join(workspace, "native-preflight.txt"), "utf8"), "PP")
      await sendControl("loop-clear")

      // OpenCode 2.0.22+ exposes public session.compact. Unlike prompt items,
      // a host compaction control does not produce session.inbox.delivered.
      // Exercise a REAL manual compaction and correlate its started.inputID
      // with the request admitted by this Loop job before accepting completion.
      if (process.env.OPENCODE2_NATIVE_COMPACT_CANARY === "1") {
        await sendControl("loop-compact", "0s --now --max-runs 1 --name native-compact")
        await waitFor(async () => {
          const job = await jobNamed("native-compact")
          return Boolean(
            job?.runCount === 1
            && !job.v2Run
            && job.enabled === false
            && typeof job.lastCompactAt === "number"
            && job.lastCompactAt > 0
          )
        }, "real host-owned manual compaction completion", diagnostics, 90_000)

        const recorded = (await readFile(eventTrace, "utf8"))
          .split("\n").filter(Boolean).map((line) => JSON.parse(line))
          .filter((event) => event?.data?.sessionID === sessionID)
        const manualStart = recorded.find((event) =>
          event.type === "session.compaction.started"
          && event.data?.reason === "manual"
          && typeof event.data?.inputID === "string"
          && event.data.inputID.length > 0
        )
        const manualEnd = recorded.find((event) =>
          event.type === "session.compaction.ended"
          && event.data?.reason === "manual"
          && manualStart
          && event.id !== undefined
        ) ?? recorded.find((event) =>
          event.type === "session.compaction.ended" && event.data?.reason === "manual"
        )
        assert.ok(manualStart, `real V2 host never started the manual inbox compaction\n${await diagnostics()}`)
        assert.ok(manualEnd, `real V2 host never completed the manual inbox compaction\n${await diagnostics()}`)
        assert.equal(server.exitCode, null)
        await sendControl("loop-clear")
      }
      const beforePresets = provider.stats.loopRequests
      await sendControl("loop-init")
      assert.match(await readFile(path.join(workspace, "progress.md"), "utf8"), /^# Progress\n/)
      await writeFile(path.join(workspace, "progress.md"), "user-owned progress\n")
      await sendControl("loop-init")
      assert.equal(await readFile(path.join(workspace, "progress.md"), "utf8"), "user-owned progress\n")
      for (const name of NATIVE_PRESETS.filter(name => name !== "loop-compact")) {
        const action = ["loop-command", "loop-cmd"].includes(name) ? "/review project"
          : name === "loop-shell" ? "npm test"
          : ["loop-prompt", "loop-ask"].includes(name) ? "did you run tests?" : ""
        await sendControl(name, `every 1h --dry-run --name ${name} ${action}`.trim())
        const saved = await jobNamed(name)
        assert.ok(saved, `${name} must create a native job`)
        assert.equal(saved.intervalMs, 3600000, `${name}: explicit every 1h must survive native registration` )
        assert.equal(saved.immediate, false)
        assert.equal(saved.runCount, 0)
        assert.equal(saved.dryRun, true)
      }

      await sendControl("loop", "after 1h --now --max-runs 9 --dry-run --name native-once continue once")
      const onceJob = await jobNamed("native-once")
      assert.equal(onceJob.intervalMs, 3600000)
      assert.equal(onceJob.maxRuns, 1, "after remains one-shot even with a conflicting max-runs flag")
      assert.equal(onceJob.immediate, false, "after never dispatches immediately")
      assert.equal(onceJob.action, "continue once")
      await sendControl("loop-testfix", "every 1h --dry-run --name custom-testfix npm run check")
      const testfix = await jobNamed("custom-testfix")
      assert.equal(testfix.verifyCommand, "npm run check")
      assert.match(testfix.action, /Test command hint: npm run check$/)
      await sendControl("loop", "continue the project --dry-run --name native-shorthand")
      const shorthand = await jobNamed("native-shorthand")
      assert.equal(shorthand.intervalMs, 0)
      assert.equal(shorthand.action, "continue the project")
      assert.equal(shorthand.pauseReason, "dry-run")

      assert.equal(provider.stats.loopRequests, beforePresets, "deferred presets and progress initialization cannot trigger model work")
      await sendControl("loop-clear")

    }

    console.log(JSON.stringify({
      ok: true,
      apiPrefix,
      sessionID,
      registeredCommands: [...latestCommands],
      loopRequests: provider.stats.loopRequests,
      chatRequests: provider.stats.chatRequests,
      initialRunCount: loop.runCount,
      initialEnabled: loop.enabled,
      controlsVerified: ["loop-pause", "loop-resume", "loop-stop", "loop-remove", "loop-clear"],
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
