---
name: BundleIndex design review
overview: "Revision 4 (decision-complete): ONE RULE each for freshness, path-set, and v1 scope. Ordinary reads auto-reconcile with path inventory; refresh() full-rebuilds including path rediscovery; applyConceptDelta deferred past v1."
todos:
  - id: remove-double-scan
    content: Derive existingTypes from listTree in seed + promptContext; leave listTypes API intact
    status: completed
  - id: extract-outbound-links
    content: Add extractOutboundLinks(body); use in graph + validate; lint keeps consuming scanGraph
    status: completed
  - id: bundle-index-v1
    content: Private BundleIndex with minimal snapshot, ensureReady (auto-reconcile), refresh (full rebuild), getIndexVersion
    status: completed
  - id: wire-readers
    content: Route listTree, listTypes, search, graph, lint, validate through snapshot; preserve per-API semantics
    status: completed
  - id: mutation-invalidate
    content: After KB write/patch/delete, invalidate and full-rebuild snapshot (no deltas in v1)
    status: completed
  - id: reconcile-pathset
    content: Both ensureReady reconcile and refresh() start with concept path inventory; then mtime+size; hash fallback
    status: pending
  - id: tests
    content: Double-scan, freshness (incl. external add/delete/rename), concurrency, and existing behavior regressions
    status: completed
isProject: false
---

# BundleIndex plan revision 4 (decision-complete)

## Decision-complete: three one-rules

These close the remaining review gaps. Implementers must not invent a fourth interpretation.

| # | ONE RULE |
|---|----------|
| **1. Freshness** | **All ordinary `KnowledgeBase` multi-concept reads auto-reconcile.** `listTree()`, `listTypes()`, `search()`, `validate()`, `lint()`, and `graph()` each call internal `ensureReady()` (build or reconcile against disk) before serving. Seed, `promptContext`, browse, MCP status, and agent tools **must not** call `refresh()` first and **must not** be allowed to see a known-stale snapshot. There is no “may serve stale” ordinary-read path. |
| **2. Path-set** | **Every freshness path starts with a directory path inventory.** Both `ensureReady()` reconcile and `refresh()` begin by rediscovering the current concept path set (`listConceptPaths()` / equivalent walk). New files, deletes, and renames are detected from that set difference — never only from `mtimeMs`/`size`/`hash` on previously indexed paths. |
| **3. V1 scope** | **V1 is full-rebuild only.** After KB mutations: invalidate → full rebuild. **`applyConceptDelta` is not in v1** and must not appear in the first implementation sequence. Deltas are a later release. |

`refresh()` = force full rebuild (path inventory + re-parse every concept), bypassing dirty heuristics. Optional for operators/tests; **not** required for ordinary consumers.

`getIndexVersion()` = for layers that cache *derived* strings (e.g. seed text held across time), not a substitute for auto-reconcile on KB reads.

`readConcept()` = single-file read via `Bundle` (always fresh from disk). Not routed through the snapshot in v1.

---

## Summary

Private, disposable `BundleIndex` owned by [`KnowledgeBase`](packages/core/src/okf/knowledge-base.ts). First optimization: remove `listTree()` + `listTypes()` double scan. Then ship full-rebuild snapshot with the freshness rules above.

OKF spirit: Markdown remains source of truth. [OKF SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

---

## Implementation changes

### 1. Remove the free double-scan now

- Build `existingTypes` from `listTree()` where metadata is already available.
- Leave `listTypes()` as a public API; stop using it on the hot path when `tree` already exists.
- Touch points: [`packages/server/src/mcp/seed.ts`](packages/server/src/mcp/seed.ts), [`packages/core/src/agent/agent.ts`](packages/core/src/agent/agent.ts) (`promptContext`).

### 2. Freshness (implements ONE RULE 1)

```text
seed / promptContext / browse / MCP / agent tools
        │
        ▼
KnowledgeBase.listTree | listTypes | search | validate | lint | graph
        │
        ▼
ensureReady()  ──►  no snapshot? full rebuild
               ──►  has snapshot? reconcile (ONE RULE 2)
        │
        ▼
serve from atomically swapped snapshot
```

| Method | Guaranteed fresh vs disk? | Caller must `refresh()`? |
|--------|---------------------------|--------------------------|
| `listTree`, `listTypes`, `search`, `validate`, `lint`, `graph` | Yes (via `ensureReady` reconcile) | **No** |
| `readConcept` | Yes (direct Bundle read) | **No** |
| `refresh()` | Yes (forced full rebuild) | N/A (it *is* the force path) |
| `getIndexVersion()` | N/A (metadata only) | N/A |

Concurrent `ensureReady()` / rebuilds coalesce on one shared promise. Never expose a partially updated snapshot.

### 3. Minimal snapshot (v1)

Store: `path`, `frontmatter`, `body`, `outboundLinks`, `mtimeMs`, `size`, optional `error`. No `normalizedText`.

### 4. Preserve current API-specific semantics

| API | Bad/unreadable file |
|-----|---------------------|
| search / `listTypes()` | skip |
| `listTree()` | list concept; empty meta if parse fails |
| graph / lint | emit nodes or warnings where possible |
| validate | report parse errors |

Reserved `index.md` / `log.md` excluded. Preserve ordering.

### 5. Share link extraction

- Add `extractOutboundLinks(body)`.
- **Reuse in graph and validate only.**
- **`lint` continues to consume `scanGraph`** (no separate lint regex path).

### 6. Mutations in v1 (implements ONE RULE 3)

After successful `writeConcept` / `patchConcept` / `deleteConcept`:

1. Filesystem mutation + existing `index.md` / log side effects.
2. Invalidate snapshot (or immediate full rebuild).
3. Bump `version` when the new snapshot is installed.

**Do not implement `applyConceptDelta` in v1.**

### 7. Path inventory + reconcile (implements ONE RULE 2)

**`ensureReady()` reconcile:**

```text
1. listConceptPaths()     → current path set   // REQUIRED; discovers add/delete/rename
2. removed = snapshot − current
3. added   = current − snapshot
4. for intersection: dirty if mtimeMs/size differ; else optional content-hash if suspicious
5. rebuild dirty + added; drop removed; recompute types + inboundLinks
6. atomic swap; version++ if changed
```

**`refresh()` full rebuild:**

```text
1. listConceptPaths()     → current path set   // same inventory step; not “re-stat known paths only”
2. parse every concept on that set
3. rebuild types + inboundLinks from scratch
4. atomic swap; version++
```

### 8. Defer watchers

No `fs.watch` / `chokidar` in v1.

### 9. Public API

`BundleIndex` stays private. Callers use KB methods. New: `refresh()`, `getIndexVersion()`.

---

## Rollout order (v1 — no deltas)

```text
0. Derive types from listTree in seed + promptContext
1. extractOutboundLinks (graph + validate); lint stays on scanGraph
2. BundleIndex: full rebuild + ensureReady(reconcile with path inventory) + refresh(full rebuild with path inventory) + getIndexVersion
3. Wire listTree / listTypes / graph / lint / validate / search through snapshot
4. On KB mutation: invalidate + full rebuild
5. Tests
── v1 ship line ──
6. Later: applyConceptDelta; benchmarks; watcher / inverted index / SQLite if measured need
```

---

## Test plan

- Double-scan removal in seed / promptContext.
- External edit visible on next ordinary read (no `refresh()`).
- External **add / delete / rename** visible on next ordinary read.
- `refresh()` full rebuild still works.
- Same-size rewrite detected via hash when stats look unchanged.
- Concurrent `ensureReady()` coalesces; no partial snapshot; mutation queue consistency.
- **No `applyConceptDelta` tests in v1** — mutation tests assert post-write visibility after full rebuild.
- Existing: search ranking, validate, graph dedupe, reserved files, mutation serialization.

---

## Out of scope (v1)

- `applyConceptDelta`
- Watchers, SQLite, embeddings, persistent sidecars
- Feeding `regenerateIndexChain` from the snapshot
