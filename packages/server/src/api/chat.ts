import express, { type Router } from "express";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type KnowledgeBase, type ProviderName } from "@understory/core";
import { z } from "zod";
import { acquireLlmSlot } from "../llm-control.js";

const textPart = z.object({ type: z.literal("text"), text: z.string().max(16_000) }).strict();
const messageSchema = z.object({
  id: z.string().max(200).optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(textPart).max(20),
}).strict();
const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(50),
  provider: z.enum(["anthropic", "openrouter", "llamacpp", "local"]).optional(),
}).strict().superRefine((body, ctx) => {
  const total = body.messages.flatMap((m) => m.parts).reduce((n, p) => n + p.text.length, 0);
  if (total > 64_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "aggregate message text is too large" });
});

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { messages, provider } = parsed.data;
    const client = req.get("authorization") || req.ip || "unknown";
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    let release: () => void;
    try {
      release = await acquireLlmSlot(client);
    } catch {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "llm_queue_full" });
      return;
    }
    try {
      const { result } = await streamChat(kb, convertToModelMessages(messages as UIMessage[]), {
        provider: provider as ProviderName,
        abortSignal: controller.signal,
      });
      const response = result.toUIMessageStreamResponse();
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
      }
      res.end();
    } finally {
      release();
    }
  });

  return router;
}
