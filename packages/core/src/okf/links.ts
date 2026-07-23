/**
 * Bundle-relative absolute concept links in markdown bodies: [text](/dir/concept.md).
 * Shared by graph and validate (lint consumes scanGraph).
 */
const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;

/** Deduped outbound concept targets from a markdown body (excludes self if passed). */
export function extractOutboundLinks(body: string, sourcePath?: string): string[] {
  const targeted = new Set<string>();
  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1];
    if (sourcePath && target === sourcePath) continue;
    targeted.add(target);
  }
  return [...targeted];
}

/**
 * Every outbound link occurrence in document order (no dedupe).
 * Preserves validate’s historical per-occurrence warning behavior.
 */
export function* eachOutboundLink(body: string): Generator<string> {
  for (const match of body.matchAll(LINK_RE)) {
    yield match[1];
  }
}
