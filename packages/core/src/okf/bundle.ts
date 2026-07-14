import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc, serializeDoc, hasNonEmptyType } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Concept, ConceptFrontmatter, TreeNode } from "./types.js";

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "OUTSIDE_BUNDLE"
      | "RESERVED_NAME"
      | "NOT_FOUND"
      | "INVALID_FRONTMATTER"
      | "NOT_MARKDOWN"
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Filesystem access to one OKF bundle, sandboxed to its root directory.
 * All public methods take/return bundle-relative paths ("/dir/concept.md").
 */
export class Bundle {
  readonly root: string;
  private readonly realRoot: Promise<string>;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpath(this.root);
  }

  /** Resolve a bundle-relative path to an absolute one, rejecting escapes. */
  resolve(bundlePath: string): string {
    if (typeof bundlePath !== "string" || bundlePath.includes("\0") || !bundlePath.startsWith("/")) {
      throw new BundleError(`Invalid bundle path: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    if (bundlePath.includes("\\") || /^[A-Za-z]:/.test(bundlePath.slice(1))) {
      throw new BundleError(`Invalid bundle path: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    if (bundlePath === this.root || bundlePath.startsWith(this.root + path.sep)) {
      throw new BundleError("OS filesystem paths are not accepted", "OUTSIDE_BUNDLE");
    }
    const segments = bundlePath.split("/");
    if (segments.some((segment) => segment === ".." || segment === ".")) {
      throw new BundleError(`Path escapes bundle root: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    const cleaned = segments.filter(Boolean).join(path.sep);
    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new BundleError(`Path escapes bundle root: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    return abs;
  }

  /** Normalize any input to a canonical bundle-relative path starting with "/". */
  toBundlePath(inputPath: string): string {
    const abs = this.resolve(inputPath);
    return this.fromAbsolute(abs);
  }

  private fromAbsolute(abs: string): string {
    const normalized = path.resolve(abs);
    if (normalized !== this.root && !normalized.startsWith(this.root + path.sep)) {
      throw new BundleError(`Path escapes bundle root`, "OUTSIDE_BUNDLE");
    }
    const rel = path.relative(this.root, normalized);
    return rel ? "/" + rel.split(path.sep).join("/") : "/";
  }

  private async assertRealContained(abs: string): Promise<string> {
    const [root, target] = await Promise.all([this.realRoot, fs.realpath(abs)]);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new BundleError("Path resolves outside bundle root", "OUTSIDE_BUNDLE");
    }
    return target;
  }

  private async verifiedWriteDirectory(abs: string): Promise<string> {
    const root = await this.realRoot;
    const rel = path.relative(this.root, path.dirname(abs));
    let current = this.root;
    for (const segment of rel.split(path.sep).filter(Boolean)) {
      const next = path.join(current, segment);
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new BundleError("Write parent is not a real directory", "OUTSIDE_BUNDLE");
        }
      } catch (err) {
        if (err instanceof BundleError) throw err;
        await fs.mkdir(next);
      }
      current = next;
    }
    const real = await fs.realpath(current);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new BundleError("Write parent resolves outside bundle root", "OUTSIDE_BUNDLE");
    }
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) {
        throw new BundleError("Refusing to replace a symlink", "OUTSIDE_BUNDLE");
      }
    } catch (err) {
      if (err instanceof BundleError) throw err;
    }
    return current;
  }

  async writeFileAtomic(bundlePath: string, content: string): Promise<void> {
    const abs = this.resolve(bundlePath);
    const dir = await this.verifiedWriteDirectory(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
      await fs.rename(tmp, abs);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  private assertConceptPath(bundlePath: string): void {
    if (!bundlePath.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${bundlePath}`, "NOT_MARKDOWN");
    }
    const base = path.posix.basename(bundlePath);
    if (RESERVED_FILENAMES.has(base)) {
      throw new BundleError(
        `"${base}" is a reserved filename (index.md/log.md) and cannot be a concept`,
        "RESERVED_NAME"
      );
    }
  }

  async exists(bundlePath: string): Promise<boolean> {
    try {
      await this.assertRealContained(this.resolve(bundlePath));
      return true;
    } catch {
      return false;
    }
  }

  async readConcept(bundlePath: string): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    const abs = this.resolve(canonical);
    let raw: string;
    try {
      raw = await fs.readFile(await this.assertRealContained(abs), "utf-8");
    } catch (err) {
      if (err instanceof BundleError) throw err;
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
    const { frontmatter, body } = parseDoc(raw);
    return { path: canonical, frontmatter: frontmatter as ConceptFrontmatter, body, raw };
  }

  async readFileRaw(bundlePath: string): Promise<string> {
    const abs = this.resolve(bundlePath);
    try {
      return await fs.readFile(await this.assertRealContained(abs), "utf-8");
    } catch (err) {
      if (err instanceof BundleError) throw err;
      throw new BundleError(`File not found: ${bundlePath}`, "NOT_FOUND");
    }
  }

  async listFileNames(bundlePath: string): Promise<string[]> {
    const dir = await this.assertRealContained(this.resolve(bundlePath));
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  }

  async writeConcept(
    bundlePath: string,
    frontmatter: ConceptFrontmatter,
    body: string
  ): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    if (!hasNonEmptyType(frontmatter)) {
      throw new BundleError(
        `Frontmatter must include a non-empty "type" field (OKF spec §5)`,
        "INVALID_FRONTMATTER"
      );
    }
    const stamped: ConceptFrontmatter = {
      ...frontmatter,
      timestamp: new Date().toISOString(),
    };
    const abs = this.resolve(canonical);
    await this.writeFileAtomic(canonical, serializeDoc(stamped, body));
    return { path: canonical, frontmatter: stamped, body, raw: serializeDoc(stamped, body) };
  }

  /**
   * Targeted update: merge frontmatter keys (null deletes a key) and/or
   * replace the content under one top-level "# Section" heading.
   */
  async patchConcept(
    bundlePath: string,
    changes: {
      frontmatter?: Record<string, unknown>;
      replaceSection?: { heading: string; content: string };
      replaceBody?: string;
    }
  ): Promise<Concept> {
    const existing = await this.readConcept(bundlePath);
    const fm: ConceptFrontmatter = { ...existing.frontmatter };
    if (changes.frontmatter) {
      for (const [k, v] of Object.entries(changes.frontmatter)) {
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
    }
    let body = changes.replaceBody ?? existing.body;
    if (changes.replaceSection) {
      body = replaceSection(body, changes.replaceSection.heading, changes.replaceSection.content);
    }
    return this.writeConcept(existing.path, fm, body);
  }

  async deleteConcept(bundlePath: string): Promise<void> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    const abs = this.resolve(canonical);
    try {
      await this.assertRealContained(abs);
      if ((await fs.lstat(abs)).isSymbolicLink()) throw new BundleError("Refusing to delete a symlink", "OUTSIDE_BUNDLE");
      await fs.unlink(abs);
    } catch (err) {
      if (err instanceof BundleError) throw err;
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
  }

  /** All concept files (recursive), as bundle-relative paths. */
  async listConceptPaths(dir = "/"): Promise<string[]> {
    const out: string[] = [];
    const start = this.resolve(dir);
    await this.assertRealContained(start);
    await this.walk(start, (abs, name) => {
      if (name.endsWith(".md") && !RESERVED_FILENAMES.has(name)) {
        out.push(this.fromAbsolute(abs));
      }
    });
    return out.sort();
  }

  /** Immediate subdirectories of a directory. */
  async listSubdirectories(dir = "/"): Promise<string[]> {
    const abs = this.resolve(dir);
    await this.assertRealContained(abs);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
      .map((e) => this.fromAbsolute(path.join(abs, e.name)))
      .sort();
  }

  async listTree(dir = "/"): Promise<TreeNode> {
    const abs = this.resolve(dir);
    await this.assertRealContained(abs);
    const name = abs === this.root ? "/" : path.basename(abs);
    const node: TreeNode = {
      name,
      path: this.fromAbsolute(abs),
      kind: "directory",
      children: [],
    };
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        node.children!.push(await this.listTree(this.fromAbsolute(childAbs)));
      } else if (entry.name.endsWith(".md")) {
        if (RESERVED_FILENAMES.has(entry.name)) {
          node.children!.push({
            name: entry.name,
            path: this.fromAbsolute(childAbs),
            kind: "reserved",
          });
        } else {
          let fmSummary: { type?: string; title?: string; description?: string } = {};
          try {
            const { frontmatter } = parseDoc(await fs.readFile(childAbs, "utf-8"));
            fmSummary = {
              type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
              title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
              description:
                typeof frontmatter.description === "string" ? frontmatter.description : undefined,
            };
          } catch {
            // Permissive: unparseable file still appears in the tree.
          }
          node.children!.push({
            name: entry.name,
            path: this.fromAbsolute(childAbs),
            kind: "concept",
            ...fmSummary,
          });
        }
      }
    }
    return node;
  }

  private async walk(
    absDir: string,
    visit: (absPath: string, name: string) => void
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.walk(child, visit);
      else visit(child, entry.name);
    }
  }
}

/** Replace the content under a top-level heading; append the section if absent. */
export function replaceSection(body: string, heading: string, content: string): string {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  const isHeading = (line: string) => /^#\s+/.test(line);
  const start = lines.findIndex(
    (line) => isHeading(line) && line.replace(/^#\s+/, "").trim() === normalized
  );
  if (start === -1) {
    const suffix = body.trim().length > 0 ? "\n\n" : "";
    return `${body.trimEnd()}${suffix}# ${normalized}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? "\n" + after : ""}`;
}
