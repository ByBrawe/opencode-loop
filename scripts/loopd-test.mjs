import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const loopd = path.join(root, "scripts", "loopd.mjs")
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loopd-test-"))

function runCli(cliArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [loopd, ...cliArgs], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", reject)
    child.on("close", (code, signal) => resolve({
      code: code ?? (signal ? 1 : 0),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

async function makeFakeCommand(name) {
  const script = path.join(temporaryRoot, `${name}.mjs`)
  const log = path.join(temporaryRoot, `${name}.jsonl`)
  await fs.writeFile(script, `
import fs from "node:fs"
const log = process.env.FAKE_COMMAND_LOG
let previous = []
try { previous = fs.readFileSync(log, "utf8").trim().split(/\\r?\\n/).filter(Boolean) } catch {}
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n")
const codes = String(process.env.FAKE_EXIT_CODES || "0").split(",").map((value) => Number(value.trim()))
const code = codes[Math.min(previous.length, codes.length - 1)]
process.exit(Number.isInteger(code) ? code : 0)
`, "utf8")

  if (process.platform === "win32") {
    const command = path.join(temporaryRoot, `${name}.cmd`)
    const escapeCmd = (value) => String(value).replace(/%/g, "%%")
    await fs.writeFile(command, `@echo off\r\n"${escapeCmd(process.execPath)}" "${escapeCmd(script)}" %*\r\nexit /b %errorlevel%\r\n`, "utf8")
    return { command, log }
  }

  const command = path.join(temporaryRoot, name)
  await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath.replace(/"/g, '\\"')}" "${script.replace(/"/g, '\\"')}" "$@"\n`, { mode: 0o755 })
  return { command, log }
}

async function readLog(log) {
  try {
    return (await fs.readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

try {
  const project = path.join(temporaryRoot, "project with spaces")
  await fs.mkdir(project, { recursive: true })
  const fakeOpenCode = await makeFakeCommand("fake-opencode")

  const inlinePrompt = 'continue "quoted text" & keep | characters literal'
  let result = await runCli([
    "--project", project,
    "--every", "0s",
    "--max-runs", "1",
    "--model", "opencode/nemotron-3-ultra-free",
    "--agent", "build",
    "--prompt", inlinePrompt,
  ], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: fakeOpenCode.log,
  })
  assert.equal(result.code, 0, result.stderr)
  let calls = await readLog(fakeOpenCode.log)
  assert.equal(calls.length, 1)
  assert.equal(path.resolve(calls[0].cwd), path.resolve(project))
  assert.deepEqual(calls[0].args, [
    "run", "--continue",
    "--model", "opencode/nemotron-3-ultra-free",
    "--agent", "build",
    inlinePrompt,
  ], "loopd must preserve model, agent, quotes, and shell metacharacters as literal arguments")

  const promptFile = path.join(project, "goal prompt.md")
  await fs.writeFile(promptFile, "\uFEFFPrompt loaded from a BOM file.", "utf8")
  result = await runCli([
    "--project", project,
    "--every", "0s",
    "--max-runs", "1",
    "--prompt-file", path.basename(promptFile),
  ], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: fakeOpenCode.log,
  })
  assert.equal(result.code, 0, result.stderr)
  calls = await readLog(fakeOpenCode.log)
  assert.equal(calls.at(-1).args.at(-1), "Prompt loaded from a BOM file.")

  const failureLog = path.join(temporaryRoot, "failure.jsonl")
  result = await runCli([
    "--project", project,
    "--every", "0s",
    "--max-runs", "1",
    "--prompt", "fail once",
  ], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: failureLog,
    FAKE_EXIT_CODES: "7",
    OPENCODE_LOOPD_FAILED_RUN_RETRY_MS: "0",
  })
  assert.equal(result.code, 7, "a finite daemon run must propagate the failing OpenCode exit code")

  result = await runCli(["--project", project, "--max-runs", "not-a-number", "--prompt", "test"], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: path.join(temporaryRoot, "invalid-count.jsonl"),
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Invalid --max-runs value/)

  result = await runCli(["--project", path.join(temporaryRoot, "missing-project"), "--max-runs", "1", "--prompt", "test"], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: path.join(temporaryRoot, "missing-project.jsonl"),
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Project directory does not exist/)

  if (process.platform === "win32") {
    const fakeTasks = await makeFakeCommand("fake-schtasks")
    const taskName = "OpenCodeLoop-Test"
    result = await runCli([
      "install-task",
      "--project", project,
      "--every", "90s",
      "--name", taskName,
      "--prompt", "scheduled task prompt",
      "--model", "opencode/nemotron-3-ultra-free",
      "--agent", "build",
    ], {
      SCHTASKS_BIN: fakeTasks.command,
      FAKE_COMMAND_LOG: fakeTasks.log,
      OPENCODE_BIN: fakeOpenCode.command,
      OPENCODE_LOOPD_TASK_DIR: path.join(temporaryRoot, "task-files"),
    })
    assert.equal(result.code, 0, result.stderr)
    const taskCalls = await readLog(fakeTasks.log)
    assert.equal(taskCalls.length, 1)
    const taskArgs = taskCalls[0].args
    assert.equal(taskArgs[0], "/Create")
    assert.equal(taskArgs[taskArgs.indexOf("/MO") + 1], "2")
    assert.equal(taskArgs[taskArgs.indexOf("/TN") + 1], taskName)
    const taskCommand = taskArgs[taskArgs.indexOf("/TR") + 1]
    assert.ok(taskCommand.length <= 261, "the Task Scheduler /TR command must stay within its documented limit")
    assert.match(taskCommand, /^cmd\.exe \/d \/s \/c /)
    const taskFiles = await fs.readdir(path.join(temporaryRoot, "task-files"))
    const taskConfigFile = path.join(temporaryRoot, "task-files", taskFiles.find((name) => name.endsWith(".json")))
    const taskConfig = JSON.parse(await fs.readFile(taskConfigFile, "utf8"))
    assert.equal(taskConfig.project, project)
    assert.equal(taskConfig.prompt, "scheduled task prompt")
    assert.equal(taskConfig.model, "opencode/nemotron-3-ultra-free")
    assert.equal(taskConfig.agent, "build")
    assert.equal(taskConfig.opencodeBin, fakeOpenCode.command)

    const taskRunLog = path.join(temporaryRoot, "task-run.jsonl")
    result = await runCli(["task-run", "--config", taskConfigFile], {
      FAKE_COMMAND_LOG: taskRunLog,
    })
    assert.equal(result.code, 0, result.stderr)
    const taskRunCall = (await readLog(taskRunLog))[0]
    assert.deepEqual(taskRunCall.args, [
      "run", "--continue",
      "--model", "opencode/nemotron-3-ultra-free",
      "--agent", "build",
      "scheduled task prompt",
    ])

    result = await runCli(["uninstall-task", "--name", taskName], {
      SCHTASKS_BIN: fakeTasks.command,
      FAKE_COMMAND_LOG: fakeTasks.log,
      OPENCODE_LOOPD_TASK_DIR: path.join(temporaryRoot, "task-files"),
    })
    assert.equal(result.code, 0, result.stderr)
    const uninstallArgs = (await readLog(fakeTasks.log)).at(-1).args
    assert.deepEqual(uninstallArgs, ["/Delete", "/F", "/TN", taskName])
    assert.deepEqual(await fs.readdir(path.join(temporaryRoot, "task-files")), [], "uninstall-task must remove its launcher and config")

    result = await runCli(["install-task", "--project", project, "--name", taskName, "--prompt", "test"], {
      SCHTASKS_BIN: path.join(temporaryRoot, "missing-schtasks.exe"),
      OPENCODE_LOOPD_TASK_DIR: path.join(temporaryRoot, "missing-task-files"),
    })
    assert.equal(result.code, 1, "a missing Task Scheduler executable must not report success")
    assert.match(result.stderr, /failed to start/i)
  }

  console.log("OpenCode Loop daemon test passed")
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
