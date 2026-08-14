export function openCode2Contract(ctx) {
  return {
    command: typeof ctx?.command?.transform === "function",
    session: typeof ctx?.session?.hook === "function",
    prompt: typeof ctx?.session?.prompt === "function",
    tools: typeof ctx?.tool?.transform === "function",
    toolHooks: typeof ctx?.tool?.hook === "function",
    events: typeof ctx?.event?.subscribe === "function",
  }
}

export function missingOpenCode2Contract(ctx) {
  return Object.entries(openCode2Contract(ctx))
    .filter(([, available]) => !available)
    .map(([name]) => name)
}
