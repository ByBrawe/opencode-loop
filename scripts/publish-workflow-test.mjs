import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateRelease, releaseDecision, assertPublishedSource, waitForPublishedGoal } from "./native-release.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflow = await readFile(path.join(repoRoot, ".github/workflows/publish-npm.yml"), "utf8")
const nativeV2Workflow = await readFile(path.join(repoRoot, ".github/workflows/native-v2-ci.yml"), "utf8")
assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/, "checkout must use the immutable trigger SHA")
assert.doesNotMatch(workflow, /ref:\s*main\b/, "publication cannot checkout moving main")
assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/)
assert.match(workflow, /COMMIT_SHA="\$GITHUB_SHA"/)
assert.match(workflow, /group:\s*npm-release/)
assert.match(workflow, /cancel-in-progress:\s*false/)
assert.match(workflow, /branches:\s*\[main\]/)
assert.match(workflow, /paths:\s*\[\.github\/npm-release\.json\]/)
assert.doesNotMatch(workflow, /release\/npm-v|git push|Remove one-shot release branch/, "main-only publication must not create or delete branches")
assert.match(workflow, /needs:\s*\[native-regressions, real-native-pair\]/)
assert.match(workflow, /node scripts\/native-release\.mjs ci/)
assert.match(workflow, /git diff --exit-code -- src\/index.js src\/server.js src\/native.js/)
assert.match(workflow, /npm run package:smoke/)
assert.match(workflow, /windows-latest/)
assert.match(workflow, /Decide whether npm publish is needed/)
assert.match(workflow, /steps\.npm-state\.outputs\.publish == 'true'/)
assert.match(workflow, /for attempt in \{1\.\.60\}/)
assert.doesNotMatch(workflow, /npm view @bybrawe\/opencode-loop@latest/, "direct registry verification already checks latest; do not add a stale npm-view cache gate")
assert.match(workflow, /native-release\.mjs verify/)
assert.match(workflow, /node_modules\/@bybrawe\/opencode-loop\/scripts\/opencode2-loop-canary.mjs/)
assert.match(workflow, /node_modules\/@bybrawe\/opencode-goal\/dist\/server.js/)
assert.match(workflow, /ref: \$\{\{ steps.release.outputs.goal_sha \}\}/)
assert.match(workflow, /npm install --no-save --legacy-peer-deps @opencode\/plugin@2\.0\.22/, "immutable Goal companion must build against its pinned OpenCode 2.0.22 plugin contract")
assert.match(nativeV2Workflow, /npm install --no-save --legacy-peer-deps @opencode\/plugin@2\.0\.18/, "Native V2 CI must pin the immutable Goal companion to the same OpenCode 2.0.18 plugin contract")
assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN/)

const publishIndex = workflow.indexOf("npm publish --access public")
const verifyIndex = workflow.indexOf("Verify published version is readable from npm")
const tagIndex = workflow.indexOf("Create tag and GitHub release")
assert.ok(publishIndex >= 0 && verifyIndex > publishIndex)
assert.ok(tagIndex > verifyIndex)
assert.match(workflow.slice(tagIndex), /needs:\s*publish/, "GitHub release must depend on verified publication")
for (const block of workflow.split(/- uses: actions\/checkout@/).slice(1)) assert.match(block.split(/\n\s*- (?:uses|name|run):/)[0], /persist-credentials:\s*false/)
const publisher = workflow.slice(workflow.indexOf("  publish:\n"), workflow.indexOf("  github-release:\n"))
assert.doesNotMatch(publisher, /contents:\s*write/, "OIDC publisher must not gain repository mutation privileges")

assert.match(workflow, /for attempt in \{1\.\.12\}/, "clean published npm consumer must retry version propagation")
assert.ok(workflow.includes('--prefer-online --cache "$VERIFY_DIR/npm-cache-$attempt"'), "consumer retries must not reuse a stale npm cache")
assert.ok(workflow.includes("Published Loop+Goal clean-install validation did not converge"), "clean consumer must remain a hard release gate")

const sha = "a".repeat(40)
const request = { name: "@bybrawe/opencode-loop", version: "0.6.6", predecessor: "0.6.5", goal: { version: "1.3.47", sha: "b".repeat(40) } }
const pkg = { name: request.name, version: request.version }
const env = { GITHUB_REPOSITORY: "ByBrawe/opencode-loop", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha }
assert.strictEqual(validateRelease(request, pkg, env), request)
for (const change of [{ GITHUB_REPOSITORY: "someone/fork" }, { GITHUB_REF: "refs/heads/release" }, { GITHUB_SHA: "main" }]) assert.throws(() => validateRelease(request, pkg, { ...env, ...change }))
assert.throws(() => validateRelease({ ...request, version: "9.0.0" }, pkg, env))
assert.throws(() => validateRelease(request, { ...pkg, version: "0.6.5" }, env))
assert.equal(releaseDecision(404, null, request, sha, "0.6.5"), true)
for (const status of [401, 403, 429, 500, 503]) assert.throws(() => releaseDecision(status, null, request, sha, "0.6.0"))
assert.throws(() => releaseDecision(404, null, request, sha, "0.7.0"))
const manifest = { ...pkg, gitHead: sha }
assert.equal(releaseDecision(200, manifest, request, sha), false)
assert.throws(() => releaseDecision(200, { ...manifest, gitHead: "b".repeat(40) }, request, sha))
assert.throws(() => assertPublishedSource({ ...manifest, gitHead: undefined }, pkg.name, pkg.version, sha))

let calls = 0, sleeps = 0
const goalManifest = { name: "@bybrawe/opencode-goal", version: request.goal.version, gitHead: request.goal.sha }
const recovered = await waitForPublishedGoal(request.goal, {
  attempts: 2, sleep: async () => { sleeps++ },
  request: async () => ++calls === 1 ? { ok: false, status: 404 } : { ok: true, json: async () => goalManifest },
})
assert.deepEqual(recovered, goalManifest)
assert.equal(calls, 2)
assert.equal(sleeps, 1)
await assert.rejects(waitForPublishedGoal(request.goal, { attempts: 1, request: async () => ({ ok: false, status: 404 }) }), /not published/)
for (const status of [403, 429, 503]) await assert.rejects(waitForPublishedGoal(request.goal, { attempts: 1, request: async () => ({ ok: false, status }) }), /transport\/auth/)
await assert.rejects(waitForPublishedGoal(request.goal, { attempts: 1, request: async () => ({ ok: true, json: async () => ({ ...goalManifest, gitHead: sha }) }) }), /different source/)
console.log("main-only publish workflow, source identity and registry failure regressions passed")
