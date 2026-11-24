import assert from "node:assert/strict"
import { validateRelease, releaseDecision, assertPublishedSource } from "./native-release.mjs"

// Only offline release/source identity regressions remain. The GitHub Actions
// publisher and its workflow YAML were intentionally removed.

const sha = "a".repeat(40)
const request = { name: "@bybrawe/opencode-loop", version: "0.6.10", predecessor: "0.6.9" }
const pkg = { name: request.name, version: request.version }
const env = { GITHUB_REPOSITORY: "ByBrawe/opencode-loop", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha }
assert.strictEqual(validateRelease(request, pkg, env), request)
for (const change of [{ GITHUB_REPOSITORY: "someone/fork" }, { GITHUB_REF: "refs/heads/release" }, { GITHUB_SHA: "main" }]) assert.throws(() => validateRelease(request, pkg, { ...env, ...change }))
assert.throws(() => validateRelease({ ...request, version: "9.0.0" }, pkg, env))
assert.throws(() => validateRelease(request, { ...pkg, version: "0.6.5" }, env))
assert.equal(releaseDecision(404, null, request, sha, "0.6.9"), true)
for (const status of [401, 403, 429, 500, 503]) assert.throws(() => releaseDecision(status, null, request, sha, "0.6.0"))
assert.throws(() => releaseDecision(404, null, request, sha, "0.7.0"))
const manifest = { ...pkg, gitHead: sha }
assert.equal(releaseDecision(200, manifest, request, sha), false)
assert.throws(() => releaseDecision(200, { ...manifest, gitHead: "b".repeat(40) }, request, sha))
assert.throws(() => assertPublishedSource({ ...manifest, gitHead: undefined }, pkg.name, pkg.version, sha))

console.log("Manual release source identity and registry failure regressions passed")
