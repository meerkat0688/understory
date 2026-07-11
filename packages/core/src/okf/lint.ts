import type { Bundle } from "./bundle.js";
import type { Concept } from "./types.js";

export interface LintFinding {
  path: string;
  type?: string;
  title?: string;
}

export interface BrokenLink {
  /** Concept containing the dangling link. */
  path: string;
  /** The missing bundle-relative target. */
  target: string;
}

export interface LintReport {
  conceptCount: number;
  /** Distinct inter-concept link edges (source → target, deduped per source). */
  linkCount: number;
  /** Concepts no other concept links to (index/log catalogs don't count). */
  orphans: LintFinding[];
  /** Outbound links pointing at nonexistent concepts. */
  brokenLinks: BrokenLink[];
  healthy: boolean;
}

// Bundle-relative links to concepts: [text](/dir/concept.md)
const LINK_RE = /\]\((\/[^)#?\s]+\.md)\)/g;

/**
 * Graph health check (deterministic, no LLM). Builds the inter-concept link
 * graph from concept bodies and reports orphans + broken links — Karpathy's
 * anti-drift lint. Reserved files (index.md/log.md) are excluded as link
 * sources: their generated catalogs link everything, which would mask every
 * orphan.
 */
export async function lintBundle(bundle: Bundle): Promise<LintReport> {
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);

  // Load every concept once.
  const concepts = new Map<string, Concept>();
  for (const p of paths) {
    try {
      concepts.set(p, await bundle.readConcept(p));
    } catch {
      // Permissive: skip unreadable files.
    }
  }

  const inbound = new Map<string, number>();
  for (const p of paths) inbound.set(p, 0);
  const brokenLinks: BrokenLink[] = [];
  let linkCount = 0;

  for (const [conceptPath, concept] of concepts) {
    const targeted = new Set<string>(); // dedupe multiple links to the same target
    for (const match of concept.body.matchAll(LINK_RE)) {
      const target = match[1];
      if (target === conceptPath) continue; // ignore self-links
      if (known.has(target)) {
        if (!targeted.has(target)) {
          targeted.add(target);
          inbound.set(target, (inbound.get(target) ?? 0) + 1);
          linkCount++;
        }
      } else {
        brokenLinks.push({ path: conceptPath, target });
      }
    }
  }

  const orphans: LintFinding[] = [];
  for (const p of paths) {
    if ((inbound.get(p) ?? 0) > 0) continue;
    const fm = concepts.get(p)?.frontmatter;
    orphans.push({
      path: p,
      type: typeof fm?.type === "string" ? fm.type : undefined,
      title: typeof fm?.title === "string" ? fm.title : undefined,
    });
  }

  return {
    conceptCount: paths.length,
    linkCount,
    orphans,
    brokenLinks,
    healthy: orphans.length === 0 && brokenLinks.length === 0,
  };
}
