import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"

function once(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `candidate anchor changed: ${before}`)
  return source.replace(before, after)
}

// Git's Windows checkout may use CRLF. Compare canonical LF bytes while
// retaining the exact source identity assertion and behavioral red baseline.
function sourceText(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n")
}

if (process.argv[2] === "tests") {
  const source = Buffer.from(sourceText("src/source/runtime/job-workspace.js"))
  const digest = createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex")
  assert.equal(digest, "e237a01830001c452b1e423804e061d91be4728f", "audit must reproduce the reviewed original scanner")
  writeFileSync("scripts/control-plane-until-test.mjs", String.raw`import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createJobWorkspaceRuntime } from "../src/source/runtime/job-workspace.js"

const marker = "NATIVE_COMPLETION_FROM_WORK_ONLY_8fd8"
const runtime = createJobWorkspaceRuntime({ toast: async () => {} })
async function fixture(file, expected) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-control-until-"))
  try {
    const target = path.join(directory, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ objective: marker }))
    assert.equal(await runtime.untilReached(directory, { until: marker }), expected)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

for (const file of [
  ".opencode/goals/live.json",
  ".opencode/goals/archive/history.json",
  ".opencode/goal-sequences/session.json",
  ".opencode/goal-locks/lease.json",
  ".opencode/goal-handoff-locks/lease.json",
  ".opencode/opencode-loop/session.json",
]) {
  test("Goal/Loop control state cannot satisfy --until: " + file, () => fixture(file, false))
}
for (const file of [
  "progress.md",
  ".opencode/opencode-loop/until.txt",
  ".opencode/commands/project-task.md",
  ".opencode/goals-project-notes/finished.md",
]) {
  test("explicit or project-owned completion marker stays supported: " + file, () => fixture(file, true))
}
`)
} else {
  assert.equal(process.argv[2], "fix")
  const file = "src/source/runtime/job-workspace.js"
  let source = sourceText(file)
  source = once(source, '    if (!job.until) return false\n    const files =',
    '    if (!job.until) return false\n' +
    '    // Goal contracts/archives/leases can contain the configured marker too.\n' +
    '    // None of this control state proves completion of user-project work.\n' +
    '    const controlRoots = new Set([\n' +
    '      stateDir(directory),\n' +
    '      ...["goals", "goal-locks", "goal-handoff-locks", "goal-sequences"]\n' +
    '        .map((name) => path.join(directory, ".opencode", name)),\n' +
    '    ].map((root) => path.resolve(root).toLowerCase()))\n' +
    '    const files =')
  source = once(source,
    '        // The control state contains the configured --until text; it is not completion evidence.\n        if (path.resolve(full) === path.resolve(stateDir(directory))) continue',
    '        // Keep the explicit until.txt marker above, but never scan plugin state.\n        if (controlRoots.has(path.resolve(full).toLowerCase())) continue')
  writeFileSync(file, source)
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  pkg.scripts.test = "node --test scripts/control-plane-until-test.mjs && " + pkg.scripts.test
  pkg.scripts.check += " && node --check scripts/control-plane-until-test.mjs"
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
  writeFileSync("docs/OPENCODE2-CONTROL-STATE.md", `# Native Goal/Loop control-state completion boundary

A Goal objective, queued contract or archived state may contain the exact string
configured by another session's Loop --until option. Recursively reading that
string is not evidence that the Loop task has finished.

The shared V1/V2 workspace marker scanner now skips these exact control roots:
.opencode/goals, .opencode/goal-locks, .opencode/goal-handoff-locks,
.opencode/goal-sequences, and .opencode/opencode-loop. Goal's native handoff
lease directory is also excluded from Goal progress by companion commit
16a276bb219a512d9a7d2a4dd8b6883eb76b9b54.

The explicit .opencode/opencode-loop/until.txt completion marker remains
supported, as do ordinary progress.md, project-owned .opencode/commands and
similarly named non-control directories. The exclusion is not a blanket ban
on all .opencode files. There is no state-schema or completion-tool change.

scripts/control-plane-until-test.mjs has six control-state negatives and four
positive compatibility cases. The candidate workflow requires the original
scanner to fail before applying the correction, then runs the full suites,
production tarballs and real native-host checks against the exact Goal companion.
All three distributed Loop bundles must be rebuilt from this shared module.
This audit does not claim a measured live-model performance gain or an npm release.
`)
}
