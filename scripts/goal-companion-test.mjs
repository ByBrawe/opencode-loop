import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const installer = path.join(root, "scripts", "install-with-goals.mjs")
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-goal-companion-"))
const fakeNpm = path.join(temporaryRoot, "fake-npm.mjs")
const expectedGoalExec = [
  "exec",
  "--yes",
  "--package=@bybrawe/opencode-goal@latest",
  "--",
  "opencode-goal",
]

await fs.writeFile(fakeNpm, `
import { appendFileSync } from "node:fs"
const log = process.env.FAKE_NPM_LOG
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8")
process.exit(Number(process.env.FAKE_NPM_EXIT || 0))
`, "utf8")

async function runInstaller(config, cliArgs = [], env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, ...cliArgs], {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: config,
        npm_execpath: fakeNpm,
        ...env,
      },
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", reject)
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

async function calls(log) {
  try {
    return (await fs.readFile(log, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function writeConfig(config, plugins, comment = "") {
  await fs.mkdir(config, { recursive: true })
  await fs.writeFile(
    path.join(config, "opencode.jsonc"),
    `{\n  ${comment ? `// ${comment}\n  ` : ""}\"plugin\": ${JSON.stringify(plugins, null, 2).replaceAll("\n", "\n  ")},\n}\n`,
    "utf8",
  )
}

try {
  const absentConfig = path.join(temporaryRoot, "absent")
  const absentLog = path.join(temporaryRoot, "absent.log")
  const absent = await runInstaller(absentConfig, [], { FAKE_NPM_LOG: absentLog })
  assert.equal(absent.code, 0, absent.stderr)
  assert.deepEqual(await calls(absentLog), [], "Loop-only installations must not silently add Goals")

  const existingConfig = path.join(temporaryRoot, "existing")
  const existingLog = path.join(temporaryRoot, "existing.log")
  await writeConfig(existingConfig, ["other-plugin", "@bybrawe/opencode-goal@1.3.16"])
  const existing = await runInstaller(existingConfig, [], { FAKE_NPM_LOG: existingLog })
  assert.equal(existing.code, 0, existing.stderr)
  assert.deepEqual(await calls(existingLog), [expectedGoalExec], "an installed Goals package must auto-refresh through its own latest installer")
  assert.match(existing.stdout, /Installed\/updated OpenCode Goals via @bybrawe\/opencode-goal@latest/)

  const localConfig = path.join(temporaryRoot, "local-goal")
  const localLog = path.join(temporaryRoot, "local-goal.log")
  await writeConfig(localConfig, ["./plugins/opencode-goal.ts"])
  const local = await runInstaller(localConfig, [], { FAKE_NPM_LOG: localLog })
  assert.equal(local.code, 0, local.stderr)
  assert.deepEqual(await calls(localLog), [expectedGoalExec], "legacy local Goals installs must be refreshed/migrated by the companion installer")

  const managedCommandConfig = path.join(temporaryRoot, "managed-command")
  const managedCommandLog = path.join(temporaryRoot, "managed-command.log")
  await fs.mkdir(path.join(managedCommandConfig, "commands"), { recursive: true })
  await fs.writeFile(path.join(managedCommandConfig, "commands", "goal.md"), "<!-- managed-by:@bybrawe/opencode-goal -->\n", "utf8")
  const managedCommand = await runInstaller(managedCommandConfig, [], { FAKE_NPM_LOG: managedCommandLog })
  assert.equal(managedCommand.code, 0, managedCommand.stderr)
  assert.deepEqual(await calls(managedCommandLog), [expectedGoalExec], "a managed /goal command is sufficient evidence that Goals should be refreshed")

  const commentedConfig = path.join(temporaryRoot, "comment-only")
  const commentedLog = path.join(temporaryRoot, "comment-only.log")
  await writeConfig(commentedConfig, ["other-plugin"], 'old note: "@bybrawe/opencode-goal@1.3.16"')
  const commented = await runInstaller(commentedConfig, [], { FAKE_NPM_LOG: commentedLog })
  assert.equal(commented.code, 0, commented.stderr)
  assert.deepEqual(await calls(commentedLog), [], "a package name mentioned only in JSONC comments must not trigger a network update")

  const explicitConfig = path.join(temporaryRoot, "explicit")
  const explicitLog = path.join(temporaryRoot, "explicit.log")
  const explicit = await runInstaller(explicitConfig, ["--with-goals"], { FAKE_NPM_LOG: explicitLog })
  assert.equal(explicit.code, 0, explicit.stderr)
  assert.deepEqual(await calls(explicitLog), [expectedGoalExec], "--with-goals must install the companion even when it is absent")

  const optOutConfig = path.join(temporaryRoot, "opt-out")
  const optOutLog = path.join(temporaryRoot, "opt-out.log")
  await writeConfig(optOutConfig, ["@bybrawe/opencode-goal@1.3.16"])
  const optOut = await runInstaller(optOutConfig, ["--loop-only"], { FAKE_NPM_LOG: optOutLog })
  assert.equal(optOut.code, 0, optOut.stderr)
  assert.deepEqual(await calls(optOutLog), [], "--loop-only must suppress companion network work")
  assert.match(optOut.stdout, /Skipped OpenCode Goals companion update/)

  const autoFailureConfig = path.join(temporaryRoot, "auto-failure")
  const autoFailureLog = path.join(temporaryRoot, "auto-failure.log")
  await writeConfig(autoFailureConfig, ["@bybrawe/opencode-goal@1.3.16"])
  const autoFailure = await runInstaller(autoFailureConfig, [], { FAKE_NPM_LOG: autoFailureLog, FAKE_NPM_EXIT: "7" })
  assert.equal(autoFailure.code, 0, "a best-effort refresh failure must not break an otherwise successful Loop update")
  assert.match(autoFailure.stderr, /could not be refreshed/)
  assert.match(autoFailure.stderr, /npx -y @bybrawe\/opencode-goal@latest/)

  const explicitFailureConfig = path.join(temporaryRoot, "explicit-failure")
  const explicitFailureLog = path.join(temporaryRoot, "explicit-failure.log")
  const explicitFailure = await runInstaller(explicitFailureConfig, ["--with-goals"], { FAKE_NPM_LOG: explicitFailureLog, FAKE_NPM_EXIT: "9" })
  assert.equal(explicitFailure.code, 9, "an explicitly requested companion install must fail closed")
  assert.match(explicitFailure.stderr, /companion install\/update failed/)

  const conflicting = await runInstaller(path.join(temporaryRoot, "conflicting"), ["--with-goals", "--loop-only"])
  assert.equal(conflicting.code, 2)
  assert.match(conflicting.stderr, /either --with-goals or --loop-only/)

  const helpLog = path.join(temporaryRoot, "help.log")
  const help = await runInstaller(path.join(temporaryRoot, "help"), ["--with-goals", "--help"], { FAKE_NPM_LOG: helpLog })
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /OpenCode Loop installer\/updater/)
  assert.match(help.stdout, /--with-goals/)
  assert.match(help.stdout, /--loop-only/)
  assert.match(help.stdout, /Loop uninstall never removes Goals/)
  assert.deepEqual(await calls(helpLog), [], "help/version flows must never install companion packages")

  console.log("OpenCode Loop Goals companion installer test passed")
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
