# Security and Reliability Remediation Plan

This plan addresses the filesystem containment, authentication, network exposure, cost-control, data-integrity, and deployment-hardening findings from the project review.

The work is divided into four reviewable phases so that critical protections can land first without being mixed with broader refactors.

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
- Add `API_BEARER_TOKEN`.
- Add `CORS_ORIGINS`, empty by default.
- Fail startup if `HOST` is non-loopback and no bearer token is configured, unless an explicit unsafe override is provided.

### 2. Protect `/api` and `/mcp`

- Add authentication middleware before both route groups.
- Require `Authorization: Bearer <token>`.
- Compare tokens using `crypto.timingSafeEqual`.
- Return a generic `401` response and never log the supplied token.
- Protect `/api/config` as well unless it is deliberately redesigned as a public endpoint.

### 3. Replace reflected CORS

- Allow same-origin requests by default.
- Allow only exact origins configured through `CORS_ORIGINS`.
- Do not combine wildcard origins with authorization.
- Permit MCP-specific headers only for approved origins.

### 4. Update the web UI

- Add a token-entry screen.
- Keep the token in memory or `sessionStorage`, not `localStorage`.
- Attach the bearer token to browse and chat requests.
- Clear the token and return to the authentication screen after a `401` response.

### 5. Update deployment defaults

- Direct server execution should default to `HOST=127.0.0.1`.
- Docker should set `HOST=0.0.0.0` inside the container.
- Compose should publish `127.0.0.1:3800:3800` by default.
- Trusted-LAN exposure should require an explicit Compose configuration change.
- Document TLS requirements when using a reverse proxy.

### Acceptance criterion

Requests without the correct bearer token cannot read memory or traces, invoke chat, or initialize and call MCP.

## Phase 3 — Abuse and Cost Controls

### 1. Validate chat requests

Use Zod in `packages/server/src/api/chat.ts` to validate:

- `messages` as a required array with a sensible maximum count.
- Per-message and aggregate text length.
- `provider` against the configured provider enum.
- `model` against a provider-specific allowlist, or remove it from public input.
- Supported message-part types.
- Unknown fields, which should be rejected.

### 2. Reduce request-size limits

- Reduce the global JSON limit from 4 MB to approximately 256 KB.
- Apply a smaller aggregate text limit to chat and LLM-backed MCP calls.

### 3. Add rate limiting

- Apply moderate per-token and per-IP limits to browse endpoints.
- Apply strict limits to chat.
- Apply moderate limits to deterministic MCP read tools.
- Apply strict limits to MCP mutation and LLM-backed tools.
- Return `429 Too Many Requests` with `Retry-After`.

### 4. Add resource controls

- Add a global LLM concurrency semaphore.
- Add a per-token concurrency limit.
- Set a maximum pending queue length.
- Add provider request timeouts.
- Abort generation when the HTTP client disconnects.
- Configure maximum output-token limits.
- Add optional request or daily cost ceilings where provider accounting permits them.

### 5. Limit deterministic workload amplification

- Cache tree, type, validation, and graph results.
- Invalidate caches after successful mutations.
- Cap individual trace size and total trace storage.
- Avoid rebuilding MCP seed data for requests that do not require it.

### Acceptance criterion

A single client cannot create unlimited concurrent model calls, an unbounded work queue, or unbounded trace storage.

## Phase 4 — Integrity and Deployment Hardening

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

- State that authentication is mandatory for LAN exposure.
- Provide localhost, trusted-LAN, and reverse-proxy examples.
- Explain bearer-token rotation and trace sensitivity.
- Add a security-reporting section.

## Verification Matrix

Before release, run:

- Core unit tests for lexical and realpath containment.
- Server integration tests for authentication, CORS, validation, and rate limiting.
- HTTP tests covering every `/api` route.
- MCP initialize, list, read, and mutation tests with missing, invalid, and valid tokens.
- Docker tests as a non-root user with named volumes and bind mounts.
- Concurrent mutation and failure-injection tests.
- Dependency audit, full build, typecheck, lint, and unit tests.
- A local adversarial PoC suite proving that traversal and symlink attacks fail.

## Release Gate

Do not publish or operate a new internet-reachable image until Phases 1 through 3 are complete. Phase 4 should follow immediately afterward; non-root Docker execution should ideally ship with the initial security release.
