# Security and Reliability Remediation Plan

This plan addresses the filesystem containment, authentication, network exposure, data-integrity, and deployment-hardening findings from the project review.

**Cost and abuse controls are out of scope here** — rate limits, LLM concurrency caps, and provider spend ceilings are handled on the operator side (nginx `limit_req`, firewall, API keys, provider dashboards).

The work is divided into three reviewable phases so that critical protections can land first without being mixed with broader refactors.

## Scope boundaries

| Area | In scope | Unchanged |
|------|----------|-----------|
| `packages/core` agent, search, graph, lint, validate | — | Tool loop, OKF semantics, mutation queue |
| `packages/core` `Bundle` / indexer / logger I/O | Path sandbox, symlink checks, atomic writes | Concept frontmatter rules, index/log format |
| `packages/server` | Auth, CORS, host bind, strip `raw` from `/api/concept` | Route shapes, MCP tool names |
| `packages/web` | Token-entry screen, bearer headers | Browse/chat UX |
| Operator (nginx, provider) | Rate limits, timeouts, cost caps | — |

Phase 1 tightens the **filesystem boundary** in core; it does not change what the agent does or how OKF concepts are structured. Phases 2+ touch server and web only.

## Target deployment

**nginx** terminates TLS for the public URL **`https://kb.cooperdesign.org`**. Understory runs on a separate host at **`192.168.3.16:3800`** on the LAN; nginx `proxy_pass`es to that upstream. Port `3800` must not be exposed to the internet — only nginx (and trusted LAN clients, if any) should reach it.

```
Internet ──TLS──► nginx (kb.cooperdesign.org:443)
                      │
                      └── proxy_pass ──► understory (192.168.3.16:3800)
                                            ├── /        web UI (static)
                                            ├── /api/*   REST browse + chat
                                            └── /mcp     streamable HTTP MCP
```

Implications for this plan:

- **Authentication is mandatory** — the service is internet-reachable once proxied through nginx.
- **Understory host (`192.168.3.16`)** — bind `3800` only on the LAN interface (or firewall so only the nginx host can connect). Do not port-forward `3800` to the internet.
- **CORS is usually same-origin** — when the web UI and API are both served at `https://kb.cooperdesign.org`, browser requests are same-origin and do not need `CORS_ORIGINS`. Set `CORS_ORIGINS` only if a separate origin (e.g. a local dev UI) must call the API.
- **Trust proxy headers** — audit logs (Phase 4) should use the client IP from `X-Forwarded-For` (via Express `trust proxy`) when requests arrive through nginx. Rate limiting is handled at nginx if desired.
- **nginx must support streaming** — `/api/chat` and `/mcp` use long-lived responses; disable buffering and allow large timeouts on those locations.

Reference nginx locations (on the nginx host — tune timeouts and cert paths):

```nginx
upstream understory {
    server 192.168.3.16:3800;
    keepalive 8;
}

server {
    listen 443 ssl http2;
    server_name kb.cooperdesign.org;

    # ssl_certificate / ssl_certificate_key — managed on the nginx host

    location / {
        proxy_pass http://understory;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Streaming chat + MCP — no response buffering
    location ~ ^/(api/chat|mcp) {
        proxy_pass http://understory;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Example production environment (Docker Compose on **`192.168.3.16`**, the understory host):

```yaml
services:
  understory:
    ports:
      - "192.168.3.16:3800:3800"   # LAN only — reachable by nginx, not the public internet
    environment:
      HOST: 0.0.0.0                   # listen inside the container
      API_BEARER_TOKEN: ${API_BEARER_TOKEN}
      BUNDLE_ROOT: /bundle
      TRUST_PROXY: "true"             # honor X-Forwarded-* from nginx
      # CORS_ORIGINS unset — same-origin at https://kb.cooperdesign.org
```

MCP clients register against the public URL:

```bash
claude mcp add --transport http ustory https://kb.cooperdesign.org/mcp
# Authorization: Bearer <API_BEARER_TOKEN> — required once Phase 2 lands
```

## Phase 1 — Filesystem Containment

### 1. Refactor bundle path handling

Update `packages/core/src/okf/bundle.ts`:

- Remove the "already OS-absolute path" fast path.
- Accept only virtual bundle paths such as `/tables/customers.md`.
- Reject NUL bytes, `..` segments, platform separators, and ambiguous absolute filesystem paths.
- Keep conversion from internal absolute walk paths in a separate private method.
- Normalize paths before performing containment checks.

### 2. Add symlink protection

- Resolve the real bundle root once.
- For reads, verify that the target's `realpath` is inside the real bundle root.
- For writes, verify every existing parent component is a real directory and not a symlink.
- Reject a destination that is already a symlink.
- Write through a temporary file in the verified directory and atomically rename it.
- Apply equivalent checks to generated `index.md`, `log.md`, and `.traces` files.

### 3. Restrict concept reads

- Make `readConcept()` validate the `.md` suffix.
- Explicitly define whether reserved `index.md` and `log.md` files are readable.
- Do not return the internal `raw` field from `/api/concept`; return only the path, frontmatter, and body.

### 4. Add containment regression tests

Extend `packages/core/test/okf.test.ts` with coverage for:

- `/bundle/../etc/passwd`
- `/bundle/sub/../../outside`
- `/../../etc/passwd`
- Absolute paths both inside and outside the bundle root
- Symlinked file reads, writes, and deletes
- Symlinked parent directories
- Symlinked `index.md`, `log.md`, and `.traces`
- Nonexistent nested write paths
- Destination replacement and TOCTOU-oriented cases where practical
- Valid nested bundle paths

### Acceptance criterion

No public `Bundle` operation can read, write, list, or delete anything outside the real bundle root.

## Phase 2 — Authentication and Safe Network Defaults

### 1. Add server security configuration

- Add `HOST`, defaulting to `127.0.0.1`.
- Add `API_BEARER_TOKEN` (required for the `kb.cooperdesign.org` deployment).
- Add `CORS_ORIGINS`, empty by default (same-origin at `https://kb.cooperdesign.org` needs no extra origins).
- Add `TRUST_PROXY` (or equivalent) so `X-Forwarded-For` / `X-Forwarded-Proto` from nginx are honored for client IP and secure-context checks.
- Fail startup if `HOST` is non-loopback and no bearer token is configured, unless an explicit unsafe override is provided.
- For the nginx-backed production layout: TLS terminates at nginx (`kb.cooperdesign.org`); understory on `192.168.3.16` does not terminate TLS. `API_BEARER_TOKEN` is required because `3800` is reachable on the LAN.

### 2. Protect `/api` and `/mcp`

- Add authentication middleware before both route groups.
- Require `Authorization: Bearer <token>`.
- Compare tokens using `crypto.timingSafeEqual`.
- Return a generic `401` response and never log the supplied token.
- Protect `/api/config` as well unless it is deliberately redesigned as a public endpoint.

### 3. Replace reflected CORS

- Allow same-origin requests by default (covers the web UI at `https://kb.cooperdesign.org`).
- Allow only exact origins configured through `CORS_ORIGINS` (e.g. `http://localhost:5180` for local Vite dev against a remote API).
- Do not combine wildcard origins with authorization.
- Permit MCP-specific headers (`Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`) only for approved origins when cross-origin MCP is needed.

### 4. Update the web UI

- Add a token-entry screen.
- Keep the token in memory or `sessionStorage`, not `localStorage`.
- Attach the bearer token to browse and chat requests.
- Clear the token and return to the authentication screen after a `401` response.

### 5. Update deployment defaults

- Direct server execution should default to `HOST=127.0.0.1`.
- Docker should set `HOST=0.0.0.0` inside the container.
- **Production (`kb.cooperdesign.org`)** — understory on `192.168.3.16` publishes `192.168.3.16:3800:3800`; nginx `proxy_pass`es to `http://192.168.3.16:3800`.
- **Local / single-host dev** — Compose may use `127.0.0.1:3800:3800` when nginx and understory share one machine.
- Do not publish `3800:3800` on all interfaces on an internet-facing host without nginx in front.
- Restrict `192.168.3.16:3800` at the firewall to the nginx host where possible.
- Document the nginx reverse-proxy layout: TLS at `kb.cooperdesign.org`, `proxy_pass` to `192.168.3.16:3800`, streaming locations for `/api/chat` and `/mcp`, and forwarding `X-Forwarded-*` headers.
- Serve the SPA and API under one public origin so the token-entry UI and bearer-protected routes share `https://kb.cooperdesign.org` without CORS friction.

### Acceptance criterion

Requests without the correct bearer token cannot read memory or traces, invoke chat, or initialize and call MCP — including through `https://kb.cooperdesign.org`.

## Phase 3 — Integrity and Deployment Hardening

### 1. Make mutations consistent

- Generate concept, index, and log outputs before committing changes.
- Stage files in their destination directories.
- Atomically rename staged files only after all generation succeeds.
- Preserve backups or implement rollback if a rename fails.
- For deletion, move the concept to a temporary tombstone until index and log updates succeed.

### 2. Sanitize generated Markdown

- Disallow newlines in titles and descriptions.
- Escape Markdown link-label characters.
- Normalize log summaries to one line.
- Keep structured log metadata under application control rather than trusting model-formatted prose.

### 3. Add centralized error handling

- Set `NODE_ENV=production` in Docker.
- Return stable JSON error codes.
- Do not expose stack traces or local filesystem paths.
- Add request IDs.
- Record security-relevant audit events without recording bearer tokens.

### 4. Harden Docker

- Create `/bundle` and assign it to the non-root `node` user.
- Run the application with `USER node`.
- Add a health check.
- Drop Linux capabilities and enable `no-new-privileges`.
- Support a read-only root filesystem.
- Document bind-mount ownership requirements.

### 5. Parameterize infrastructure

- Remove the hardcoded `192.168.1.101` address.
- Require `LLAMACPP_BASE_URL` or use a non-network default.
- Add an `.env.example` containing safe defaults.

### 6. Update security documentation

- State that authentication is mandatory for internet exposure (including `https://kb.cooperdesign.org`).
- Provide three deployment examples:
  - **Localhost** — `HOST=127.0.0.1`, optional dev token, no nginx.
  - **nginx reverse proxy (production)** — `kb.cooperdesign.org` → `192.168.3.16:3800`, `API_BEARER_TOKEN` required, sample nginx config, MCP URL `https://kb.cooperdesign.org/mcp`.
  - **Trusted-LAN direct** — explicit opt-in only; not used for this host.
- Explain bearer-token rotation and trace sensitivity.
- Add a security-reporting section.

## Verification Matrix

Before release, run:

- Core unit tests for lexical and realpath containment.
- Server integration tests for authentication and CORS.
- Smoke test through nginx: `https://kb.cooperdesign.org` → upstream `192.168.3.16:3800`, streaming `/api/chat`, MCP initialize with bearer token, and `X-Forwarded-For` propagation.
- HTTP tests covering every `/api` route.
- MCP initialize, list, read, and mutation tests with missing, invalid, and valid tokens.
- Docker tests as a non-root user with named volumes and bind mounts.
- Concurrent mutation and failure-injection tests.
- Dependency audit, full build, typecheck, lint, and unit tests.
- A local adversarial PoC suite proving that traversal and symlink attacks fail.

## Release Gate

Do not operate `https://kb.cooperdesign.org` (or publish a new internet-reachable image) until Phases 1 and 2 are complete. Phase 3 (integrity + Docker hardening) should follow immediately afterward; non-root Docker execution should ideally ship with the initial security release.

**Operator-side controls (not in this repo):** nginx `limit_req` on `/api/chat` and `/mcp`, provider API keys and spend limits, firewall rules on `192.168.3.16:3800`.
