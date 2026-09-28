import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const tools = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const root = process.cwd()
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
assert.ok(["@bybrawe/opencode-loop", "@bybrawe/opencode-goal"].includes(pkg.name))
const loop = pkg.name.endsWith("opencode-loop")
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function edit(file, before, after) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n")
  assert.equal(text.split(before).length, 2, `Expected exactly one anchor in ${file}: ${before}`)
  write(file, text.replace(before, after))
}
function add(file, text) {
  assert.equal(existsSync(file), false, `Refusing to replace ${file}`)
  write(file, text)
}

if (tools !== root) add("scripts/native-entry-test.mjs", readFileSync(path.join(tools, "scripts/native-entry-test.mjs"), "utf8"))
const baseline = spawnSync(process.execPath, ["scripts/native-entry-test.mjs"], { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
if (baseline.error) throw baseline.error
assert.notEqual(baseline.status, 0, "Expected the baseline to expose the eager legacy import")
assert.match(`${baseline.stdout}\n${baseline.stderr}`, /V2_LEGACY_IMPORT:/, "Baseline failed for a different reason")
console.log("REPRODUCED: the current package server entry resolves the legacy runtime before V2 setup")

if (loop) {
  edit("src/source/server.js", 'import OpenCodeLoopPlugin from "./v1.js"\n', "")
  edit("src/source/server.js", 'export const OPENCODE_LOOP_PLUGIN_ID', `// Load the legacy runtime only when a V1 host invokes its server contract.\n// A runtime URL prevents bundlers from inlining the legacy implementation.\n// Both source and package entries have a sibling v1.js; the package shim\n// delegates to the standalone V1 bundle, without initializing it on V2.\nasync function OpenCodeLoopPlugin(...args) {\n  const { default: legacy } = await import(new URL("./v1.js", import.meta.url).href)\n  return legacy(...args)\n}\n\nexport const OPENCODE_LOOP_PLUGIN_ID`)
  add("src/v1.js", 'export { default } from "./index.js"\n')
  pkg.scripts.test = "node scripts/native-entry-test.mjs && " + pkg.scripts.test
  pkg.scripts.check += " && node --check scripts/native-entry-test.mjs && node --check scripts/package-native-smoke.mjs && node --check src/v1.js"
  pkg.scripts["package:smoke"] = "node scripts/package-native-smoke.mjs"
  edit("scripts/install-node.mjs", 'legacyV1 ? "server.js" : "native.js"', 'legacyV1 ? "index.js" : "native.js"')
  edit("scripts/install-test.mjs", 'path.join(root, "src", "server.js")', 'path.join(root, "src", "index.js")')
  edit("scripts/install-test.mjs", "local install must copy the dual OpenCode 1/2 server bundle", "explicit legacy install must copy the standalone V1 bundle, not the lazy package facade")
  edit(".github/workflows/native-v2-ci.yml", "      - run: npm pack --dry-run", "      - run: npm run package:smoke")
} else {
  // Extract shared evidence definitions unchanged. Native verification must
  // not load the V1 tool SDK; V1 and V2 retain the same functions/Error class.
  const verifierFile = "src/opencode/verifier.ts"
  let verifier = readFileSync(verifierFile, "utf8").replace(/\r\n/g, "\n")
  const extract = (start, next) => {
    const a = verifier.indexOf(start), b = verifier.indexOf(next, a + start.length)
    assert.ok(a >= 0 && b > a, `Missing verifier extraction bounds: ${start}`)
    const block = verifier.slice(a, b).trimEnd() + "\n"
    verifier = verifier.slice(0, a) + verifier.slice(b)
    return block
  }
  const timeout = extract("export const DEFAULT_VERIFIER_TIMEOUT_MS", "const VERIFIER_CLEANUP_TIMEOUT_MS")
  const error = extract("export class SemanticVerifierUnavailableError", "interface PendingAudit")
  const evidence = extract("function currentRevisionTurns(", "async function bestEffortWithin(")
  const shared = [
    'import { createHash } from "node:crypto"',
    'import { promises as fs } from "node:fs"',
    'import path from "node:path"',
    'import type { EvidenceRecord, GoalState } from "../domain/types.js"',
    'import type { SemanticEvidenceRef, SemanticRequirementResult } from "./semantic.js"',
    "", timeout, error, evidence,
  ].join("\n")
  add("src/verification/verifier-evidence.ts", shared)
  verifier = verifier.replace('import { createHash, randomUUID }', 'import { randomUUID }')
    .replace('import { promises as fs } from "node:fs"\n', '')
    .replace('import path from "node:path"\n', '')
  const bindings = "DEFAULT_VERIFIER_TIMEOUT_MS, SemanticVerifierUnavailableError, corroborateSemanticVerifierEvidence, semanticVerificationPrompt, semanticVerifierHostEvidence"
  verifier = `import { ${bindings} } from "../verification/verifier-evidence.js"\nexport { ${bindings} } from "../verification/verifier-evidence.js"\n` + verifier
  write(verifierFile, verifier)
  for (const name of readdirSync("src/opencode2")) {
    if (!name.endsWith(".ts")) continue
    const file = path.join("src/opencode2", name)
    const text = readFileSync(file, "utf8")
    if (text.includes('"../opencode/verifier.js"')) edit(file, '"../opencode/verifier.js"', '"../verification/verifier-evidence.js"')
  }
  add("test/verifier-evidence-shared.test.mjs", `import assert from "node:assert/strict"\nimport test from "node:test"\nimport * as shared from "../dist/verification/verifier-evidence.js"\nimport * as legacy from "../dist/opencode/verifier.js"\n\ntest("V1 and V2 use the same verifier proof helpers and Error identity", () => {\n  for (const name of Object.keys(shared)) assert.strictEqual(legacy[name], shared[name], name)\n  const error = new shared.SemanticVerifierUnavailableError("fixture")\n  assert.ok(error instanceof legacy.SemanticVerifierUnavailableError)\n})\n`)
  const index = readFileSync("src/index.ts", "utf8").replace(/\r\n/g, "\n")
  const boundary = '\nexport * from "./domain/types.js"'
  assert.equal(index.split(boundary).length, 2)
  const offset = index.indexOf(boundary)
  add("src/legacy-v1.ts", index.slice(0, offset).trimEnd() + "\n")
  write("src/index.ts", 'export { default } from "./legacy-loader.js"\n' + index.slice(offset))
  add("src/legacy-loader.ts", `// The public API and dual server facade share this function identity.\n// Importing native V2 must not resolve the V1 SDK or initialize its runtime.\ntype LegacyPlugin = typeof import("./legacy-v1.js").default\n\nexport default async function OpenCodeGoalPlugin(\n  ...args: Parameters<LegacyPlugin>\n): Promise<Awaited<ReturnType<LegacyPlugin>>> {\n  const { default: legacy } = await import("./legacy-v1.js")\n  return legacy(...args)\n}\n`)
  edit("src/server.ts", 'import OpenCodeGoalPlugin from "./index.js"', 'import OpenCodeGoalPlugin from "./legacy-loader.js"')
  add("src/native.ts", `import OpenCode2GoalsPlugin from "./opencode2/experimental.js"\n\n// Explicit native-only entry. Persisted Goal state remains owned by the same\n// V2 implementation; this entry adds no alternate lifecycle or recovery path.\nexport default {\n  id: "@bybrawe/opencode-goal",\n  setup: OpenCode2GoalsPlugin.setup,\n}\n`)
  assert.equal(pkg.exports["./v2"], undefined)
  assert.equal(pkg.exports["./v1"], undefined)
  pkg.exports["./v2"] = { types: "./dist/native.d.ts", import: "./dist/native.js" }
  pkg.exports["./v1"] = { ...pkg.exports["."] }
  pkg.scripts.check += " && node --check scripts/native-entry-test.mjs"
  add("test/native-entry.test.mjs", `import assert from "node:assert/strict"\nimport { spawnSync } from "node:child_process"\nimport { fileURLToPath } from "node:url"\nimport test from "node:test"\n\ntest("V2 package entries isolate V1 imports and preserve lazy per-host legacy delegation", () => {\n  const root = fileURLToPath(new URL("../", import.meta.url))\n  const result = spawnSync(process.execPath, ["scripts/native-entry-test.mjs"], { cwd: root, encoding: "utf8", timeout: 90_000, windowsHide: true })\n  if (result.error) throw result.error\n  assert.equal(result.status, 0, result.stdout + result.stderr)\n})\n`)
  edit("scripts/package-smoke.mjs", '    const probe = String.raw`', `    const nativeProbe = run(process.execPath, [path.join(root, "scripts", "native-entry-test.mjs"), consumer], { cwd: root })\n    console.log(nativeProbe.stdout.trim())\n\n    const probe = String.raw\``)
  edit("scripts/package-smoke.mjs", '    "dist/index.js", "dist/index.d.ts", "dist/server.js", "dist/server.d.ts",', '    "dist/index.js", "dist/index.d.ts", "dist/server.js", "dist/server.d.ts",\n    "dist/native.js", "dist/native.d.ts", "dist/legacy-loader.js", "dist/legacy-v1.js",')
  edit("scripts/package-smoke.mjs", '      serverEntrypoint: true,', '      serverEntrypoint: true,\n      nativeEntrypointIsolation: true,\n      lazyLegacyDelegation: true,')
}
write("package.json", JSON.stringify(pkg, null, 2) + "\n")

add("docs/OPENCODE2-MIGRATION.md", `# OpenCode 2 migration plan: Goal and Loop\n\nBaseline: Goal 8688252; Loop 35e4f96. Target contract for this batch: OpenCode 2.0.18.\nThis is a source/main plan, not an npm publication announcement or a claim of complete feature parity.\n\n## Rules\n\n- Work on main only. Preserve existing history; no force-push or new feature branches.\n- Native V2 uses its own admission, inbox, execution, tool and compaction surfaces.\n- Preserve project-local state, Goal IDs/revisions/evidence/budgets, and one continuation owner.\n- Prompt hooks are pre-admission and retryable, not an exactly-once persistence boundary.\n- Keep V1 compatibility explicit and isolated. Do not migrate a store merely because V2 offers a storage API.\n- Finish a coherent source/test batch before reviewing CI collectively. Never remove a safety assertion to turn CI green.\n- Close only issues with a matching implementation and test evidence. Publication is a separate step.\n\n## Phases and acceptance\n\n| Phase | Work in both repositories | Acceptance | Status |\n| --- | --- | --- | --- |\n| 1. Native package boundary | Remove eager V1 runtime imports from V2 server entries; provide explicit /v2 and /v1 exports; retain lazy legacy delegation | Import real source/bundled/installed V2 entries with V1 resolution deliberately rejected; input/options/errors remain intact for explicit V1 calls | Implemented in this batch; validated before commit |\n| 2. Installation and CLI | Audit plugins object options, JSONC/multiple configs, combined Goal+Loop install, native local files, daemon/CLI executable detection and help text | Clean install/update/uninstall on Windows/Linux; preserve custom files and options; exercise actual V2 CLI | Pending full audit |\n| 3. Runtime boundaries | Audit foreground admission, event generations, compaction ordering, retry/timeout, subscription teardown and disposal failures | Both terminal event orders; duplicate/replayed events; no abort of native compaction; no overlapping continuation or leaked registration | Pending additional audit |\n| 4. Goal parity and handoff | Recheck completion evidence, waiting-user/Plan/delegated-task gates, telemetry/budget accounting, unit rotation and crash phases | Same Goal identity/evidence/usage across handoff; one owner after restart; final unit does not rotate; stale proofs cannot complete | Existing implementation; re-audit planned |\n| 5. Loop command/policy parity | Compare every documented command and option against the native path, including shell/command aliases, watches, stop conditions, preflight/verify/postrun and checkpoints | Feature matrix with real tests; unsupported combinations rejected before durable job creation | Pending full audit |\n| 6. Joint validation and release | Test current main+main and pinned supported hosts; production tarballs; update docs/version/release notes once scope is complete | Batch CI + independent package loading + joint real-host canaries; distinguish deterministic local-provider evidence from live-model field testing | Pending final sign-off |\n\n## First batch\n\nBoth server facades previously imported V1 before a V2 host could invoke setup.\nThe native-entry regression test reproduces that failure using an ESM resolver\nwhich explicitly rejects the V1 SDK and legacy implementation entry. The same\ntest must pass after the change, including inside an installed production tarball.\n\nGoal retains its public API exports and shared default function identity. Its V1\nimplementation is moved without behavioral edits behind a typed lazy loader.\nIts new /v2 entry exposes only native setup; /v1 retains the existing library API.\nPure verifier proof helpers are shared without importing the V1 tool SDK; both\nadapters retain the same exported functions and unavailable-error identity.\n\nLoop uses a sibling runtime URL so bundling cannot inline the legacy import.\nThe small src/v1.js shim delegates to the standalone legacy bundle. Explicit\n--legacy-v1 local installation uses that standalone bundle, not a facade that\nrequires adjacent package files. The native local installation is unchanged.\n\nThe legacy dependency manifest is deliberately retained in this batch for\ncompatibility. Import isolation does not claim that all V1 packages have been\nremoved from npm dependency resolution. That packaging policy requires separate\ncompatibility/release review. No Goal or Loop persistence schema is changed.\n\n## Evidence\n\n- scripts/native-entry-test.mjs: native import isolation plus per-host lazy legacy delegation and error propagation.\n- Goal: test/native-entry.test.mjs and the production-only scripts/package-smoke.mjs consumer.\n- Loop: scripts/package-native-smoke.mjs and native-v2-ci on Windows and Linux.\n- Validation runs must also pass the existing regression suites and an exact OpenCode 2.0.18 real-host canary before committing.\n\n## Known follow-up checks (not claimed resolved)\n\n- Loop README still contains historical experimental-V2 wording; reconcile it against a complete native feature matrix, not a blanket parity assertion.\n- Audit default CLI/daemon host selection separately from plugin entry loading.\n- Recheck V2 handoff and dedicated-Goal reservation together against both final main heads.\n- Retain historical closed-issue evidence; do not equate a closed issue with completion of this entire migration plan.\n`)
console.log(`Prepared native entry isolation for ${pkg.name}; build and run all gates before committing`)
