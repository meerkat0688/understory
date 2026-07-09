import matter from "gray-matter";
import type { ConceptFrontmatter } from "./types.js";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Permissive parse (spec §9: consumers must not reject unknown keys/types).
 * Throws only if the YAML itself is unparseable.
 */
export function parseDoc(raw: string): ParsedDoc {
  const parsed = matter(raw);
  return { frontmatter: parsed.data ?? {}, body: parsed.content.replace(/^\n/, "") };
}

export function serializeDoc(frontmatter: ConceptFrontmatter, body: string): string {
  return matter.stringify(body.endsWith("\n") ? body : body + "\n", frontmatter);
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}
