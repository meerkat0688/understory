import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { KnowledgeBase } from "@okf-agent/core";
import { buildMcpServer } from "./server.js";

/**
 * Mount MCP streamable-HTTP at /mcp. Stateless mode: a fresh transport per
 * request (no session store) — simple and horizontally safe; the KB itself
 * serializes mutations.
 */
export function registerMcpHttp(app: FastifyInstance, kb: KnowledgeBase): void {
  app.route({
    method: ["POST", "GET", "DELETE"],
    url: "/mcp",
    config: {
      // Raw body handling is done by the MCP transport.
    },
    handler: async (request, reply) => {
      const server = buildMcpServer(kb);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      reply.hijack();
      request.raw.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
