import {
  activeRunCompletionFromMessages,
  compactSession,
  executeTuiCommand,
  log,
  readRecentSessionMessages,
  resolveCompactionModel,
  toast,
} from "./host.js"

export function createOpenCodeHostAdapter(client, directory) {
  return Object.freeze({
    executeTuiCommand: (command) => executeTuiCommand(client, command),
    readRecentMessages: (sessionID, limit = 12) => readRecentSessionMessages(client, sessionID, directory, limit),
    activeRunCompletion: (sessionID, active) => activeRunCompletionFromMessages(directory, client, sessionID, active),
    resolveCompactionModel: (sessionID, preferredModel) => resolveCompactionModel(directory, client, sessionID, preferredModel),
    compactSession: (sessionID, preferredModel) => compactSession(directory, client, sessionID, preferredModel),
    log: (level, message, extra) => log(client, level, message, extra),
    toast: (message, variant) => toast(client, message, variant),
  })
}
