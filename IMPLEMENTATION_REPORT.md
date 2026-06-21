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
- `synapsor config validate`
- `synapsor config show --redacted`
- `synapsor doctor --config synapsor.runner.json`
- `synapsor benchmark mcp-efficiency`

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
Tests       63 passed (63)
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
corepack pnpm test:onboarding-generated
corepack pnpm test:docker
corepack pnpm test:mcp-local
corepack pnpm test:mcp-cloud-linked
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
- tampered jobs fail before adapter mutation.

Remaining security work:

- local UI is not implemented, so UI CSRF/localhost/browser-state protections
  are documented but not enforced in code yet;
- guided TTY wizard is incomplete;
- broader path traversal and replay secret-scanning tests still need to be
  added.

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

- true interactive TTY `synapsor init` wizard is not implemented;
- `synapsor mcp configure --client <client> --print/--write` is not implemented;
- `synapsor ui` is not implemented;
- `synapsor config migrate` is not implemented;
- under-10-minute activation has not been measured with a live fresh database;
- local UI security tests are not applicable until the UI exists;
- benchmark snapshots are not checked as golden files;
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
- generated config path is Docker-smoked end to end for Postgres and MySQL;
- semantic MCP/proposal/writeback/replay paths are covered by existing tests;
- benchmark command is reproducible and model-API-free;
- license/content gate is automated.

Not yet proven:

- a fresh developer can complete the full own-Postgres/MySQL path in under 10
  minutes without hand-writing a full config in a manual human run;
- local UI proposal review.
