#!/usr/bin/env node
// Read-only diagnosis for a Windows OpenCode Desktop/TUI command mismatch.
// Never publish service.json, config content, authorization or response bodies.
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const packageNames = Object.freeze(["loop", "goal"])
const allowHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
const knownConfigs = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]

async function readSmall(file) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > 1024 * 1024) return undefined
    return await readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

function localUrl(raw) {
  if (typeof raw !== "string") return
  let url
  try { url = new URL(raw) } catch { return }
  if (!["http:", "https:"].includes(url.protocol)) return
  if (!allowHosts.has(url.hostname.toLowerCase())) return
  if (url.username || url.password) return
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return
  return url.origin
}

function presentPins(raw) {
  const result = {}
  for (const name of packageNames) {
    const prefix = "@bybrawe/opencode-" + name + "@"
    const hits = raw.match(new RegExp(prefix.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\$&") + "[0-9]+\\.[0-9]+\\.[0-9]+", "g")) ?? []
    result[name] = [...new Set(hits)].sort()
  }
  return result
}

async function configPins(env, home) {
  const configHome = env.OPENCODE_CONFIG_DIR
    ?? path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode")
  const files = []
  const pins = { loop: [], goal: [] }
  for (const name of knownConfigs) {
    const file = path.join(configHome, name)
    const value = await readSmall(file)
    if (value === undefined) continue
    files.push(file)
    const found = presentPins(value)
    for (const kind of packageNames) pins[kind].push(...found[kind])
  }
  for (const kind of packageNames) pins[kind] = [...new Set(pins[kind])].sort()
  return { directory: configHome, files, pins }
}

function commandsFrom(json) {
  const body = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : undefined
  if (!body) return undefined
  return new Set(body.flatMap((item) => typeof item?.name === "string" ? [item.name] : []))
}

async function request(fetchImpl, base, pathname, headers) {
  try {
    const response = await fetchImpl(base + pathname, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (![200, 201].includes(response.status)) return { status: response.status }
    const json = await response.json()
    return { status: response.status, json }
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? "timeout" : "connection-failed" }
  }
}

export async function diagnose({
  env = process.env, home = homedir(), workspace = process.cwd(),
  server, serviceFile, fetchImpl = fetch,
} = {}) {
  const cwd = path.resolve(workspace)
  const config = await configPins(env, home)
  const registeredFile = serviceFile ?? path.join(
    env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "service.json",
  )
  const output = { workspace: cwd, config, service: { source: server ? "explicit" : "registration", status: "unavailable" } }
  let url = server
  let password = env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD
  let version
  let pid
  if (!server) {
    const raw = await readSmall(registeredFile)
    if (raw === undefined) {
      output.service.status = "registration-not-found"
      return output
    }
    let info
    try { info = JSON.parse(raw) }
    catch {
      output.service.status = "registration-invalid"
      return output
    }
    url = info?.url
    password = info?.password
    version = typeof info?.version === "string" ? info.version : undefined
    pid = Number.isInteger(info?.pid) ? info.pid : undefined
  }
  const origin = localUrl(url)
  if (!origin) {
    output.service.status = "refused-nonlocal-or-invalid-url"
    return output
  }
  output.service.host = new URL(origin).host
  if (version) output.service.registeredVersion = version
  const headers = { "x-opencode-directory": cwd, accept: "application/json" }
  if (typeof password === "string" && password.length) {
    headers.authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64")
  }
  const info = await request(fetchImpl, origin, "/api/info", headers)
  if (info.error) {
    output.service.status = info.error
    return output
  }
  if (info.status === 401 || info.status === 403) {
    output.service.status = "authorization-failed"
    return output
  }
  if (info.status === 200 && info.json) {
    const hostPID = info.json?.pid
    if (pid !== undefined && hostPID !== undefined && pid !== hostPID) {
      output.service.status = "stale-service-registration"
      return output
    }
    if (typeof info.json.version === "string") output.service.actualVersion = info.json.version
  }
  let list = await request(fetchImpl, origin, "/api/command", headers)
  if (list.status === 404) list = await request(fetchImpl, origin, "/command", headers)
  if (list.error) {
    output.service.status = list.error
    return output
  }
  if (list.status === 401 || list.status === 403) {
    output.service.status = "authorization-failed"
    return output
  }
  const names = commandsFrom(list.json)
  if (!names) {
    output.service.status = "command-catalog-unavailable"
    output.service.httpStatus = list.status
    return output
  }
  output.service.status = "ready"
  output.service.commands = { loop: names.has("loop"), goal: names.has("goal"), count: names.size }
  return output
}

export async function runDesktopDiagnosticCli(args = process.argv.slice(2), options = {}) {
  let workspace = process.cwd(), server, json = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: opencode-loop --desktop-diagnostics [--workspace PATH] [--server LOCAL_URL] [--json]")
      console.log("Read-only check of both native /loop and /goal registrations; never prints credentials.")
      return 0
    }
    if (arg === "--json") { json = true; continue }
    if (arg === "--workspace" || arg === "--server") {
      if (!args[i + 1]) { console.error("Missing value for " + arg); return 2 }
      if (arg === "--workspace") workspace = args[++i]
      else server = args[++i]
      continue
    }
    console.error("Unknown Desktop diagnostic option: " + arg)
    return 2
  }
  const result = await diagnose({ ...options, workspace, server })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log("OpenCode Desktop native command diagnosis (read-only)")
    console.log("Workspace: " + result.workspace)
    console.log("Global config: " + result.config.directory)
    for (const kind of packageNames)
      console.log("Configured " + kind + " spec: " + (result.config.pins[kind].join(", ") || "not found (text scan)"))
    console.log("Local service: " + result.service.status + (result.service.registeredVersion ? " (" + result.service.registeredVersion + ")" : ""))
    if (result.service.commands)
      console.log("Server /loop: " + result.service.commands.loop + " | /goal: " + result.service.commands.goal)
    if (!result.service.commands)
      console.log("No confirmed local server catalog. Desktop may use a different connection or service.")
    console.log("This checks one local service and directory; it cannot prove which connection Desktop currently uses.")
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDesktopDiagnosticCli().then((code) => { process.exitCode = code }).catch((error) => {
    console.error("Desktop diagnostic failed: " + (error?.code || error?.name || "unknown error"))
    process.exitCode = 1
  })
}
