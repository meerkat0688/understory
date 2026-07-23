export { runQuery, runMutation, streamChat, buildPromptContext } from "./agent.js";
export type { AgentOptions, QueryResult, MutationResult, MutationOutcome } from "./agent.js";
export { buildSystemPrompt } from "./system-prompt.js";
export { buildReadTools, buildWriteTools, formatTree } from "./tools.js";
export { TraceRecorder, TraceStore, buildNotation } from "./trace.js";
export type { QueryTrace, TraceStep, TraceOutcome } from "./trace.js";
export {
  ChatHistoryError,
  DEFAULT_CHAT_HISTORY_CONFIG,
  estimateChatTokens,
  loadChatHistoryConfig,
  trimModelMessages,
} from "./chat-history.js";
export type { ChatHistoryConfig, TrimmedChatHistory } from "./chat-history.js";
