# Runner 1.5.4 Network Authentication Progress

Updated: 2026-07-21 America/Los_Angeles

## Objective

Implement and verify `/home/sandesh-tiwari/Desktop/C++/goal.txt` without changing
the canonical contract packages. Preserve local stdio while hardening networked
MCP authentication, transport, session identity, and client provisioning.

## Baseline

- Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`
- Branch created before edits: `security/runner-1.5.4-network-auth-hardening`
- Base commit: `4e27811a7c08458e8ed20cf0bcd6200370a7af9c`
- Base subject: `Ship Runner 1.5.3 safe action workflow`
- Base worktree: clean
- `origin/main`: same base commit
- GitHub CI on base: `ci`, `safe-action-ci`, `mcp-audit`, and Dependabot checks green
- npm on baseline: `@synapsor/runner` latest/next `1.5.3`; `1.5.4` available
- Local package versions:
  - monorepo `1.5.3`
  - `@synapsor/runner` `1.5.3`
  - `@synapsor/spec` `1.4.2`
  - `@synapsor/dsl` `1.4.3`
- Toolchain observed: Node `v22.22.2`, MCP SDK `1.29.0`, jose `6.2.3`
- No pushes, merges, tags, publishes, dist-tag changes, deployments, or AWS changes authorized.

## Current Phase

Implementation and verification complete. The branch is ready for user review
and an explicitly requested commit. Nothing has been committed, merged, pushed,
tagged, published, deployed, or changed in AWS/Cloud state.

## Initial Facts To Reproduce

- Stdio is the default and opens no HTTP listener.
- Streamable HTTP defaults to loopback and requires either static Bearer auth or
  signed `session_auth` when trusted context uses `http_claims`.
- Static Bearer comparison is timing-safe but currently has no explicit entropy
  policy or previous-token rotation input.
- `jwt_hs256` and `jwt_asymmetric` verification already exist.
- The server pins an auth fingerprint to each MCP session.
- Runner-owned TLS/mTLS exists.
- `--dev-no-auth` is loopback-only.
- Non-loopback cleartext currently warns rather than refusing startup.
- CORS, Origin/Host checks, request/session bounds, OAuth protected-resource
  metadata, and token-expiry behavior on existing sessions require source and
  runtime verification.

## Decisions

- Authentication remains Runner deployment configuration, not `@synapsor/spec`
  or `@synapsor/dsl` content.
- `1.5.4` is the release target because it is the next available SemVer patch.
- Runner is an MCP protected resource, not an identity provider. It must not gain
  password storage or refresh-token issuance.
- Preserve shared-token compatibility for loopback and explicit single-tenant
  deployments, but do not present it as per-user identity.
- Prefer asymmetric JWT/JWKS for shared production deployments.

## MCP Standard Baseline

- Official specification inspected: MCP `2025-11-25` Authorization:
  `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
  (source:
  `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/basic/authorization.mdx`).
- Official transport security inspected: MCP `2025-11-25` Transports:
  `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
  (source:
  `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/basic/transports.mdx`).
- Repository SDK: `@modelcontextprotocol/sdk@1.29.0`. Its RFC 9728 schema and
  `getOAuthProtectedResourceMetadataUrl()` helper match the current protected
  resource metadata model.
- HTTP authorization is optional for MCP generally, but an implementation that
  supports it should conform. Stdio should obtain credentials from its process
  environment rather than implement the HTTP OAuth flow.
- For OAuth-protected HTTP MCP, Runner is a resource server. It must advertise at
  least one external authorization server through RFC 9728 metadata and expose
  the metadata URL in a Bearer challenge and/or the current well-known path.
- For an endpoint at `/mcp`, the path-specific discovery endpoint is
  `/.well-known/oauth-protected-resource/mcp`; clients also probe the root
  fallback. The resource metadata must identify the exact protected resource.
- Every protected request carries an HTTP `Authorization: Bearer` credential.
  Tokens do not belong in query parameters. Invalid or expired credentials get
  401; insufficient scope gets 403. Runner must validate resource/audience and
  must not pass the token through to downstream services.
- Streamable HTTP servers must validate every present `Origin` header and return
  403 for an invalid origin. Local listeners should bind loopback, and MCP
  session IDs remain distinct from authentication.

## Threat-Model Delta

| Threat | Baseline control | Required 1.5.4 delta |
| --- | --- | --- |
| Anonymous network calls | HTTP auth defaults on; loopback-only no-auth | Preserve and test; prohibit no-auth on every non-loopback posture |
| Stolen/replayed static token | Timing-safe exact comparison | Minimum production entropy, active/previous bounded rotation, honest single-tenant labeling |
| Secret leakage | Environment-variable indirection and redacted diagnostics exist | Audit all startup/help/generator/error/tarball paths; never emit values |
| Remote cleartext Bearer use | No startup refusal | Refuse before bind unless direct TLS, explicit trusted proxy, or explicit authenticated break-glass |
| JWT confusion/drift | Provider-specific algorithm allowlists, exp, optional issuer/audience, bounded JWKS | Require issuer/audience for shared production, safe claims, metadata/resource/scopes, expiry on every session request |
| MCP session takeover | Token fingerprint pinned to session | Preserve; test active/previous rotation and identity/token swap explicitly |
| Model-controlled trusted context | `http_claims` maps only verified JWT claims | Preserve and test headers, query, `_meta`, tool args, and handles as non-authority |
| DNS rebinding/browser abuse | Optional CORS response header only | Exact Origin validation plus Host policy for direct listeners; explicit proxy assumptions |
| Compromised proxy headers | Forwarded headers are not current identity inputs | Keep them non-authoritative and require an explicit trusted-proxy posture |
| Resource exhaustion | 1 MiB body cap and some rate limits exist | Bound headers, request timeout, sessions, idle lifetime, and concurrent handshakes; stable safe errors |
| Fleet inconsistency | Shared runtime store supports fleet rate/ledger state | Keep per-session auth independent; document which limits become fleet-wide only with shared storage |
| Credential confusion | Cloud, operator, handler, DB, and MCP credentials are separate in code | Make distinctions explicit in help/docs and reject static token as shared tenant identity |

## Pre-Edit Implementation Audit

- `serveStdio` uses the SDK `StdioServerTransport` and does not start an HTTP
  listener.
- Both HTTP servers default to `127.0.0.1`, require Bearer auth by default, and
  reject `--dev-no-auth` off loopback.
- The legacy bridge rejects `http_claims`; Streamable HTTP chooses signed session
  JWTs whenever the runtime uses `http_claims`, otherwise the opaque token mode.
- Streamable sessions store an authentication fingerprint and reject a later
  request whose credential fingerprint differs.
- JWT verification already restricts HS256 versus RS256/ES256, requires `exp`,
  rejects private PEM material, uses HTTPS JWKS outside loopback, forbids JWKS
  redirects, and bounds JWKS time/size/cache behavior.
- Runner-owned TLS and optional mTLS already use Node HTTPS. Their combination
  with static/JWT authentication needs explicit profile semantics and regression
  coverage.
- Current gaps confirmed in source: remote cleartext is not refused, static
  token strength/previous-token rotation are absent, OAuth protected-resource
  metadata/challenges are absent, Origin is not validated, Host is not checked,
  and session count/idle lifetime are not bounded explicitly.
- `/healthz` and `/readyz` are handled before MCP authentication; `/metrics`
  has separate access configuration. Their disclosure remains in the focused
  security audit.

## Changed Files

- `development/runner-1.5.4-network-auth-progress.md` (this tracker)
- `packages/config/src/index.ts` and `packages/config/src/index.test.ts`
  (`http_security` validation, shared-profile invariants, focused tests)
- `schemas/synapsor.runner.schema.json` (deployment-only HTTP security schema)
- `packages/mcp-server/src/index.ts` and `packages/mcp-server/src/index.test.ts`
  (transport policy, token rotation, Origin/Host checks, RFC 9728 resource
  metadata/challenges, limits, TLS preflight, session reauthentication/tests)
- `packages/mcp-server/src/jwt-auth.ts` and `packages/mcp-server/src/jwt-auth.test.ts`
  (public-only JWKS validation and negative verification matrix)
- `apps/runner/src/cli.ts` (transport option forwarding, redacted doctor output,
  help, client provisioning, config-aware token-env precedence, and
  authenticated Runner-bundle HTTP recipes)
- `apps/runner/src/cli.test.ts` (redacted doctor and client-provisioning checks)
- `docs/http-mcp.md`, both Runner READMEs, client/production/security/config/
  fleet/database-scope/Cloud guides, and affected HTTP examples (one consistent
  deployment ladder; documentation alignment remains in progress)
- `examples/runner-fleet/*` and `scripts/verify-runner-fleet.mjs` (shared
  protected-resource configuration and ephemeral direct-TLS visual fixture)
- `scripts/verify-packed-network-auth.mjs` and root package script (independent
  tarball install plus opaque-token, remote-cleartext, TLS/JWT, RFC 9728,
  doctor-redaction, and packed-content verification)

## Verification Log

- `git status --short --branch`: clean base before branch creation.
- `git log -5 --oneline --decorate`: base confirmed.
- `npm view @synapsor/runner dist-tags versions --json`: latest/next `1.5.3`,
  `1.5.4` absent and available.
- `gh run list --branch main --limit 5 ...`: latest base workflows successful.
- Official MCP authorization and transport sources fetched successfully on
  2026-07-21; requirements above recorded before implementation.
- SDK declarations inspected from the installed `1.29.0` package, including
  `OAuthProtectedResourceMetadataSchema` and the resource-metadata URL helper.
- Baseline `corepack pnpm test:mcp-streamable`: PASS, 190/190 tests in 2 files
  (114.05 seconds). This includes the official SDK client transport, signed
  session isolation, JWT rotation, JWKS, and mTLS cases that existed in 1.5.3.
- Baseline `corepack pnpm verify:packed-runner`: PASS. The independently packed
  1.5.3 CLI, docs, client snippets, and install checks completed successfully.
- No pre-existing baseline failures were observed in either required baseline
  check. Any later failure in these scopes is therefore a regression until
  proven otherwise.
- Focused config/MCP/JWT test after core implementation:
  `corepack pnpm exec vitest run packages/mcp-server/src/jwt-auth.test.ts packages/config/src/index.test.ts packages/mcp-server/src/index.test.ts --reporter=dot`:
  PASS, 121/121 tests in 3 files (11.05 seconds).
- Focused cases now prove: remote cleartext refusal before bind; direct-TLS
  material requirement; trusted-proxy and authenticated break-glass postures;
  static active/previous rotation and session pinning; exact Origin/Host; body,
  header, and session-capacity bounds; RFC 9728 metadata and 401/403 challenge;
  official client interoperability; ES256 shared identity; unsafe claim denial;
  credential expiry on an existing session; JWKS cache/refresh, timeout,
  redirect, oversize, malformed JSON, private-key, unknown-kid, and unsafe-URL
  failure; mTLS valid/missing/wrong-CA/expired-client handling; invalid TLS
  material refusal.
- Focused config/MCP/JWT suite after the final in-flight handshake-capacity
  change: PASS, 122/122 tests in 3 files (11.48 seconds).
- Full CLI suite after doctor/client-generator changes:
  `corepack pnpm exec vitest run apps/runner/src/cli.test.ts --reporter=dot`:
  PASS, 116/116 tests (110.52 seconds).
- `examples/runner-fleet/synapsor.runner.json` validates with the expected
  synthetic-HS256 warning; its Compose YAML and ephemeral TLS entrypoint pass
  static syntax/config checks.
- Documentation audit found and corrected an OpenAI Agents TypeScript recipe
  that did not send the required Bearer header. The current `@openai/agents`
  0.13.5 declaration confirms `requestInit` is the supported Streamable HTTP
  option. Generated and checked examples now load the value only from env.
- Post-documentation build, focused CLI tests, and generated client-config
  verifier: PASS. The six selected CLI cases passed, all checked client files
  parsed and remained secret-free, stdio `tools/list` worked, and current Claude
  Code/Codex CLIs accepted the generated stdio configuration.
- Live npm registry on 2026-07-21 confirms Runner 1.5.3 was published at
  `2026-07-21T16:40:42.035Z`; release text now reflects that fact. Version 1.5.4
  remains absent.
- Final pre-bump focused suite:
  `vitest run packages/mcp-server/src/jwt-auth.test.ts packages/config/src/index.test.ts packages/mcp-server/src/index.test.ts apps/runner/src/cli.test.ts`:
  PASS, 238/238 tests in 4 files (123.32 seconds).
- Immediate registry check for `@synapsor/runner@1.5.4`: expected `E404`; the
  version remained available immediately before staging.
- Staged versions: monorepo and `@synapsor/runner` 1.5.4;
  `@synapsor/spec` 1.4.2 and `@synapsor/dsl` 1.4.3 unchanged.
- Pre-matrix release checks: both READMEs byte-identical; `git diff --check`,
  modified JSON parsing, fleet shell syntax, and Compose config all PASS; no
  runnable placeholder endpoint token or literal credential was found.
- `corepack pnpm build`: PASS at Runner 1.5.4.
- `corepack pnpm test`: initial run had 646/646 Vitest tests pass but correctly
  failed the 1,500-word README content gate at 1,521 words. The new boundary
  paragraph was compressed without removing a security invariant. Final-tree
  rerun: PASS, 646/646 plus license/content, DSL source paths, and Cursor plugin.
- `corepack pnpm test:mcp-streamable`: PASS, 203/203 tests. This includes the
  official SDK client, per-request signed reauthentication, session isolation,
  expiry, mTLS, and full CLI behavior.
- `corepack pnpm test:principal-scope`: PASS for PostgreSQL/MySQL and both DSL
  suffixes, including generic cross-scope denial and shared-ledger handles.
- `corepack pnpm test:database-scope`: PASS for independent PostgreSQL RLS,
  trusted scope binding, pool reset, guarded writes, compensation, and doctor.
- `corepack pnpm test:fleet`: first run exposed a derived local smoke config that
  inherited the new shared HTTP declaration after switching to `static_dev`.
  The fixture now explicitly declares loopback and removes only incompatible
  OAuth metadata while retaining the verifier needed by its later claims test.
  Final rerun: PASS across two Runners, shared locks/rate limits, quorum,
  worker/crash recovery, overload classification, and backup/restore/retention.
- `corepack pnpm test:mcp-client-configs`: PASS; generated examples are
  parseable, secret-free, semantic-only, and accepted by current Claude
  Code/Codex stdio clients.
- `corepack pnpm test:mcp-cloud-linked`: PASS from Runner registration and MCP
  proposal through Cloud approval/lease, guarded local write, and receipt.
- `corepack pnpm test:smoke`: PASS. The sequential release gate completed 366
  core tests, client checks, first-run Docker proof, public commands, local and
  packed Runner checks, packed own-database proof, content checks, and an npm
  dry-run for `@synapsor/runner@1.5.4` (253 files, 1.2 MB). Packed own-database
  timing was 8,164 ms to first proposal and 11,760 ms to first receipt.
- The first independent packed-network run exposed a real CLI/config precedence
  defect: startup eagerly supplied `SYNAPSOR_RUNNER_HTTP_TOKEN`, preventing
  `http_security.static_token.active_env` from taking effect. The CLI now uses
  explicit flag, then deployment config, then legacy default consistently;
  generated client config uses the same order. A focused CLI regression test
  covers configured env names on both HTTP servers and explicit CLI override.
- Focused token-env precedence tests: PASS, 2/2 selected tests (116 skipped).
  They cover both server startup paths, explicit server-env override, configured
  generated-client env references, and independent explicit client/server env
  overrides without embedding values.
- `corepack pnpm verify:packed-network-auth`: PASS from a scratch-installed
  1.5.4 tarball. Verified missing/wrong opaque Bearer denial, configured env-name
  use, pre-bind undeclared remote-cleartext refusal, direct TLS plus RS256 claims
  through the official MCP client, RFC 9728 metadata/challenge, redacted doctor
  posture, semantic-only tools, and absence of development state/stores/logs/
  certificate or key files from the tarball.
- Restored the previously withheld network-authentication material in
  `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md`. It now
  explains stdio versus HTTP, Bearer versus opaque/JWT credentials, token
  provisioning, TLS/mTLS, all deployment profiles, verified trusted-context
  binding, OAuth protected-resource discovery, rotation, limits, diagnostics,
  independent DB/operator authority, and the packed verifier command.
- Final-tree `corepack pnpm build`: PASS.
- Final-tree `corepack pnpm test`: PASS, 648/648 tests in 39 files plus
  license/content, DSL source-path, and Cursor plugin checks.
- Final-tree `corepack pnpm test:mcp-streamable`: PASS, 205/205 tests in the MCP
  server and complete Runner CLI suites.
- Final-tree `corepack pnpm test:mcp-client-configs`: PASS for generated generic,
  Claude Desktop, Cursor, VS Code, OpenAI Agents, Claude Code 2.1.217, and Codex
  0.144.6 configurations; files remained parseable, secret-free, and semantic-
  tool-only.
- Final-tree `corepack pnpm test:smoke`: PASS. The release gate reran 368/368
  selected core tests, all client checks, disposable Docker first-run proof,
  public commands, local and scratch-installed packed Runner, own-database
  proposal/approval/apply, content/license checks, and npm dry-run. The final
  tarball is `@synapsor/runner@1.5.4`, 1.2 MB packed, 5.5 MB unpacked, 253 files;
  final own-database timings were 8,692 ms to proposal and 12,580 ms to receipt.
- Final post-gate `corepack pnpm verify:packed-network-auth`: PASS again.
- Final static audit: `git diff --check` PASS; root/packaged READMEs are byte-
  identical; Markdown code fences in the external deep dive are balanced and no
  withheld-auth placeholder remains; no tracked canonical-package or lockfile
  change; no tarball/certificate/key/store/log artifact is tracked or packed.
- Final registry audit: latest/next remain 1.5.3 and `@synapsor/runner@1.5.4`
  still returns expected E404. Spec remains 1.4.2 and DSL remains 1.4.3.
- Resume completion audit on the unchanged final tree:
  - `corepack pnpm verify:packed-network-auth`: PASS again from a scratch install;
    loopback opaque Bearer denial/success, pre-bind remote-cleartext refusal,
    direct TLS plus RS256 identity through the official MCP client, RFC 9728
    metadata/challenge, redacted doctor output, semantic-only tools, and clean
    tarball contents were reproduced.
  - `corepack pnpm test`: PASS again, 648/648 tests in 39 files plus the
    license/content, DSL source-path, and Cursor plugin checks. The previously
    timing-sensitive signed-session isolation and cross-process SQLite writer
    contention tests both passed within their existing narrow timeouts.
  - `git diff --check`, README synchronization, modified JSON parsing, and the
    canonical-package/lockfile audit remain clean. No tracked certificate, key,
    database, log, or tarball artifact exists.
  - Live npm still reports Runner latest/next 1.5.3, spec 1.4.2, and DSL 1.4.3;
    Runner 1.5.4 remains unpublished and available.
  - Manual source review reconfirmed pre-bind channel enforcement, constant-time
    opaque-token comparison, per-request signed-token verification and session
    fingerprint pinning, exact Origin/Host checks, RFC 9728 scope challenges,
    bounded sessions/requests, public-only JWKS validation, config-aware token
    environment precedence, and separate metrics authorization.

## Acceptance Audit

- AC1-AC4: PASS - stdio unchanged; loopback auth defaults on; remote cleartext
  fails before bind; direct TLS and trusted proxy are enforced and diagnosed.
- AC5-AC8: PASS - shared mode requires signed per-session identity; JWT/session
  reauthentication and trusted-claim scope fail closed against swaps/expiry and
  every model-controlled alternate authority channel.
- AC9-AC11: PASS - RFC 9728 metadata/challenges, bounded static rotation,
  constant-time comparison, TLS/mTLS, Origin/Host/CORS, and resource limits are
  implemented and covered by negative/positive tests.
- AC12-AC14: PASS - cross-tenant/principal rows and resource handles remain
  isolated; operator/credential authority stays outside tools; database scope,
  overload, rate limits, fleet, and Cloud-linked behavior pass.
- AC15-AC16: PASS - generated clients use env references only, and all named
  documentation/help/example surfaces plus the external deep dive describe the
  same implemented deployment ladder with no auth draft placeholder.
- AC17-AC18: PASS - every required matrix command passed; the scratch-installed
  1.5.4 tarball independently reproduced the network profiles and is free of
  test auth/state material.
- AC19: PASS - `@synapsor/spec` and `@synapsor/dsl` are unchanged.
- AC20: PASS - no unauthorized external-state operation was performed.

## Implementation Shape

- Add one optional top-level Runner deployment block, `http_security`. It is
  runtime wiring and remains outside canonical contracts.
- Use explicit deployment (`loopback`, `single_tenant`, or `shared`) and channel
  (`direct_tls`, `trusted_tls_proxy`, or `insecure_http_break_glass`) labels.
  Direct TLS may also be inferred from actual TLS material, but remote cleartext
  may never be inferred as safe.
- Keep existing `--auth-token-env` compatibility. Add only environment-variable
  names for an optional previous opaque token; never accept a literal token.
- Use the existing `session_auth` verifier and `http_claims` trusted-context
  model. RFC 9728 metadata adds resource-server discovery, not another identity
  or token-issuing system.
- Validate present browser Origin values exactly. Native MCP clients may omit
  Origin. Validate Host independently and do not trust forwarded identity or
  forwarded host headers.

## Blockers

None.

## Next Exact Action

Await explicit user authorization to commit and, separately, to merge/push or
publish. Before any publish, rerun the registry availability check and the
established prepack/release gate; do not republish spec or DSL for this change.
