export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: TreeNode[];
}

export interface Concept {
  path: string;
  frontmatter: Record<string, unknown> & { type: string };
  body: string;
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface LogEntry {
  date: string;
  action: "Creation" | "Update" | "Deletion";
  summary: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export interface AppConfig {
  providers: string[];
  defaultProvider: string;
  defaultModel: string;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  tree: () => get<TreeNode>("/api/tree"),
  concept: (path: string) => get<Concept>(`/api/concept?path=${encodeURIComponent(path)}`),
  search: (q: string) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  log: () => get<LogEntry[]>("/api/log"),
  validate: () => get<ConformanceReport>("/api/validate"),
  config: () => get<AppConfig>("/api/config"),
};
