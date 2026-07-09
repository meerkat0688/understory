import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bundle,
  BundleError,
  KnowledgeBase,
  parseDoc,
  replaceSection,
  validateBundle,
  regenerateIndex,
  readLog,
  searchBundle,
} from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("frontmatter round-trip", () => {
  it("writes and reads a concept preserving fields, stamping timestamp", async () => {
    const written = await kb.writeConcept(
      "/tables/customers.md",
      { type: "BigQuery Table", title: "Customers", description: "Core customer table", tags: ["crm"], custom_key: 42 },
      "# Schema\n\nid, name, email",
      "Added customers table concept."
    );
    expect(written.frontmatter.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await kb.readConcept("/tables/customers.md");
    expect(read.frontmatter.type).toBe("BigQuery Table");
    expect(read.frontmatter.custom_key).toBe(42);
    expect(read.body).toContain("# Schema");
  });

  it("rejects concepts without a type", async () => {
    await expect(
      kb.writeConcept("/x.md", { type: "" } as never, "body", "log")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("rejects reserved filenames as concepts", async () => {
    await expect(
      kb.writeConcept("/index.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
    await expect(
      kb.writeConcept("/sub/log.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
  });

  it("is permissive reading unknown keys and types", () => {
    const { frontmatter } = parseDoc(`---\ntype: Alien Format\nweird: [1, 2]\n---\nbody`);
    expect(frontmatter.type).toBe("Alien Format");
    expect(frontmatter.weird).toEqual([1, 2]);
  });
});

describe("sandbox", () => {
  it("rejects .. escapes", () => {
    const bundle = new Bundle(root);
    expect(() => bundle.resolve("/../../etc/passwd")).toThrow(BundleError);
    expect(() => bundle.resolve("../outside.md")).toThrow(BundleError);
  });

  it("allows normal nested paths", () => {
    const bundle = new Bundle(root);
    expect(bundle.resolve("/a/b/c.md")).toBe(path.join(root, "a/b/c.md"));
  });
});

describe("index regeneration (spec §6)", () => {
  it("generates bullet lists with titles and descriptions, root gets okf_version", async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "Customer records" },
      "body",
      "add"
    );
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).toContain('okf_version: "0.1"');
    expect(rootIndex).toMatch(/\* \[tables\]\(tables\/\)/);

    const dirIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf-8");
    expect(dirIndex).toContain("* [Customers](customers.md) - Customer records");
    // index.md must not have frontmatter outside root
    expect(dirIndex.startsWith("---")).toBe(false);
  });

  it("regenerates the whole ancestor chain after nested writes", async () => {
    await kb.writeConcept("/a/b/deep.md", { type: "T", title: "Deep" }, "x", "add deep");
    for (const p of ["index.md", "a/index.md", "a/b/index.md"]) {
      await expect(fs.access(path.join(root, p))).resolves.toBeUndefined();
    }
  });
});

describe("log (spec §7)", () => {
  it("appends newest-first with action bullets under ISO date headings", async () => {
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "x", "Created one.");
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "y", "Updated one.");
    await kb.deleteConcept("/one.md", "Removed one.");

    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toMatch(/^# Directory Update Log/);
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2}/);

    const entries = await readLog(kb.bundle);
    expect(entries.map((e) => e.action)).toEqual(["Deletion", "Update", "Creation"]);
    expect(entries[0].summary).toBe("Removed one.");
  });
});

describe("patch", () => {
  it("merges frontmatter and replaces a named section only", async () => {
    await kb.writeConcept(
      "/doc.md",
      { type: "T", title: "Doc", tags: ["a"] },
      "intro text\n\n# Schema\n\nold schema\n\n# Examples\n\nkeep me",
      "add"
    );
    const patched = await kb.patchConcept(
      "/doc.md",
      { frontmatter: { tags: ["a", "b"] }, replaceSection: { heading: "Schema", content: "new schema" } },
      "Updated schema section."
    );
    expect(patched.frontmatter.tags).toEqual(["a", "b"]);
    expect(patched.body).toContain("new schema");
    expect(patched.body).not.toContain("old schema");
    expect(patched.body).toContain("keep me");
    expect(patched.body).toContain("intro text");
  });

  it("appends the section when the heading is absent", () => {
    const out = replaceSection("just a body", "Citations", "[1] [X](https://x.com)");
    expect(out).toContain("# Citations");
    expect(out).toContain("[1] [X](https://x.com)");
    expect(out).toContain("just a body");
  });
});

describe("search", () => {
  beforeEach(async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "CRM customer records", tags: ["crm"] },
      "Contains emails and billing country.",
      "add"
    );
    await kb.writeConcept(
      "/apis/billing.md",
      { type: "API Endpoint", title: "Billing API", tags: ["billing"] },
      "Charges customers monthly.",
      "add"
    );
  });

  it("ranks title matches above body matches", async () => {
    const hits = await searchBundle(kb.bundle, "customers");
    expect(hits[0].path).toBe("/tables/customers.md");
    expect(hits.length).toBe(2); // body match on billing too
  });

  it("filters by type and tags", async () => {
    const byType = await searchBundle(kb.bundle, "customers", { type: "API Endpoint" });
    expect(byType.map((h) => h.path)).toEqual(["/apis/billing.md"]);
    const byTag = await searchBundle(kb.bundle, "", { tags: ["crm"] });
    expect(byTag.map((h) => h.path)).toEqual(["/tables/customers.md"]);
  });
});

describe("conformance (spec §9)", () => {
  it("valid bundle passes; missing type is an error; broken link is only a warning", async () => {
    await kb.writeConcept(
      "/good.md",
      { type: "T", title: "Good", description: "fine" },
      "See [missing](/nope.md).",
      "add"
    );
    // Write a malformed concept behind the KB's back.
    await fs.writeFile(path.join(root, "bad.md"), `---\ntitle: No Type\n---\nbody\n`);

    const report = await validateBundle(kb.bundle);
    expect(report.conformant).toBe(false);
    expect(report.issues.some((i) => i.severity === "error" && i.path === "/bad.md")).toBe(true);
    const linkIssue = report.issues.find((i) => i.message.includes("/nope.md"));
    expect(linkIssue?.severity).toBe("warning");

    await fs.rm(path.join(root, "bad.md"));
    const clean = await validateBundle(kb.bundle);
    expect(clean.conformant).toBe(true);
  });
});

describe("mutation serialization", () => {
  it("concurrent writes all land and log all entries", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        kb.writeConcept(`/c${i}.md`, { type: "T", title: `C${i}` }, "x", `Added C${i}.`)
      )
    );
    const entries = await readLog(kb.bundle);
    expect(entries.length).toBe(8);
    const tree = await kb.listTree();
    const concepts = tree.children!.filter((c) => c.kind === "concept");
    expect(concepts.length).toBe(8);
  });
});
