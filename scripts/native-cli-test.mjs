import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temp = await mkdtemp(path.join(os.tmpdir(), "loop-native-cli-"))
const project = path.join(temp, "project with spaces")
await mkdir(project)
const log = path.join(temp, "calls.jsonl")
const script = path.join(temp, "host.cjs")
await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NATIVE_CLI_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') { console.log(process.env.NATIVE_CLI_VERSION || 'opencode v2.0.18'); process.exit(0); }
if (args[0] !== '--version' && process.env.NATIVE_CLI_EXPECT_PASSWORD && process.env.OPENCODE_PASSWORD !== process.env.NATIVE_CLI_EXPECT_PASSWORD) {
  console.error('test host rejected missing native password'); process.exit(19);
}
if (args[0] === 'session') {
  if (process.env.NATIVE_CLI_BAD_LIST) { console.log('invalid-json'); process.exit(0); }
  console.log(JSON.stringify([
    { id: 'ses_foreign', directory: process.cwd() + '-other', title: 'Other worktree' },
    { id: 'ses_local', directory: process.cwd(), title: 'Local session', updated: Date.now() }
  ])); process.exit(0);
}
if (process.env.NATIVE_CLI_SLEEP) setTimeout(() => process.exit(0), 10000);
else process.exit(Number(process.env.NATIVE_CLI_EXIT || 0));
`)
const command = path.join(temp, process.platform === "win32" ? "host.cmd" : "host")
await writeFile(command, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
async function run(args = [], env = {}) {
  await rm(log, { force: true })
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/loopd.mjs"), ...args], {
      cwd: root, windowsHide: true,
      env: { ...process.env, OPENCODE_BIN: command, OPENCODE_BINARY: "", NATIVE_CLI_LOG: log, OPENCODE_LOOPD_FAILED_RUN_RETRY_MS: "0", ...env },
    })
    let stdout = "", stderr = ""
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`CLI test hung: ${args.join(' ')}\n${stdout}\n${stderr}`)) }, 20_000)
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.once("error", (error) => { clearTimeout(deadline); reject(error) })
    child.once("close", (code) => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
  })
}
const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const base = ["--project", project, "--max-runs", "2", "--prompt", "native task"]
let cases = 0
try {
  let result = await run(base, { NATIVE_CLI_VERSION: "1.18.15" })
  assert.notEqual(result.code, 0, "native daemon must reject V1 instead of silently dispatching there")
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 0)
  cases++

  result = await run([...base, "--server", "http://127.0.0.1:12345"])
  assert.equal(result.code, 0, result.stderr)
  const observed = await calls()
  assert.equal(observed.filter((call) => call.args[0] === "--version").length, 1, "select the host once, not once per iteration")
  const runs = observed.filter((call) => call.args[0] === "run")
  assert.equal(runs.length, 2)
  for (const call of runs) {
    assert.equal(call.args[call.args.indexOf("--session") + 1], "ses_local", "never adopt another worktree's newest session")
    assert.equal(call.args[call.args.indexOf("--server") + 1], "http://127.0.0.1:12345")
    assert.deepEqual(call.args.slice(-2), ["--", "native task"])
  }
  assert.ok(observed.filter((call) => call.args[0] === "session").every((call) => call.args.includes("--server")))
  cases++

  result = await run(base, { NATIVE_CLI_EXIT: "7" })
  assert.equal(result.code, 7, result.stderr)
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 1, "V2 dispatch errors are not replay-safe")
  cases++

  result = await run([...base, "--timeout", "200ms"], { NATIVE_CLI_SLEEP: "1" })
  assert.equal(result.code, 124, result.stderr)
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 1, "killing a CLI client does not prove its native server execution ended")
  cases++

  result = await run(base, { NATIVE_CLI_BAD_LIST: "1" })
  assert.notEqual(result.code, 0)
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 0, "invalid session output cannot be mistaken for an empty list")
  cases++

  for (const subcommand of ["daemon", "pulse-check", "install-task", "task-run"]) {
    result = await run([subcommand, "--help"])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /--legacy-v1/)
    assert.deepEqual(await calls(), [], "help must not probe or start a host")
  }
  cases++

  result = await run([...base, "--legacy-v1"], { NATIVE_CLI_VERSION: "1.18.15" })
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 2)
  cases++

  result = await run(["--project", project, "--max-runs", "1", "--prompt", "--server not-a-flag"])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual((await calls()).find((call) => call.args[0] === "run").args.slice(-2), ["--", "--server not-a-flag"])
  cases++

  result = await run([...base, "--server", "http://127.0.0.1:12345"], {
    OPENCODE_PASSWORD: "isolated-cli-test-password",
    NATIVE_CLI_EXPECT_PASSWORD: "isolated-cli-test-password",
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await calls()).filter((call) => call.args[0] === "run").length, 2)
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(await calls()), /isolated-cli-test-password/, "native auth must stay in the environment, not argv or logs")
  cases++

  const { selectOpenCodeHost, projectSessions } = await import("./opencode-host.mjs")
  const probed = []
  const probe = async (binary) => { probed.push(binary); return { code: 0, stdout: binary === "opencode2" ? "opencode v2.0.18\n" : "1.18.15\n" } }
  assert.equal((await selectOpenCodeHost({ probe })).binary, "opencode2")
  assert.deepEqual(probed, ["opencode", "opencode2"])
  assert.equal((await selectOpenCodeHost({ probe: async () => ({ code: 0, stdout: "opencode v2.0.18" }) })).binary, "opencode", "prefer the current canonical binary when both names work")
  const fallback = await selectOpenCodeHost({ probe: async (binary) => binary === "opencode2" ? { code: -1 } : { code: 0, stdout: "opencode v2.0.18" } })
  assert.equal(fallback.binary, "opencode")
  await assert.rejects(selectOpenCodeHost({ binary: "custom", probe: async () => ({ code: 0, stdout: "warning 2.0.18" }) }), /OpenCode 2/)
  await assert.rejects(selectOpenCodeHost({ probe: async () => ({ code: 0, stdout: "1.18.15" }) }), /legacy-v1/)
  assert.equal((await selectOpenCodeHost({ legacyV1: true, probe })).major, 1)
  assert.deepEqual(projectSessions(JSON.stringify([{ id: "a", location: { directory: project } }, { id: "b", directory: temp }]), project, true).map((item) => item.id), ["a"])
  assert.throws(() => projectSessions("{}", project, true), /session list/)
  cases++
  console.log(`Native CLI: ${cases} scenarios passed`)
} finally { await rm(temp, { recursive: true, force: true }) }
