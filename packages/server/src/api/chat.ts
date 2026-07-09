import type { FastifyInstance } from "fastify";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type KnowledgeBase, type ProviderName } from "@okf-agent/core";

interface ChatBody {
  messages: UIMessage[];
  provider?: ProviderName;
  model?: string;
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function registerChatRoute(app: FastifyInstance, kb: KnowledgeBase): void {
  app.post<{ Body: ChatBody }>("/api/chat", async (request, reply) => {
    const { messages, provider, model } = request.body;
    const { result } = await streamChat(kb, convertToModelMessages(messages), {
      provider,
      model,
    });
    reply.hijack();
    const response = result.toUIMessageStreamResponse();
    // Bridge the Fetch Response to Fastify's raw Node response.
    reply.raw.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries())
    );
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        reply.raw.write(chunk);
      }
    }
    reply.raw.end();
  });
}
