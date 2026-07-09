import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { KnowledgeBase } from "@okf-agent/core";
import { registerMcpHttp } from "./mcp/http.js";
import { registerBrowseRoutes } from "./api/browse.js";
import { registerChatRoute } from "./api/chat.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

registerBrowseRoutes(app, kb);
registerChatRoute(app, kb);
registerMcpHttp(app, kb);

// Serve the built web UI in production (single container).
const webDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist"
);
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api") || request.url.startsWith("/mcp")) {
      return reply.status(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html"); // SPA fallback
  });
}

const port = Number(process.env.PORT ?? 3800);
await app.listen({ port, host: "0.0.0.0" });
console.log(`okf-agent serving bundle ${bundleRoot} on :${port} (web + /api + /mcp)`);
