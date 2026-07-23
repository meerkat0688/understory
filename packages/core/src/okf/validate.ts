import { parseDoc, hasNonEmptyType } from "./frontmatter.js";
import { eachOutboundLink } from "./links.js";
import type { Bundle } from "./bundle.js";
import type { ConformanceIssue, ConformanceReport } from "./types.js";

/**
 * Conformance check per spec §9. Errors make the bundle non-conformant;
 * warnings (broken links, missing recommended fields) never do — the spec
 * requires consumers to tolerate them.
 */
export async function validateBundle(bundle: Bundle): Promise<ConformanceReport> {
  const issues: ConformanceIssue[] = [];
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);
  let directoryCount = 0;

  const countDirs = async (dir: string): Promise<void> => {
    directoryCount++;
    for (const sub of await bundle.listSubdirectories(dir)) await countDirs(sub);
  };
  await countDirs("/");

  for (const conceptPath of paths) {
    let raw: string;
    try {
      raw = await bundle.readFileRaw(conceptPath);
    } catch {
      continue;
    }
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseDoc(raw));
    } catch {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: "Frontmatter is not parseable YAML (spec §9.1)",
      });
      continue;
    }
    if (!hasNonEmptyType(frontmatter)) {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: 'Missing non-empty "type" frontmatter field (spec §9.2)',
      });
    }
    if (!frontmatter.title) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "title" field',
      });
    }
    if (!frontmatter.description) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "description" field',
      });
    }
    // Per-occurrence warnings (not deduped) — historical validate behavior.
    for (const target of eachOutboundLink(body)) {
      if (!known.has(target)) {
        issues.push({
          path: conceptPath,
          severity: "warning",
          message: `Broken bundle-relative link: ${target}`,
        });
      }
    }
  }

  return {
    conformant: !issues.some((i) => i.severity === "error"),
    conceptCount: paths.length,
    directoryCount,
    issues,
  };
}

/** Validate from an indexed snapshot (avoids a second FS parse pass). */
export function validateFromSnapshot(input: {
  concepts: Iterable<{
    path: string;
    frontmatter: Record<string, unknown>;
    body: string;
    error?: string;
    /** IO failure — skipped like validateBundle’s unreadable-file continue. */
    ioError?: boolean;
  }>;
  directories: ReadonlySet<string>;
}): ConformanceReport {
  const concepts = [...input.concepts];
  const known = new Set(concepts.map((c) => c.path));
  const issues: ConformanceIssue[] = [];
  let conceptCount = 0;

  for (const concept of concepts) {
    if (concept.ioError) continue;
    conceptCount++;
    if (concept.error) {
      issues.push({
        path: concept.path,
        severity: "error",
        message: "Frontmatter is not parseable YAML (spec §9.1)",
      });
      continue;
    }
    const frontmatter = concept.frontmatter;
    if (!hasNonEmptyType(frontmatter)) {
      issues.push({
        path: concept.path,
        severity: "error",
        message: 'Missing non-empty "type" frontmatter field (spec §9.2)',
      });
    }
    if (!frontmatter.title) {
      issues.push({
        path: concept.path,
        severity: "warning",
        message: 'Missing recommended "title" field',
      });
    }
    if (!frontmatter.description) {
      issues.push({
        path: concept.path,
        severity: "warning",
        message: 'Missing recommended "description" field',
      });
    }
    for (const target of eachOutboundLink(concept.body)) {
      if (!known.has(target)) {
        issues.push({
          path: concept.path,
          severity: "warning",
          message: `Broken bundle-relative link: ${target}`,
        });
      }
    }
  }

  return {
    conformant: !issues.some((i) => i.severity === "error"),
    conceptCount,
    directoryCount: input.directories.size,
    issues,
  };
}
