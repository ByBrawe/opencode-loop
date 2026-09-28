import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
const commands = JSON.parse(readFileSync("package.json", "utf8")).scripts.test.split(" && ")
const failed = []
for (const command of commands) {
  const result = spawnSync(command, { shell: true, encoding: "utf8", timeout: 240_000, maxBuffer: 20_000_000 })
  if (result.status !== 0) {
    failed.push(command)
    console.error(`FAIL ${command}\n${result.stdout?.slice(-16000)}\n${result.stderr?.slice(-16000)}\n${result.error || ""}`)
  } else console.log(`PASS ${command}\n${result.stdout?.trim().split("\n").slice(-2).join("\n")}`)
}
console.log(JSON.stringify({ total: commands.length, failed }, null, 2))
if (failed.length) process.exitCode = 1
