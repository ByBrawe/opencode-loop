import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { stateDir } from "../src/source/core/state.js"
import { createJobWorkspaceRuntime, dangerousShell } from "../src/source/runtime/job-workspace.js"

assert.equal(dangerousShell("npm test"), false)
assert.equal(dangerousShell("git status"), false)
assert.equal(dangerousShell("git push origin main"), true)
assert.equal(dangerousShell("git reset --hard HEAD"), true)
assert.equal(dangerousShell("rm -rf build"), true)
assert.equal(dangerousShell("Remove-Item cache -Recurse -Force"), true)
assert.equal(dangerousShell("terraform destroy"), true)
assert.equal(dangerousShell("kubectl delete pod app"), true)
assert.equal(dangerousShell("deploy production"), true)
assert.throws(() => createJobWorkspaceRuntime({}), /toast/)

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-workspace-"))
try {
  const processCalls = []
  const processResults = []
  const toasts = []
  const logs = []
  const goalPromptCalls = []

  const runtime = createJobWorkspaceRuntime({
    toast: async (...args) => { toasts.push(args) },
    appendLoopLog: async (...args) => { logs.push(args) },
    runProcess: async (...args) => {
      processCalls.push(args)
      return processResults.shift() || { code: 0, stdout: "", stderr: "" }
    },
    buildGoalPrompt: async (...args) => {
      goalPromptCalls.push(args)
      return "GOAL PROMPT"
    },
  })

  await fs.writeFile(path.join(directory, "PROMPT.md"), "Extra instructions\n", "utf8")
  await fs.writeFile(path.join(directory, "CONTEXT.md"), "Context contents\n", "utf8")

  const prompt = await runtime.buildPrompt(directory, {
    kind: "prompt",
    action: "Implement the change",
    promptFile: "PROMPT.md",
    includeFiles: ["CONTEXT.md"],
  })
  assert.match(prompt, /Instructions from PROMPT\.md:\nExtra instructions/)
  assert.match(prompt, /Implement the change/)
  assert.match(prompt, /Context from CONTEXT\.md:\nContext contents/)
  assert.equal(goalPromptCalls.length, 0)

  const goalPrompt = await runtime.buildPrompt(directory, { kind: "goal", action: "Ship it" })
  assert.equal(goalPrompt, "GOAL PROMPT")
  assert.equal(goalPromptCalls.length, 1)
  assert.equal(goalPromptCalls[0][0], directory)
  assert.equal(goalPromptCalls[0][1].action, "Ship it")

  const missingPrompt = await runtime.buildPrompt(directory, {
    kind: "prompt",
    action: "Fallback action",
    promptFile: "MISSING.md",
  })
  assert.match(missingPrompt, /could not be read/)
  assert.match(missingPrompt, /Fallback action/)

  const noBranch = { id: "none" }
  assert.equal(await runtime.ensureBranch(directory, noBranch, {}, "session"), noBranch)
  assert.equal(processCalls.length, 0)

  processResults.push({ code: 1, stdout: "", stderr: "not a repo" })
  const nonRepo = { id: "nonrepo", branch: "feature/test" }
  await runtime.ensureBranch(directory, nonRepo, {}, "session")
  assert.equal(nonRepo.branchDone, true)
  assert.equal(processCalls.at(-1)[0], "git")
  assert.deepEqual(processCalls.at(-1)[1], ["rev-parse", "--is-inside-work-tree"])
  assert.equal(toasts.length, 0)
  assert.equal(logs.length, 0)

  processResults.push(
    { code: 0, stdout: "true", stderr: "" },
    { code: 1, stdout: "", stderr: "missing" },
    { code: 0, stdout: "", stderr: "" },
  )
  const branchJob = { id: "branch", branch: "feature/test" }
  const client = { id: "client" }
  await runtime.ensureBranch(directory, branchJob, client, "session")
  assert.equal(branchJob.branchDone, true)
  assert.deepEqual(processCalls.slice(-3).map((call) => call[1]), [
    ["rev-parse", "--is-inside-work-tree"],
    ["switch", "feature-test"],
    ["switch", "-c", "feature-test"],
  ])
  assert.deepEqual(toasts.at(-1), [client, "Loop branch active: feature-test", "success"])
  assert.deepEqual(logs.at(-1), [directory, "branch", { sessionID: "session", branch: "feature-test", code: 0 }])

  const watched = path.join(directory, "watched.txt")
  await fs.writeFile(watched, "one", "utf8")
  const initialSnapshot = await runtime.snapshotPaths(directory, ["watched.txt", "missing.txt"])
  assert.notEqual(initialSnapshot["watched.txt"], "missing")
  assert.equal(initialSnapshot["missing.txt"], "missing")

  const watchJob = { watchPaths: ["watched.txt"], watchSnapshot: initialSnapshot }
  assert.equal(await runtime.watchChanged(directory, watchJob), false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await fs.writeFile(watched, "two-and-longer", "utf8")
  assert.equal(await runtime.watchChanged(directory, watchJob), true)
  assert.notEqual(watchJob.watchSnapshot["watched.txt"], initialSnapshot["watched.txt"])
  assert.equal(await runtime.watchChanged(directory, { watchPaths: [] }), false)

  assert.equal(await runtime.untilReached(directory, { until: "never" }), false)
  await fs.writeFile(path.join(directory, "progress.md"), "status: DONE_MARKER\n", "utf8")
  assert.equal(await runtime.untilReached(directory, { until: "DONE_MARKER" }), true)

  await fs.mkdir(path.join(directory, "nested"), { recursive: true })
  await fs.writeFile(path.join(directory, "nested", "state.yaml"), "value: NESTED_MARKER\n", "utf8")
  assert.equal(await runtime.untilReached(directory, { until: "NESTED_MARKER" }), true)

  await fs.mkdir(path.join(directory, "node_modules", "hidden"), { recursive: true })
  await fs.writeFile(path.join(directory, "node_modules", "hidden", "secret.md"), "IGNORED_MARKER", "utf8")
  assert.equal(await runtime.untilReached(directory, { until: "IGNORED_MARKER" }), false)
  assert.equal(await runtime.untilReached(directory, {}), false)

  const checkpointProcessStart = processCalls.length
  processResults.push(
    { code: 0, stdout: "true", stderr: "" },
    { code: 0, stdout: " M changed.js\n", stderr: "" },
    { code: 0, stdout: "diff-data", stderr: "" },
    { code: 0, stdout: "staged-data", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  )
  await runtime.createCheckpoint(directory, "session/checkpoint", { id: "job", name: "workspace", checkpointOnly: true, gitCheckpoint: true }, client)
  const checkpointCalls = processCalls.slice(checkpointProcessStart)
  assert.deepEqual(checkpointCalls.map((call) => call[1]), [
    ["rev-parse", "--is-inside-work-tree"],
    ["status", "--short"],
    ["diff", "--binary"],
    ["diff", "--cached", "--binary"],
    ["add", "-A"],
    assert.arrayContaining(["commit", "-m"]),
  ])
  assert.match(checkpointCalls.at(-1)[1][2], /^chore: opencode loop checkpoint /)

  const checkpointDir = path.join(stateDir(directory), "checkpoints", "session-checkpoint")
  const checkpointFiles = await fs.readdir(checkpointDir)
  const statusFile = checkpointFiles.find((file) => file.endsWith(".status.txt"))
  const patchFile = checkpointFiles.find((file) => file.endsWith(".patch"))
  assert.ok(statusFile)
  assert.ok(patchFile)
  assert.equal(await fs.readFile(path.join(checkpointDir, statusFile), "utf8"), " M changed.js\n")
  assert.equal(await fs.readFile(path.join(checkpointDir, patchFile), "utf8"), "diff-data\nstaged-data")
  assert.match(toasts.at(-1)[1], /^Loop checkpoint saved:/)
  assert.equal(toasts.at(-1)[2], "success")

  const beforeNoopCalls = processCalls.length
  await runtime.createCheckpoint(directory, "session", { id: "none" }, client)
  assert.equal(processCalls.length, beforeNoopCalls)

  console.log("job workspace tests passed")
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
