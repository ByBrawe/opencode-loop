import assert from "node:assert/strict"
import { promises as fs } from "node:fs"

const legacy = await fs.readFile("src/source/legacy-v1.js", "utf8")
const host = await fs.readFile("src/source/opencode/host.js", "utf8")

const legacyStart = legacy.indexOf("function fireSdk(")
const legacyEnd = legacy.indexOf("function guardLoopOwnedUserMessage(")
const hostStart = host.indexOf("export function fireSdk(")
assert.ok(legacyStart >= 0 && legacyEnd > legacyStart, "legacy host bridge block not found")
assert.ok(hostStart >= 0, "host bridge module block not found")

const normalize = (text) => text
  .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, "")
  .replace(/\r\n/g, "\n")
  .trim()

const legacyBlock = normalize(legacy.slice(legacyStart, legacyEnd))
const hostBlock = normalize(host.slice(hostStart))
assert.equal(hostBlock, legacyBlock, "OpenCode host bridge drifted from the stable V1 implementation")

console.log("host bridge parity test passed")
