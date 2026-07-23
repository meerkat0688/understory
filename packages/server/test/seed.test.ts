import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@understory/core";
import { buildSeedMemory } from "../src/mcp/seed.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "seed-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept(
    "/tables/a.md",
    { type: "Table", title: "A", description: "Alpha" },
    "body",
    "add"
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildSeedMemory", () => {
  it("does not call listTypes when tree already supplies type metadata", async () => {
    const spy = vi.spyOn(kb, "listTypes");
    const seed = await buildSeedMemory(kb);
    expect(spy).not.toHaveBeenCalled();
    expect(seed).toContain("Table");
    expect(seed).toContain("Alpha");
    spy.mockRestore();
  });
});
