import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const adapterFile = path.join(root, "src", "source", "opencode2", "experimental.js")
const expectedID = "bybrawe.opencode-loop.v2.experimental"
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function run(command, args, { cwd, env, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-loop-v2-adapter-"))
  const project = path.join(temp, "project")
  const home = path.join(temp, "home")
  const config = path.join(home, ".config")
  const data = path.join(home, ".local", "share")
  const state = path.join(home, ".local", "state")
  const pluginDirectory = path.join(project, ".opencode", "plugins")
  const marker = path.join(project, "v2-adapter-marker.json")
  const wrapper = path.join(pluginDirectory, "opencode-loop-v2-adapter.js")
  const adapterURL = pathToFileURL(adapterFile).href

  await Promise.all([
    mkdir(pluginDirectory, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(state, { recursive: true }),
  ])
  await writeFile(
    wrapper,
    `import { writeFile } from "node:fs/promises"\nimport adapter from ${JSON.stringify(adapterURL)}\nconst marker = new URL("../../v2-adapter-marker.json", import.meta.url)\nexport default {\n  id: "bybrawe.opencode-loop.v2.adapter-canary",\n  async setup(ctx) {\n    await adapter.setup(ctx)\n    await writeFile(marker, JSON.stringify({ activated: true, adapterID: adapter.id }, null, 2), "utf8")\n  },\n}\n`,
    "utf8",
  )
  await writeFile(path.join(project, "README.md"), "# OpenCode Loop V2 adapter canary\n", "utf8")

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    OPENCODE_DB: path.join(data, "opencode", "opencode-loop-v2-adapter.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_LOG_LEVEL: "DEBUG",
    CI: "true",
  }
  run("git", ["init", "-q"], { cwd: project, env })
  run("git", ["config", "user.name", "OpenCode Loop Canary"], { cwd: project, env })
  run("git", ["config", "user.email", "opencode-loop-canary@example.invalid"], { cwd: project, env })
  run("git", ["add", "."], { cwd: project, env })
  run("git", ["commit", "-q", "-m", "initialize adapter canary"], { cwd: project, env })

  try {
    const request = run(
      "opencode2",
      ["api", "get", "/api/command", "-H", `x-opencode-directory: ${project}`],
      { cwd: project, env, timeout: 90_000 },
    )

    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const value = JSON.parse(await readFile(marker, "utf8"))
        if (value?.activated === true && value?.adapterID === expectedID) {
          console.log(JSON.stringify({ ok: true, adapterID: value.adapterID, platform: process.platform }, null, 2))
          return
        }
      } catch {}
      await delay(200)
    }

    throw new Error([
      "OpenCode 2 loaded the canary project but did not complete the repository V2 adapter setup.",
      `stdout: ${String(request.stdout ?? "")}`,
      `stderr: ${String(request.stderr ?? "")}`,
    ].join("\n"))
  } finally {
    run("opencode2", ["service", "stop"], { cwd: project, env, timeout: 15_000 })
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
