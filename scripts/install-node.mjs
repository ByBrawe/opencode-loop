#!/usr/bin/env node
import { copyFile, mkdir, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const pluginDir = join(config, "plugins")
const commandDir = join(config, "commands")

await mkdir(pluginDir, { recursive: true })
await mkdir(commandDir, { recursive: true })
await copyFile(join(root, "src", "index.js"), join(pluginDir, "opencode-loop.ts"))

for (const name of await readdir(join(root, "commands"))) {
  if (name.endsWith(".md")) {
    await copyFile(join(root, "commands", name), join(commandDir, name))
  }
}

console.log(`Installed OpenCode Loop plugin to ${config}`)
console.log("Restart OpenCode, then run: /loop-help")
