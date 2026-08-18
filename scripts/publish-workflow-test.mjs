import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "publish-npm.yml")
const workflow = await readFile(workflowPath, "utf8")

assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/, "publish workflow must checkout the release trigger SHA")
assert.doesNotMatch(workflow, /ref:\s*main\b/, "publish workflow must not checkout a moving main branch")
assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/, "release source must be verified against main history")
assert.match(workflow, /COMMIT_SHA="\$GITHUB_SHA"/, "release tag must target the immutable trigger SHA")
assert.match(workflow, /group:\s*npm-release/, "npm publication must be serialized")
assert.match(workflow, /cancel-in-progress:\s*false/, "a newer release must not cancel an in-flight publication")

const publishIndex = workflow.indexOf("npm publish --access public")
const verifyIndex = workflow.indexOf("Verify published version is readable from npm")
const tagIndex = workflow.indexOf("Create tag and GitHub release")
const cleanupIndex = workflow.indexOf("Remove one-shot release branch")
assert.ok(publishIndex >= 0 && verifyIndex > publishIndex, "npm publication must be verified after publish")
assert.ok(tagIndex > verifyIndex, "tag/release creation must happen only after npm verification")
assert.ok(cleanupIndex > tagIndex, "release branch cleanup must be the final release step")

console.log("publish workflow tests passed")
