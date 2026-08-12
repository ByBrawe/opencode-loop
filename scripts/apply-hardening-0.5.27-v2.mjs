import { readFile, writeFile } from "node:fs/promises"

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Could not find ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Found ${label} more than once`)
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

function replaceRange(source, start, end, replacement, label) {
  const from = source.indexOf(start)
  if (from < 0) throw new Error(`Could not find start of ${label}`)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`Could not find end of ${label}`)
  return `${source.slice(0, from)}${replacement}${source.slice(to)}`
}

async function patchFile(file, transform) {
  const source = await readFile(file, "utf8")
  const updated = transform(source)
  if (updated === source) throw new Error(`${file} was not changed`)
  await writeFile(file, updated, "utf8")
}

function sourceFunction(fn, name = fn.name) {
  const text = fn.toString()
  return text.replace(new RegExp(`^(async\\s+)?function\\s+${fn.name}\\b`), (match, asyncPrefix = "") => `${asyncPrefix || ""}function ${name}`)
}

async function readStateFile(directory, sessionID) {
  const target = statePath(directory, sessionID)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"))
      return { version: 4, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] }
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 4, jobs: [] }
      const transient = error instanceof SyntaxError || isRetriableStateWriteError(error)
      if (!transient || attempt === attempts - 1) break
      await delay(25 * (attempt + 1))
    }
  }
  try {
    await ensureDir(stateDir(directory))
    await fs.copyFile(target, `${target}.corrupt-${Date.now()}`)
  } catch {}
  return { version: 4, jobs: [] }
}

async function readState(directory, sessionID) {
  const state = await readStateFile(directory, sessionID)
  Object.defineProperty(state, STATE_BASELINE, {
    value: structuredClone(state.jobs || []),
    enumerable: false,
    configurable: false,
    writable: true,
  })
  return state
}

function stateValuesEqual(left, right) {
  if (Object.is(left, right)) return true
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function mergeStateJob(baseJob, intendedJob, currentJob) {
  const merged = structuredClone(currentJob || {})
  const keys = new Set([
    ...Object.keys(baseJob || {}),
    ...Object.keys(intendedJob || {}),
  ])
  for (const key of keys) {
    const baseHas = Object.prototype.hasOwnProperty.call(baseJob || {}, key)
    const intendedHas = Object.prototype.hasOwnProperty.call(intendedJob || {}, key)
    const currentHas = Object.prototype.hasOwnProperty.call(currentJob || {}, key)
    const intendedChanged = baseHas !== intendedHas || !stateValuesEqual(baseJob?.[key], intendedJob?.[key])
    if (!intendedChanged) continue
    const currentChanged = baseHas !== currentHas || !stateValuesEqual(baseJob?.[key], currentJob?.[key])
    const sameResult = intendedHas === currentHas && stateValuesEqual(intendedJob?.[key], currentJob?.[key])
    // First committed writer wins a true same-field conflict. A stale snapshot
    // can still apply changes to unrelated fields without erasing newer state.
    if (currentChanged && !sameResult) continue
    if (intendedHas) merged[key] = structuredClone(intendedJob[key])
    else delete merged[key]
  }
  return merged
}

function mergeStateJobs(baseJobs, intendedJobs, currentJobs) {
  const byID = (jobs) => new Map((jobs || []).filter((job) => job?.id).map((job) => [job.id, job]))
  const base = byID(baseJobs)
  const intended = byID(intendedJobs)
  const current = byID(currentJobs)
  const merged = []

  for (const currentJob of currentJobs || []) {
    const id = currentJob?.id
    if (!id || !base.has(id)) {
      merged.push(structuredClone(currentJob))
      continue
    }
    const baseJob = base.get(id)
    const intendedJob = intended.get(id)
    if (!intendedJob) {
      // A deletion based on an old snapshot must not erase a job that changed
      // after that snapshot was read.
      if (!stateValuesEqual(baseJob, currentJob)) merged.push(structuredClone(currentJob))
      continue
    }
    merged.push(mergeStateJob(baseJob, intendedJob, currentJob))
  }

  for (const intendedJob of intendedJobs || []) {
    const id = intendedJob?.id
    if (!id || base.has(id) || current.has(id)) continue
    merged.push(structuredClone(intendedJob))
  }
  return merged
}

async function writeState(directory, sessionID, state) {
  await withStateWriteLock(directory, sessionID, async () => {
    await ensureDir(stateDir(directory))
    const target = statePath(directory, sessionID)
    const baseline = state?.[STATE_BASELINE]
    let jobs = structuredClone(state.jobs || [])
    if (Array.isArray(baseline)) {
      const current = await readStateFile(directory, sessionID)
      jobs = mergeStateJobs(baseline, jobs, current.jobs || [])
      state.jobs = structuredClone(jobs)
      state[STATE_BASELINE] = structuredClone(jobs)
    }
    const payload = JSON.stringify({ version: 4, jobs }, null, 2)
    await writeFileAtomically(target, payload)
  })
}

async function testStateRebasePreservesConcurrentPause() {
  const h = await createHarness()
  const originalRename = fs.rename
  try {
    await h.command("loop", "10m --no-now --name race continue safely")
    h.statuses.set(h.sessionID, "busy")
    let delayed = false
    fs.rename = async (source, target, ...rest) => {
      if (!delayed && path.resolve(target) === path.resolve(h.stateFile)) {
        delayed = true
        await delay(120)
      }
      return await originalRename.call(fs, source, target, ...rest)
    }

    const pause = h.command("loop-pause", "race")
    await delay(20)
    const runNow = h.command("loop-now", "race")
    await Promise.all([pause, runNow])

    const state = await h.readState()
    const job = state.jobs.find((item) => item.name === "race")
    assert.ok(job, "the concurrent state update must keep the loop job")
    assert.equal(job.paused, true, "a stale scheduler snapshot must not erase a concurrent user pause")
  } finally {
    fs.rename = originalRename
    await h.cleanup()
  }
}

function terminateChild(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      return
    }
    if (child.pid) process.kill(-child.pid, "SIGTERM")
    else child.kill("SIGTERM")
    const force = setTimeout(() => {
      try {
        if (child.exitCode !== null) return
        if (child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }, 1_000)
    force.unref?.()
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

function spawnOnce(command, commandArgs, cwd, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const capture = options.capture === true
    const stdout = []
    const stderr = []
    let timer
    const done = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        ...result,
        timedOut,
        stdout: capture ? Buffer.concat(stdout).toString("utf8") : "",
        stderr: capture ? Buffer.concat(stderr).toString("utf8") : "",
      })
    }

    let child
    try {
      child = spawn(command, commandArgs, {
        cwd,
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      done({ code: -1, error })
      return
    }

    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    if (Number(options.timeoutMs) > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateChild(child)
      }, Number(options.timeoutMs))
      timer.unref?.()
    }
    child.on("error", (error) => done({ code: -1, error }))
    child.on("exit", (code, signal) => done({ code: timedOut ? 124 : (code ?? (signal ? 1 : 0)), signal }))
  })
}

async function run(command, commandArgs, cwd, options = {}) {
  const direct = await spawnOnce(command, commandArgs, cwd, options)
  if (direct.code !== -1 || process.platform !== "win32" || !["ENOENT", "EINVAL"].includes(direct.error?.code)) return direct

  const fallback = await spawnOnce("cmd.exe", ["/d", "/s", "/c", command, ...commandArgs], cwd, options)
  if (fallback.code === -1) {
    console.error(`[opencode-loopd] failed to start ${command}: ${fallback.error?.message || direct.error?.message || "unknown error"}`)
  }
  return fallback
}

async function resolveLatestSessionID(opencodeBin, project, preferredTitle) {
  const result = await run(opencodeBin, ["session", "list", "--format", "json", "-n", "20"], project, { capture: true, timeoutMs: 15_000 })
  if (result.code !== 0 || result.timedOut) return undefined
  let parsed
  try { parsed = JSON.parse(result.stdout || "[]") } catch { return undefined }
  const sessions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : []
  const match = preferredTitle ? sessions.find((item) => item?.title === preferredTitle) : sessions[0]
  return typeof match?.id === "string" && match.id ? match.id : undefined
}

async function daemon(options = {}) {
  const project = path.resolve(options.project ?? arg("--project", process.cwd()))
  validateProject(project)
  const every = options.every ?? arg("--every", "0s")
  const delay = parseMs(every)
  const maxRuns = parseMaxRuns(options.maxRuns ?? arg("--max-runs", "0"))
  const timeoutText = options.timeout ?? arg("--timeout", "30m")
  const timeoutMs = parseMs(timeoutText)
  const sleepFirst = options.sleepFirst ?? has("--sleep-first")
  const prompt = readPrompt(project, options)
  const model = options.model ?? arg("--model")
  const agent = options.agent ?? arg("--agent")
  const opencodeBin = options.opencodeBin || OPENCODE_BIN
  const explicitSessionID = options.session ?? arg("--session")
  let sessionID = explicitSessionID || await resolveLatestSessionID(opencodeBin, project)
  const sessionTitle = `OpenCode Loop daemon ${process.pid}-${Date.now()}`

  console.log("OpenCode Loop daemon")
  console.log(`project: ${project}`)
  console.log(`every: ${every}`)
  console.log(`maxRuns: ${maxRuns || "unlimited"}`)
  console.log(`timeout: ${timeoutText}`)
  if (sessionID) console.log(`session: ${sessionID} (pinned)`)

  let count = 0

  if (sleepFirst && delay > 0) await sleep(delay)

  while (true) {
    count += 1
    console.log("")
    console.log(`[opencode-loopd] run #${count} ${new Date().toISOString()}`)

    const runArgs = ["run"]
    if (sessionID) runArgs.push("--session", sessionID)
    else runArgs.push("--title", sessionTitle)
    if (model) runArgs.push("--model", model)
    if (agent) runArgs.push("--agent", agent)
    runArgs.push(prompt)

    const result = await run(opencodeBin, runArgs, project, { timeoutMs })
    const code = result.timedOut ? 124 : result.code
    const moreRunsRemain = maxRuns === 0 || count < maxRuns

    if (!sessionID && code === 0 && moreRunsRemain) {
      sessionID = await resolveLatestSessionID(opencodeBin, project, sessionTitle)
      if (!sessionID) {
        console.error("[opencode-loopd] could not resolve the newly created session; refusing to continue unpinned")
        return 1
      }
      console.log(`[opencode-loopd] pinned session ${sessionID}`)
    }

    if (result.timedOut) console.log(`[opencode-loopd] opencode run timed out after ${timeoutText}`)
    else if (code !== 0) console.log(`[opencode-loopd] opencode exited with code ${code}`)
    if (code !== 0 && delay === 0 && moreRunsRemain) await sleep(FAILED_RUN_RETRY_MS)

    if (maxRuns > 0 && count >= maxRuns) {
      console.log("[opencode-loopd] max runs reached")
      return Number.isInteger(code) && code > 0 ? code : code < 0 ? 1 : 0
    }

    if (delay > 0) await sleep(delay)
  }
}

await patchFile("src/index.js", (input) => {
  let source = replaceOnce(
    input,
    'const LOCAL_COMMAND_AGENT = "opencode-loop-local"\n',
    'const LOCAL_COMMAND_AGENT = "opencode-loop-local"\nconst STATE_BASELINE = Symbol("opencode-loop-state-baseline")\n',
    "state baseline symbol",
  )
  source = replaceRange(
    source,
    "async function readState(directory, sessionID) {",
    "function isRetriableStateWriteError(error) {",
    `${sourceFunction(readStateFile)}\n\n${sourceFunction(readState)}\n\n`,
    "state reader",
  )
  source = replaceRange(
    source,
    "async function writeState(directory, sessionID, state) {",
    "async function removeState(directory, sessionID) {",
    [
      sourceFunction(stateValuesEqual),
      sourceFunction(mergeStateJob),
      sourceFunction(mergeStateJobs),
      sourceFunction(writeState),
      "",
    ].join("\n\n"),
    "state writer",
  )
  return source
})

await patchFile("scripts/comprehensive-test.mjs", (input) => {
  let source = replaceOnce(
    input,
    "await testParserAndPresets()\n",
    `${sourceFunction(testStateRebasePreservesConcurrentPause)}\n\nawait testParserAndPresets()\n`,
    "comprehensive test insertion",
  )
  source = replaceOnce(
    source,
    "await testStateReadRetriesTransientPartialJson()\n",
    "await testStateReadRetriesTransientPartialJson()\nawait testStateRebasePreservesConcurrentPause()\n",
    "comprehensive test invocation",
  )
  return source
})

await patchFile("scripts/loopd.mjs", (input) => {
  let source = replaceRange(
    input,
    "function spawnOnce(command, commandArgs, cwd) {",
    "function quoteWindowsArg(value) {",
    `${sourceFunction(terminateChild)}\n\n${sourceFunction(spawnOnce)}\n\n`,
    "daemon process helper",
  )
  source = replaceRange(
    source,
    "async function run(command, commandArgs, cwd) {",
    "function runSync(command, commandArgs) {",
    `${sourceFunction(run)}\n\n${sourceFunction(resolveLatestSessionID)}\n\n`,
    "daemon run helper",
  )
  source = replaceRange(
    source,
    "async function daemon(options = {}) {",
    "function taskArtifacts(name) {",
    `${sourceFunction(daemon)}\n\n`,
    "daemon loop",
  )
  source = replaceOnce(
    source,
    '  const agent = arg("--agent")\n  const node = process.execPath\n',
    '  const agent = arg("--agent")\n  const timeout = arg("--timeout", "30m")\n  const node = process.execPath\n',
    "task timeout argument",
  )
  source = replaceOnce(
    source,
    '    agent: agent || undefined,\n    opencodeBin: OPENCODE_BIN,\n',
    '    agent: agent || undefined,\n    timeout,\n    opencodeBin: OPENCODE_BIN,\n',
    "task timeout config",
  )
  source = replaceOnce(
    source,
    '  --agent <name>         OpenCode agent used for each run\n  --max-runs <n>         Stop after n runs\n  --sleep-first          Wait before first run\n',
    '  --agent <name>         OpenCode agent used for each run\n  --session <id>         Pin an existing OpenCode session (auto-pinned otherwise)\n  --timeout <duration>   Max time per OpenCode run (default: 30m, 0s disables)\n  --max-runs <n>         Stop after n runs\n  --sleep-first          Wait before first run\n',
    "daemon help options",
  )
  return source
})

const fakeCommandScript = `
import fs from "node:fs"
const log = process.env.FAKE_COMMAND_LOG
const argv = process.argv.slice(2)
let previous = []
try { previous = fs.readFileSync(log, "utf8").trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line)) } catch {}
fs.appendFileSync(log, JSON.stringify({ args: argv, cwd: process.cwd() }) + "\\n")
if (argv[0] === "session" && argv[1] === "list") {
  console.log(process.env.FAKE_SESSION_LIST_JSON || "[]")
  process.exit(0)
}
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 0)
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs))
const previousRuns = previous.filter((entry) => entry?.args?.[0] === "run").length
const codes = String(process.env.FAKE_EXIT_CODES || "0").split(",").map((value) => Number(value.trim()))
const code = codes[Math.min(previousRuns, codes.length - 1)]
process.exit(Number.isInteger(code) ? code : 0)
`

await patchFile("scripts/loopd-test.mjs", (input) => {
  let source = replaceRange(
    input,
    "  await fs.writeFile(script, `",
    '  if (process.platform === "win32") {',
    `  await fs.writeFile(script, ${JSON.stringify(fakeCommandScript)}, "utf8")\n\n`,
    "fake OpenCode command",
  )
  source = replaceOnce(
    source,
    `  let calls = await readLog(fakeOpenCode.log)
  assert.equal(calls.length, 1)
  assert.equal(path.resolve(calls[0].cwd), path.resolve(project))
  assert.deepEqual(calls[0].args, [
    "run", "--continue",
    "--model", "opencode/nemotron-3-ultra-free",
    "--agent", "build",
    inlinePrompt,
  ], "loopd must preserve model, agent, quotes, and shell metacharacters as literal arguments")
`,
    `  let calls = await readLog(fakeOpenCode.log)
  let runCalls = calls.filter((item) => item.args[0] === "run")
  assert.equal(runCalls.length, 1)
  assert.equal(path.resolve(runCalls[0].cwd), path.resolve(project))
  assert.deepEqual(runCalls[0].args, [
    "run", "--title", runCalls[0].args[2],
    "--model", "opencode/nemotron-3-ultra-free",
    "--agent", "build",
    inlinePrompt,
  ], "loopd must preserve model, agent, quotes, and shell metacharacters as literal arguments")
  assert.match(runCalls[0].args[2], /^OpenCode Loop daemon /)
`,
    "initial daemon assertion",
  )
  source = replaceOnce(
    source,
    '  calls = await readLog(fakeOpenCode.log)\n  assert.equal(calls.at(-1).args.at(-1), "Prompt loaded from a BOM file.")\n',
    '  calls = await readLog(fakeOpenCode.log)\n  runCalls = calls.filter((item) => item.args[0] === "run")\n  assert.equal(runCalls.at(-1).args.at(-1), "Prompt loaded from a BOM file.")\n',
    "prompt file assertion",
  )

  const added = `  const pinnedLog = path.join(temporaryRoot, "pinned.jsonl")
  result = await runCli([
    "--project", project,
    "--every", "0s",
    "--max-runs", "2",
    "--prompt", "pinned session work",
  ], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: pinnedLog,
    FAKE_SESSION_LIST_JSON: JSON.stringify([{ id: "ses_pinned", title: "Pinned" }]),
  })
  assert.equal(result.code, 0, result.stderr)
  const pinnedRuns = (await readLog(pinnedLog)).filter((item) => item.args[0] === "run")
  assert.equal(pinnedRuns.length, 2)
  assert.ok(pinnedRuns.every((item) => item.args[1] === "--session" && item.args[2] === "ses_pinned"), "every daemon iteration must stay pinned to the same session")

  const timeoutLog = path.join(temporaryRoot, "timeout.jsonl")
  result = await runCli([
    "--project", project,
    "--every", "0s",
    "--max-runs", "1",
    "--timeout", "50ms",
    "--prompt", "hang",
  ], {
    OPENCODE_BIN: fakeOpenCode.command,
    FAKE_COMMAND_LOG: timeoutLog,
    FAKE_SLEEP_MS: "5000",
  })
  assert.equal(result.code, 124, "a timed-out daemon run must return exit code 124")
  assert.match(result.stdout, /timed out after 50ms/)

`
  source = replaceOnce(
    source,
    '  const failureLog = path.join(temporaryRoot, "failure.jsonl")\n',
    `${added}  const failureLog = path.join(temporaryRoot, "failure.jsonl")\n`,
    "daemon regression insertion",
  )
  source = replaceOnce(
    source,
    '    assert.equal(taskConfig.agent, "build")\n    assert.equal(taskConfig.opencodeBin, fakeOpenCode.command)\n',
    '    assert.equal(taskConfig.agent, "build")\n    assert.equal(taskConfig.timeout, "30m")\n    assert.equal(taskConfig.opencodeBin, fakeOpenCode.command)\n',
    "task timeout assertion",
  )
  source = replaceOnce(
    source,
    `    const taskRunCall = (await readLog(taskRunLog))[0]
    assert.deepEqual(taskRunCall.args, [
      "run", "--continue",
      "--model", "opencode/nemotron-3-ultra-free",
      "--agent", "build",
      "scheduled task prompt",
    ])
`,
    `    const taskRunCalls = (await readLog(taskRunLog)).filter((item) => item.args[0] === "run")
    assert.equal(taskRunCalls.length, 1)
    assert.deepEqual(taskRunCalls[0].args, [
      "run", "--title", taskRunCalls[0].args[2],
      "--model", "opencode/nemotron-3-ultra-free",
      "--agent", "build",
      "scheduled task prompt",
    ])
`,
    "task run assertion",
  )
  return source
})

await patchFile("package.json", (input) => {
  let source = replaceOnce(input, '"version": "0.5.26"', '"version": "0.5.27"', "package version")
  source = replaceOnce(source, '"@opencode-ai/plugin": ">=1.4.0"', '"@opencode-ai/plugin": ">=1.4.0 <2"', "peer dependency range")
  source = replaceOnce(
    source,
    '"check": "node --check src/index.js && node --check scripts/install-node.mjs && node --check scripts/loopd.mjs && node --check scripts/install-test.mjs && node --check scripts/loopd-test.mjs && node --check scripts/smoke-test.mjs && node --check scripts/comprehensive-test.mjs",',
    '"check": "node --check src/index.js && node --check scripts/install-node.mjs && node --check scripts/loopd.mjs && node --check scripts/install-test.mjs && node --check scripts/loopd-test.mjs && node --check scripts/smoke-test.mjs && node --check scripts/comprehensive-test.mjs && node --check scripts/host-loop-canary.mjs",',
    "package syntax checks",
  )
  source = replaceOnce(
    source,
    '"install:global": "node scripts/install-node.mjs",',
    '"canary:host": "node scripts/host-loop-canary.mjs",\n    "install:global": "node scripts/install-node.mjs",',
    "package host canary script",
  )
  return source
})

await patchFile("README.md", (input) => {
  let source = replaceOnce(input, "**Current release: `0.5.26`.**", "**Current release: `0.5.27`.**", "README version")
  source = replaceOnce(
    source,
    "The normal `/loop` plugin is session-bound. If OpenCode closes, that TUI/session loop cannot keep running in the background.\n",
    "The normal `/loop` plugin is session-bound. If OpenCode closes, that TUI/session loop cannot keep running in the background. `opencode-loopd` resolves the session once at startup and pins that exact session for later iterations, so a newer unrelated session cannot steal the daemon. If no session exists, the daemon creates one and pins it before the second iteration. Each daemon run is bounded by `--timeout` (30 minutes by default; use `--timeout 0s` to disable).\n",
    "README daemon guarantees",
  )
  source = replaceOnce(
    source,
    "opencode-loopd --project . --every 0s --max-runs 1 --model provider/model --agent build --prompt-file loop-prompt.md\n",
    "opencode-loopd --project . --every 0s --max-runs 1 --timeout 30m --model provider/model --agent build --prompt-file loop-prompt.md\n",
    "README daemon timeout example",
  )
  source = replaceOnce(
    source,
    "Limit total runs:\n\n```bash\nopencode-loopd --project . --every 5m --max-runs 20 --prompt-file loop-prompt.md\n```\n",
    "Pin a specific existing session when needed:\n\n```bash\nopencode-loopd --project . --session ses_xxx --every 5m --prompt-file loop-prompt.md\n```\n\nLimit total runs:\n\n```bash\nopencode-loopd --project . --every 5m --max-runs 20 --prompt-file loop-prompt.md\n```\n",
    "README session pin example",
  )
  return source
})

await patchFile("CHANGELOG.md", (input) => replaceOnce(
  input,
  "# Changelog\n\n",
  `# Changelog

## 0.5.27

- Rebase stale Loop state snapshots against the latest persisted job state before writing, preventing scheduler bookkeeping from erasing unrelated user pause/resume or other state changes.
- Add a deterministic concurrency regression that forces overlapping state reads/writes and proves a concurrent user pause survives a stale scheduler update.
- Harden \`opencode-loopd\` by pinning one exact OpenCode session across iterations instead of resolving \`--continue\` on every run; a fresh daemon session is created and then pinned when no existing session is available.
- Add per-run daemon timeouts (30 minutes by default, configurable with \`--timeout\`; \`0s\` disables) and timeout exit code 124, including descendant-process termination.
- Add daemon regressions for session pinning, timeout termination, and scheduled-task timeout propagation.
- Add a real OpenCode host canary that proves a three-run \`/loop\` performs exactly three autonomous turns on Ubuntu and Windows.
- Narrow the OpenCode plugin peer range to \`>=1.4.0 <2\` so a future breaking 2.x release is not treated as automatically compatible.

`,
  "changelog header",
))

console.log("OpenCode Loop 0.5.27 hardening patch applied")
