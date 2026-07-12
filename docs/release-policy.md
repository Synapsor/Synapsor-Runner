# Release Policy

Synapsor Runner `0.1.0` was the first stable local runner line. Synapsor
Runner `1.0.0` is the first production approval-loop semver line: batch apply,
aggregate policy limits, verified operator identity, structured operations, and
shared runtime-store deployment are part of the documented compatibility
surface. Use the stable package for normal installs:

```bash
npx -y -p @synapsor/runner synapsor-runner demo --quick
npm install -g @synapsor/runner
```

Use `@alpha` or an exact prerelease only when intentionally testing the moving
preview channel.

## Alpha Expectations

Alpha versions may change:

- command names and help text;
- MCP transport defaults;
- config fields and JSON Schema;
- local store layout;
- result envelope format;
- writeback/handler contracts;
- example layout and docs.

Alpha releases must keep the safety boundary intact:

- no model-facing `execute_sql`;
- no model-facing write credentials;
- no model-facing approval/commit/apply tools;
- no generic model-generated INSERT/DELETE/UPSERT/DDL/multi-row SQL;
- proposal-first write path stays explicit.

## Stable Expectations

A stable `0.1.0` release should only be tagged after:

- npm README commands match the published package;
- `synapsor-runner demo --quick` works from a clean directory;
- own-database onboarding works from a clean directory;
- one-command review-mode `synapsor-runner up` is verified from a clean
  directory and clearly prints model-facing tools, writeback path, handler
  requirements, and next commands;
- review-mode wizard output is verified for one read capability plus one
  proposal capability;
- handler template security warnings are verified in docs, CLI output, and
  generated templates;
- stdio MCP and Streamable HTTP MCP are both verified;
- OpenAI alias mode is verified;
- direct SQL writeback requirements are documented and tested;
- app-owned executor requirements are documented and tested;
- local evidence/proposal/receipt/replay inspection works;
- current limitations are accurate.
- at least one external developer can follow the README without reading source;
- there are no known docs/code mismatches around transport, credentials,
  receipt tables, or handler expectations.

## 1.0 Stability Gate

Do not tag `1.0.0` only because the package is useful. `1.0.0` is the public
semver contract for the Runner production approval loop, and it should be cut
only after the following are true in the current tree and release artifacts:

- batch apply can apply all approved proposals independently, reports
  applied/conflict/skipped IDs, is safe to rerun through idempotency receipts,
  and supports `--capability`, `--tenant`, and `--max`;
- aggregate auto-approval limits are authored in DSL, represented in the
  canonical contract spec, enforced as human-review fallback, persisted with
  tripped-limit details, and visible in doctor/tools preview output;
- approve/reject/apply can require a verified operator identity, enforce
  contract reviewer roles and apply roles, and bind tamper-evident identity
  records into the proposal ledger;
- designed rejections and writeback outcomes emit structured logs, operational
  counters are available per tenant and capability, and owner-only local store
  permissions remain under test;
- the documented public surfaces below have release-gate coverage from packed
  artifacts, not only source-tree tests.

After `1.0.0`, changes to the documented CLI, schema, contract, MCP result,
writeback, approval, metrics, and replay surfaces must follow semantic
versioning. Breaking changes require a new major version, except for security
fixes that close a vulnerability while preserving the safest possible
compatibility path.

## Stable Compatibility Promise

Starting with `1.0.0`, Synapsor Runner keeps these public surfaces compatible
through the `1.x` line unless a release note marks a deprecation first:

- the `synapsor-runner` binary name and README quickstart commands;
- `synapsor.runner.json` schema version `1` for documented fields;
- result envelope v2 for new configs, with the documented v1 opt-out;
- stdio MCP and Streamable HTTP MCP command surfaces;
- generated MCP client snippets for documented clients;
- proposal, approval, guarded writeback, receipt, evidence, query-audit, and
  replay inspection commands;
- direct SQL writeback and app-owned executor contracts documented in README
  and `docs/writeback-executors.md`.

Stable does not promise production SLA, hosted Cloud features, compliance
certification, physical Postgres/MySQL branching, generic SQL writeback,
generic multi-row writes, or compatibility for undocumented local SQLite
internals. Local store migrations may happen inside `1.x` and later minor
versions, but documented CLI inspection commands should remain the supported way
to read the store.

Alpha users should pin an exact alpha version in package.json, CI, and MCP
client snippets. Use `@alpha` only when intentionally testing the moving
preview channel.

## Result Envelope Migration

New `init` and `onboard db` configs default to:

```json
{
  "result_format": 2
}
```

Existing hand-written configs without `result_format` keep the legacy runtime
default for compatibility. To force v2 or opt an older client back to v1, use:

```bash
synapsor-runner mcp serve --result-format v2
synapsor-runner mcp serve-streamable-http --result-format v2
synapsor-runner mcp serve --result-format v1
```

v2 makes `ok` the only required branch point for MCP client code. Do not remove
the v1 escape hatch until the stable compatibility policy says legacy result
shapes are no longer supported.

## Publish Checklist

Before publishing any release:

```bash
./scripts/verify-release-gate.sh
```

After publishing an alpha prerelease:

```bash
VERIFY_PUBLISHED_ALPHA=1 ./scripts/verify-release-gate.sh 0.1.0-alpha.17
```

After publishing/promoting stable `latest`, verify the stable channel from a
clean temporary directory:

```bash
./scripts/verify-published-stable.sh 0.1.0
```
