import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KnowledgeBase,
  collectTypesFromTree,
  extractOutboundLinks,
  eachOutboundLink,
} from "../src/okf/index.js";
import { buildPromptContext } from "../src/agent/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-index-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectTypesFromTree (double-scan removal)", () => {
  it("derives types from tree metadata without a second scan", async () => {
    await kb.writeConcept(
      "/tables/a.md",
      { type: "Table", title: "A" },
      "body",
      "add"
    );
    await kb.writeConcept(
      "/playbooks/b.md",
      { type: "Playbook", title: "B" },
      "body",
      "add"
    );
    const tree = await kb.listTree();
    const listTypesSpy = vi.spyOn(kb, "listTypes");
    const derived = collectTypesFromTree(tree);
    expect(derived).toEqual(["Playbook", "Table"]);
    expect(listTypesSpy).not.toHaveBeenCalled();
    listTypesSpy.mockRestore();
  });

  it("buildPromptContext does not call listTypes", async () => {
    await kb.writeConcept("/a.md", { type: "Note", title: "A" }, "body", "add");
    const spy = vi.spyOn(kb, "listTypes");
    const ctx = await buildPromptContext(kb, "query");
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.existingTypes).toEqual(["Note"]);
    expect(ctx.treeSummary).toContain("a.md");
    expect(ctx.treeSummary).toContain("Note");
    spy.mockRestore();
  });
});

describe("outbound link helpers", () => {
  it("extractOutboundLinks dedupes; eachOutboundLink keeps occurrences", () => {
    const body = "See [a](/a.md) and [a again](/a.md) and [self](/me.md).";
    expect(extractOutboundLinks(body, "/me.md")).toEqual(["/a.md"]);
    expect([...eachOutboundLink(body)]).toEqual(["/a.md", "/a.md", "/me.md"]);
  });
});

describe("BundleIndex freshness", () => {
  async function seedLinkedPair() {
    await kb.writeConcept(
      "/a.md",
      { type: "T", title: "Alpha", description: "first" },
      "See [b](/b.md).",
      "a"
    );
    await kb.writeConcept(
      "/b.md",
      { type: "T", title: "Beta", description: "second" },
      "body",
      "b"
    );
    await kb.listTree();
  }

  it("sees external edits on ordinary reads without refresh()", async () => {
    await kb.writeConcept(
      "/note.md",
      { type: "Note", title: "Old" },
      "old body unique-token",
      "add"
    );
    await kb.listTree();
    const v1 = kb.getIndexVersion();

    await fs.writeFile(
      path.join(root, "note.md"),
      `---\ntype: Note\ntitle: New\ndescription: externally edited\n---\n\nnew body fresh-token\n`,
      "utf-8"
    );

    const tree = await kb.listTree();
    const note = tree.children?.find((c) => c.path === "/note.md");
    expect(note?.title).toBe("New");
    expect(note?.description).toBe("externally edited");
    expect(kb.getIndexVersion()).toBeGreaterThan(v1);
  });

  it("external content change is visible to search, validate, lint, and graph", async () => {
    await seedLinkedPair();

    await fs.writeFile(
      path.join(root, "a.md"),
      `---\ntype: T\ntitle: Alpha\ndescription: first\n---\n\nChanged to mention zebra-unique and drop the link.\n`,
      "utf-8"
    );

    const hits = await kb.search("zebra-unique");
    expect(hits.some((h) => h.path === "/a.md")).toBe(true);

    const report = await kb.validate();
    expect(
      report.issues.some((i) => i.path === "/a.md" && i.message.includes("/b.md"))
    ).toBe(false);

    const graph = await kb.graph();
    expect(graph.edges).toEqual([]);

    const lint = await kb.lint();
    // Both concepts are orphans once the a→b edge is gone.
    expect(lint.orphans.map((o) => o.path).sort()).toEqual(["/a.md", "/b.md"]);
  });

  it("sees external add / delete / rename via path inventory", async () => {
    await kb.writeConcept("/keep.md", { type: "T", title: "Keep" }, "x", "add");
    await kb.listTypes();

    await fs.writeFile(
      path.join(root, "added.md"),
      `---\ntype: T\ntitle: Added\n---\n\nbody\n`,
      "utf-8"
    );
    let tree = await kb.listTree();
    expect(tree.children?.some((c) => c.path === "/added.md")).toBe(true);

    await fs.unlink(path.join(root, "keep.md"));
    tree = await kb.listTree();
    expect(tree.children?.some((c) => c.path === "/keep.md")).toBe(false);

    await fs.rename(path.join(root, "added.md"), path.join(root, "renamed.md"));
    tree = await kb.listTree();
    expect(tree.children?.some((c) => c.path === "/added.md")).toBe(false);
    expect(tree.children?.some((c) => c.path === "/renamed.md")).toBe(true);
    expect(await kb.listTypes()).toEqual(["T"]);
  });

  it("same-mtime same-size rewrites are visible on ordinary reconcile via hash", async () => {
    await kb.writeConcept(
      "/same.md",
      { type: "T", title: "AAAA" },
      "body-1",
      "add"
    );
    await kb.listTree();
    const abs = path.join(root, "same.md");
    const st = await fs.stat(abs);

    const raw = await fs.readFile(abs, "utf-8");
    const next = raw.replace("title: AAAA", "title: BBBB");
    expect(Buffer.byteLength(next)).toBe(Buffer.byteLength(raw));
    await fs.writeFile(abs, next, "utf-8");
    await fs.utimes(abs, st.atime, st.mtime);

    const tree = await kb.listTree();
    expect(tree.children?.find((c) => c.path === "/same.md")?.title).toBe("BBBB");
  });

  it("refresh() bumps version even when disk is unchanged", async () => {
    await kb.writeConcept("/x.md", { type: "T", title: "X" }, "body", "add");
    await kb.listTree();
    const before = kb.getIndexVersion();
    await kb.refresh();
    expect(kb.getIndexVersion()).toBe(before + 1);
  });

  it("KB mutations are visible on the next read after the queue drains", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "See [b](/b.md).", "a");
    await kb.writeConcept("/b.md", { type: "T", title: "B" }, "body", "b");
    const graph = await kb.graph();
    expect(graph.edges).toContainEqual({ source: "/a.md", target: "/b.md" });

    await kb.patchConcept("/a.md", { replaceBody: "no links" }, "unlink");
    const after = await kb.graph();
    expect(after.edges).toEqual([]);
  });

  it("tolerates unreadable concept files without failing indexed reads or writes", async () => {
    await kb.writeConcept("/ok.md", { type: "T", title: "Ok" }, "body", "add");
    await fs.writeFile(
      path.join(root, "bad.md"),
      "---\n: : not valid yaml\n---\n\nbody\n",
      "utf-8"
    );

    const tree = await kb.listTree();
    expect(tree.children?.some((c) => c.path === "/bad.md")).toBe(true);
    expect(tree.children?.find((c) => c.path === "/bad.md")?.title).toBeUndefined();

    const hits = await kb.search("Ok");
    expect(hits.map((h) => h.path)).toEqual(["/ok.md"]);

    const report = await kb.validate();
    expect(report.issues.some((i) => i.path === "/bad.md" && i.severity === "error")).toBe(
      true
    );

    await expect(
      kb.writeConcept("/ok2.md", { type: "T", title: "Ok2" }, "body", "add")
    ).resolves.toMatchObject({ path: "/ok2.md" });
  });

  it("recovers from temporary file-read failures on the next ordinary read", async () => {
    await kb.writeConcept("/flip.md", { type: "T", title: "Flip" }, "readable", "add");
    const abs = path.join(root, "flip.md");
    await kb.listTree();

    // Replace the file with a directory so readFile fails (EISDIR) — more reliable than chmod.
    await fs.unlink(abs);
    await fs.mkdir(abs);
    const during = await kb.listTree();
    expect(during.children?.some((c) => c.path === "/flip.md")).toBe(true);
    expect(during.children?.find((c) => c.path === "/flip.md")?.title).toBeUndefined();
    expect((await kb.search("readable")).map((h) => h.path)).not.toContain("/flip.md");

    await fs.rmdir(abs);
    await fs.writeFile(
      abs,
      `---\ntype: T\ntitle: Flip\n---\n\nreadable again\n`,
      "utf-8"
    );

    const tree = await kb.listTree();
    expect(tree.children?.find((c) => c.path === "/flip.md")?.title).toBe("Flip");
    expect((await kb.search("readable")).some((h) => h.path === "/flip.md")).toBe(true);
  });

  it("validate reports repeated broken links per occurrence", async () => {
    await kb.writeConcept(
      "/a.md",
      { type: "T", title: "A", description: "d" },
      "See [x](/missing.md) and [y](/missing.md).",
      "add"
    );
    const report = await kb.validate();
    const broken = report.issues.filter((i) =>
      i.message.includes("Broken bundle-relative link: /missing.md")
    );
    expect(broken).toHaveLength(2);
  });
});

describe("BundleIndex concurrency", () => {
  it("coalesces cold ensureReady into a single rebuild", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "body", "add");
    await kb.writeConcept("/b.md", { type: "U", title: "B" }, "body", "add");

    const cold = new KnowledgeBase(root);
    await Promise.all([cold.listTree(), cold.listTypes(), cold.search("A"), cold.graph()]);
    expect(cold.getIndexVersion()).toBe(1);
  });

  it("coalesces concurrent refresh() into one rebuild", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "body", "add");
    await kb.listTree();
    const before = kb.getIndexVersion();
    await Promise.all([kb.refresh(), kb.refresh(), kb.refresh()]);
    expect(kb.getIndexVersion()).toBe(before + 1);
  });

  it("refresh racing ordinary reads never tears the snapshot", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "See [b](/b.md).", "a");
    await kb.writeConcept("/b.md", { type: "T", title: "B" }, "body", "b");
    await kb.listTree();

    const results = await Promise.all([
      kb.listTree(),
      kb.refresh(),
      kb.graph(),
      kb.search("A"),
      kb.validate(),
      kb.lint(),
      kb.refresh(),
      kb.listTypes(),
    ]);

    const graph = results[2] as Awaited<ReturnType<KnowledgeBase["graph"]>>;
    const paths = new Set(graph.nodes.map((n) => n.path));
    for (const edge of graph.edges) {
      expect(paths.has(edge.source)).toBe(true);
      expect(paths.has(edge.target)).toBe(true);
    }
    expect(graph.nodes.map((n) => n.path).sort()).toEqual(["/a.md", "/b.md"]);
  });

  it("unchanged reconcile does not bump version (atomic reuse)", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "body", "add");
    await kb.listTree();
    const v = kb.getIndexVersion();
    // Hash path still runs, but identical content must reuse the snapshot object.
    await Promise.all([kb.listTree(), kb.listTypes(), kb.search("A")]);
    expect(kb.getIndexVersion()).toBe(v);
  });
});
