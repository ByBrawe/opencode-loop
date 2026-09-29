import path from 'node:path'

// The plugin location is not evidence about an arbitrary session.
// Resolve through the host before using the instance's local files.
export function createNativeSessionLocationGuard({ directory, workspaceID, getSession }) {
  const expected = path.resolve(directory)
  return async (sessionID) => {
    if (typeof sessionID !== 'string' || !sessionID || typeof getSession !== 'function') return false
    try {
      const session = await getSession({ sessionID })
      if (session?.id !== sessionID || typeof session.location?.directory !== 'string' || !path.isAbsolute(session.location.directory)) return false
      if (path.relative(expected, path.resolve(session.location.directory)) !== '') return false
      return (session.location.workspaceID ?? '') === (workspaceID ?? '')
    } catch { return false }
  }
}
