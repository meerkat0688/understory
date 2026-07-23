import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bundle } from "./bundle.js";
import { parseDoc, hasNonEmptyType } from "./frontmatter.js";
import { extractOutboundLinks } from "./links.js";
import { scanGraphFromConcepts, type GraphData, type GraphScan } from "./graph.js";
import { lintReportFromScan, type LintReport } from "./lint.js";
import { validateFromSnapshot } from "./validate.js";
import type {
  ConceptFrontmatter,
  ConformanceReport,
  SearchHit,
  TreeNode,
} from "./types.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { SearchOptions } from "./search.js";

export interface IndexedConcept {
  path: string;
  frontmatter: ConceptFrontmatter;
  body: string;
  outboundLinks: string[];
  mtimeMs: number;
  size: number;
  contentHash: string;
  /** Set when YAML/frontmatter parse failed (file was readable). */
  error?: string;
  /** Set when stat/readFile failed — validate skips; tree/graph still list. */
  ioError?: boolean;
}

export interface BundleSnapshot {
  concepts: Map<string, IndexedConcept>;
  directories: Set<string>;
  reserved: Set<string>;
  types: Map<string, Set<string>>;
  inboundLinks: Map<string, Set<string>>;
  version: number;
}

/**
 * Private disposable in-process index over an OKF bundle.
 * Markdown on disk remains the source of truth; restart rebuilds everything.
 */
export class BundleIndex {
  private snapshot: BundleSnapshot | null = null;
  /** Shared by ensureReady and refresh so concurrent callers join one rebuild. */
  private inflight: Promise<BundleSnapshot> | null = null;
  /** Coalesces concurrent refresh() into one full rebuild. */
  private refreshInflight: Promise<BundleSnapshot> | null = null;
  /** Monotonic even across invalidate(); exposed via getIndexVersion(). */
  private version = 0;

  constructor(private readonly bundle: Bundle) {}

  getIndexVersion(): number {
    return this.snapshot?.version ?? this.version;
  }

  /** Drop the snapshot so the next ensureReady() does a full rebuild. */
  invalidate(): void {
    this.snapshot = null;
  }

  /**
   * Build or reconcile against disk (path inventory + dirty checks).
   * Concurrent callers share one in-flight promise.
   */
  ensureReady(): Promise<BundleSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        if (!this.snapshot) {
          this.snapshot = await this.fullRebuild();
        } else {
          this.snapshot = await this.reconcile(this.snapshot);
        }
        return this.snapshot;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Force full rebuild from a fresh path inventory (bypasses dirty heuristics). */
  refresh(): Promise<BundleSnapshot> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = (async () => {
      // Wait out any ensureReady reconcile, then take over inflight for the rebuild
      // so concurrent ensureReady() callers join this full rebuild.
      if (this.inflight) await this.inflight.catch(() => {});
      this.inflight = (async () => {
        try {
          this.snapshot = await this.fullRebuild();
          return this.snapshot;
        } finally {
          this.inflight = null;
        }
      })();
      try {
        return await this.inflight;
      } finally {
        this.refreshInflight = null;
      }
    })();
    return this.refreshInflight;
  }

  async listTree(): Promise<TreeNode> {
    const snap = await this.ensureReady();
    return buildTreeFromSnapshot(snap);
  }

  async listTypes(): Promise<string[]> {
    const snap = await this.ensureReady();
    return [...snap.types.keys()].sort();
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const snap = await this.ensureReady();
    return searchSnapshot(snap, query, options);
  }

  async validate(): Promise<ConformanceReport> {
    const snap = await this.ensureReady();
    return validateFromSnapshot({
      concepts: snap.concepts.values(),
      directories: snap.directories,
    });
  }

  async scanGraph(): Promise<GraphScan> {
    const snap = await this.ensureReady();
    return graphScanFromSnapshot(snap);
  }

  async graph(): Promise<GraphData> {
    const { nodes, edges } = await this.scanGraph();
    return { nodes, edges };
  }

  async lint(): Promise<LintReport> {
    return lintReportFromScan(await this.scanGraph());
  }

  private async fullRebuild(): Promise<BundleSnapshot> {
    this.version += 1;
    const inventory = await this.inventory();
    const concepts = new Map<string, IndexedConcept>();
    for (const conceptPath of inventory.conceptPaths) {
      concepts.set(conceptPath, await this.indexConcept(conceptPath));
    }
    return assembleSnapshot(concepts, inventory.directories, inventory.reserved, this.version);
  }

  private async reconcile(prev: BundleSnapshot): Promise<BundleSnapshot> {
    const inventory = await this.inventory();
    const current = new Set(inventory.conceptPaths);
    const prevPaths = new Set(prev.concepts.keys());

    const concepts = new Map<string, IndexedConcept>();
    let changed = false;

    for (const p of current) {
      if (!prevPaths.has(p)) {
        concepts.set(p, await this.indexConcept(p));
        changed = true;
        continue;
      }
      const old = prev.concepts.get(p)!;
      const abs = this.bundle.resolve(p);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        // Vanished between inventory and stat — treat as removed.
        changed = true;
        continue;
      }

      // Prior IO/parse failures: always re-index so a recovered file is not stuck.
      if (old.ioError || old.error) {
        const next = await this.indexConcept(p);
        concepts.set(p, next);
        if (
          next.contentHash !== old.contentHash ||
          Boolean(next.ioError) !== Boolean(old.ioError) ||
          next.error !== old.error ||
          next.body !== old.body
        ) {
          changed = true;
        }
        continue;
      }

      if (st.mtimeMs !== old.mtimeMs || st.size !== old.size) {
        concepts.set(p, await this.indexConcept(p));
        changed = true;
        continue;
      }

      // Same mtime+size: content-hash fallback catches in-place rewrites.
      let raw: string;
      try {
        raw = await fs.readFile(abs, "utf-8");
      } catch (err) {
        concepts.set(p, {
          path: p,
          frontmatter: { type: "" },
          body: "",
          outboundLinks: [],
          mtimeMs: st.mtimeMs,
          size: st.size,
          contentHash: "",
          error: err instanceof Error ? err.message : String(err),
          ioError: true,
        });
        changed = true;
        continue;
      }
      const hash = hashContent(raw);
      if (hash === old.contentHash) {
        concepts.set(p, old);
      } else {
        concepts.set(p, indexFromRaw(p, raw, st.mtimeMs, st.size, hash));
        changed = true;
      }
    }

    for (const p of prevPaths) {
      if (!current.has(p)) changed = true;
    }

    if (
      !changed &&
      setsEqual(prev.directories, inventory.directories) &&
      setsEqual(prev.reserved, inventory.reserved)
    ) {
      return prev;
    }

    this.version += 1;
    return assembleSnapshot(
      concepts,
      inventory.directories,
      inventory.reserved,
      this.version
    );
  }

  private async inventory(): Promise<{
    conceptPaths: string[];
    directories: Set<string>;
    reserved: Set<string>;
  }> {
    const conceptPaths: string[] = [];
    const directories = new Set<string>(["/"]);
    const reserved = new Set<string>();

    const walk = async (absDir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const child = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          directories.add(this.bundle.toBundlePath(child));
          await walk(child);
        } else if (entry.name.endsWith(".md")) {
          const bundlePath = this.bundle.toBundlePath(child);
          if (RESERVED_FILENAMES.has(entry.name)) reserved.add(bundlePath);
          else conceptPaths.push(bundlePath);
        }
      }
    };

    await walk(this.bundle.root);
    conceptPaths.sort();
    return { conceptPaths, directories, reserved };
  }

  private async indexConcept(conceptPath: string): Promise<IndexedConcept> {
    const abs = this.bundle.resolve(conceptPath);
    let st;
    try {
      st = await fs.stat(abs);
    } catch (err) {
      return {
        path: conceptPath,
        frontmatter: { type: "" },
        body: "",
        outboundLinks: [],
        mtimeMs: 0,
        size: 0,
        contentHash: "",
        error: err instanceof Error ? err.message : String(err),
        ioError: true,
      };
    }
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch (err) {
      return {
        path: conceptPath,
        frontmatter: { type: "" },
        body: "",
        outboundLinks: [],
        mtimeMs: st.mtimeMs,
        size: st.size,
        contentHash: "",
        error: err instanceof Error ? err.message : String(err),
        ioError: true,
      };
    }
    return indexFromRaw(conceptPath, raw, st.mtimeMs, st.size, hashContent(raw));
  }
}

function indexFromRaw(
  conceptPath: string,
  raw: string,
  mtimeMs: number,
  size: number,
  contentHash: string
): IndexedConcept {
  try {
    const { frontmatter, body } = parseDoc(raw);
    return {
      path: conceptPath,
      frontmatter: frontmatter as ConceptFrontmatter,
      body,
      outboundLinks: extractOutboundLinks(body, conceptPath),
      mtimeMs,
      size,
      contentHash,
    };
  } catch (err) {
    return {
      path: conceptPath,
      frontmatter: { type: "" },
      body: "",
      outboundLinks: [],
      mtimeMs,
      size,
      contentHash,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function assembleSnapshot(
  concepts: Map<string, IndexedConcept>,
  directories: Set<string>,
  reserved: Set<string>,
  version: number
): BundleSnapshot {
  const types = new Map<string, Set<string>>();
  const inboundLinks = new Map<string, Set<string>>();

  for (const p of concepts.keys()) inboundLinks.set(p, new Set());

  for (const concept of concepts.values()) {
    if (!concept.error && !concept.ioError && hasNonEmptyType(concept.frontmatter)) {
      const t = String(concept.frontmatter.type);
      let set = types.get(t);
      if (!set) {
        set = new Set();
        types.set(t, set);
      }
      set.add(concept.path);
    }
    for (const target of concept.outboundLinks) {
      if (!concepts.has(target) || target === concept.path) continue;
      let inbound = inboundLinks.get(target);
      if (!inbound) {
        inbound = new Set();
        inboundLinks.set(target, inbound);
      }
      inbound.add(concept.path);
    }
  }

  return { concepts, directories, reserved, types, inboundLinks, version };
}

function hashContent(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Graph/lint scan using cached outboundLinks + snapshot inboundLinks. */
function graphScanFromSnapshot(snap: BundleSnapshot): GraphScan {
  const scan = scanGraphFromConcepts(snap.concepts.values());
  const inbound = new Map<string, number>();
  for (const path of snap.concepts.keys()) {
    inbound.set(path, snap.inboundLinks.get(path)?.size ?? 0);
  }
  return { ...scan, inbound };
}

function buildTreeFromSnapshot(snap: BundleSnapshot): TreeNode {
  const childrenOf = new Map<string, string[]>();
  const ensure = (dir: string) => {
    if (!childrenOf.has(dir)) childrenOf.set(dir, []);
  };
  ensure("/");

  for (const dir of snap.directories) {
    ensure(dir);
    if (dir === "/") continue;
    const parent = parentDir(dir);
    ensure(parent);
    childrenOf.get(parent)!.push(dir);
  }
  for (const p of snap.concepts.keys()) {
    const parent = parentDir(p);
    ensure(parent);
    childrenOf.get(parent)!.push(p);
  }
  for (const p of snap.reserved) {
    const parent = parentDir(p);
    ensure(parent);
    childrenOf.get(parent)!.push(p);
  }

  const build = (dirPath: string): TreeNode => {
    const name = dirPath === "/" ? "/" : path.posix.basename(dirPath);
    const children: TreeNode[] = [];
    const entries = [...new Set(childrenOf.get(dirPath) ?? [])].sort((a, b) =>
      path.posix.basename(a).localeCompare(path.posix.basename(b))
    );
    for (const childPath of entries) {
      if (snap.directories.has(childPath)) {
        children.push(build(childPath));
      } else if (snap.reserved.has(childPath)) {
        children.push({
          name: path.posix.basename(childPath),
          path: childPath,
          kind: "reserved",
        });
      } else {
        const concept = snap.concepts.get(childPath);
        const node: TreeNode = {
          name: path.posix.basename(childPath),
          path: childPath,
          kind: "concept",
        };
        if (concept && !concept.error && !concept.ioError) {
          const fm = concept.frontmatter;
          if (typeof fm.type === "string") node.type = fm.type;
          if (typeof fm.title === "string") node.title = fm.title;
          if (typeof fm.description === "string") node.description = fm.description;
        }
        children.push(node);
      }
    }
    return { name, path: dirPath, kind: "directory", children };
  };

  return build("/");
}

function parentDir(bundlePath: string): string {
  const dir = path.posix.dirname(bundlePath);
  return dir === "." ? "/" : dir;
}

function searchSnapshot(
  snap: BundleSnapshot,
  query: string,
  options: SearchOptions
): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const hits: SearchHit[] = [];

  for (const concept of snap.concepts.values()) {
    if (concept.error || concept.ioError) continue; // search skips unreadable
    const fm = concept.frontmatter;

    if (options.type && fm.type?.toLowerCase() !== options.type.toLowerCase()) continue;
    if (options.tags?.length) {
      const conceptTags = (Array.isArray(fm.tags) ? fm.tags : []).map((t) =>
        String(t).toLowerCase()
      );
      if (!options.tags.every((t) => conceptTags.includes(t.toLowerCase()))) continue;
    }

    const title = (fm.title ?? "").toString().toLowerCase();
    const description = (fm.description ?? "").toString().toLowerCase();
    const tags = (Array.isArray(fm.tags) ? fm.tags : []).join(" ").toLowerCase();
    const body = concept.body.toLowerCase();
    const pathLower = concept.path.toLowerCase();

    let score = 0;
    let firstBodyMatch = -1;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      if (pathLower.includes(term)) score += 6;
      if (description.includes(term)) score += 5;
      if (tags.includes(term)) score += 5;
      const bodyIdx = body.indexOf(term);
      if (bodyIdx !== -1) {
        score += 2;
        if (firstBodyMatch === -1) firstBodyMatch = bodyIdx;
      }
    }
    if (terms.length === 0) score = 1;
    if (score === 0) continue;

    hits.push({
      path: concept.path,
      type: fm.type ?? "unknown",
      title: fm.title as string | undefined,
      description: fm.description as string | undefined,
      snippet:
        firstBodyMatch >= 0
          ? concept.body
              .slice(Math.max(0, firstBodyMatch - 60), firstBodyMatch + 120)
              .replace(/\s+/g, " ")
              .trim()
          : undefined,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}
