# Implementation Report

Status: local implementation complete for the requested source-available
mini-Synapsor runner experience. Publication, legal, repository-visibility, and
external security decisions remain release gates and were intentionally not
performed by this task.

## Repository State

- Repository: `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`
- Feature branch: `mcp-commit-safe-runtime`
- Starting branch recorded in `CURRENT_ARCHITECTURE.md`: `mcp-commit-safe-runtime`
- Starting commit recorded in `CURRENT_ARCHITECTURE.md`: `06554aa7a49c2eeda855ace3cffb959b00fe54fd`
- Worktree was clean when the architecture audit began.
- No packages were published.
- No branches were pushed.
- No GitHub releases were created.
- No deployments were made.

## Commit Log For This Goal Slice

- `a51b068` - Add safe schema inspection onboarding
- `ab1b511` - Add local runner doctor checks
- `d04b470` - Cross-check writeback jobs against config
- `4c467f4` - Clarify own database onboarding path
- `a97b3de` - Migrate runner licensing to Elastic-2.0
- `21debe4` - Add MCP efficiency benchmark fixture
- `34b3a33` - Expand writeback authority tamper tests
- `3b86ab8` - Add inspection driven init path
- `061ec0c` - Add generated onboarding Docker smoke
- `fa263db` - Add MCP client configure command
- `016a4a5` - Add conservative config migration command
- `84bfb62` - Update implementation report with config migration
- `24c218a` - Clarify own database runner path
- `982f9a4` - Add localhost proposal review UI
- `5e92055` - Harden cloud smoke database readiness
- `103dd92` - Update implementation report for local UI
- `3174099` - Add benchmark golden snapshots
- `fea2ea7` - Update implementation report with benchmark snapshots
- `d498ac7` - Reject secret material in local store
- `96bddad` - Update implementation report with store guard
- `a51a8d6` - Add guided init wizard path
- `cc19aac` - Update implementation report with guided init
- `1181722` - Add guarded proposal value templates
- `8a45cf1` - Update implementation report with proposal guards
- `fdc2a2e` - Harden writeback protocol identifiers
- `01f8e43` - Align writeback tamper test with identifier guard

## What Changed

### Architecture and Onboarding

- Added `CURRENT_ARCHITECTURE.md` with package responsibilities, CLI entry
  points, config shape, local proposal lifecycle, MCP lifecycle, worker trust
  checks, Cloud boundary, and goal gaps.
- Added `packages/schema-inspector` for safe Postgres/MySQL metadata inspection.
- Added `schemas/onboarding-selection.v1.schema.json`.
- Added `synapsor inspect`.
- Added `synapsor init --spec onboarding-selection.json --non-interactive`.
- Added `synapsor init --database-url-env ...` for inspection-driven config
  generation from explicit reviewed flags.
- Added `synapsor init --inspection-json schema-inspection.json ...` so a saved
  sanitized inspection can drive config generation without reconnecting.
- Added an interactive `synapsor init --wizard` flow for the core own-database
  path: engine/read-env selection, schema inspection, table selection,
  primary-key/tenant/conflict confirmation, visible columns, mode, semantic
  names, trusted context env vars, proposal patch mappings, preview, and final
  confirmation before writing files.
- Added `scripts/smoke-generated-onboarding.mjs` and
  `corepack pnpm test:onboarding-generated` for generated own-database
  onboarding proof against disposable Postgres and MySQL fixtures.
- Fixed MySQL metadata inspection aliases so table columns, primary keys, tenant
  columns, and conflict columns are visible to `doctor`.
- Generated files include:
  - `synapsor.runner.json`
  - `.env.example`
  - `.synapsor/mcp/generic-stdio.json`
  - `.synapsor/mcp/claude-desktop.json`
  - `.synapsor/mcp/cursor.json`
  - `.synapsor/mcp/vscode.json`

### CLI Commands

Added or strengthened:

- `synapsor inspect`
- `synapsor init --spec ... --non-interactive`
- `synapsor init --database-url-env ...`
- `synapsor init --inspection-json ...`
- `synapsor init --wizard`
- `synapsor init --starter`
- `synapsor config validate`
- `synapsor config show --redacted`
- `synapsor config migrate`
- `synapsor doctor --config synapsor.runner.json`
- `synapsor benchmark mcp-efficiency`
- `synapsor mcp configure --client ...`
- `synapsor mcp audit <target>`
- `synapsor ui`

### Doctor

Local `doctor` now checks:

- config parse/validation;
- trusted context env vars;
- source env vars;
- read/write credential separation;
- selected metadata when read URL is available;
- MCP runtime tool listing;
- absence of raw SQL and approval/commit tools.

### Proposal and Writeback Hardening

Local config writeback now cross-checks jobs against reviewed config:

- source exists in config;
- engine matches source;
- lease is not expired;
- target schema/table/primary-key/tenant matches capability;
- allowed columns do not widen reviewed config;
- patch columns are reviewed;
- conflict guard matches;
- local proposal state/digest match when `--store` is provided;
- non-dry-run local config apply requires `--store`.

Added tampering tests for:

- changed table;
- changed schema;
- changed primary-key column;
- changed tenant column;
- changed conflict column;
- widened allowed columns;
- disallowed patch columns;
- SQL-looking patch identifiers;
- expired leases;
- missing approval data;
- missing local store on real apply;
- approval/proposal digest mismatch.

The local proposal store now rejects obvious credential material before it can
be persisted into proposals, evidence bundles, query audit payloads, runner
state, or replay:

- database URLs;
- bearer tokens;
- Synapsor runner tokens;
- private-key blocks;
- secret-like fields such as password, token, API key, private key, cookie,
  credential, connection string, read URL, or write URL.

Generated proposal capabilities now support reviewed declarative value
constraints:

- `numeric_bounds` for bounded numeric changes;
- `transition_guards` for constrained status transitions;
- runtime enforcement before proposal creation;
- config and onboarding-spec validation;
- CLI support through `--numeric-bound` and `--transition-guard`.

Public change-set and writeback-job protocol validation now requires fixed safe
schema, table, primary-key, tenant, conflict, allowed-column, and patch-column
identifiers. Path-traversal and SQL-fragment-like identifier strings fail before
adapter execution.

### Benchmark

Added:

```bash
synapsor benchmark mcp-efficiency
synapsor benchmark mcp-efficiency --json
```

The benchmark compares an included late-fee-waiver fixture:

- generic database MCP reference path;
- Synapsor Runner semantic path.

It reports exposed tools, serialized `tools/list` bytes, deterministic fixture
token counts, scripted tool calls, schema/context bytes/tokens, business result
bytes/tokens, raw SQL exposure, approval separation, and stale-row conflict
checking.

It is explicitly not a universal token-savings claim.

Checked-in golden snapshots now cover both output modes:

- `fixtures/benchmark/mcp-efficiency.txt`
- `fixtures/benchmark/mcp-efficiency.json`

### MCP Client Setup

Added:

```bash
synapsor mcp configure --client generic-stdio|claude-desktop|cursor|vscode
synapsor mcp configure --client cursor --write --destination ./cursor.json --yes
```

Default behavior prints a snippet and writes nothing. Write mode requires an
explicit destination and confirmation, merges known client formats, validates
JSON, and creates a timestamped backup before replacing an existing file.

### MCP Audit

Added and documented:

```bash
synapsor mcp audit <target>
synapsor mcp audit <target> --json
```

The audit command performs a static MCP database risk review over exported tool
manifests, remote `tools/list` endpoints, or stdio MCP servers. It calls only
`tools/list`, never business tools, and labels the result as a static risk
review rather than proof that an MCP server is secure. Remote bearer tokens are
read from environment variables and are not printed.

### Config Migration

Added:

```bash
synapsor config migrate --config synapsor.runner.json
synapsor config migrate --config synapsor.runner.json --output migrated.json --yes
synapsor config migrate --config synapsor.runner.json --write --yes
```

Because version 1 is the only supported schema today, migration is conservative:
it validates the current config, reports "already current" by default, rejects
unsupported versions, and only writes a normalized copy when explicitly asked.

### Smoke Reliability

- Strengthened the Cloud-linked Docker smoke readiness check so it waits for a
  real `psql SELECT 1` before resetting fixture data. This prevents the smoke
  from racing `docker compose up -d` and failing before the runner path is
  exercised.

### Local UI

Added:

```bash
synapsor ui --config ./synapsor.runner.json --store ./.synapsor/local.db
```

The UI is a lightweight localhost proposal review surface. It:

- binds to `127.0.0.1` by default;
- refuses non-localhost binding unless `--allow-remote-bind` is explicitly
  passed;
- prints a per-run local URL with a session token;
- sets the session token in an HttpOnly SameSite cookie after initial token URL
  load;
- requires a CSRF token for approve/reject actions;
- shows setup summary, semantic tools, proposals, exact diffs, evidence,
  approval state, receipts, and replay;
- redacts obvious database URLs, passwords, bearer tokens, runner tokens, and
  secret-like fields from JSON API responses;
- exposes no raw SQL editor;
- exposes no MCP approval, commit, or writeback tools;
- exposes no browser control that widens reviewed tables or columns.

### Licensing and Docs

- Replaced first-party Apache license file with official Elastic License 2.0
  text.
- Set first-party package metadata to `Elastic-2.0`.
- Replaced public "open-source" wording with "source-available".
- Added `docs/licensing.md`.
- Added `TRADEMARKS.md`.
- Updated `CONTRIBUTING.md` to avoid accepting external code until a
  counsel-approved CLA/inbound-rights process exists.
- Added `docs/dependency-license-inventory.md`.
- Added `scripts/check-license-content.mjs`.
- Wired license/content check into `corepack pnpm test`.
- Added docs:
  - `docs/trusted-context.md`
  - `docs/local-ui.md`
  - `docs/security-boundary.md`
  - `docs/mcp-efficiency-benchmark.md`
  - `docs/telemetry.md`
  - `docs/production-readiness.md`
  - `docs/config-migrations.md`

## Golden-Path Transcript

Docker-backed generated own-database onboarding has an automated sanitized
transcript through:

```bash
corepack pnpm test:onboarding-generated
```

Latest sanitized transcript:

```text
> synapsor-runner-monorepo@0.1.0-alpha.0 test:onboarding-generated
> tsc -b --pretty false && node scripts/smoke-generated-onboarding.mjs

== generated Postgres billing onboarding: inspect schema ==
== generated Postgres billing onboarding: generate config from inspection ==
== generated Postgres billing onboarding: validate and doctor generated config ==
== generated Postgres billing onboarding: generated MCP tools/list and tool calls ==
== generated Postgres billing onboarding: local approval -> guarded apply with generated config ==
== generated Postgres billing onboarding: stale-row conflict with generated config ==
== generated Postgres billing onboarding: completed in 20.4s ==

== generated MySQL orders onboarding: inspect schema ==
== generated MySQL orders onboarding: generate config from inspection ==
== generated MySQL orders onboarding: validate and doctor generated config ==
== generated MySQL orders onboarding: generated MCP tools/list and tool calls ==
== generated MySQL orders onboarding: local approval -> guarded apply with generated config ==
== generated MySQL orders onboarding: stale-row conflict with generated config ==
== generated MySQL orders onboarding: completed in 39.6s ==

Generated own-database onboarding smoke passed for Postgres and MySQL in 60.0s.
```

The script proves both Postgres and MySQL:

- start disposable fixture database;
- set read/write URL environment variables without writing secret values to
  generated artifacts;
- run `synapsor inspect`;
- generate temporary config through `synapsor init --inspection-json`;
- generate MCP client snippets;
- generate reviewed numeric bounds for the Postgres late-fee proposal;
- generate reviewed status-transition guards for the MySQL order proposal;
- run `synapsor config validate`;
- run `synapsor doctor`;
- launch generated semantic MCP tools;
- confirm `tools/list` exposes only semantic tools;
- call inspect/proposal tools;
- confirm source row unchanged before approval;
- approve outside MCP;
- apply through guarded writeback with `--config` and a separate write
  credential;
- retry idempotently;
- mutate a second proposal between proposal/apply and return
  `VERSION_CONFLICT`;
- export replay;
- scan generated text artifacts and replay exports for fixture secrets.

## Tests Run

Latest verified commands:

```bash
corepack pnpm build
corepack pnpm test:mcp-client-configs
git diff --check
corepack pnpm test
corepack pnpm test:docker
corepack pnpm test:mcp-local
corepack pnpm test:onboarding-generated
corepack pnpm test:mcp-cloud-linked
corepack pnpm exec vitest run apps/runner/src/cli.test.ts -t "audits"
```

Result:

```text
corepack pnpm build: passed
corepack pnpm test:mcp-client-configs: passed
git diff --check: passed
corepack pnpm test: passed
Test Files  11 passed (11)
Tests       77 passed (77)
License/content check passed.
corepack pnpm test:docker: passed for local Postgres/MySQL apply,
  idempotency, stale-version conflict, tenant mismatch, and disallowed-column
  flows.
corepack pnpm test:mcp-local: passed for Postgres billing, Postgres support,
  and MySQL orders.
corepack pnpm test:onboarding-generated: passed for generated Postgres and
  MySQL own-database onboarding in 60.0s total.
corepack pnpm test:mcp-cloud-linked: passed for token, registration,
  tools/list, proposal, approval, lease, guarded writeback, and receipt.
corepack pnpm exec vitest run apps/runner/src/cli.test.ts -t "audits": passed,
  2 audit tests passed.
```

## Security Review

Current protections:

- generated configs store env-var names, not URL values;
- MCP snippets do not include database credentials;
- local doctor avoids printing secret values;
- local mode does not send telemetry by default;
- Cloud communication is explicit through Cloud mode/commands;
- model-facing MCP tools remain semantic only;
- approval/commit tools are not exposed to the model-facing MCP catalog;
- writeback uses a separate trusted apply path;
- writeback jobs are cross-checked against reviewed config;
- tampered jobs fail before adapter mutation;
- writeback jobs and public change sets reject path-traversal and
  SQL-fragment-like database identifiers before adapter execution;
- generated proposal capabilities can enforce reviewed numeric bounds and
  status-transition maps before proposal creation;
- local UI binds localhost by default, requires a per-run token, requires CSRF
  on approve/reject, and redacts obvious secret values from API responses.
- local proposal-store persistence rejects obvious credential material before it
  reaches SQLite/replay.

Remaining security/release work:

- independent external security review is still recommended before public
  release or production use claims;
- no hidden telemetry was added, and local mode does not require Cloud.

## License Review

Previous state:

- first-party `LICENSE` was Apache-2.0;
- README said "Open-source";
- package manifests did not declare `Elastic-2.0`.

Current state:

- first-party `LICENSE` contains official Elastic License 2.0 text;
- package manifests declare `Elastic-2.0`;
- README says source-available;
- dependency inventory summary exists in `docs/dependency-license-inventory.md`;
- release checklist requires qualified counsel review.

Release blocker:

- final license and trademark text still needs legal review before public
  release.

Public distribution note:

- this report does not prove whether any earlier code was publicly distributed
  under Apache-2.0. If it was, changing the current files does not retroactively
  remove rights already granted for those earlier distributed versions.

## Known Gaps

Known code/product gaps:

- no known code gap remains from this local-runner goal after the latest test
  pass;
- the measured under-10-minute path is Docker-backed disposable
  Postgres/MySQL onboarding, not an independent external developer usability
  study.

Remaining operational/legal gaps:

- qualified counsel review for license/trademark text;
- final dependency/license notice review;
- final repository visibility and publication decision;
- final security review before public release.
- GitHub remote/repository publication was intentionally not performed.
- package publication, GitHub releases, tags, pushing, and deployment were
  intentionally not performed.

## Product Proof

Current proof:

- developer can generate config from a reviewed spec;
- developer can generate config from a saved inspection JSON and explicit flags;
- developer can run an injectable/tested guided init flow for one reviewed
  table/action without hand-authoring the full config;
- generated proposal capabilities support reviewed numeric bounds and
  status-transition guards, with config validation and runtime enforcement
  before proposal creation;
- generated config path is Docker-smoked end to end for Postgres and MySQL;
- semantic MCP/proposal/writeback/replay paths are covered by existing tests;
- local UI proposal review is covered by token/CSRF/secret-redaction tests;
- local proposal/evidence/query-audit persistence rejects obvious credential
  material before replay storage;
- benchmark command is reproducible, model-API-free, and checked against
  committed human/JSON snapshots;
- license/content gate is automated.
- under-10-minute activation is proven by
  `corepack pnpm test:onboarding-generated`: generated Postgres onboarding
  completed in 20.4s, generated MySQL onboarding completed in 39.6s, and both
  together completed in 60.0s. This measures a disposable local fixture path
  using the same inspect/init/doctor/MCP/proposal/approval/apply/replay steps a
  developer uses, without hand-writing the full config.
