import express, { type Router } from "express";
import { convertToModelMessages, safeValidateUIMessages, type UIMessage } from "ai";
import {
  ChatHistoryError,
  loadChatHistoryConfig,
  streamChat,
  trimModelMessages,
  type KnowledgeBase,
  type ProviderName,
} from "@understory/core";

interface ChatBody {
  messages: UIMessage[];
  provider?: ProviderName;
  model?: string;
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();
  const historyConfig = loadChatHistoryConfig();

  router.post(
    "/chat",
    express.json({ limit: historyConfig.maxRequestBytes }),
    async (req, res) => {
      const validation = await safeValidateUIMessages<UIMessage>({
        messages: req.body?.messages,
      });
      if (!validation.success) {
        res.status(400).json({
          error: {
            code: "INVALID_CHAT_REQUEST",
            message: "The chat request contains invalid messages.",
          },
        });
        return;
      }

      const { provider, model } = req.body as ChatBody;
      try {
        const converted = await convertToModelMessages(validation.data);
        const trimmed = trimModelMessages(converted, historyConfig);
        const { result } = await streamChat(kb, trimmed.messages, { provider, model });
        const response = result.toUIMessageStreamResponse({
          onError: (error) => publicStreamError(error),
        });
        res.status(response.status);
        res.setHeader("X-Chat-Messages-Trimmed", String(trimmed.removedMessages));
        res.setHeader("X-Chat-Import-Mode", String(trimmed.importMode));
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            res.write(chunk);
          }
        }
        res.end();
      } catch (error) {
        if (error instanceof ChatHistoryError) {
          res.status(413).json({
            error: { code: error.code, message: error.message },
          });
          return;
        }
        throw error;
      }
    }
  );

  return router;
}

function publicStreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/context|token|too long|maximum length/i.test(message)) {
    return "The model rejected this request because it exceeded its context limit.";
  }
  console.error(`[understory] chat stream failed: ${message}`);
  return "The model provider could not complete this request.";
}
