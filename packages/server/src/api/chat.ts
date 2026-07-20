import express, { type Router } from "express";
import { convertToModelMessages, safeValidateUIMessages, type UIMessage } from "ai";
import {
  ChatHistoryError,
  estimateCostUsd,
  extractOpenRouterCostUsd,
  formatUnknownError,
  isContentFilterError,
  loadChatHistoryConfig,
  loadLlmPricing,
  streamChat,
  trimModelMessages,
  type KnowledgeBase,
} from "@understory/core";

interface ChatBody {
  messages: UIMessage[];
  model?: string;
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();
  const historyConfig = loadChatHistoryConfig();
  const pricing = loadLlmPricing();

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

      const { model } = req.body as ChatBody;
      try {
        const converted = await convertToModelMessages(validation.data);
        const trimmed = trimModelMessages(converted, historyConfig);
        const { result } = await streamChat(kb, trimmed.messages, { model });
        // OpenRouter bills per model step; sum costs across tool-loop steps.
        let providerCostUsd = 0;
        let sawProviderCost = false;
        const response = result.toUIMessageStreamResponse({
          onError: (error) => publicStreamError(error),
          messageMetadata: ({ part }) => {
            if (part.type === "finish-step") {
              const stepCost = extractOpenRouterCostUsd(
                part.providerMetadata as Record<string, unknown> | undefined
              );
              if (stepCost != null) {
                providerCostUsd += stepCost;
                sawProviderCost = true;
              }
              return undefined;
            }
            if (part.type !== "finish") return undefined;
            const usage = {
              inputTokens: part.totalUsage.inputTokens,
              outputTokens: part.totalUsage.outputTokens,
              totalTokens: part.totalUsage.totalTokens,
            };
            if (sawProviderCost) {
              return {
                usage,
                estimatedCostUsd: providerCostUsd,
                costSource: "provider" as const,
              };
            }
            const estimated = estimateCostUsd(usage, pricing);
            return {
              usage,
              estimatedCostUsd: estimated,
              costSource: estimated != null ? ("estimate" as const) : null,
            };
          },
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
  const message = formatUnknownError(error);
  console.error(`[understory] chat stream failed: ${message}`);

  if (/context|token|too long|maximum length/i.test(message)) {
    return "The model rejected this request because it exceeded its context limit.";
  }
  if (isContentFilterError(error)) {
    return (
      "The upstream model provider blocked this response as inappropriate content. " +
      "Try a different model, or rephrase and retry."
    );
  }
  return "The model provider could not complete this request.";
}
