#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const pluginDir = join(config, "plugins")
const commandDir = join(config, "commands")
const packagePath = join(config, "package.json")

async function ensureDependency() {
  let pkg = {}
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not update ${packagePath}: ${error.message}`)
      console.warn('Add "@opencode-ai/plugin": ">=1.4.0" to that package.json if OpenCode cannot load the local plugin.')
      return
    }
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) pkg = {}
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {}
  if (!pkg.dependencies["@opencode-ai/plugin"]) {
    pkg.dependencies["@opencode-ai/plugin"] = ">=1.4.0"
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  }
}

await mkdir(pluginDir, { recursive: true })
await mkdir(commandDir, { recursive: true })
await ensureDependency()
await copyFile(join(root, "src", "index.js"), join(pluginDir, "opencode-loop.ts"))
await rm(join(pluginDir, "opencode-loop.js"), { force: true })

for (const name of await readdir(join(root, "commands"))) {
  if (name.endsWith(".md")) {
    await copyFile(join(root, "commands", name), join(commandDir, name))
  }
}

console.log(`Installed OpenCode Loop plugin to ${config}`)
console.log("Restart OpenCode, then run: /loop-help")
