# Changelog

## Unreleased

No unreleased changes yet.

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
