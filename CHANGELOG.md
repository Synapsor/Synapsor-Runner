# Changelog

## 1.1.1 (prepared, not published)

### Resource Read Authorization

- Reauthorizes local MCP proposal, evidence, and replay reads against the
  owning capability's trusted tenant and principal before returning content.
- Returns the same generic `RESOURCE_NOT_FOUND` result for missing resources,
  cross-tenant access, cross-principal access, and incomplete legacy ownership
  metadata so a leaked handle does not become bearer authority.
- Adds shared-store and Streamable HTTP regressions proving owner access still
  works while cross-session resource reads fail closed.
- Stages only `@synapsor/runner@1.1.1`; canonical Spec and DSL remain `1.1.0`.

## 1.1.0

### Fleet Safety And Operations

- Fails closed when claim-authenticated HTTP serving resolves an
  environment/static contract context, and fixes object-filtered activity so
  unrelated receipts cannot enter results.
- Adds RS256/ES256 session and operator JWT verification with bounded JWKS or
  public-PEM loading, plus verified operator attestations without bearer-token
  persistence.
- Adds dependency-aware `/readyz`, separately protected `/metrics`, reusable
  bounded Postgres/MySQL pools, and trusted tenant/capability fixed-window rate
  limits that are atomic in shared runtime-store mode.
- Adds optional canonical `required_approvals` and DSL `REQUIRE n APPROVALS`,
  distinct-reviewer enforcement, `n/N` progress, terminal rejection, and
  policy-auto-approval deferral for multi-human quorum.
- Hardens shared Postgres migration startup, bounds the transient bridge with
  `max_entries`, makes CLI/UI reviewers read the shared queue, and fixes nested
  worker/apply bridge locking.
- Adds verified dead-letter list/show/requeue/discard, shared-ledger
  backup/digest/restore, archive-before-retention, and a repeatable two-Runner
  kill/recovery test over synthetic Postgres/MySQL.
- Stages `@synapsor/spec@1.1.0`, `@synapsor/dsl@1.1.0`, and
  `@synapsor/runner@1.1.0`. Nothing is published by this change.

## 1.0.0

### Production Approval Loop

- Adds `apply --all-approved --yes` with per-proposal results, conflict
  isolation, idempotent reruns, and `--capability`, `--tenant`, and `--max`
  filters.
- Adds canonical aggregate auto-approval limits in `@synapsor/spec`, DSL
  `LIMIT` clauses, reviewer-visible limit trip events, and doctor/tool preview
  surfacing.
- Adds signed operator identity checks for approve/reject/apply while keeping
  dev env identity available for local experiments.
- Adds structured operational logs, per-tenant/capability counters, supervised
  writeback worker retries/dead letters, and continued owner-only local store
  permission tests.
- Adds Postgres shared ledger support, runtime-store mode, per-session
  HTTP-claims trusted context, managed secret hydration, token rotation hooks,
  and Streamable HTTP mTLS.
- Declares the first semver contract for the documented CLI, schema, contract,
  MCP result, writeback, approval, metrics, and replay surfaces.
- Stages `@synapsor/spec@1.0.0`, `@synapsor/dsl@1.0.0`, and
  `@synapsor/runner@1.0.0`.

## 0.1.16

### Fleet-Lab Runner Hardening

- Preserves native Postgres timestamp precision from scoped reads through
  evidence, proposals, conflict guards, and guarded writeback.
- Keeps conflicts immutable and inspectable while allowing a freshly based
  successor proposal for the same object.
- Returns `PROPOSAL_ALREADY_EXISTS` with the active proposal id/state instead
  of a generic `INTERNAL` error, and emits a matching structured log event.
- Rejects DSL `LOOKUP ... BY` columns that differ from the declared primary key
  instead of silently changing contract meaning.
- Uses administrator-created receipt tables with least-privilege steady-state
  writer grants; doctor/apply no longer require schema `CREATE`.
- Aligns audit contract-path resolution, Runner JSON Schema, owner-only local
  store permissions, CLI help, and reference documentation with runtime
  behavior.
- Stages `@synapsor/dsl@0.1.6` and `@synapsor/runner@0.1.16`;
  `@synapsor/spec` remains `0.1.4` because canonical contract semantics did not
  change.

## 0.1.15

### Editor-Friendly DSL Source Files

- Prefers `.synapsor.sql` for DSL source files so editors can provide generic
  SQL highlighting while keeping `.synapsor` backward compatible.
- Keeps DSL semantics, Runner behavior, and generated canonical JSON unchanged.
- Stages `@synapsor/dsl@0.1.5` and `@synapsor/runner@0.1.15`.

## 0.1.14

### README Path Polish

- Makes the audit, demo, and staging-database adoption sequence explicit for
  readers scanning the first minute of the README.
- Trims the inline JSON example to the reviewed capability entry and links the
  generated storage, source, trusted-context, and timeout wiring to the full
  own-database guide.
- Stages `@synapsor/runner@0.1.14`; `@synapsor/spec` and `@synapsor/dsl` remain
  unchanged for that release.

## 0.1.13

### Front-Door Documentation

- Rewrites the GitHub and npm READMEs around an audit-first 60-second proof,
  one staging-database path, and direct links to task-specific documentation.
- Adds a trust and verification section that links the threat model,
  conformance fixtures, live Postgres/MySQL apply smoke, and Cloud/C++
  contract round-trip evidence.
- Untracks internal progress files, preserves them under the ignored local
  notes directory, and adds ignore guards so session state cannot return to the
  public repository root.
- Stages `@synapsor/runner@0.1.13`; `@synapsor/spec` and `@synapsor/dsl` remain
  unchanged.

## 0.1.12

### Runner Version Invocation

- Stages `@synapsor/runner@0.1.12` without changing or republishing
  `@synapsor/spec@0.1.4` or `@synapsor/dsl@0.1.4`.
- Keeps `--version`, `-v`, and `version` stable when an npm/npx wrapper forwards
  a duplicated `synapsor-runner` executable token.
- Reads the Runner version from bundled package metadata instead of the
  invoking project's ambient `npm_package_version` value.
- Adds source-wrapper and installed-tarball checks for every supported version
  form and the duplicated-token regression shape.

## 0.1.11

### Cloud Adoption Loop

- Publishes `@synapsor/spec@0.1.4`, `@synapsor/dsl@0.1.4`, and
  `@synapsor/runner@0.1.11`.
- Adds a seven-file MCP client bundle for Claude Desktop, Cursor, OpenAI Agents
  SDK, and generic stdio/Streamable HTTP clients, including OpenAI-safe tool
  aliases.
- Productizes local and Cloud-generated Runner bundles with placeholder env
  wiring, validation/run instructions, and no embedded credentials or rows.
- Adds a network-free adoption quickstart verifier and a real local
  Runner-to-Cloud-to-ZIP-to-Runner verification path around the flagship
  `support-plan-credit` contract.
- Documents the Cloud registry/version/bundle loop and avoids implying managed
  runner fleets, SAML/SCIM, hosted policy enforcement, or enterprise SLA.
- Adds `SYNAPSOR_CLOUD_WORKSPACE` support and explicit Cloud push failure tests
  for authorization, validation, conflict, server, and network outcomes.
- Corrects `cloud push --help` so it describes the implemented authenticated
  upload path and the network-free dry-run instead of the removed pre-registry
  limitation.

## 0.1.10

### Policy Auto-Approval

- Stages `@synapsor/spec@0.1.3`, `@synapsor/dsl@0.1.3`, and
  `@synapsor/runner@0.1.10` for policy-based local approval.
- Adds portable proposal approval `policy` references and typed approval policy
  rules to the canonical contract.
- Adds DSL `AUTO APPROVE WHEN field <= integer` clauses that compile to
  reviewed approval policies.
- Adds a conformance fixture for policy auto-approval thresholds.

## 0.1.9

### CLI Hygiene

- Adds top-level `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` output so published package checks do not look like
  an unknown command.

## 0.1.8

### DSL / JSON Contract Parity

- Adds portable spec fields for capability `returns_hint`, proposal
  `numeric_bounds`, and proposal `transition_guards` so reviewed safety
  metadata can live in canonical contracts instead of runner-private config.
- Extends the DSL with `DESCRIPTION`, `RETURNS HINT`, arg descriptions,
  numeric arg min/max, text `MAX LENGTH`, patch `BOUND`, and `TRANSITION`
  clauses.
- Adds DSL warnings and `--strict` mode so weak proposal contracts fail CI
  instead of silently compiling.
- Preserves compiled bounds through `contracts: []` into Runner propose-time
  enforcement and accepts pure-contract configs with `capabilities: []`.
- Adds `docs/dsl-json-parity.md` so developers can see which fields are
  authored in DSL, validated in JSON, enforced by Runner, and accepted by
  C++/Cloud.

### Cloud Registry Push

- Wires non-dry-run `synapsor-runner cloud push` to the Synapsor Cloud control
  API. The CLI validates locally, posts normalized `@synapsor/spec` JSON, and
  reports Cloud contract/version/digest details only after the server confirms
  storage.
- Keeps `--dry-run` network-free and updates error handling for invalid tokens,
  missing workspace permissions, validation errors, conflicts, and network
  failures without printing bearer tokens.
- Documents the project-scoped Cloud registry path and backend runner-bundle
  export foundation.

### Release Verification

- Adds `corepack pnpm test:live-apply` as the documented Docker-backed live
  apply smoke. It aliases the existing MCP local examples proof and verifies
  proposal diffs, approval outside MCP, guarded writeback, idempotent retry,
  stale-row conflict, receipts, and replay against disposable Postgres/MySQL
  databases.

## 0.1.7

### Contract Writeback Resolution

- Fixes contract-authored proposal capabilities loaded through `contracts: []`
  so `apply` resolves the same reviewed capability catalog used by serve,
  tools, propose, and doctor.
- Rejects duplicate capability names across embedded runner config and
  referenced contracts instead of silently shadowing a safety contract.
- Preserves canonical contract writeback modes, including direct SQL,
  app-owned handler, cloud-worker, and proposal-only/no-local-writeback
  semantics.
- Fails broken applyable writeback definitions at propose/doctor time before a
  human approves a proposal.
- Creates local store parent directories automatically and trims env-derived
  URLs, tokens, and trusted context values before use.

## 0.1.5

### Contract Authoring Front Door

- Introduces `@synapsor/spec` and `@synapsor/dsl` in the main Runner README so
  developers can find the canonical contract and SQL-like authoring layers from
  the repo and npm package front door.
- Adds a copy-pasteable `CREATE AGENT CONTEXT` / `CREATE CAPABILITY` authoring
  flow that compiles to `synapsor.contract.json`, validates, bundles, dry-run
  pushes to Cloud, and serves through Runner local wiring.
- Refreshes capability authoring docs to lead with the contract/DSL path while
  preserving direct `synapsor.runner.json` embedded capability authoring for
  local experiments and compatibility.
- Clarifies that workflow declarations are supported in contracts/DSL, while
  Runner 0.1 does not execute full Synapsor Cloud workflow DAGs, auto-merge,
  settlement policies, or native branching.
- Updates the repository map to include `packages/spec` and `packages/dsl`.

## 0.1.4

### Public Repository Metadata

- Points the packaged npm README and repository metadata at the public GitHub
  repository: `https://github.com/Synapsor/Synapsor-Runner`.
- Pins the CI badge to the `main` branch so Dependabot PR failures do not make
  the public project front door look broken.
- Adds Dependabot guardrails so semver-major dependency updates are deliberate
  migrations instead of automatic public PR noise.

## 0.1.3

### Public npm DX

- Prepares the spec-ready Runner package for the normal untagged npm path so
  developers can use `npx -y -p @synapsor/runner synapsor-runner ...` without
  knowing about the temporary `next` release-candidate tag.
- Keeps the same contract/spec functionality as `0.1.2`; this is a release
  hygiene patch for public install and README/package-page verification.
- `@synapsor/spec@0.1.0` and `@synapsor/dsl@0.1.0` remain the canonical
  contract packages.

## 0.1.2

### Contract Compatibility

- Publishes the canonical contract packages as `@synapsor/spec@0.1.0` and
  `@synapsor/dsl@0.1.0`, with `@synapsor/runner@0.1.2` available on the `next`
  npm tag for round-trip verification before promotion.
- Documents the canonical `synapsor.contract.json` path for contracts produced
  by the DSL, Cloud, or the C++ exporter.
- Adds OSS-side conformance notes for C++/Cloud export snapshots that validate
  with `@synapsor/spec` and load in Runner.
- Keeps `@synapsor/runner` publishable after `0.1.1` by reserving the next
  stable patch version for this contract round-trip readiness pass.

## 0.1.1

### Launch Readiness

- Reworked the README and packaged npm README so the first screen leads with
  the `execute_sql` risk, the reviewed-business-action alternative, badges,
  and the no-database quick demo.
- Added the self-contained `examples/support-billing-agent/` flagship demo with
  schema, seed data, reviewed contract, app-boundary note, one-command
  `make demo`, and the exact model-facing tools:
  `support.inspect_ticket`, `support.propose_plan_credit`,
  `billing.inspect_invoice`, and `billing.propose_late_fee_waiver`.
- Added copy-paste example entry points for raw SQL vs Synapsor,
  Claude Desktop, Cursor, OpenAI Agents SDK over Streamable HTTP and stdio, and
  MySQL refund review.
- Added agent-native repo guidance files for Codex/Claude/Cursor/Copilot and
  verified in a temp copy that an agent can create an inspect/propose
  capability with non-interactive CLI commands without reading generated
  `dist/` files.
- Restructured the docs index into a task-first path from quickstart to raw SQL
  risk, demo, own database setup, capability generation, MCP serving,
  propose/approve/apply, replay/audit, app-owned handlers, and concepts.
- Added release-gate and repo hygiene assets, including issue/PR templates,
  threat model/security references, README badges, and package metadata.
- Hardened package building so generated `.synapsor` local ledgers are not
  shipped in npm examples.

## 0.1.0

### Stable Channel

- Promotes the alpha.17 safety/onboarding surface to the first stable
  `@synapsor/runner` release.
- Documents the `0.1.x` compatibility promise for the `synapsor-runner` binary,
  `synapsor.runner.json` schema version `1`, result envelope v2, stdio and
  Streamable HTTP MCP surfaces, MCP client snippets, local inspection commands,
  direct SQL writeback, and app-owned executor contracts.

### Included From Alpha.17

- Prompt-free onboarding for scripts, CI, and LLM agents.
- Review-mode configs that avoid silently disabled writeback.
- `up --serve`, stale lease reclaim, result envelope v2 defaults for new
  configs, app-owned handler warnings, final wizard preview, friendlier
  capability names, local event webhooks, and smoke-call first-run guidance.

## 0.1.0-alpha.17

### Added

- Prompt-free onboarding for `onboard db` / `init` through `--yes`,
  `--non-interactive`, and `--answers <file.json>`.
- Friendly scripted onboarding flags: `--tenant-column`, `--id-arg`, `--patch
  column=fixed:value|arg:name`, `--patch-bounds`, `--status-guards`,
  `--read-description`, `--read-returns-hint`, `--handler-output`, and
  `--emit-handler`.
- Answers-file onboarding can emit the same artifacts as the wizard: reviewed
  config, `.env.example`, MCP snippets, and optional handler template.
- Guided onboarding now shows a final "what I am about to write" preview where
  users can revise visible fields or capability names before files are written.
- README and runner README now include a short "How An External Handler Works"
  explanation directly after the writeback rule.
- `events webhook` / `events push` can POST local proposal/writeback lifecycle
  events to a local/dev/staging HTTP endpoint for review UIs or notifications.

### Changed

- When `--namespace` is omitted, generated capability names derive a namespace
  from the selected table instead of defaulting to `source.*`.
- App-owned `http_handler` and `command_handler` generated configs mark the
  Runner source as `read_only: true` when no writer env is supplied. These
  configs now validate without a `WRITEBACK_DISABLED` warning.
- Direct SQL review-mode proposal capabilities still require `write_url_env`
  readiness; missing writer env remains visible as `WRITEBACK_DISABLED`.
- Published docs/examples no longer contain install-looking
  `@synapsor/handler` imports. The app-owned example uses the bundled
  `synapsor-handler.mjs` shim directly.

## 0.1.0-alpha.16

### Added

- `synapsor-runner up` for first-session review-mode bring-up. It validates
  the local config/store, checks active store leases, summarizes model-facing
  tools, explains direct SQL versus app-owned executor writeback, and prints
  the next smoke, approval, apply, replay, UI, and doctor commands.
- Guided app-owned executor setup can now write a starter handler template
  during `init --wizard` / `start --from-env ... --mode review`.
- `result_format: 2` for a stable MCP result envelope with `ok`, `summary`,
  `data`, `proposal`, `error`, `evidence`, `source_database_changed`, and
  `_meta.canonical_capability`.
- `--result-format v1|v2` for `mcp serve`, `mcp serve --transport
  streamable-http`, `mcp serve-streamable-http`, and the legacy JSON-RPC
  bridge.
- Capability config fields `description`, per-argument `description`, and
  `returns_hint`; these are surfaced in MCP tool metadata.
- `tools list` as a first-class alias for `tools preview`, including
  `tools list --aliases`.
- `mcp client-config --include-instructions` for Claude/Cursor/OpenAI-style
  client snippets with propose-first agent guidance.
- `schemas/synapsor.runner.schema.json` for editor validation.
- `docs/capability-authoring.md`, `docs/result-envelope-v2.md`, and RFC source
  docs under `docs/rfcs/`.

### Changed

- Handler templates, template CLI output, app-owned writeback docs, and
  examples now carry the explicit handler security warning: app handlers own the
  final business write and must re-check tenant/scope, conflict guards,
  idempotency, business action, transactions, and safe receipts.
- OpenAI-safe aliases include the canonical Synapsor capability name in
  descriptions/metadata so model-visible aliases can still be audited against
  dotted capability names.
- v2 MCP errors redact raw driver/infra strings and map failures to a small
  safe error-code enum.
- Release policy now keeps the stable channel gated on `up`, review-mode wizard
  verification, handler warning coverage, clean npm install checks, and at
  least one external developer following the README without source reading.

### Compatibility

- Result envelope v1 remains the default in this alpha. Opt in with
  `result_format: 2` or `--result-format v2`.
- The public command remains `synapsor-runner`.

## 0.1.0-alpha.15

### Changed

- Clarified that users install only `@synapsor/runner`. A handler is the
  user's app endpoint or script for rich approved writes, and Runner includes
  templates/examples to help build one.

## 0.1.0-alpha.14

### Changed

- Clarified that `@synapsor/handler` is not published as a standalone npm
  package yet. The TypeScript helper currently exists in the source monorepo
  and as the bundled `synapsor-handler.mjs` shim used by the packaged
  app-owned executor example.
- Included `CHANGELOG.md` in the `@synapsor/runner` npm tarball so users can
  inspect alpha changes without cloning the repository.

## 0.1.0-alpha.13

### Changed

- Reworked the README opening around a five-line mental model: agent talks to
  Runner, Runner exposes capabilities, proposals are saved but not applied, and
  approval/writeback stay outside the model-facing tool surface.
- Added plain definitions for capability, proposal, writeback, and executor near
  the top of the README.
- Added the direct-writeback versus app-owned-executor rule up front: guarded
  one-row updates can use Runner direct writeback; richer business actions use
  an app-owned executor.
- Added a tiny readable own-database config example with one read capability and
  one proposal capability so new users can picture what the guided wizard
  creates.

## 0.1.0-alpha.12

### Added

- `doctor --check-writeback` verifies direct SQL writer connectivity,
  receipt-table readiness, and rollback-only access to configured proposal
  target tables/columns without mutating business rows.
- `docs/doctor.md` documents redacted setup checks, handler reachability,
  direct SQL writeback probes, and receipt-table guidance.
- `store reset --yes` removes only the local SQLite ledger files and refuses
  active server leases unless `--force` is provided.

### Changed

- Doctor output now warns when direct SQL writeback has not been probed and
  points to `--check-writeback`.
- Packed/public verification scripts exercise `store reset` in addition to
  stats/prune.

## 0.1.0-alpha.11

See [docs/release-notes.md](docs/release-notes.md) for the current published
alpha notes.
