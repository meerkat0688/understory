import type { ModelMessage } from "ai";

export interface ChatHistoryConfig {
  contextWindowTokens: number;
  contextSafetyTokens: number;
  historyMaxTokens: number;
  importModeThresholdTokens: number;
  maxRequestBytes: number;
}

export interface TrimmedChatHistory {
  messages: ModelMessage[];
  removedMessages: number;
  estimatedTokens: number;
  importMode: boolean;
}

export const DEFAULT_CHAT_HISTORY_CONFIG: ChatHistoryConfig = {
  contextWindowTokens: 1_000_000,
  contextSafetyTokens: 100_000,
  historyMaxTokens: 50_000,
  importModeThresholdTokens: 100_000,
  maxRequestBytes: 16 * 1024 * 1024,
};

export class ChatHistoryError extends Error {
  readonly code = "CONTEXT_LIMIT_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "ChatHistoryError";
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadChatHistoryConfig(
  env: NodeJS.ProcessEnv = process.env
): ChatHistoryConfig {
  return {
    contextWindowTokens: positiveInteger(
      env.CHAT_CONTEXT_WINDOW_TOKENS,
      DEFAULT_CHAT_HISTORY_CONFIG.contextWindowTokens
    ),
    contextSafetyTokens: positiveInteger(
      env.CHAT_CONTEXT_SAFETY_TOKENS,
      DEFAULT_CHAT_HISTORY_CONFIG.contextSafetyTokens
    ),
    historyMaxTokens: positiveInteger(
      env.CHAT_HISTORY_MAX_TOKENS,
      DEFAULT_CHAT_HISTORY_CONFIG.historyMaxTokens
    ),
    importModeThresholdTokens: positiveInteger(
      env.CHAT_IMPORT_MODE_THRESHOLD_TOKENS,
      DEFAULT_CHAT_HISTORY_CONFIG.importModeThresholdTokens
    ),
    maxRequestBytes: positiveInteger(
      env.CHAT_MAX_REQUEST_BYTES,
      DEFAULT_CHAT_HISTORY_CONFIG.maxRequestBytes
    ),
  };
}

/**
 * Conservative approximation that works reasonably for both Latin text and CJK:
 * English commonly uses ~4 UTF-8 bytes/token while CJK is closer to 3.
 */
export function estimateChatTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
}

function turnsBefore(messages: ModelMessage[], latestUserIndex: number): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  let start = 0;
  for (let i = 1; i <= latestUserIndex; i += 1) {
    if (messages[i].role === "user") {
      turns.push(messages.slice(start, i));
      start = i;
    }
  }
  if (start < latestUserIndex) turns.push(messages.slice(start, latestUserIndex));
  return turns.filter((turn) => turn.length > 0);
}

function findLatestUserIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Preserve the newest user turn in full, then spend only the history budget on
 * complete recent turns. A large import gets the context to itself.
 */
export function trimModelMessages(
  messages: ModelMessage[],
  config: ChatHistoryConfig = DEFAULT_CHAT_HISTORY_CONFIG
): TrimmedChatHistory {
  if (messages.length === 0) {
    throw new ChatHistoryError("Chat request must contain at least one message.");
  }

  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex < 0) {
    throw new ChatHistoryError("Chat request must contain a user message.");
  }

  const availableInputTokens = config.contextWindowTokens - config.contextSafetyTokens;
  if (availableInputTokens <= 0) {
    throw new ChatHistoryError("Chat context safety reserve leaves no room for input.");
  }

  // Usually this is exactly the latest user message. Keeping the suffix also
  // makes retries safe if a client includes already-completed assistant parts.
  const currentTurn = messages.slice(latestUserIndex);
  const currentTurnTokens = estimateChatTokens(currentTurn);
  if (currentTurnTokens > availableInputTokens) {
    throw new ChatHistoryError(
      `The newest message needs about ${currentTurnTokens.toLocaleString()} tokens, ` +
        `above the safe input limit of ${availableInputTokens.toLocaleString()}.`
    );
  }

  const importMode = currentTurnTokens >= config.importModeThresholdTokens;
  const selectedTurns: ModelMessage[][] = [];
  let historyTokens = 0;

  if (!importMode) {
    const historyBudget = Math.min(
      config.historyMaxTokens,
      availableInputTokens - currentTurnTokens
    );
    const previousTurns = turnsBefore(messages, latestUserIndex);
    for (let i = previousTurns.length - 1; i >= 0; i -= 1) {
      const turn = previousTurns[i];
      const turnTokens = estimateChatTokens(turn);
      if (historyTokens + turnTokens > historyBudget) break;
      selectedTurns.unshift(turn);
      historyTokens += turnTokens;
    }
  }

  const selected = [...selectedTurns.flat(), ...currentTurn];
  return {
    messages: selected,
    removedMessages: messages.length - selected.length,
    estimatedTokens: historyTokens + currentTurnTokens,
    importMode,
  };
}
