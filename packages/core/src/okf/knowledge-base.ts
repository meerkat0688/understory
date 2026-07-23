import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { Bundle } from "./bundle.js";
import { BundleIndex } from "./bundle-index.js";
import { regenerateIndexChain } from "./indexer.js";
import { appendLog, readLog } from "./logger.js";
import type { SearchOptions } from "./search.js";
import type { LintReport } from "./lint.js";
import type { GraphData } from "./graph.js";
import type {
  Concept,
  ConceptFrontmatter,
  ConformanceReport,
  LogAction,
  LogEntry,
  SearchHit,
  TreeNode,
} from "./types.js";

export interface KnowledgeBaseOptions {
  /** Commit after each mutation. Requires the bundle to be inside a git repo. */
  gitAutocommit?: boolean;
}

/**
 * The one write-path into the bundle. Spec conformance (index.md, log.md,
 * frontmatter validation, timestamps) is enforced HERE, deterministically —
 * never delegated to the LLM. Mutations are serialized through a queue.
 */
export class KnowledgeBase {
  readonly bundle: Bundle;
  private readonly index: BundleIndex;
  private readonly git: SimpleGit | null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(bundleRoot: string, private readonly options: KnowledgeBaseOptions = {}) {
    this.bundle = new Bundle(bundleRoot);
    this.index = new BundleIndex(this.bundle);
    this.git = options.gitAutocommit ? simpleGit(this.bundle.root) : null;
  }

  // ── Reads (auto-reconcile via BundleIndex; no mutation queue) ───────

  /** Single-file read — always from disk (not the snapshot). */
  readConcept(conceptPath: string): Promise<Concept> {
    return this.bundle.readConcept(conceptPath);
  }

  listTree(): Promise<TreeNode> {
    return this.index.listTree();
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.index.search(query, options);
  }

  listTypes(): Promise<string[]> {
    return this.index.listTypes();
  }

  readLog(): Promise<LogEntry[]> {
    return readLog(this.bundle);
  }

  validate(): Promise<ConformanceReport> {
    return this.index.validate();
  }

  /** Graph health: orphaned concepts + broken links (deterministic, no LLM). */
  lint(): Promise<LintReport> {
    return this.index.lint();
  }

  /** Inter-concept link graph (nodes + edges) for visualization. */
  graph(): Promise<GraphData> {
    return this.index.graph();
  }

  /** Force a full index rebuild from disk (path inventory + re-parse all). */
  refresh(): Promise<void> {
    return this.index.refresh().then(() => undefined);
  }

  /** Current snapshot version (0 before first ensureReady). */
  getIndexVersion(): number {
    return this.index.getIndexVersion();
  }

  // ── Mutations (serialized; auto index + log + optional commit) ──────

  writeConcept(
    conceptPath: string,
    frontmatter: ConceptFrontmatter,
    body: string,
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const existed = await this.bundle.exists(conceptPath);
      const concept = await this.bundle.writeConcept(conceptPath, frontmatter, body);
      await this.afterMutation(concept.path, existed ? "Update" : "Creation", logSummary);
      return concept;
    });
  }

  patchConcept(
    conceptPath: string,
    changes: Parameters<Bundle["patchConcept"]>[1],
    logSummary: string
  ): Promise<Concept> {
    return this.enqueue(async () => {
      const concept = await this.bundle.patchConcept(conceptPath, changes);
      await this.afterMutation(concept.path, "Update", logSummary);
      return concept;
    });
  }

  deleteConcept(conceptPath: string, logSummary: string): Promise<void> {
    return this.enqueue(async () => {
      const canonical = this.bundle.toBundlePath(conceptPath);
      await this.bundle.deleteConcept(canonical);
      await this.afterMutation(canonical, "Deletion", logSummary);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async afterMutation(
    conceptPath: string,
    action: LogAction,
    logSummary: string
  ): Promise<void> {
    await regenerateIndexChain(this.bundle, path.posix.dirname(conceptPath));
    const linked = `[${conceptPath.split("/").pop()}](${conceptPath})`;
    await appendLog(this.bundle, action, logSummary || `${action} of ${linked}.`);
    // V1: full rebuild after mutation (no applyConceptDelta).
    await this.index.refresh();
    if (this.git) {
      try {
        await this.git.add(".");
        await this.git.commit(`${action.toLowerCase()}: ${logSummary || conceptPath}`);
      } catch (err) {
        // Autocommit is best-effort; the KB write itself already succeeded.
        console.error(`[understory] git autocommit failed: ${(err as Error).message}`);
      }
    }
  }
}
