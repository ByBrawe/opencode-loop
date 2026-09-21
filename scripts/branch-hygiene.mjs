#!/usr/bin/env node
import { appendFile } from "node:fs/promises"
import process from "node:process"

function sameRepositoryHead(pull, repository) {
  return pull?.head?.repo?.full_name === repository
}

function encodeRef(name) {
  return String(name || "").split("/").map(encodeURIComponent).join("/")
}

function validSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ""))
}

export function planBranchCleanup({ repository, defaultBranch, branches, openPulls, closedPulls }) {
  const openHeads = new Set(
    openPulls
      .filter((pull) => sameRepositoryHead(pull, repository))
      .map((pull) => String(pull?.head?.ref || "").trim())
      .filter(Boolean),
  )

  const mergedHeads = new Map()
  for (const pull of closedPulls) {
    if (!pull?.merged_at || !sameRepositoryHead(pull, repository)) continue
    const name = String(pull?.head?.ref || "").trim()
    const sha = String(pull?.head?.sha || "").trim()
    if (!name || !sha) continue
    const values = mergedHeads.get(name) || []
    values.push({ sha, number: pull.number })
    mergedHeads.set(name, values)
  }

  const candidates = []
  const retained = []
  for (const branch of branches) {
    const name = String(branch?.name || "").trim()
    const sha = String(branch?.commit?.sha || "").trim()
    if (!name || !sha) continue
    if (name === defaultBranch) {
      retained.push({ name, reason: "default" })
      continue
    }
    if (branch?.protected === true) {
      retained.push({ name, reason: "protected" })
      continue
    }
    if (openHeads.has(name)) {
      retained.push({ name, reason: "open-pr" })
      continue
    }

    const merged = (mergedHeads.get(name) || []).find((entry) => entry.sha === sha)
    if (!merged) {
      retained.push({ name, reason: "no-exact-merged-head" })
      continue
    }
    candidates.push({ name, sha, pull: merged.number, source: "merged-pr" })
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name))
  retained.sort((a, b) => a.name.localeCompare(b.name))
  return { candidates, retained }
}

export function planArchivedCleanup({
  repository,
  defaultBranch,
  archiveRef,
  manifest,
  branches,
  openPulls,
}) {
  if (!manifest || typeof manifest !== "object") throw new Error("archive manifest must be an object")
  if (manifest.repository !== repository) throw new Error(`archive manifest repository mismatch: ${manifest.repository}`)
  if (manifest.archiveBranch !== archiveRef) throw new Error(`archive manifest branch mismatch: ${manifest.archiveBranch}`)
  if (!Array.isArray(manifest.archivedBranches)) throw new Error("archive manifest archivedBranches must be an array")

  const branchByName = new Map(
    branches
      .map((branch) => [String(branch?.name || "").trim(), branch])
      .filter(([name]) => Boolean(name)),
  )
  const openHeads = new Set(
    openPulls
      .filter((pull) => sameRepositoryHead(pull, repository))
      .map((pull) => String(pull?.head?.ref || "").trim())
      .filter(Boolean),
  )

  const seenNames = new Set()
  const candidates = []
  const retained = []

  for (const entry of manifest.archivedBranches) {
    const name = String(entry?.name || "").trim()
    const sha = String(entry?.sha || "").trim()
    if (!name || !validSha(sha)) throw new Error(`invalid archived branch entry: ${JSON.stringify(entry)}`)
    if (seenNames.has(name)) throw new Error(`duplicate archived branch entry: ${name}`)
    seenNames.add(name)

    if (name === defaultBranch || name === archiveRef) {
      retained.push({ name, reason: "reserved" })
      continue
    }

    const branch = branchByName.get(name)
    if (!branch) {
      retained.push({ name, reason: "already-absent" })
      continue
    }
    if (branch?.protected === true) {
      retained.push({ name, reason: "protected" })
      continue
    }
    if (openHeads.has(name)) {
      retained.push({ name, reason: "open-pr" })
      continue
    }

    const currentSha = String(branch?.commit?.sha || "").trim()
    if (currentSha !== sha) {
      retained.push({ name, reason: "head-changed", expectedSha: sha, currentSha })
      continue
    }

    candidates.push({ name, sha, source: "archive-manifest" })
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name))
  retained.sort((a, b) => a.name.localeCompare(b.name))
  return { candidates, retained }
}

async function request({ api, token }, method, pathname) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opencode-branch-hygiene",
    },
  })
  if (response.status === 204) return undefined
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${raw.slice(0, 1000)}`)
  }
  return raw ? JSON.parse(raw) : undefined
}

async function paginate(client, pathname, query = {}) {
  const values = []
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
      per_page: "100",
      page: String(page),
    })
    const batch = await request(client, "GET", `${pathname}?${params}`)
    if (!Array.isArray(batch)) throw new Error(`Expected an array from ${pathname}`)
    values.push(...batch)
    if (batch.length < 100) return values
  }
  throw new Error(`Pagination safety limit exceeded for ${pathname}`)
}

async function loadArchive(client, root, repository, archiveRef) {
  if (!archiveRef) return null

  const archivePath = "archive/legacy-branches-2026-09-21.json"
  const encodedRef = encodeURIComponent(archiveRef)
  const payload = await request(client, "GET", `${root}/contents/${archivePath}?ref=${encodedRef}`)
  if (payload?.encoding !== "base64" || typeof payload?.content !== "string") {
    throw new Error("archive manifest content is not base64")
  }

  const raw = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8")
  const manifest = JSON.parse(raw)
  if (manifest.repository !== repository) throw new Error("archive manifest repository does not match current repository")
  if (manifest.archiveBranch !== archiveRef) throw new Error("archive manifest archiveBranch does not match configured ref")

  const ref = await request(client, "GET", `${root}/git/ref/heads/${encodeRef(archiveRef)}`)
  const archiveSha = String(ref?.object?.sha || "").trim()
  if (!validSha(archiveSha)) throw new Error("archive branch did not resolve to a commit SHA")

  return { manifest, archiveSha, archivePath }
}

async function verifyArchivedReachability(client, root, archiveSha, items) {
  const verified = []
  for (const item of items) {
    const compare = await request(client, "GET", `${root}/compare/${item.sha}...${archiveSha}`)
    if (!["ahead", "identical"].includes(compare?.status)) {
      throw new Error(`archive ref does not retain ${item.name} @ ${item.sha}; compare status=${compare?.status || "unknown"}`)
    }
    verified.push(item)
  }
  return verified
}

async function deleteCandidates(client, root, items, dryRun, label) {
  const deleted = []
  const skipped = []
  const failures = []

  for (const item of items) {
    console.log(`${dryRun ? "DRY-RUN" : "DELETE"} [${label}] ${item.name} @ ${item.sha}`)
    if (dryRun) continue

    try {
      const encodedRef = encodeRef(item.name)
      const refPath = `${root}/git/ref/heads/${encodedRef}`
      const current = await request(client, "GET", refPath)
      const currentSha = String(current?.object?.sha || "").trim()
      if (currentSha !== item.sha) {
        console.log(`SKIP [${label}] ${item.name}: head changed from ${item.sha} to ${currentSha || "unknown"}`)
        skipped.push({ ...item, reason: "head-changed-at-delete", currentSha })
        continue
      }
      await request(client, "DELETE", `${root}/git/refs/heads/${encodedRef}`)
      deleted.push(item)
    } catch (error) {
      failures.push({ item, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { deleted, skipped, failures }
}

function countReasons(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.reason))]
      .sort()
      .map((reason) => [reason, items.filter((item) => item.reason === reason).length]),
  )
}

async function main() {
  const repository = String(process.env.GITHUB_REPOSITORY || "").trim()
  const token = String(process.env.GITHUB_TOKEN || "").trim()
  const api = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "")
  const defaultBranch = String(process.env.BRANCH_HYGIENE_DEFAULT_BRANCH || "main").trim()
  const archiveRef = String(process.env.BRANCH_HYGIENE_ARCHIVE_REF || "").trim()
  const dryRun = process.env.BRANCH_HYGIENE_DRY_RUN === "1"

  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name")
  if (!token) throw new Error("GITHUB_TOKEN is required")
  if (!defaultBranch) throw new Error("default branch is required")

  const client = { api, token }
  const root = `/repos/${repository}`
  const [branches, openPulls, closedPulls] = await Promise.all([
    paginate(client, `${root}/branches`),
    paginate(client, `${root}/pulls`, { state: "open" }),
    paginate(client, `${root}/pulls`, { state: "closed" }),
  ])

  const mergedPlan = planBranchCleanup({
    repository,
    defaultBranch,
    branches,
    openPulls,
    closedPulls,
  })

  let archivePlan = { candidates: [], retained: [] }
  let archiveSha = ""
  if (archiveRef) {
    const archive = await loadArchive(client, root, repository, archiveRef)
    archiveSha = archive.archiveSha
    archivePlan = planArchivedCleanup({
      repository,
      defaultBranch,
      archiveRef,
      manifest: archive.manifest,
      branches,
      openPulls,
    })
    await verifyArchivedReachability(client, root, archiveSha, archivePlan.candidates)
  }

  const mergedResult = await deleteCandidates(client, root, mergedPlan.candidates, dryRun, "merged-pr")

  const mergedNames = new Set(mergedPlan.candidates.map((item) => item.name))
  const archiveCandidates = archivePlan.candidates.filter((item) => !mergedNames.has(item.name))
  const archiveResult = await deleteCandidates(client, root, archiveCandidates, dryRun, "archive")

  const failures = [...mergedResult.failures, ...archiveResult.failures]
  const summary = [
    "## Branch hygiene",
    "",
    `- Repository: \`${repository}\``,
    `- Default branch: \`${defaultBranch}\``,
    `- Branches scanned: ${branches.length}`,
    `- Exact merged-head candidates: ${mergedPlan.candidates.length}`,
    `- Archived inactive candidates: ${archiveCandidates.length}`,
    `- Archive ref: \`${archiveRef || "disabled"}\``,
    `- Archive SHA: \`${archiveSha || "n/a"}\``,
    `- Deleted: ${dryRun ? 0 : mergedResult.deleted.length + archiveResult.deleted.length}`,
    `- Dry run: ${dryRun}`,
    `- Retained merged-plan reasons: \`${JSON.stringify(countReasons(mergedPlan.retained))}\``,
    `- Retained archive-plan reasons: \`${JSON.stringify(countReasons(archivePlan.retained))}\``,
    "",
    "Safety rules: merged branches require an exact merged-PR head SHA. Archived branches additionally require an unchanged current SHA, no open PR, and proof that the archived tip is an ancestor of the configured archive ref before deletion.",
  ].join("\n")

  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8")
  console.log(summary)

  if (failures.length) {
    for (const failure of failures) console.error(`FAILED ${failure.item.name}: ${failure.error}`)
    throw new Error(`Failed to delete ${failures.length} eligible branch(es)`)
  }
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll("\\", "/"))
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
