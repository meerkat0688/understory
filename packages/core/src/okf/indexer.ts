import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDoc } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Bundle } from "./bundle.js";

/**
 * Regenerate a directory's index.md per spec §6:
 * bullet list of `[Title](relative-url) - description`, subdirectories included.
 * The root index.md carries the only frontmatter allowed in an index: okf_version.
 */
export async function regenerateIndex(bundle: Bundle, dir = "/"): Promise<string> {
  const absDir = bundle.resolve(dir);
  const isRoot = absDir === bundle.root;
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const conceptLines: string[] = [];
  const dirLines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      dirLines.push(`* [${entry.name}](${entry.name}/) - subdirectory`);
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_FILENAMES.has(entry.name)) continue;
    let title = entry.name.replace(/\.md$/, "");
    let description = "";
    try {
      const { frontmatter } = parseDoc(
        await fs.readFile(path.join(absDir, entry.name), "utf-8")
      );
      if (typeof frontmatter.title === "string" && frontmatter.title) title = frontmatter.title;
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Permissive: index unparseable files by filename.
    }
    conceptLines.push(`* [${title}](${entry.name})${description ? ` - ${description}` : ""}`);
  }

  const dirName = isRoot ? "Knowledge Base" : path.basename(absDir);
  const sections: string[] = [];
  if (isRoot) sections.push(`---\nokf_version: "0.1"\n---\n`);
  sections.push(`# ${capitalize(dirName)}\n`);
  if (conceptLines.length > 0) sections.push(conceptLines.join("\n") + "\n");
  if (dirLines.length > 0) sections.push(`## Subdirectories\n\n${dirLines.join("\n")}\n`);

  const content = sections.join("\n");
  await fs.writeFile(path.join(absDir, "index.md"), content, "utf-8");
  return content;
}

/** Regenerate index.md for a directory and every ancestor up to the root. */
export async function regenerateIndexChain(bundle: Bundle, dir: string): Promise<void> {
  let current = bundle.resolve(dir);
  // If given a file path, start from its directory.
  if (current.endsWith(".md")) current = path.dirname(current);
  while (true) {
    await regenerateIndex(bundle, bundle.toBundlePath(current));
    if (current === bundle.root) break;
    current = path.dirname(current);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
