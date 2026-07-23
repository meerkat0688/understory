import type { Bundle } from "./bundle.js";
import { scanGraph, type GraphScan } from "./graph.js";

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

/** Shared lint projection for bundle scans and BundleIndex snapshots. */
export function lintReportFromScan(scan: GraphScan): LintReport {
  const orphans: LintFinding[] = scan.nodes
    .filter((n) => (scan.inbound.get(n.path) ?? 0) === 0)
    .map((n) => ({ path: n.path, type: n.type, title: n.title }));

  return {
    conceptCount: scan.nodes.length,
    linkCount: scan.edges.length,
    orphans,
    brokenLinks: scan.brokenLinks,
    healthy: orphans.length === 0 && scan.brokenLinks.length === 0,
  };
}

/**
 * Graph health check (deterministic, no LLM) — orphans + broken links,
 * Karpathy's anti-drift lint. Derived from the shared graph scan.
 */
export async function lintBundle(bundle: Bundle): Promise<LintReport> {
  return lintReportFromScan(await scanGraph(bundle));
}
