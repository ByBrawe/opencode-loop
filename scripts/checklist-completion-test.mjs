import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseLoopArgs } from "../src/source/core/args.js"
import { summarizeTaskChecklist, inspectTaskChecklist } from "../src/source/runtime/checklist-completion.js"
import { formatOpenCode2LoopStatus } from "../src/source/opencode2/status.js"
import { createNativeJobPolicy } from "../src/source/opencode2/native-policy.js"

let checks = 0
function expectSummary(input, status, total, pending) {
  const got = summarizeTaskChecklist(input)
  assert.deepEqual([got.status, got.total, got.pending], [status, total, pending])
  checks++
}
const ticks = String.fromCharCode(96).repeat(3)
expectSummary("- [ ] first\n- [x] second", "pending", 2, 1)
expectSummary("- [X] first\r\n  * [x] second\r\n    + [x] third", "complete", 3, 0)
expectSummary("\uFEFF- [x] already finished\n", "complete", 1, 0)
expectSummary("- [ ]", "pending", 1, 1)
expectSummary("- [x]\n- [ ] TODO", "pending", 2, 1)
expectSummary(ticks + "md\n- [ ] fake\n" + ticks + "\n- [x] real", "complete", 1, 0)
expectSummary("~~~~\n- [ ] fake\n~~~~\n- [x] real", "complete", 1, 0)
expectSummary("> - [ ] fake\n- [x] real", "complete", 1, 0)
expectSummary("<!--\n- [ ] fake\n-->\n- [x] real", "complete", 1, 0)
expectSummary("<!-- - [ ] fake -->\n- [x] real", "complete", 1, 0)
expectSummary("No Markdown task boxes here.", "unavailable", 0, 0)
expectSummary(ticks + "\n- [x] fake\n" + ticks, "unavailable", 0, 0)
expectSummary("## [x] Not a task\n- [other] Nope", "unavailable", 0, 0)

const args = parseLoopArgs("0s --progress-file TASK.md --until-checklist-complete task")
assert.equal(args.ok, true)
assert.equal(args.job.untilChecklistComplete, true)
assert.equal(args.job.progressFile, "TASK.md")
assert.equal(parseLoopArgs("0s --until-checklist-complete task").ok, false)
assert.equal(parseLoopArgs("0s --progress-file TASK.md task").job.untilChecklistComplete, false)
checks += 5
assert.equal(formatOpenCode2LoopStatus({ jobs: [] }).text, "OpenCode loop status:\nNo active loop jobs.")
checks++

const root = await mkdtemp(path.join(os.tmpdir(), "loop-checklist-"))
try {
  await writeFile(path.join(root, "TASK.md"), "- [ ] one\n- [x] two\n")
  let state = await inspectTaskChecklist(root, "TASK.md")
  assert.deepEqual([state.status, state.total, state.pending], ["pending", 2, 1])
  checks++
  await writeFile(path.join(root, "TASK.md"), "- [X] one\n- [x] two\n")
  state = await inspectTaskChecklist(root, "TASK.md")
  assert.equal(state.status, "complete")
  assert.match(state.digest, /^[0-9a-f]{64}$/)
  checks++
  const verifiedHash = state.digest
  const policy = createNativeJobPolicy()
  const job = { id: "verify", untilChecklistComplete: true, progressFile: "TASK.md",
    verifyCommand: "npm test", lastVerifyCode: 0, lastVerifyAt: 10, lastVerifyChecklistDigest: verifiedHash }
  await writeFile(path.join(root, "TASK.md"), "- [X] one\n- [x] two\n- [x] three\n")
  assert.equal(await policy.checkStop({ directory: root }, job), true,
    "stale digest must not complete a modified checklist")
  assert.equal(job.enabled, undefined)
  assert.equal(job.paused, undefined)
  checks++
  job.lastVerifyChecklistDigest = (await inspectTaskChecklist(root, "TASK.md")).digest
  assert.equal(await policy.checkStop({ directory: root }, job), false)
  assert.equal(job.paused, true)
  assert.equal(job.pauseReason, "checklist-complete")
  checks++
  await mkdir(path.join(root, "plans"))
  await writeFile(path.join(root, "plans", "tasks.md"), " - [x] done\n")
  assert.equal((await inspectTaskChecklist(root, "plans/tasks.md")).status, "complete")
  checks++

  const bad = [
    ["missing.md", "file-missing"],
    ["../escape.md", "outside-project"],
    ["/tmp/not-a-project-task.md", "absolute-path"],
    [".opencode/goals/goal.md", "control-plane-path"],
    [".git/TASK.md", "control-plane-path"],
    ["node_modules/TASK.md", "control-plane-path"],
    ["plans", "not-regular-file"],
  ]
  for (const [file, reason] of bad) {
    const result = await inspectTaskChecklist(root, file)
    assert.equal(result.status, "unavailable", file)
    assert.equal(result.reason, reason, file)
    checks++
  }
  await writeFile(path.join(root, "empty.md"), "Just prose\n")
  assert.equal((await inspectTaskChecklist(root, "empty.md")).reason, "no-task-checkboxes")
  checks++
  await writeFile(path.join(root, "huge.md"), "x".repeat(256_001))
  assert.equal((await inspectTaskChecklist(root, "huge.md")).reason, "file-too-large")
  checks++
  try {
    await symlink(path.join(root, "TASK.md"), path.join(root, "linked.md"))
    assert.equal((await inspectTaskChecklist(root, "linked.md")).reason, "symlink-path")
    checks++
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error
  }
} finally {
  await rm(root, { force: true, recursive: true })
}

console.log("checklist completion regression tests passed: " + checks)
