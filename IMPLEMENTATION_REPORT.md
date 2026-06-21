# Implementation Report

Status: in progress. This repository is closer to the requested local
mini-Synapsor experience, but the full goal is not complete yet.

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

Docker-backed generated own-database onboarding now has an automated transcript
through:

```bash
corepack pnpm test:onboarding-generated
```

That script proves both Postgres and MySQL:

- start disposable fixture database;
- run `synapsor inspect`;
- generate temporary config through `synapsor init --inspection-json`;
- run `synapsor config validate`;
- run `synapsor doctor`;
- launch generated semantic MCP tools;
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

A polished sanitized human-readable transcript can still be extracted for
release docs, but the automated proof is present.

## Tests Run

Latest verified command:

```bash
corepack pnpm test
```

Result:

```text
Test Files  10 passed (10)
Tests       66 passed (66)
License/content check passed.
```

Latest after local UI:

```text
Test Files  11 passed (11)
Tests       68 passed (68)
License/content check passed.
```

Latest after store-level secret persistence guard:

```text
Test Files  11 passed (11)
Tests       69 passed (69)
License/content check passed.
```

Latest after guided init wizard:

```text
Test Files  11 passed (11)
Tests       70 passed (70)
License/content check passed.
```

Additional spot checks run during implementation:

```bash
node scripts/check-license-content.mjs
git diff --check
corepack pnpm licenses list --json
corepack pnpm runner benchmark mcp-efficiency
corepack pnpm runner benchmark mcp-efficiency --json
corepack pnpm exec vitest run apps/runner/src/cli.test.ts
corepack pnpm exec vitest run apps/runner/src/local-ui.test.ts apps/runner/src/cli.test.ts
corepack pnpm test:onboarding-generated
corepack pnpm test:docker
corepack pnpm test:mcp-local
corepack pnpm test:mcp-cloud-linked
```

The latest Docker-backed smoke results after the local UI work:

- `corepack pnpm test:onboarding-generated`: passed for Postgres and MySQL.
- `corepack pnpm test:mcp-local`: passed for Postgres billing, Postgres
  support, and MySQL orders.
- `corepack pnpm test:mcp-cloud-linked`: passed after strengthening the
  Postgres readiness check.
- `corepack pnpm test:docker`: passed for local Postgres and MySQL runner
  apply/idempotency/conflict/tamper flows.
- After adding store-level secret persistence guards:
  - `corepack pnpm test`: passed, 69 tests.
  - `corepack pnpm test:mcp-local`: passed for Postgres billing, Postgres
    support, and MySQL orders.
  - `corepack pnpm test:onboarding-generated`: passed for Postgres and MySQL.
  - `corepack pnpm test:mcp-cloud-linked`: passed.

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
- local UI binds localhost by default, requires a per-run token, requires CSRF
  on approve/reject, and redacts obvious secret values from API responses.
- local proposal-store persistence rejects obvious credential material before it
  reaches SQLite/replay.

Remaining security work:

- broader path traversal tests still need to be added.

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

The full goal is not complete yet.

Remaining code/product gaps:

- guided init supports the core inspect-by-id plus explicit field-update
  proposal flow, but constrained status-transition and bounded numeric-change
  templates are not implemented yet;
- under-10-minute activation has not been measured with a live fresh database;
- full final release checklist is not complete.

Remaining operational/legal gaps:

- qualified counsel review for license/trademark text;
- final dependency/license notice review;
- final repository visibility and publication decision;
- final security review before public release.

## Product Proof

Current proof:

- developer can generate config from a reviewed spec;
- developer can generate config from a saved inspection JSON and explicit flags;
- developer can run an injectable/tested guided init flow for one reviewed
  table/action without hand-authoring the full config;
- generated config path is Docker-smoked end to end for Postgres and MySQL;
- semantic MCP/proposal/writeback/replay paths are covered by existing tests;
- local UI proposal review is covered by token/CSRF/secret-redaction tests;
- local proposal/evidence/query-audit persistence rejects obvious credential
  material before replay storage;
- benchmark command is reproducible, model-API-free, and checked against
  committed human/JSON snapshots;
- license/content gate is automated.

Not yet proven:

- a fresh developer can complete the full own-Postgres/MySQL path in under 10
  minutes without hand-writing a full config in a manual human run.
