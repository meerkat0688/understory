import type { TreeNode } from "./types.js";

/** Distinct concept `type` values already present on a tree (no second FS scan). */
export function collectTypesFromTree(root: TreeNode): string[] {
  const types = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (node.kind === "concept" && node.type) types.add(node.type);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return [...types].sort();
}
