// OpenCode SDK compatibility helpers.
export function sdkError(result) {
  if (!result || typeof result !== "object") return undefined
  return result.error || result.error === null ? result.error : undefined
}

export function sdkData(result) {
  if (!result || typeof result !== "object") return result
  return Object.prototype.hasOwnProperty.call(result, "data") ? result.data : result
}

export function sdkErrorMessage(error) {
  if (!error) return "unknown SDK error"
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object") {
    if (typeof error.message === "string") return error.message
    if (typeof error.name === "string") return error.name
    try { return JSON.stringify(error).slice(0, 400) } catch {}
  }
  return String(error)
}

export async function sdkCall(method, ...argsList) {
  let firstError
  for (const args of argsList) {
    if (args === undefined) continue
    try {
      const result = await method(args)
      const error = sdkError(result)
      if (!error) return sdkData(result)
      firstError = firstError || new Error(sdkErrorMessage(error))
    } catch (error) {
      firstError = firstError || error
    }
  }
  throw firstError || new Error("SDK call failed without arguments")
}
