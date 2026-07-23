import { describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chatRouter } from "../src/api/chat.js";
import type { KnowledgeBase } from "@understory/core";

/** Same mount order as packages/server/src/index.ts for body parsing. */
function createBodyLimitApp() {
  const app = express();
  // Chat never touches kb when message validation fails.
  app.use("/api", chatRouter({} as KnowledgeBase));
  app.use(express.json({ limit: "4mb" }));
  app.post("/mcp", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const details = error as { type?: string; status?: number };
    if (details.type === "entity.too.large" || details.status === 413) {
      res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "The chat request exceeds the configured request-size limit.",
        },
      });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL_ERROR" } });
  });
  return app;
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

/** Just over 4 MB — enough to hit the global cap, far under chat's 16 MB. */
const OVERSIZED_JSON = JSON.stringify({
  messages: "x".repeat(4 * 1024 * 1024 + 64 * 1024),
});

describe("chat vs global JSON body limits", () => {
  it(
    "accepts an oversized POST /api/chat body (chat limit, not global 4 MB)",
    async () => {
      const { server, port } = await listen(createBodyLimitApp());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: OVERSIZED_JSON,
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { code?: string } };
        expect(json.error?.code).toBe("INVALID_CHAT_REQUEST");
      } finally {
        server.close();
      }
    },
    20_000
  );

  it(
    "accepts an oversized POST /api/chat/ body (trailing slash)",
    async () => {
      const { server, port } = await listen(createBodyLimitApp());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: OVERSIZED_JSON,
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { code?: string } };
        expect(json.error?.code).toBe("INVALID_CHAT_REQUEST");
      } finally {
        server.close();
      }
    },
    20_000
  );

  it(
    "rejects an oversized POST /mcp body under the global 4 MB cap",
    async () => {
      const { server, port } = await listen(createBodyLimitApp());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: OVERSIZED_JSON,
        });
        expect(res.status).toBe(413);
        const json = (await res.json()) as { error?: { code?: string } };
        expect(json.error?.code).toBe("PAYLOAD_TOO_LARGE");
      } finally {
        server.close();
      }
    },
    20_000
  );
});
