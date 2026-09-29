import assert from "node:assert/strict"
import { readFile, appendFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

export function validateRelease(request, pkg, env) {
  assert.equal(env.GITHUB_REPOSITORY, "ByBrawe/opencode-loop", "wrong release repository")
  assert.equal(env.GITHUB_REF, "refs/heads/main", "npm release must come from main")
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/, "immutable release SHA required")
  assert.equal(request?.version, "0.6.0", "release version is not authorized")
  assert.equal(request?.name, "@bybrawe/opencode-loop")
  assert.equal(pkg.name, request.name)
  assert.equal(pkg.version, request.version)
  assert.equal(request.predecessor, "0.5.38")
  assert.equal(request.goal?.version, "1.3.39")
  assert.match(request.goal?.sha ?? "", /^[a-f0-9]{40}$/)
  return request
}

export function assertPublishedSource(manifest, name, version, sha) {
  assert.equal(manifest?.name, name, "published package name differs")
  assert.equal(manifest?.version, version, "published package version differs")
  assert.equal(manifest?.gitHead, sha, "immutable npm version belongs to different source; use a new version")
}

export function releaseDecision(status, manifest, request, sha, latest) {
  if (status === 200) {
    assertPublishedSource(manifest, request.name, request.version, sha)
    return false
  }
  assert.equal(status, 404, "registry failure is not proof that a version is unpublished")
  assert.equal(latest, request.predecessor, "npm latest differs from the predecessor; refuse out-of-order publication")
  return true
}

export async function waitForPublishedGoal(goal, options = {}) {
  const request = options.request ?? fetch
  const sleep = options.sleep ?? delay
  const attempts = options.attempts ?? 60
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request("https://registry.npmjs.org/" + encodeURIComponent("@bybrawe/opencode-goal") + "/" + goal.version, { signal: AbortSignal.timeout(20000) })
    if (response.ok) {
      const manifest = await response.json()
      assertPublishedSource(manifest, "@bybrawe/opencode-goal", goal.version, goal.sha)
      return manifest
    }
    assert.equal(response.status, 404, "Goal registry transport/auth errors cannot authorize the joint release")
    if (attempt + 1 < attempts) await sleep(10000)
  }
  throw new Error("Declared Goal release is not published; Loop publication refused")
}

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function main() {
  const request = JSON.parse(await readFile(new URL("../.github/npm-release.json", import.meta.url), "utf8"))
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  validateRelease(request, pkg, process.env)
  const mode = process.argv[2]
  const sha = process.env.GITHUB_SHA
  const base = "https://registry.npmjs.org/" + encodeURIComponent(pkg.name)
  if (mode === "validate") {
    console.log(JSON.stringify({ release: request, source: sha }))
    return
  }
  if (mode === "ci") {
    const headers = { Accept: "application/vnd.github+json" }
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const runs = []
      for (let page = 1; page <= 10; page++) {
        const result = await json(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`, headers)
        runs.push(...result.workflow_runs)
        if (runs.length >= result.total_count || result.workflow_runs.length < 100) break
        if (page === 10) throw new Error("Cannot safely paginate release checks")
      }
      const gates = ["CI", "Native V2 CI"].map((name) => {
        const run = runs.filter((item) => item.name === name && item.head_sha === sha && item.head_branch === "main" && item.event === "push" && item.repository?.full_name === process.env.GITHUB_REPOSITORY).sort((a, b) => Number(b.id) - Number(a.id))[0]
        return { name, id: run?.id, status: run?.status, conclusion: run?.conclusion }
      })
      console.log(JSON.stringify({ sha, gates }))
      if (gates.some((gate) => gate.status === "completed" && gate.conclusion !== "success")) throw new Error("Exact-main CI failed; npm publication refused")
      if (gates.every((gate) => gate.status === "completed" && gate.conclusion === "success")) return
      await delay(15000)
    }
    throw new Error("Timed out waiting for exact-main CI")
  }
  if (mode === "decide") {
    // Wait only for an absent, concurrently publishing companion. A different
    // immutable source or an actual registry error fails immediately.
    const goal = await waitForPublishedGoal(request.goal)
    const exact = await fetch(base + "/" + request.version, { signal: AbortSignal.timeout(20000) })
    const existing = exact.ok ? await exact.json() : null
    const latest = exact.status === 404 ? await json(base + "/latest") : null
    const publish = releaseDecision(exact.status, existing, request, sha, latest?.version)
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
    console.log(JSON.stringify({ publish, loop: request.version, goal: goal.version, goalSHA: goal.gitHead }))
    return
  }
  if (mode === "verify") {
    const exact = await json(base + "/" + request.version)
    const latest = await json(base + "/latest")
    assertPublishedSource(exact, pkg.name, request.version, sha)
    assert.equal(latest.version, request.version, "latest must resolve to this release")
    assert.deepEqual(exact.exports, pkg.exports)
    for (const [name, file] of Object.entries(pkg.bin)) assert.equal(exact.bin?.[name]?.replace(/^\.\//, ""), file.replace(/^\.\//, ""))
    assert.ok(exact.dist?.integrity)
    console.log("REGISTRY_VERIFIED " + JSON.stringify({ name: exact.name, version: exact.version, gitHead: exact.gitHead, integrity: exact.dist.integrity, latest: latest.version, bin: exact.bin }))
    return
  }
  throw new Error("Expected validate, ci, decide or verify")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
