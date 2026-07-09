import type { FastifyInstance } from "fastify";
import { BundleError, type KnowledgeBase } from "@okf-agent/core";
import { availableProviders, loadProviderConfig } from "@okf-agent/core";

/** Deterministic browse API — no LLM involved, browsing never costs tokens. */
export function registerBrowseRoutes(app: FastifyInstance, kb: KnowledgeBase): void {
  app.get("/api/tree", async () => kb.listTree());

  app.get<{ Querystring: { path: string } }>("/api/concept", async (request, reply) => {
    try {
      return await kb.readConcept(request.query.path);
    } catch (err) {
      if (err instanceof BundleError) {
        return reply.status(err.code === "NOT_FOUND" ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { q?: string; type?: string; tag?: string } }>(
    "/api/search",
    async (request) => {
      const { q = "", type, tag } = request.query;
      return kb.search(q, { type, tags: tag ? [tag] : undefined });
    }
  );

  app.get("/api/log", async () => kb.readLog());

  app.get("/api/validate", async () => kb.validate());

  app.get("/api/types", async () => kb.listTypes());

  app.get("/api/config", async () => {
    const config = loadProviderConfig();
    return {
      providers: availableProviders(),
      defaultProvider: config.provider,
      defaultModel: config.model,
    };
  });
}
