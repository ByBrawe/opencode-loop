import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import net from "node:net"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const binary = process.env.OPENCODE2_BINARY || "opencode2"
const workspace = await mkdtemp(path.join(os.tmpdir(), "native-loop-cli-host-"))
const home = path.join(workspace, ".home")
const prompt = "NATIVE_CLI_CANARY: reply OK, do not use tools"
let turns = 0
let server, serverLog = ""
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404); response.end(); return
    }
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const last = (body.messages || []).filter((message) => message.role === "user").at(-1)
    const text = typeof last?.content === "string" ? last.content : (last?.content || []).map((part) => part.text || "").join("\n")
    if (text.includes(prompt)) turns++
    const base = { id: `cli-canary-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "canary" }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
function run(command, args, env, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, env, windowsHide: true })
    let stdout = "", stderr = ""
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI deadline: ${args[0]}\n${stdout}\n${stderr}\n${serverLog}`)) }, timeout)
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-40_000) })
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-40_000) })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 3_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
    child.kill("SIGTERM")
  })
}
try {
  await mkdir(path.join(home, ".config/opencode"), { recursive: true })
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerPort = provider.address().port
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    model: "canary/canary",
    providers: { canary: {
      name: "Local CLI compatibility canary", package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${providerPort}/v1` },
      models: { canary: { name: "Canary", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100000, output: 4096 } } },
    } },
  }))
  execFileSync("git", ["init", "--quiet"], { cwd: workspace })
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, OPENCODE_CONFIG_DIR: path.join(home, ".config/opencode"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_SERVER_USERNAME: "", OPENCODE_SERVER_PASSWORD: "", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_BIN: binary, CI: "true",
  }
  const version = await run(binary, ["--version"], env, 10_000)
  assert.equal(version.code, 0, version.stderr)
  assert.equal(version.stdout.trim(), "opencode v2.0.18", "this canary proves the exact pinned CLI")
  const reservation = net.createServer()
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const url = `http://127.0.0.1:${port}`
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
  server.on("error", (error) => { serverLog += error.message })
  server.stdout.on("data", (data) => { serverLog = (serverLog + data).slice(-40_000) })
  server.stderr.on("data", (data) => { serverLog = (serverLog + data).slice(-40_000) })
  const deadline = Date.now() + 30_000
  let ready = false
  while (!ready && Date.now() < deadline && server.exitCode === null) {
    ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => { socket.destroy(); resolve(true) })
      socket.once("error", () => { socket.destroy(); resolve(false) })
    })
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, serverLog)
  const result = await run(process.execPath, [path.join(root, "scripts/loopd.mjs"), "--project", workspace, "--server", url, "--max-runs", "2", "--timeout", "60s", "--model", "canary/canary", "--prompt", prompt], env, 150_000)
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}\n${serverLog}`)
  assert.match(result.stdout, /pinned session/)
  assert.equal(turns, 2, `expected exactly two daemon turns\n${result.stdout}\n${serverLog}`)
  const listed = await run(binary, ["session", "list", "--format", "json", "-n", "100", "--server", url], env)
  assert.equal(listed.code, 0, listed.stderr)
  const sessions = JSON.parse(listed.stdout)
  assert.equal(sessions.length, 1, "both daemon iterations must use the one created native session")
  assert.ok(sessions[0].title.startsWith("OpenCode Loop daemon "))
  console.log(JSON.stringify({ host: version.stdout.trim(), turns, sessions: sessions.length, sessionID: sessions[0].id, result: "native CLI daemon PASS" }))
} finally {
  await stop(server)
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  await rm(workspace, { recursive: true, force: true })
}
