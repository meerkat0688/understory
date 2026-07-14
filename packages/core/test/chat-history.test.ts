import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  ChatHistoryError,
  DEFAULT_CHAT_HISTORY_CONFIG,
  estimateChatTokens,
  trimModelMessages,
} from "../src/agent/chat-history.js";

const smallConfig = {
  ...DEFAULT_CHAT_HISTORY_CONFIG,
  contextWindowTokens: 1_000,
  contextSafetyTokens: 100,
  historyMaxTokens: 80,
  importModeThresholdTokens: 300,
};

describe("trimModelMessages", () => {
  it("keeps a short conversation intact", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "done" },
      { role: "user", content: "and beta" },
    ];

    const result = trimModelMessages(messages, smallConfig);
    expect(result.messages).toEqual(messages);
    expect(result.removedMessages).toBe(0);
    expect(result.importMode).toBe(false);
  });

  it("drops oldest complete turns without separating tool results", () => {
    const toolTurn: ModelMessage[] = [
      { role: "user", content: "x".repeat(90) },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "memory_query",
            input: { query: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "memory_query",
            output: { type: "text", value: "y".repeat(90) },
          },
        ],
      },
      { role: "assistant", content: "finished" },
    ];
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      ...toolTurn,
      { role: "user", content: "new request" },
    ];

    const result = trimModelMessages(messages, smallConfig);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.removedMessages).toBeGreaterThan(0);
  });

  it("uses import mode and gives a large newest message all available history space", () => {
    const large = "知識".repeat(600);
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: large },
    ];
    const config = { ...smallConfig, contextWindowTokens: 2_000 };

    const result = trimModelMessages(messages, config);
    expect(result.importMode).toBe(true);
    expect(result.messages).toEqual([messages[2]]);
  });

  it("rejects a newest message that cannot fit instead of truncating it", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "知".repeat(2_000) }];
    expect(() => trimModelMessages(messages, smallConfig)).toThrow(ChatHistoryError);
  });

  it("estimates CJK conservatively from UTF-8 bytes", () => {
    expect(estimateChatTokens("知".repeat(100))).toBeGreaterThanOrEqual(100);
  });
});
