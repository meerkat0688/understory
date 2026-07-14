import type { UIMessage } from "ai";

export interface ChatLimits {
  contextWindowTokens: number;
  contextSafetyTokens: number;
  historyMaxTokens: number;
  importModeThresholdTokens: number;
  maxRequestBytes: number;
}

export interface PreparedChatMessages {
  messages: UIMessage[];
  removedMessages: number;
  importMode: boolean;
  estimatedTokens: number;
}

export const DEFAULT_CHAT_LIMITS: ChatLimits = {
  contextWindowTokens: 1_000_000,
  contextSafetyTokens: 100_000,
  historyMaxTokens: 50_000,
  importModeThresholdTokens: 100_000,
  maxRequestBytes: 16 * 1024 * 1024,
};

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(utf8Bytes(value) / 3);
}

function turnsBefore(messages: UIMessage[], latestUserIndex: number): UIMessage[][] {
  const turns: UIMessage[][] = [];
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

function findLatestUserIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export function prepareChatMessages(
  messages: UIMessage[],
  limits: ChatLimits
): PreparedChatMessages {
  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex < 0) throw new Error("A chat request needs a user message.");

  const availableInputTokens = limits.contextWindowTokens - limits.contextSafetyTokens;
  if (availableInputTokens <= 0) {
    throw new Error("The configured context reserve leaves no room for input.");
  }

  const currentTurn = messages.slice(latestUserIndex);
  const currentTokens = estimatedTokens(currentTurn);
  if (currentTokens > availableInputTokens) {
    throw new Error(
      `The newest message needs about ${currentTokens.toLocaleString()} tokens, ` +
        `above the safe input limit of ${availableInputTokens.toLocaleString()}.`
    );
  }

  const importMode = currentTokens >= limits.importModeThresholdTokens;
  const selectedTurns: UIMessage[][] = [];
  let historyTokens = 0;
  if (!importMode) {
    const historyBudget = Math.min(
      limits.historyMaxTokens,
      availableInputTokens - currentTokens
    );
    const previousTurns = turnsBefore(messages, latestUserIndex);
    for (let i = previousTurns.length - 1; i >= 0; i -= 1) {
      const turn = previousTurns[i];
      const turnTokens = estimatedTokens(turn);
      if (historyTokens + turnTokens > historyBudget) break;
      selectedTurns.unshift(turn);
      historyTokens += turnTokens;
    }
  }

  const selected = [...selectedTurns.flat(), ...currentTurn];
  return {
    messages: selected,
    removedMessages: messages.length - selected.length,
    importMode,
    estimatedTokens: currentTokens + historyTokens,
  };
}
