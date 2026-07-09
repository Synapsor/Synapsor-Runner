# Release Notes

These notes track public Synapsor Runner behavior. Starting with `0.1.0`, the
normal install path uses the untagged stable package:

```bash
npx -y -p @synapsor/runner synapsor-runner demo --quick
```

The OSS runner command is `synapsor-runner`. The `synapsor` command is reserved
for the Synapsor Cloud CLI.

## Unreleased

Prepared package version: `@synapsor/runner@0.1.12`. The already-published
`@synapsor/spec@0.1.4` and `@synapsor/dsl@0.1.4` do not change and must not be
republished for this release.

### Runner Version Invocation

- Keeps `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` stable if an npm/npx wrapper forwards a duplicated
  executable token.
- Uses Runner's bundled package metadata instead of the invoking project's
  `npm_package_version` environment value.
- Adds source-wrapper and installed-tarball verification for all three forms.

## 0.1.11

### Cloud Adoption Loop

- Adds complete Claude, Cursor, OpenAI Agents SDK, and generic MCP templates to
  local and Cloud-generated Runner bundles.
- Adds a flagship adoption verifier and a real local Cloud registry/version/ZIP
  bundle round trip.
- Expands the `support-plan-credit` walkthrough from no-database validation to
  Docker-backed policy tiers, MCP setup, Cloud push, bundle download, replay,
  cleanup, and troubleshooting.
- Supports `SYNAPSOR_CLOUD_WORKSPACE` and verifies distinct 401/403/404/409/422,
  server, and network errors without exposing tokens.
- Clarifies that Cloud registry/versioning is beta-ready while managed runners,
  SAML/SCIM, hosted policy enforcement, legal hold, and enterprise SLA are not
  part of this release.
- Corrects `cloud push --help` to describe the real authenticated registry
  upload and network-free dry-run behavior.

## 0.1.10

### Policy Auto-Approval

- Adds portable approval-policy references and threshold rules.
- Adds DSL `AUTO APPROVE WHEN field <= integer` and the three-tier
  `support-plan-credit` example: policy approval, operator review, and bound
  rejection.

## 0.1.9

### CLI Hygiene

- Adds top-level `synapsor-runner --version`, `synapsor-runner -v`, and
  `synapsor-runner version` output.

## 0.1.8

### DSL / JSON Contract Parity

- Adds portable spec fields for capability `returns_hint`, proposal
  `numeric_bounds`, and proposal `transition_guards`.
- Extends the DSL with `DESCRIPTION`, `RETURNS HINT`, arg descriptions,
  numeric arg min/max, text `MAX LENGTH`, patch `BOUND`, and `TRANSITION`
  clauses.
- Adds DSL warnings and `--strict` mode so proposal capabilities cannot
  silently lose reviewed safety metadata.
- Preserves compiled bounds through `contracts: []` into Runner propose-time
  enforcement and accepts pure-contract configs with `capabilities: []`.
- Adds `docs/dsl-json-parity.md` as the field-by-field support matrix across
  JSON spec, DSL, Runner, C++/Cloud, and Cloud push.

### Cloud Registry Push

- Wires non-dry-run `synapsor-runner cloud push` to the Cloud control API.
- Keeps dry-run network-free and prints server-confirmed contract, version,
  digest, and registry details for real uploads.
- Adds clearer 401/403/404/409/422/network error messages without printing
  bearer tokens.

### Release Verification

- Adds `corepack pnpm test:live-apply` as the documented Docker-backed live
  apply smoke for disposable Postgres/MySQL MCP examples, guarded writeback,
  idempotent retry, stale-row conflict, receipts, and replay.

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

### OSS Launch Readiness

- Reworked the README and packaged npm README so the first screen leads with
  the `execute_sql` risk, the reviewed-business-action alternative, badges, and
  the no-database quick demo.
- Added the self-contained `examples/support-billing-agent/` flagship demo with
  schema, seed data, reviewed contract, app-boundary note, one-command
  `make demo`, and the exact support/billing model-facing tool list.
- Added copy-paste example entry points for raw SQL vs Synapsor, Claude
  Desktop, Cursor, OpenAI Agents SDK over Streamable HTTP and stdio, and MySQL
  refund review.
- Added agent-native repo guidance files and verified that an agent can create
  an inspect/propose capability with the non-interactive CLI without reading
  generated `dist/` files.
- Restructured the docs index into a task-first path and added release-gate
  repo hygiene assets.
- Hardened package building so generated `.synapsor` local ledgers are not
  included in npm examples.

## 0.1.0

### Stable Channel

- Promotes the alpha.17 safety/onboarding surface to the first stable
  `@synapsor/runner` release.
- Documents the `0.1.x` compatibility promise for the `synapsor-runner` binary,
  `synapsor.runner.json` schema version `1`, result envelope v2, stdio and
  Streamable HTTP MCP surfaces, MCP client snippets, local inspection commands,
  direct SQL writeback, and app-owned executor contracts.
- Keeps alpha/prerelease builds available through the `@alpha` tag for preview
  behavior.

### Included From Alpha.17

- Prompt-free onboarding for scripts, CI, and LLM agents.
- Review-mode configs that avoid silently disabled writeback.
- `up --serve`, stale lease reclaim, result envelope v2 defaults for new
  configs, app-owned handler warnings, final wizard preview, friendlier
  capability names, local event webhooks, and smoke-call first-run guidance.

## 0.1.0-alpha.17

### Scripted Onboarding

- `onboard db` and `init` now have a prompt-free path for scripts, CI, and LLM
  agents. Use `--yes`, `--non-interactive`, or `--answers <file.json>`.
- Added friendly flags that match the first-run mental model:
  `--tenant-column`, `--id-arg`, `--patch column=fixed:value|arg:name`,
  `--patch-bounds`, `--status-guards`, `--read-description`,
  `--read-returns-hint`, `--read-tool`, `--proposal-tool`,
  `--handler-output`, and `--emit-handler`.
- Answers-file onboarding writes the reviewed config, `.env.example`, MCP
  snippets, and optional handler template without opening a TTY prompt.
- When `--namespace` is omitted, generated capability names now derive a
  namespace from the selected table instead of falling back to `source.*`.
- The guided wizard now has a final "what I am about to write" preview where
  users can revise visible fields or capability names before files are written.
- README Start Here now tells users to run `tools preview` and `smoke call`
  before wiring an MCP client.
- `events webhook` / `events push` can POST local proposal/writeback lifecycle
  events to a local/dev/staging HTTP endpoint for review UIs or notifications.

### Writeback Readiness

- App-owned executor configs generated by Runner now mark the Runner source as
  `read_only: true` when no writer env is supplied. `config validate` no longer
  reports `WRITEBACK_DISABLED` for handler-owned writeback paths.
- Direct SQL review-mode proposals still surface `WRITEBACK_DISABLED` if the
  source has no `write_url_env`, because Runner cannot apply those proposals
  without a trusted writer connection.

### Handler Docs

- README and runner README now include a short "How An External Handler Works"
  section: agent proposes, human approves outside MCP, Runner POSTs to your
  endpoint, and your code writes in its own transaction.
- Published docs/examples no longer include install-looking imports for a
  separate handler package. Use `synapsor-runner handler template ...` or the
  bundled `synapsor-handler.mjs` shim in the app-owned example.

## 0.1.0-alpha.16

### Review-Mode Bring-Up

- Added `synapsor-runner up` as the local review-mode orientation command. It
  validates the config/store, checks active store leases, summarizes
  model-facing tools, identifies direct SQL versus app-owned executor writeback
  paths, and prints the next smoke, approval, apply, replay, UI, and doctor
  commands.
- `up` is guidance-only by default. `up --serve` starts the standard MCP
  Streamable HTTP server after the same validation and guidance.
- `up --dry-run` gives the full checklist without starting a server.
- `up --handler-check` or `up --with-handler` runs the redacted handler
  env/reachability doctor path before serving.
- The guided wizard now writes model-facing capability descriptions,
  per-argument descriptions, returns hints, and defaults generated configs to
  `result_format: 2`.
- `result_format: 2` gives MCP clients a stable envelope with `ok`, `summary`,
  `data`, `proposal`, `error`, `evidence`, `source_database_changed`, and
  `_meta.canonical_capability`. Pass `--result-format v1` or
  `"result_format": 1` only when an older client needs the legacy shape.
- `tools list`, `tools list --aliases`, and
  `mcp client-config --include-instructions` help users inspect exposed tools
  and generate client snippets without source reading.

### Handler Security

- Generated handler templates, template-list output, app-owned writeback docs,
  and examples now explicitly warn that the app handler owns the final business
  write. Handlers must re-check tenant/scope, expected-version or conflict
  guard, idempotency, allowed business action, transaction/rollback, and safe
  error receipts before mutating application state.
- The guided review-mode wizard can now write a starter handler template when
  the app-owned HTTP or command handler path is selected.

## 0.1.0-alpha.15

### Handler Wording Clarification

- README and app-owned executor docs now state that users install only
  `@synapsor/runner`. A handler is the user's own app endpoint or script for
  rich approved writes, not a second Synapsor package to install.

## 0.1.0-alpha.14

### Handler Helper And Changelog Clarity

- Public docs now state that the handler helper is not a standalone npm package
  yet. The helper currently ships as source under `packages/handler` and as the
  bundled `synapsor-handler.mjs` shim in the app-owned executor example
  included with `@synapsor/runner`.
- `CHANGELOG.md` is included in the `@synapsor/runner` npm tarball.

## 0.1.0-alpha.13

### README First-Five-Minutes Polish

- The README now opens with the plain mental model: the agent talks to Runner,
  can inspect scoped data, can create proposals, cannot commit, and writeback
  plus replay happen outside the model-facing tool.
- Capability, proposal, writeback, and executor are defined before the first
  command so a new reader can understand the rest of the docs.
- The README now states the direct-writeback rule early: guarded one-row updates
  can use Runner direct writeback; inserts, multi-table work, events, and other
  rich writes belong in an app-owned executor.
- The own-database section now includes a tiny readable config with one read
  capability and one proposal capability so users can picture what the wizard
  generates before they run it.

## 0.1.0-alpha.12

### Doctor And Writeback Checks

- `synapsor-runner doctor --config synapsor.runner.json --check-writeback`
  verifies direct SQL writer connectivity, receipt-table readiness, and
  rollback-only target-table access for reviewed proposal capabilities.
- Plain `doctor` warns when direct SQL writeback exists but has not been probed.
- The writeback probe uses fixed identifiers from reviewed config only. It does
  not accept model SQL, user SQL, arbitrary table names, or arbitrary columns.
- Probe failures are redacted to safe categories such as `connection failed`,
  `permission denied`, and `configured object not found`.
- `docs/doctor.md` explains handler checks, direct SQL writeback checks, and
  receipt-table DDL/grant guidance.

### Store Lifecycle

- `synapsor-runner store reset --store ./.synapsor/local.db --yes` removes only
  local SQLite ledger files and reports `source_database_changed: false`.
- Destructive store reset refuses active server leases by default and requires
  `--force` for advanced/stale-lease recovery.
- Packed and public verifier scripts now cover `store reset`.

## 0.1.0-alpha.11

### OpenAI MCP Aliases

- `synapsor-runner mcp serve` and `synapsor-runner mcp serve-streamable-http`
  now accept `--alias-mode openai` and `--openai-tool-aliases`.
- `synapsor-runner mcp serve --transport streamable-http` is available as a
  unified command form for the standard HTTP MCP server.
- `synapsor-runner mcp client-config --client openai-agents` prints a
  Streamable HTTP start command and OpenAI Agents SDK snippet.
- `synapsor-runner tools preview --alias-mode openai` shows model-visible alias
  names and the canonical Synapsor capability each alias maps to.
- `examples/mcp-postgres-billing-app-handler/` adds a disposable Postgres proof
  for the app-owned executor path: proposal first, approval outside MCP,
  account-credit row inserted by the app handler, idempotent retry, and replay.
- `--alias-mode both` exposes canonical dotted names and OpenAI-safe aliases
  together for migration/debugging.
- OpenAI alias mode exposes MCP tool names such as
  `billing__inspect_invoice` instead of canonical dotted names such as
  `billing.inspect_invoice`.
- Tool metadata includes `synapsor.canonical_tool_name`,
  `synapsor.exposed_tool_name`, and `synapsor.tool_name_style`, so reviewers
  can still see the canonical Synapsor capability.
- Runner routes alias calls back to the canonical capability. This removes the
  need for user-written OpenAI wrapper code whose only job is replacing dots in
  tool names.
- The OpenAI Agents SDK stdio and Streamable HTTP examples now document the
  built-in alias mode.

## 0.1.0-alpha.10

### First-Run Flow

- `synapsor-runner start --from-env DATABASE_URL` is the shortest own-database
  onboarding command. It is an alias for the guided `onboard db --from-env`
  flow, not the legacy cloud worker.
- The wizard inspects database metadata, creates trusted context bindings,
  generates semantic capabilities, writes `.env.example`, previews MCP tools,
  and prints exact smoke-call, MCP, and UI commands.
- If you provide a real object id and the required environment variables are
  set, onboarding attempts the first smoke tool call and stores local evidence
  and query audit. If not, it prints the exact `smoke call` command to run
  after setting the values.
- `synapsor-runner ui --open` opens the local review UI and is the preferred
  way to inspect proposals, evidence, receipts, and replay after a demo or
  smoke call.

### MCP Transport

- `synapsor-runner mcp serve` is standard stdio MCP for local MCP clients that
  can launch Runner, such as Claude Desktop, Cursor, and similar clients.
- `synapsor-runner mcp serve-streamable-http` is the standard Streamable HTTP
  MCP path for app/server agents and SDK clients. It implements MCP
  initialize/session behavior on the `/mcp` endpoint.
- `synapsor-runner mcp serve-http` is an authenticated JSON-RPC bridge for
  simple `tools/list`, `tools/call`, and `resources/read` wrappers. It is not
  the standard Streamable HTTP MCP transport and prints a runtime warning when
  started.
- The OpenAI Agents SDK HTTP example uses the Streamable HTTP MCP path. Use the
  JSON-RPC bridge only when you intentionally want a thin app-owned wrapper.

### Writeback

- Direct SQL writeback is intentionally narrow: guarded single-row `UPDATE`
  only. It does not support arbitrary SQL, DDL, `INSERT`, `DELETE`, `UPSERT`,
  stored procedures, or multi-row writes.
- Direct SQL writeback reads the trusted writer connection from the source
  `write_url_env` in `synapsor.runner.json`, such as
  `SYNAPSOR_DATABASE_WRITE_URL`.
- `SYNAPSOR_DATABASE_URL` is accepted only as a legacy fallback for older
  direct worker/apply flows without a local config.
- Direct SQL writeback creates or writes `synapsor_writeback_receipts` for
  idempotency and replay. The trusted writer needs permission for that receipt
  table, or an administrator must pre-create the table and grant access.
- Use `synapsor-runner writeback doctor`, `writeback migration`, and
  `writeback grants` to inspect and prepare the direct writeback path.
- Use app-owned `http_handler` or `command_handler` executors for rich writes
  such as inserting credit rows, opening tickets, deleting records through app
  policy, or updating multiple related rows.
- `synapsor-runner handler template` writes starter Node/Fastify,
  Python/FastAPI, or command-handler files so rich writes can start from an
  app-owned transaction boundary instead of hand-writing a handler from
  scratch.

### Evidence And Replay

- Read-only capabilities produce scoped semantic tools, trusted context
  binding, evidence handles, query audit, and local inspection records.
- Proposal workflows add full local replay across evidence, approval,
  writeback jobs, execution receipts, and events.
- `synapsor-runner events tail` prints local lifecycle events from the SQLite
  ledger and can follow new proposal/writeback events while a local flow runs.
- `synapsor-runner events webhook` pushes those local lifecycle events to a
  local/dev/staging HTTP endpoint for review UIs or notifications without
  polling. It is not a hosted central ledger.
- MCP server modes write an active-store lease next to the local SQLite file.
  Destructive `store prune --yes` refuses while that lease points at a live
  process unless `--force` is provided.
- External Postgres/MySQL databases are not physically branched by Runner.
  Replay covers records captured by Runner; it is not external database
  time travel.

### Known Limitations

- This is an alpha local runner, not Synapsor Cloud, not the Synapsor DBMS, and
  not a generic MCP security platform.
- Runner does not expose model-callable approval, commit, apply, or raw SQL
  tools.
- Runner does not implement Synapsor Cloud workflow DAGs, native branches,
  auto-merge, settlement policies, hosted RBAC/SSO, hosted evidence retention,
  CDC, managed runner fleets, compliance exports, production SLA, or C++ DBMS
  internals.
- The local store is single-node SQLite for local/dev/staging usage.
- Node >= 22.5.0 is required because the local ledger uses Node's
  `node:sqlite` runtime. Use a supported Node runtime or the Docker-backed
  source demo path.

### Upgrade Notes From Earlier Alphas

- Public command examples now use `synapsor-runner`, not `synapsor`.
- Standard HTTP MCP examples now use `mcp serve-streamable-http`; `mcp
  serve-http` is documented as the JSON-RPC bridge.
- Direct SQL writeback docs now use `write_url_env` for writer credentials and
  document `SYNAPSOR_DATABASE_URL` only as a legacy fallback.
- Receipt-table permissions are now a documented writeback requirement.
- The quick demo is guided in interactive terminals, concise in noninteractive
  mode, and keeps the longer explanation behind `--details`.

## Stable Release Policy

Use untagged `@synapsor/runner` for stable installs. Use `@alpha` or an exact
prerelease only when intentionally testing preview behavior. Stable `0.1.x`
releases should keep the compatibility promise documented in
`docs/release-policy.md`.

The first stable `0.1.0` release was gated on:

- the README's npm commands match the published package;
- a clean temporary directory can run the quick demo, own-database onboarding,
  MCP config generation, smoke call, UI, and replay commands;
- stdio MCP and Streamable HTTP MCP are covered by tests and examples;
- direct and app-owned writeback requirements are documented and verified; and
- known limitations are still accurate.

For the local tarball before publish, run:

```bash
./scripts/verify-release-gate.sh
```

After publishing an alpha, verify the public package from a clean temporary
directory:

```bash
VERIFY_PUBLISHED_ALPHA=1 ./scripts/verify-release-gate.sh 0.1.0-alpha.17
```

After publishing/promoting stable `latest`, verify the stable channel:

```bash
./scripts/verify-published-stable.sh 0.1.0
```
