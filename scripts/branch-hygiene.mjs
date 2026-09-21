#!/usr/bin/env node
import { appendFile } from "node:fs/promises"
import process from "node:process"

function sameRepositoryHead(pull, repository) {
  return pull?.head?.repo?.full_name === repository
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
    candidates.push({ name, sha, pull: merged.number })
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

async function main() {
  const repository = String(process.env.GITHUB_REPOSITORY || "").trim()
  const token = String(process.env.GITHUB_TOKEN || "").trim()
  const api = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "")
  const defaultBranch = String(process.env.BRANCH_HYGIENE_DEFAULT_BRANCH || "main").trim()
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

  const { candidates, retained } = planBranchCleanup({
    repository,
    defaultBranch,
    branches,
    openPulls,
    closedPulls,
  })

  console.log(`Branch hygiene: ${branches.length} branches, ${candidates.length} exact merged-head candidates, ${retained.length} retained.`)
  for (const item of candidates) {
    console.log(`${dryRun ? "DRY-RUN" : "DELETE"} ${item.name} @ ${item.sha} (merged PR #${item.pull})`)
  }

  const deleted = []
  const failures = []
  if (!dryRun) {
    for (const item of candidates) {
      try {
        const encodedRef = item.name.split("/").map(encodeURIComponent).join("/")
        const refPath = `${root}/git/ref/heads/${encodedRef}`
        const current = await request(client, "GET", refPath)
        const currentSha = String(current?.object?.sha || "").trim()
        if (currentSha !== item.sha) {
          console.log(`SKIP ${item.name}: head changed from ${item.sha} to ${currentSha || "unknown"}`)
          continue
        }
        await request(client, "DELETE", `${root}/git/refs/heads/${encodedRef}`)
        deleted.push(item)
      } catch (error) {
        failures.push({ item, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const retainedCounts = Object.fromEntries(
    [...new Set(retained.map((item) => item.reason))]
      .sort()
      .map((reason) => [reason, retained.filter((item) => item.reason === reason).length]),
  )

  const summary = [
    "## Branch hygiene",
    "",
    `- Repository: \`${repository}\``,
    `- Default branch: \`${defaultBranch}\``,
    `- Branches scanned: ${branches.length}`,
    `- Exact merged-head candidates: ${candidates.length}`,
    `- Deleted: ${dryRun ? 0 : deleted.length}`,
    `- Dry run: ${dryRun}`,
    `- Retained by reason: \`${JSON.stringify(retainedCounts)}\``,
    "",
    "Safety rule: delete only a non-default, unprotected, same-repository branch with no open PR when a merged PR recorded exactly the branch's current head SHA.",
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
