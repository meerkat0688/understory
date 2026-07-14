const GLOBAL_LIMIT = Math.max(1, Number(process.env.LLM_CONCURRENCY || 4));
const PER_CLIENT_LIMIT = Math.max(1, Number(process.env.LLM_PER_TOKEN_CONCURRENCY || 2));
const MAX_QUEUE = Math.max(0, Number(process.env.LLM_MAX_QUEUE || 20));

let active = 0;
let pending = 0;
const clients = new Map<string, number>();
const waiters: (() => void)[] = [];

export async function acquireLlmSlot(client: string): Promise<() => void> {
  if (pending >= MAX_QUEUE) throw Object.assign(new Error("LLM queue full"), { status: 429 });
  while (active >= GLOBAL_LIMIT || (clients.get(client) || 0) >= PER_CLIENT_LIMIT) {
    pending++;
    await new Promise<void>((resolve) => waiters.push(resolve));
    pending--;
  }
  active++;
  clients.set(client, (clients.get(client) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const left = (clients.get(client) || 1) - 1;
    if (left) clients.set(client, left); else clients.delete(client);
    for (const wake of waiters.splice(0)) wake();
  };
}

export async function withLlmSlot<T>(client: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLlmSlot(client);
  try { return await fn(); } finally { release(); }
}
