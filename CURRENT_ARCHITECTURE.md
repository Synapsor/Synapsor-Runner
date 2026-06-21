# Current Architecture

Baseline recorded for the local Synapsor Runner onboarding goal.

## Repository State

- Starting branch: `mcp-commit-safe-runtime`
- Starting commit for this audit: `06554aa7a49c2eeda855ace3cffb959b00fe54fd`
- Initial worktree: clean
- Baseline test run: `corepack pnpm test` passed with 9 test files and 52 tests.

## Packages And Apps

- `apps/runner`: CLI entrypoint exposed as `synapsor` and `synapsor-runner`. Current commands include `init`, `doctor`, `validate`, `apply`, `runner start`, `cloud connect`, `mcp serve`, `mcp audit`, `proposals`, and `replay`.
- `packages/config`: strict JSON runner config validation. It rejects inline database URLs, raw SQL fields, model-controlled trusted fields, missing tenant guards, missing proposal allowlists, and missing conflict guards.
- `packages/mcp-server`: local stdio MCP server and runtime. It exposes configured semantic capabilities, resolves trusted context, reads scoped rows from Postgres/MySQL using the read URL env, records evidence/query audit/proposals, and returns read/proposal structured content.
- `packages/proposal-store`: local SQLite proposal, evidence, query-audit, approval, writeback-job, receipt, and replay store.
- `packages/protocol`: public change-set, writeback-job, runner-registration, and receipt schemas/normalization.
- `packages/postgres`: guarded Postgres writeback adapter. It builds parameterized single-row `UPDATE`s from structured jobs, enforces allowed patch columns, tenant guard, primary key guard, version conflict guard, idempotency receipts, and exact affected row count.
- `packages/mysql`: guarded MySQL writeback adapter with the same single-row guarded update model.
- `packages/control-plane-client`: Synapsor Cloud runner registration, heartbeat, adapter tool catalog/call, writeback claim/lease/result client.
- `packages/worker-core`: shared runner config loading, Cloud polling, doctor plumbing, redaction, logging, and MCP static risk audit.

## Current Config Schema

The current local config is strict JSON with:

- `version: 1`
- `mode: read_only | shadow | review | cloud`
- `storage.sqlite_path`
- `sources.{source}.engine`
- `sources.{source}.read_url_env`
- optional `sources.{source}.write_url_env`
- `trusted_context.provider`
- `trusted_context.values.tenant_id_env`
- `trusted_context.values.principal_env`
- `capabilities[]` with semantic name, kind, source, target schema/table, primary key, tenant key, model args, lookup arg, visible columns, evidence policy, max rows, patch mapping, allowed columns, conflict guard, and approval metadata.

Config currently uses environment-variable names for secrets, not inline URLs.

## Local Proposal Lifecycle

1. MCP read/proposal tool receives only model-visible business arguments.
2. Runtime rejects trusted-field overrides such as `tenant_id`, `principal`, table, schema, column, and raw SQL.
3. Runtime resolves trusted context from environment/static/cloud session.
4. Runtime reads exactly one scoped row using configured primary key and tenant key.
5. Runtime records evidence and query audit in SQLite.
6. Read tools return reviewed visible columns only.
7. Proposal tools build an exact change set from declarative patch mapping, record proposal state, leave the source DB unchanged, and return proposal/evidence/replay handles.
8. CLI approval/rejection happens outside the MCP tool catalog.
9. Approved proposals can generate `synapsor.writeback-job.v1` jobs.
10. `synapsor apply` applies jobs through the guarded Postgres/MySQL adapter and records terminal receipts.

## MCP Lifecycle

- `synapsor mcp serve` starts a stdio MCP server.
- Local mode lists configured semantic tools only.
- `read_only` mode lists read capabilities only.
- `shadow` and `review` expose proposal tools, but proposal calls still do not mutate source DB rows.
- Approval, rejection, commit, and writeback are not exposed as model-callable MCP tools.
- MCP resources expose local proposal, evidence, and replay records.

## Worker Trust Checks

Current adapter-level checks include:

- safe identifier quoting;
- structured patch only;
- allowed-column enforcement;
- primary-key column cannot be patch-allowlisted;
- tenant column cannot be patch-allowlisted;
- primary-key and tenant guarded `WHERE`;
- version-column conflict guard when present;
- idempotency receipt table;
- transaction around writeback;
- exact one-row affected check.

## Cloud Boundary

Cloud mode delegates tool catalog and tool calls to Synapsor Cloud while keeping local write credentials in the runner environment. The Cloud client supports doctor, runner registration, heartbeat, adapter tool catalog/call, writeback claim, heartbeat lease renewal, and result submission. Local mode does not require Cloud.

## Gaps Relative To Goal

- No reusable schema-inspection package yet.
- No `synapsor inspect` command yet.
- `synapsor init` currently generates a generic config and still requires manual table/capability authoring.
- No non-interactive onboarding spec or schema yet.
- No generated `.env.example` or MCP client snippets from init yet.
- `synapsor doctor` currently checks Cloud/worker env, not local config/schema/tool readiness.
- No local UI command yet.
- Writeback apply does not yet cross-check a job against local reviewed config before applying.
- No MCP efficiency benchmark yet.
- Licensing has been migrated toward ELv2/source-available metadata after the initial audit. Final public release still requires counsel review.
- Required docs and final `IMPLEMENTATION_REPORT.md` are incomplete.
