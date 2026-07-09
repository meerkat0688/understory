import { tool } from "ai";
import { z } from "zod";
import type { KnowledgeBase } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
const conceptPath = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe("YAML frontmatter. Additional producer-defined keys are allowed.");

const logSummary = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

export function buildReadTools(kb: KnowledgeBase) {
  return {
    search_knowledge: tool({
      description:
        "Search the knowledge base by keywords, optionally filtered by concept type and/or tags. Returns ranked hits with paths and snippets.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to search for. May be empty when filtering by type/tags only."),
        type: z.string().optional().describe("Exact concept type filter"),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
      }),
      execute: async ({ query, type, tags }) => kb.search(query, { type, tags }),
    }),
    read_concept: tool({
      description: "Read one concept document in full: frontmatter and markdown body.",
      inputSchema: z.object({ path: conceptPath }),
      execute: async ({ path }) => {
        const c = await kb.readConcept(path);
        return { path: c.path, frontmatter: c.frontmatter, body: c.body };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types/titles/descriptions. Use to understand structure and decide where new concepts belong.",
      inputSchema: z.object({}),
      execute: async () => formatTree(await kb.listTree()),
    }),
  };
}

export function buildWriteTools(kb: KnowledgeBase, filesChanged: Set<string>) {
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, body, log_summary }) => {
        const c = await kb.writeConcept(path, frontmatter, body, log_summary);
        filesChanged.add(c.path);
        return { written: c.path };
      },
    }),
    patch_concept: tool({
      description:
        "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one top-level '# Section' body section. Prefer this over write_concept for small edits.",
      inputSchema: z.object({
        path: conceptPath,
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Frontmatter keys to merge; set a key to null to remove it"),
        replace_section: z
          .object({
            heading: z.string().describe("Top-level heading name, e.g. 'Schema'"),
            content: z.string().describe("New content for that section"),
          })
          .optional(),
        log_summary: logSummary,
      }),
      execute: async ({ path, frontmatter, replace_section, log_summary }) => {
        const c = await kb.patchConcept(
          path,
          {
            frontmatter,
            replaceSection: replace_section
              ? { heading: replace_section.heading, content: replace_section.content }
              : undefined,
          },
          log_summary
        );
        filesChanged.add(c.path);
        return { patched: c.path };
      },
    }),
    delete_concept: tool({
      description:
        "Permanently delete a concept file. Prefer deprecation (tag 'deprecated' via patch_concept) unless content is wrong/harmful or deletion was explicitly requested.",
      inputSchema: z.object({
        path: conceptPath,
        log_summary: logSummary,
      }),
      execute: async ({ path, log_summary }) => {
        await kb.deleteConcept(path, log_summary);
        filesChanged.add(path);
        return { deleted: path };
      },
    }),
  };
}

/** Compact indented listing for prompts and the list_directory tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${child.name}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      const meta = [child.type, child.description].filter(Boolean).join(" — ");
      lines.push(`${indent}${child.name}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
