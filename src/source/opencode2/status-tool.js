import { readState } from "../core/state.js"

const EMPTY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
})

function sessionInfo(value) {
  return value?.data ?? value
}

async function sessionDirectory(ctx, sessionID) {
  if (typeof ctx?.session?.get !== "function") throw new Error("OpenCode 2 session.get capability is unavailable")
  const session = sessionInfo(await ctx.session.get({ sessionID }))
  const directory = session?.location?.directory ?? session?.directory
  if (!directory) throw new Error(`OpenCode 2 session ${sessionID} has no directory`)
  return String(directory)
}

function jobStatus(job) {
  return Object.freeze({
    id: job?.id,
    name: job?.name,
    kind: job?.kind,
    paused: job?.paused === true,
    runCount: Number(job?.runCount) || 0,
    intervalMs: Number(job?.intervalMs) || 0,
    nextRunAt: job?.nextRunAt,
    lastFinishedAt: job?.lastFinishedAt,
    lastFailureReason: job?.lastFailureReason,
  })
}

export function summarizeOpenCode2LoopState(state) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs.map(jobStatus) : []
  return Object.freeze({
    version: Number(state?.version) || 4,
    jobCount: jobs.length,
    jobs: Object.freeze(jobs),
  })
}

export function formatOpenCode2LoopStatus(summary) {
  if (!summary?.jobCount) return "OpenCode Loop: no loop jobs for this session."
  const rows = summary.jobs.map((job) => {
    const label = job.name || job.id || "unnamed"
    const state = job.paused ? "paused" : "active"
    return `- ${label}: ${state}, runs=${job.runCount}, intervalMs=${job.intervalMs}`
  })
  return [`OpenCode Loop: ${summary.jobCount} loop job(s).`, ...rows].join("\n")
}

export function createOpenCode2StatusTool(ctx) {
  return Object.freeze({
    name: "opencode_loop_status",
    input: EMPTY_INPUT_SCHEMA,
    description: "Read the persisted OpenCode Loop status for the current session without changing Loop state.",
    async execute(_input, context) {
      const sessionID = String(context?.sessionID || "").trim()
      if (!sessionID) throw new Error("OpenCode Loop status requires a session ID")
      const directory = await sessionDirectory(ctx, sessionID)
      const summary = summarizeOpenCode2LoopState(await readState(directory, sessionID))
      return {
        content: formatOpenCode2LoopStatus(summary),
        metadata: {
          sessionID,
          directory,
          jobCount: summary.jobCount,
        },
      }
    },
  })
}

export async function registerOpenCode2StatusTool(ctx) {
  if (typeof ctx?.tool?.transform !== "function") return undefined
  const tool = createOpenCode2StatusTool(ctx)
  return await ctx.tool.transform((draft) => {
    if (typeof draft?.add !== "function") throw new Error("OpenCode 2 tool draft.add capability is unavailable")
    draft.add(tool)
  })
}
