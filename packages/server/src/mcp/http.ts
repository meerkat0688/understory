import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import express from "express";
import type { KnowledgeBase } from "@understory/core";
import { buildMcpServer } from "./server.js";
import crypto from "node:crypto";
import { withLlmSlot } from "../llm-control.js";

/**
 * MCP streamable-HTTP at /mcp. Stateless: a fresh McpServer + transport per
 * request (no session store) — the KB itself serializes mutations. Express
 * hands the SDK transport the raw Node req/res directly, so there is no
 * hijack/lifecycle glue and CORS is handled by the app-level cors() middleware.
 */
export function mcpRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  const handle = async (req: Request, res: Response) => {
    const identity = crypto.createHash("sha256").update(req.get("authorization") || req.ip || "unknown").digest("hex");
    const server = await buildMcpServer(kb, (fn) => withLlmSlot(identity, fn));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // one JSON reply per request — no long-lived SSE
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    // express.json() already parsed the body; pass it so the transport doesn't
    // try to re-read the consumed stream.
    await transport.handleRequest(req, res, req.body);
  };

  router.post("/", handle);
  router.get("/", handle);
  router.delete("/", handle);
  return router;
}
