import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
async function scenario(mode) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-cli-io-"))
  const project = path.join(temp, "project with spaces")
  await mkdir(project)
  const script = path.join(temp, "host.cjs")
  const log = path.join(temp, "calls.jsonl")
  await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IO_LOG, JSON.stringify({args, cwd:process.cwd(), pwd:process.env.PWD})+'\\n');
if(args[0]==='--version'){console.log(process.env.IO_MODE==='legacy'?'1.18.15':'opencode v2.0.18');process.exit(0)}
if(args[0]==='session'){console.log(JSON.stringify([{id:'ses_io',directory:process.cwd()}]));process.exit(0)}
if(process.env.IO_MODE==='pwd'){process.exit(process.env.PWD===process.cwd()?0:23)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{console.log('INPUT='+input);process.exit(input===(process.env.IO_MODE==='legacy'?'legacy-input':'')?0:24)});
process.stdin.resume();
`)
  const binary = path.join(temp, process.platform === "win32" ? "host.cmd" : "host")
  await writeFile(binary, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  let child, timer
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(root, "scripts/loopd.mjs"), "--project", project, "--max-runs", "1", "--timeout", "3s", "--prompt", "argument-only prompt", ...(mode === "legacy" ? ["--legacy-v1"] : [])], {
        cwd: root, windowsHide: true,
        env: { ...process.env, OPENCODE_BIN: binary, PWD: root, IO_MODE: mode, IO_LOG: log },
      })
      let stdout = "", stderr = ""
      timer = setTimeout(() => { child.kill(); reject(new Error(`daemon deadline\n${stdout}\n${stderr}`)) }, 20_000)
      child.stdout.on("data", data => { stdout += data })
      child.stderr.on("data", data => { stderr += data })
      child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error) })
      child.once("error", reject)
      child.once("close", code => resolve({ code, stdout, stderr }))
      if (mode === "legacy") child.stdin.end("legacy-input")
      else child.stdin.write("must-not-become-a-prompt") // Deliberately leave the parent's pipe open.
    })
    assert.equal(result.code, 0, `${mode}: ${result.stdout}\n${result.stderr}`)
    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map(JSON.parse)
    if (mode === "pwd") {
      for (const call of calls.filter(call => ["session", "run"].includes(call.args[0]))) {
        assert.equal(call.pwd, project, "native lookup and run must use the selected project, not the caller's PWD")
        assert.equal(call.cwd, project)
      }
    }
    if (mode === "stdin") assert.match(result.stdout, /INPUT=\r?\n/)
    if (mode === "legacy") assert.match(result.stdout, /INPUT=legacy-input/)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test("native CLI binds PWD to --project for lookup and run", () => scenario("pwd"))
test("native CLI receives EOF even while the daemon stdin stays open", () => scenario("stdin"))
test("explicit V1 retains inherited stdin", () => scenario("legacy"))
