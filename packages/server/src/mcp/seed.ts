import type { KnowledgeBase } from "@okf-agent/core";
import type { TreeNode } from "@okf-agent/core";

const MAX_SEED_CHARS = 3000;

/**
 * Seed memory: a compact overview of what the knowledge base contains,
 * loaded into the client LLM at session start (via MCP `instructions` and
 * the memory_query tool description). Without it the model has no signal
 * that memory might hold an answer, so it never thinks to look.
 */
export async function buildSeedMemory(kb: KnowledgeBase): Promise<string> {
  const [tree, types, log] = await Promise.all([kb.listTree(), kb.listTypes(), kb.readLog()]);

  const lines: string[] = [];
  renderTree(tree, "", lines);

  const recent = log
    .slice(0, 3)
    .map((e) => `- ${e.date} ${e.action}: ${e.summary}`);

  const sections = [
    `Concept types in use: ${types.join(", ") || "(none yet)"}`,
    `Contents:\n${lines.join("\n") || "(empty — nothing stored yet)"}`,
  ];
  if (recent.length > 0) sections.push(`Recent activity:\n${recent.join("\n")}`);

  let seed = sections.join("\n\n");
  if (seed.length > MAX_SEED_CHARS) {
    seed =
      seed.slice(0, MAX_SEED_CHARS) +
      "\n… (truncated — use memory_query to explore further)";
  }
  return seed;
}

function renderTree(node: TreeNode, indent: string, out: string[]): void {
  for (const child of node.children ?? []) {
    if (child.kind === "directory") {
      out.push(`${indent}${child.name}/`);
      renderTree(child, indent + "  ", out);
    } else if (child.kind === "concept") {
      const desc = child.description ?? child.title ?? "";
      out.push(`${indent}${child.name} [${child.type ?? "?"}]${desc ? ` — ${desc}` : ""}`);
    }
  }
}

/** The initialize `instructions` block — seed plus the instinct-igniting rules. */
export function seedInstructions(seed: string): string {
  return `This server is your persistent memory — an OKF knowledge base of markdown concepts that survives across sessions.

MEMORY OVERVIEW (as of session start):

${seed}

How to use your memory:
- BEFORE answering anything related to the topics above, call memory_query — the answer may already be stored. Prefer stored knowledge over guessing.
- When you learn a lasting fact, decision, preference, or piece of documentation, persist it with memory_add. If it isn't stored, it will be forgotten.
- When existing knowledge turns out to be wrong or outdated, fix it with memory_update.
- memory_status reports size and health of the memory.`;
}
