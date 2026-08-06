import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";


export function usage(args: string[] = []): void {
  const [command, subcommand] = args;
  const key = (command === "mcp" || command === "handler") && subcommand ? `${command} ${subcommand}` : command ?? "";
  const cmd = cliCommandName();
  const help: Record<string, string> = {
    "": `Synapsor Runner

Safe MCP tools for Postgres/MySQL-backed agent actions.

New here?
  No database needed: ${cmd} try
  Connect your database: ${cmd} start --from-env DATABASE_URL

\`start\` is the interactive guided first run. \`onboard db\` is the explicit,
scriptable one-command artifact generator for CI and established automation.

Usage:
  ${cmd} <command>

Commands:
  try          Run an isolated proof, or ask/explore/call active project tools
  inspect      Inspect a Postgres/MySQL schema
  start        Interactive guided first run, or no-arg legacy worker polling
  action       Validate/watch disabled TypeScript Safe Action drafts
  up           Bring up local review mode guidance/server
  init         Generate a Synapsor capability contract
  config       Validate local synapsor.runner.json wiring
  mcp          Serve safe semantic tools over MCP
  contract     Validate and normalize canonical Synapsor contract files
  effect       Catch changed agent business effects with offline fixtures
  report       Export and verify scoped tamper-evident ledger reports
  policy       Evaluate and review opt-in graduated-trust recommendations
  dsl          Compile SQL-like Synapsor authoring DSL to contract JSON
  language-server  Start the Synapsor contract LSP over stdio
  cloud        Register runner metadata or dry-run contract push to Cloud
  onboard      Scriptable one-command own-database artifact setup
  smoke        Test generated tool calls before wiring an MCP client
  tools        List model-facing MCP tools and aliases
  writeback    Print direct SQL writeback receipt DDL, grants, and checks
  handler      Create app-owned writeback handler templates
  propose      Create a local evidence-backed proposal
  audit        Review MCP/database tool risk
  proposals   Review, approve, or reject proposals
  lifecycle   Inspect an action from proposal through receipt/replay
  evidence    Inspect local evidence bundles
  query-audit Inspect local query audit records
  receipts    Inspect guarded writeback receipts
  activity    Search local evidence/replay ledger
  events      Tail or push local proposal/writeback lifecycle events
  metrics     Export tenant/capability operational counters
  activation  Inspect/export the local try-to-first-proposal funnel
  attention   Inspect human-attention work without copying proposal IDs
  notifications  Test and dispatch quiet, signed operator notifications
  worker      Run or inspect the supervised local writeback queue
  store       Inspect and maintain the local SQLite ledger
  shadow      Compare shadow proposals with authoritative outcomes
  apply        Apply an approved proposal with guarded writeback
  revert       Create a reviewed compensation proposal for an applied write
  replay       Show what happened
  demo         Start the local commit-safety demo
  ui           Open the local review UI

Examples:
  ${cmd} try --prove --yes --no-open
  ${cmd} try ask --provider openai [--model <model>] [--verbose]
  ${cmd} start --from-env DATABASE_URL
  ${cmd} start --from-env DATABASE_URL --cli
  ${cmd} start --action refund_order --description "Propose one reviewed order refund"
  ${cmd} action validate ./synapsor/actions/billing.propose_refund_order.ts
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db --dry-run
  ${cmd} onboard db --from-env DATABASE_URL
  ${cmd} inspect --from-env DATABASE_URL
  ${cmd} init --wizard --from-env DATABASE_URL
  ${cmd} config validate --config ./synapsor.runner.json
  ${cmd} contract validate ./synapsor.contract.json
  ${cmd} contract normalize ./synapsor.contract.json --out ./synapsor.contract.normalized.json
  ${cmd} contract explain ./contract.synapsor.sql --format markdown
  ${cmd} contract lint ./contract.synapsor.sql --strict
  ${cmd} lifecycle --store ./.synapsor/local.db
  ${cmd} lifecycle show --object invoice:INV-3001 --details --store ./.synapsor/local.db
  ${cmd} effect fixture create --from-replay replay_wrp_... --request "Waive the late fee" --contract ./synapsor.contract.json --store ./.synapsor/local.db --out ./effects/late-fee.json
  ${cmd} effect run --fixture ./effects/late-fee.json --result ./effects/late-fee.result.json
  ${cmd} report --object invoice:INV-3001 --tenant tenant_acme --store ./.synapsor/local.db --format markdown
  ${cmd} policy recommend --contract ./synapsor.contract.json --config ./synapsor.runner.json --tenant tenant_acme --capability billing.propose_credit --policy low_risk_credit --store ./.synapsor/local.db
  ${cmd} dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json
  ${cmd} language-server --stdio
  ${cmd} cloud push ./synapsor.contract.json --dry-run
  ${cmd} smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools list --aliases --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} handler template node-fastify --output ./synapsor-writeback-handler.mjs
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} propose billing.propose_late_fee_waiver --sample
  ${cmd} audit ./synapsor.runner.json
  ${cmd} activation show --config ./synapsor.runner.json --store ./.synapsor/local.db

Global options:
  --secrets-provider aws-secretsmanager-cli --secret-map-env SYNAPSOR_SECRET_MAP
  --secrets-provider env-json --secret-map-env SYNAPSOR_SECRET_MAP --secret-values-env SYNAPSOR_SECRET_VALUES
`,
    try: `Usage:
  ${cmd} try
  ${cmd} try --no-open
  ${cmd} try --prove
  ${cmd} try --yes --no-open
  ${cmd} try --json --yes --no-open
  ${cmd} try --prove --state-dir ./tmp/synapsor-state
  ${cmd} try call --list
  ${cmd} try call <capability-name> --sample
  ${cmd} try explore
  ${cmd} try explore --suggested
  ${cmd} try explore --resource public.check_ins --count-distinct member_id --group-by outcome --time-bucket checked_in_at:week
  ${cmd} try explore --resource public.orders --sum total_cents --group-by channel --time-bucket created_at:week --compare created_at --period 2026-06-01T00:00:00Z..2026-06-08T00:00:00Z --vs-period 2026-06-08T00:00:00Z..2026-06-15T00:00:00Z
  ${cmd} try explore --plan '{"kind":"aggregate",...}'
  ${cmd} try ask --provider openai [--model <model>]
  ${cmd} try ask --provider anthropic [--model <model>]
  ${cmd} try ask --provider openai-compatible --model <model> --base-url http://127.0.0.1:11434/v1
  ${cmd} try ask "Which reviewed regions changed most by week?" --provider openai
  ${cmd} try protect --last --name analytics.protected_analysis
  ${cmd} try protect --from A2 --name analytics.protected_analysis

Choose the intended path:
  ${cmd} try
    Runs an isolated synthetic commit-safety proof. It does not use your
    connected project database and may open its separate demo review screen.
  ${cmd} try ask --provider openai
    Opens the terminal natural-language analytics shell for an already active
    reviewed project boundary. OpenAI defaults to gpt-5-mini and Anthropic
    defaults to Claude Sonnet; --model overrides either choice. A loopback
    OpenAI-compatible provider still requires an explicit model. This command
    does not open the demo UI.

Run the complete Synapsor commit-boundary proof without Docker, a database,
signup, API key, MCP client, or LLM call. A deterministic simulated agent uses
the real semantic proposal/ledger/writeback lifecycle against an isolated
synthetic embedded demo source.

The default path shows scoped evidence, the exact business diff, explicit
operator review outside MCP, guarded commit, receipt, and replay. --prove also
demonstrates restart-safe retry, changed-intent idempotency rejection, stale
conflict, and non-mutating replay. --yes is valid only for this isolated demo
and CI; it does not grant model authority.

--state-dir selects a caller-owned container. Runner stores the disposable
proof in a marked managed child, preserves unrelated files, and refuses
protected or symlinked paths.

In an initialized project, try call lists or invokes the active reviewed
named capabilities through the same runtime used by MCP. try explore
describes or executes the active local development/staging Scoped Explore
boundary using reviewed flags or advanced structured plans, never SQL.
Use field@reviewed_relationship when one reviewed many-to-one path supplies a
dimension. try ask is the local development/staging analytics surface and
requires active Scoped Explore. Without a positional question it opens the
natural-language shell; with one question it runs once. It exposes exactly
app.describe_data and app.explore_data and never falls back to named reads or
proposal tools. Provider output is untrusted; Runner renders the authoritative
structured result separately. It requires exact egress consent, never accepts a
credential as a command-line value, and cannot activate, approve, or apply.
Successful verified data hides safely recovered intermediate attempts by
default. Use /attempts in the shell or --verbose to inspect those attempts.
Interactive use shows the reviewed provider destination and defaults Continue
to Yes when the operator presses Enter. Noninteractive automation must still
provide the exact authority-bound --consent value.
Inside the shell, /protect selects the sole current analysis or opens a readable
picker. Outside it, try protect --last promotes only an unambiguous latest
analysis. Explicit --from A2 remains available. Every Protect result is public
DSL, canonical JSON, and tests for a disabled named capability; it never
activates the result.
	`,
    config: `Usage:
  ${cmd} config init [--output ./synapsor.runner.json] [--engine postgres|mysql] [--read-url-env DATABASE_URL]
  ${cmd} config init --production-explore --issuer https://identity.example --audience https://runner.example/mcp --accounting-namespace acme.analytics.production [--project-root .]
  ${cmd} config init --production-explore --single-tenant-organization-id internal-finance --principal-claim sub --issuer https://identity.example --audience https://runner.example/mcp --accounting-namespace internal.finance.production
  ${cmd} config validate --config ./synapsor.runner.json
  ${cmd} config migrate --config ./synapsor.runner.json --out ./synapsor.runner.migrated.json

Initialize or validate local Runner wiring before tools preview, doctor, smoke,
or MCP serve. config init creates a valid read-only zero-authority shell using
environment-variable references and refuses to overwrite an existing file.
With --production-explore it emits the complete zero-authority shared-Postgres,
JWT/JWKS, secured HTTP, OAuth, budget, source-pool, and session-cap skeleton.
It reuses source and claim bindings from a production boundary draft when one
exists; issuer, audience, and accounting namespace remain explicit operator
inputs. No database URL, JWT, HMAC key, or other secret value is written.
Contract paths are resolved relative to the config file. SQLite store paths are
resolved by the Runner process working directory.
`,
    contract: `Usage:
  ${cmd} contract validate ./synapsor.contract.json [--json]
  ${cmd} contract normalize ./synapsor.contract.json [--out ./synapsor.contract.normalized.json]
  ${cmd} contract explain ./contract.synapsor.sql [--format text|markdown|json] [--out explanation.md]
  ${cmd} contract lint ./contract.synapsor.sql [--config ./synapsor.runner.json] [--format text|json|sarif] [--fail-on error|warning]
  ${cmd} contract test --contract ./synapsor.contract.json --tests ./synapsor.contract-tests.json --config ./synapsor.runner.json [--live] [--format text|json|junit]

Validate or normalize canonical Synapsor contract files. Explain renders the
reviewed boundary in plain language. Lint reports stable objective rule IDs and
never claims to infer all sensitive columns. Test runs adopter-authored static
assertions and, with --live, calls the real MCP runtime against an explicitly
approved disposable database. Local database URLs, ports, and store paths stay
in runner config.
`,
    effect: `Usage:
  ${cmd} effect fixture create --from-replay replay_wrp_... --request "Waive the late fee" --contract ./synapsor.contract.json --store ./.synapsor/local.db --out ./effects/late-fee.json
  ${cmd} effect fixture create --from-shadow-case shc_... --request "Issue a plan credit" --contract ./synapsor.contract.json --store ./.synapsor/local.db --out ./effects/plan-credit.json
  ${cmd} effect result init --fixture ./effects/late-fee.json --out ./effects/late-fee.result.json
  ${cmd} effect run --fixture ./effects/late-fee.json --result ./effects/late-fee.result.json [--format text|json|junit]
  ${cmd} effect run --dataset ./effects/dataset.json --results-dir ./effects/results [--format text|json|junit]
  ${cmd} effect run --dataset ./effects/dataset.json --adapter node --adapter-arg ./app/effect-adapter.mjs --result-origin deterministic-application [--format text|json|junit]
  ${cmd} effect accept --fixture ./effects/late-fee.json --result ./effects/late-fee.result.json --actor <operator> --reason <reviewed-change> --in-place --yes

Create a versioned effect baseline from an existing proposal replay or shadow
case, import a provider-neutral result from your agent harness, and fail CI when
capability calls, trusted context, target, business diff, policy, hidden fields,
conflict behavior, or result category drift.

Runner evaluates imported results offline and never applies a write. Evidence is
snapshotted from the existing ledger. A new source read is rejected unless
--allow-live-read is explicit. Baselines never update silently: acceptance
requires an operator identity, reason, --yes, and --in-place or a new output.
The command adapter launches an adopter-owned executable without a shell and
without ambient database/token credentials. It must emit one result JSON on
stdout and declare whether it is deterministic application logic or an external
model. Runner cannot sandbox code that loads its own credentials, so adapters
must remain propose-only and run against fixtures or disposable sources.
This complements contract test; it does not replace contract conformance.
`,
    report: `Usage:
  ${cmd} report --object invoice:INV-3001 --tenant tenant_acme --store ./.synapsor/local.db [--config ./synapsor.runner.json] [--format markdown|json|pdf] [--out report.md]
  ${cmd} report --principal support.operator --tenant tenant_acme --store ./.synapsor/local.db [--config ./synapsor.runner.json] [--format markdown|json|pdf] [--out report.json]
  ${cmd} report verify ./report.json [--public-key ./operator.pub.pem] [--json]

Export a tenant-scoped chronology from proposal, evidence metadata, query audit,
approval, writeback, receipt, and replay records. Evidence rows and credentials
are never exported. Optional --signing-key adds an operator signature. Digest or
signature verification makes an export tamper-evident; it does not make a local
SQLite ledger immutable compliance storage.
`,
    policy: `Usage:
  ${cmd} policy recommend --contract ./synapsor.contract.json --config ./synapsor.runner.json --tenant <tenant> --capability <name> --policy <name> --store ./.synapsor/local.db
  ${cmd} policy recommendations list --tenant <tenant> --store ./.synapsor/local.db [--capability <name>] [--policy <name>] [--status pending_review|approved|rejected|exported]
  ${cmd} policy recommendations show <ptr_id> --tenant <tenant> --store ./.synapsor/local.db
  ${cmd} policy recommendations approve <ptr_id> --tenant <tenant> --config ./synapsor.runner.json --reason <text> --yes --store ./.synapsor/local.db
  ${cmd} policy recommendations reject <ptr_id> --tenant <tenant> --config ./synapsor.runner.json --reason <text> --yes --store ./.synapsor/local.db
  ${cmd} policy recommendations export <ptr_id> --tenant <tenant> --contract ./synapsor.contract.json --out ./synapsor.contract.recommended.json --actor <operator> --yes --store ./.synapsor/local.db

Graduated trust is disabled by default. It evaluates scoped, human-reviewed
history and can create a pending recommendation; it never auto-approves,
changes, pushes, or activates a contract. Approval/rejection requires a
cryptographically verified signed_key or jwt_oidc operator identity. Export
revalidates the active contract digest and writes a separate reviewable artifact.
`,
    "language-server": `Usage:
  ${cmd} language-server --stdio

Start the Synapsor contract Language Server Protocol endpoint. It supports
.synapsor.sql and legacy .synapsor files with diagnostics, completion, hover,
and formatting from the same parser used by dsl validate/compile.
`,
    dsl: `Usage:
  ${cmd} dsl validate ./contract.synapsor.sql [--json]
  ${cmd} dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json

Both .synapsor.sql and legacy .synapsor source files are supported.

Compile the preview SQL-like Synapsor authoring DSL into canonical
@synapsor/spec JSON. Unsupported Cloud-only/generated clauses fail explicitly
instead of being ignored.
`,
    cloud: `Usage:
  ${cmd} cloud connect --config ./synapsor.cloud.json
  ${cmd} cloud sync latest --config ./synapsor.cloud.json --store ./.synapsor/local.db
  ${cmd} cloud sync-activity latest --config ./synapsor.cloud.json --store ./.synapsor/local.db
  ${cmd} cloud push ./synapsor.contract.json --dry-run [--workspace <id>] [--name <registry-name>]

cloud sync sends a pending proposal plus bounded evidence/query-audit metadata.
cloud sync-activity sends stable local evidence, query-audit, and replay ids;
record contents and database credentials stay local. cloud push validates and
normalizes the contract locally, then prints the
payload summary. With --dry-run it makes no network request. Without --dry-run
it uploads to the authenticated Cloud registry and reports the stored contract,
version, digest, and registry URL returned by the server.
`,
    up: `Usage:
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db [--transport stdio|streamable-http]
  ${cmd} up --serve --config ./synapsor.runner.json --store ./.synapsor/local.db --port 8766 --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db --handler-check --dry-run

Validate the local Runner config and store, summarize model-facing tools,
explain direct SQL versus app-owned executor writeback, and print the next
smoke/approve/apply/replay commands.

With --transport stdio, \`${cmd} up\` prints MCP client wiring because stdio is
launched by the client. \`${cmd} up --serve\` starts the standard Streamable HTTP
MCP server after the checklist. Use --with-handler to run the handler doctor
before serving app-owned writeback configs.

Options:
  --serve
  --alias-mode canonical|openai|both
  --result-format v1|v2
  --handler-check
  --with-handler
  --open-ui
  --dry-run
  --previous-auth-token-env <ENV>
  --trusted-tls-proxy
  --unsafe-allow-cleartext-http
  --tls-cert-env <ENV> --tls-key-env <ENV>
  --tls-ca-env <ENV> --require-client-cert
`,
    start: `Usage:
  # Recommended interactive first run
  ${cmd} start --from-env DATABASE_URL [--schema public]
  ${cmd} start --from-env DATABASE_URL --cli [--schema public] [--verbose]
  ${cmd} start --from-env DATABASE_URL --cli --single-tenant --organization-id internal-finance

  # Canonical non-interactive read-only setup
  ${cmd} start --from-env DATABASE_URL --table public.invoices --mode read_only --tenant-key tenant_id --yes --no-open

  ${cmd} start --from-env DATABASE_URL --answers ./answers.json --yes
  ${cmd} start --action refund_order --description "Propose one reviewed order refund" [--based-on billing.inspect_order]
  ${cmd} start --from-env DATABASE_URL --mode review --writeback http_handler --handler-url-env APP_WRITEBACK_URL [--handler-signing-secret-env APP_WRITEBACK_SIGNING_SECRET]
  ${cmd} runner start --once --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} start

A fresh interactive --from-env invocation with no existing config, selector, or
automation input scans the whole schema, combines deterministic database,
Prisma, Drizzle, OpenAPI, and existing Synapsor evidence, emits a disabled
DSL-first Auto Boundary draft, and opens the secured local Workbench. It never
samples source rows or uses an LLM. This fresh loopback route establishes the
development authoring profile once; Workbench does not ask for a second
development/staging declaration. Explicit production, unknown, remote, and
established manual profiles retain their existing fail-closed behavior.

For a database that genuinely contains one organization and no tenant columns
or row-level tenant policies, add \`--single-tenant --organization-id <stable-id>\`.
This is an explicit digest-bound owner decision: Runner applies no tenant row
predicate, still applies reviewed principal scope when present, and refuses the
mode if inspection finds evidence that the source is actually multi-tenant.

Add \`--cli\` to keep the complete interactive journey in the terminal. Runner
drafts or resumes the boundary and, for a fresh conservative candidate, asks
for one default-yes human Quick Start gesture. That gesture records review,
rechecks schema and read-only role posture, and activates only the exact
one-table, zero-relationship local digest. The same screen displays the
selected provider and exact model. Enter accepts that default without adding a
step; M chooses OpenAI, Anthropic, a loopback OpenAI-compatible model, an
existing MCP client, or Later; E opens detailed multi-table/column review.
Submitting the first question confirms the displayed provider/model/origin
egress review. In the Analytics shell, \`/access\` opens the terminal boundary
editor and \`/access-workbench\` opens its visual counterpart. \`--no-open\`
retains its established behavior: initialize or resume
without opening a browser or starting an interactive review.

In a terminal, selectors such as --table seed the interactive wizard instead
of disabling its prompts. For CI, provide --table, --mode, and either
--tenant-key or --single-tenant-dev together; Runner reports every missing
decision in one error. Add --force only after reviewing existing generated
files. --answers remains the stable file-driven automation path. These routes
never unexpectedly open a browser, and a valid config/boundary handshake does
not count as a real own-data read.

With no flags, start the legacy cloud-linked writeback polling worker from the
worker environment config. Prefer \`${cmd} runner start\` for that worker path
so it is not confused with first-run onboarding. Add \`--once\` with both
\`--config\` and \`--store\` for a bounded claim/apply cycle that still rechecks
the local reviewed contract and proposal before writeback.
`,
    boundary: `Usage:
  ${cmd} boundary draft --from-env DATABASE_URL [--schema public] [--project-root .] [--json]
  ${cmd} boundary draft --from-env DATABASE_URL --single-tenant --organization-id internal-finance [--project-root .]
  ${cmd} boundary draft --from-env DATABASE_URL --profile production --tenant-claim tenant_id --principal-claim sub [--project-root .]
  ${cmd} boundary draft --from-env DATABASE_URL --profile production --single-tenant --organization-id internal-finance --principal-claim sub [--project-root .]
  ${cmd} boundary review [--project-root .] [--output boundary-review.json] [--json]
  ${cmd} boundary review --access [--project-root .]  # focused table/column/path editor
  ${cmd} boundary review --map [--all] [--project-root .]
  ${cmd} boundary review --confirm [--project-root .] [--actor reviewer@example.com]
  ${cmd} boundary rename reviewed_sales --to sales_analytics --actor reviewer@example.com --reason "Use the team-facing boundary name"
  ${cmd} boundary delete old_draft --yes [--project-root .]
  ${cmd} boundary review resource public.orders [--project-root .] [--map|--json]
  ${cmd} boundary review resource public.orders --include --tenant-key tenant_id --no-principal --visible-fields id,status --actor reviewer@example.com --reason "Reviewed tenant-scoped order access"
  ${cmd} boundary review resource public.order_items --include --tenant-scope-path order_items_order_id_fkey --actor reviewer@example.com --reason "Order items inherit tenant scope through their required order"
  ${cmd} boundary review resource public.orders --withhold-from-model customer_segment --actor reviewer@example.com --reason "Use this grouping locally without sending segment values to the model"
  ${cmd} boundary review resource public.orders --minimum-cohort 3 --actor owner@example.com --reason "Reviewed owner decision for this staging dataset"
  ${cmd} boundary review resource public.orders --max-ranked-groups 200 --actor reviewer@example.com --reason "Reviewed bounded ranking across this known customer population"
  ${cmd} boundary review --apply-decisions boundary-decisions.json [--project-root .] [--json]
  ${cmd} boundary review --apply-decisions boundary-decisions.json --apply --confirm "APPLY REVIEW sha256:..." --config ./synapsor/synapsor.runner.json --identity reviewer --identity-key ./reviewer.pem --required-role boundary_reviewer
  ${cmd} boundary activate [--project-root .]
  ${cmd} boundary activate --headless --review-bundle boundary-review.json --config ./synapsor/synapsor.runner.json --confirm "ACTIVATE sha256:..." --identity reviewer --identity-key ./reviewer.pem --required-role boundary_reviewer --reason "Reviewed staging authority"
  ${cmd} boundary disable [--project-root .] [--actor reviewer@example.com]
  ${cmd} boundary disable --project-root . --confirm "DISABLE sha256:..." --json
  ${cmd} boundary status [--project-root .] [--json]
  ${cmd} boundary diff [--project-root .] [--json]
  ${cmd} mcp install <cursor|claude-code|vscode> --project --authoring --project-root . --yes

Draft the whole deterministic application boundary without opening a browser,
inspect/export its disabled review state, and compare the generation lock with
the current schema and exact database role/grant/RLS posture. Interactive review
uses development/staging by default. Production Explore requires a separate
production draft whose tenant and principal claim names match the verified JWT
session contract; claim values never enter the draft or model arguments.
from a fresh directory also prepares the validated local Runner config, SQLite
ledger, and MCP snippets needed by the eventual Ask handoff; it writes
environment-variable names but no credential values. An established config is
never replaced. The review groups the exact digest-bound decisions into one
sign-off per table plus one
boundary-wide sign-off. Stable decision IDs remain available in JSON for audit
and automation. After final sign-off, the interactive flow shows the complete
reviewed fingerprint and offers activation immediately with a default-yes
confirmation. A resumed \`boundary activate\` command uses the same prompt.
After activation, the same terminal offers OpenAI, Anthropic, a loopback
OpenAI-compatible model, an existing MCP client, or Later. Choosing a model
enters the existing \`try ask\` analytics shell immediately; it does not create
another authority path. Existing MCP client setup and Later leave the reviewed
boundary active without starting a provider. JSON and headless routes never
show this menu or launch Ask.
Headless automation still requires the complete digest and a verified signed
operator decision.

Auto Boundary drafts every deterministically reviewable table/view from the
selected schema. With no saved review, CLI and Workbench offer the same
deterministic one-table Quick Start boundary. If Quick Start is activated, that
exact active boundary becomes the unchanged baseline for later expansion;
Add tables first shows only tables connected to the current boundary by an
inspected foreign-key path. The operator can explicitly expand that view to all
inspected tables when an independent resource is genuinely needed.
Before Quick Start, detailed review may recommend up to three related tables.
Run \`${cmd} boundary review --map\` for a
concise explanation of active access, the disabled multi-table draft, other
inspected tables, and useful proven paths. Add \`--all\` only when you need the
complete inspected catalog.

Scoped Explore boundaries are named saved sets. Each boundary may contain many
tables and reviewed relationship paths; a \`schema.table\` row is a table inside
the boundary, not a separate boundary. A project may keep several disabled
boundary drafts for different analytical scopes. One draft is selected for
editing, and up to eight exact reviewed boundaries may be active together.
Creating, opening, renaming, or deleting a disabled draft never changes active
authority. Activating a new name adds that boundary; activating the same name
updates only that boundary. Runner never unions their relationship graphs.
The same two tools remain advertised: \`app.describe_data\` catalogs active
boundaries and one \`app.explore_data\` plan selects exactly one of them.

A boundary is the reviewed set of tables, fields, relationships, trusted row
scope, privacy limits, and query budgets an agent may use. A disabled draft is
editable and grants no access.

Plain language for the access editor:
  Boundary           The data and operations the AI cannot exceed.
  Record ID          A database-proven unique key for one row.
  Tenant isolation   The customer/account column Runner fixes outside AI input.
  Model + Runner     Reviewed raw values may be sent to the configured model.
  Runner only        Raw values stay local; reviewed counts/statistics may be sent.
  Kept out           The field cannot be used by Explore at all.
  Fingerprint        Runner's internal proof that the reviewed access did not change.

If a table has valid Record ID and Tenant isolation candidates but Runner cannot
choose between them safely, Enter opens one inline choice screen. Saving those
choices keeps the table in the disabled draft and continues directly to column
review. It does not require a signed key and does not activate access.

Run \`${cmd} boundary review --access\`, press E from \`start --cli\`, or use
\`/access\` in Analytics for the focused two-step editor. First choose every
table and column tier in one screen. Routine choices save directly to the
selected disabled boundary while current active boundaries remain available. Then C
shows one complete boundary summary and one default-yes activation confirmation
before returning to Ask. The provider/model/key remain in memory; authority
changes clear conversation state and renew the egress decision. Sensitive-field widening still requires
a reviewer and reason. A nullable reviewed path asks explicitly whether
unmatched counted rows remain under an empty group or are excluded; there is no
default because that choice changes totals.

To change aggregate privacy for one table in the focused editor:

1. If the boundary list appears, highlight the boundary and press Enter.
2. In the table list, highlight the table. Do not press Enter; Enter opens its
   columns. Press P instead. Privacy applies to the highlighted table.
3. Enter a minimum group size from 1 through 5 and a short recorded reason.
   Runner hides groups with fewer rows than that number. A value of 1 turns
   small-group suppression off and may reveal a group containing one person or
   record.
4. At \`Save this privacy change? [Y/n]\`, press Enter to save the disabled
   boundary revision. This does not change active authority.
5. At \`Review and activate this boundary change now? [Y/n]\`, press Enter to
   review and activate it. If you choose No or Escape, return to the boundary
   screen later and press C (**Review + activate**).

Press P while the boundary itself is highlighted to set one minimum group size
for every included table atomically. The same save and activation steps apply.

Run \`${cmd} boundary review\` in a terminal to see only the saved boundaries
that exist. This is the advanced governance route. A creates another named
disabled boundary from the selected draft, Enter opens a boundary, and X
deletes a non-active draft after confirmation. Only then does Runner show its
member tables. Directly below the TABLES heading, P explains the highlighted
table's sign-off: field access, operations, trusted scope, privacy, and
relationships. The default table row says \`table sign-off needed\`, not an
internal decision count. P exposes those exact audit decisions when wanted;
one S sign-off records all of them together. Enter on a
table edits its columns, R stages its removal, and Esc returns to the boundary
list. Table and guided boundary sign-off prompts use \`[Y/n]\`: Enter records
the review already shown, while \`n\` declines it. A sign-off still does not
activate authority.
A reveals related inspected tables so another can be added; Tab deliberately
expands to all inspected tables. Choosing a table first saves it in the disabled
boundary and then opens its columns for review. B returns to the boundary's
table list, M opens the whole-boundary map, N renames the selected disabled
boundary, and C **Complete review** guides every remaining sign-off and
then offers activation. One table sign-off records
the exact individual decisions for column access, operations, trusted scope,
privacy limits, and relationships; those decisions remain separately
digest-bound underneath. They are not separate boundaries or unsaved column
edits. The column picker then
stages one of three explicit tiers: V makes values available to Runner and the
configured model, W keeps real values in Runner's local verified output while
the model receives response-only tokens for raw output; explicitly reviewed
derived results remain available. K keeps the field out of every read operation.
Press the Spacebar key to change the selected column's access; each
press moves from Model + Runner to Raw values: Runner only to Kept out, then repeats.
Trusted tenant and principal columns use the same output tiers. Their values
remain fixed by trusted runtime context in every tier; no tier creates a model
argument for tenant or principal scope. Changing their disclosure still needs a
recorded human reason and a new exact boundary fingerprint.
Press V, W, or K to choose one directly. The footer follows standard terminal
navigation: Up/Down navigates, Enter continues to review, Esc returns to the
table list, B is an equivalent visible back action, M opens the selected table's
access map, and Q quits without saving. Enter with unchanged column access
continues to one plain-language table sign-off. A changed access tier still
uses a validated preview in this advanced route; its disabled-draft save prompt
uses \`[Y/n]\`, so Enter saves immediately and \`n\` discards it. The focused
\`--access\` route omits repeated actor/reason/save prompts for routine
low-risk edits because its one final exact-boundary confirmation records the
human decision. Neither route lets the model edit or activate authority or
requires rerunning a generated resource command. Use the resource-level
\`--map\` to print the table map without entering the picker. Both maps are
inspection-only. Activation remains a separate exact-digest decision under the
focused one-confirmation presentation.

\`${cmd} boundary disable\` narrows authority by removing active local Scoped
Explore access. It does not delete saved disabled boundaries, review decisions,
protected named capabilities, evidence, ledger, or source data. Interactive use
asks for one confirmation; automation must bind the exact active digest with
\`--confirm "DISABLE sha256:..."\`.

Resource decision flags:
  --include | --exclude
  --row-identity <column>
  --tenant-key <column>
  --principal-key <column> | --no-principal
  --keep-out <column,...>
  --withhold-from-model <column,...>
  --allow-reviewed-field <column,...>
  --visible-fields <column,...>
  --filter-fields <column,...>
  --sort-fields <column,...>
  --group-fields <column,...>
  --measure-fields <column,...>
  --count-distinct-fields <column,...>
  --time-fields <column,...>
  --minimum-cohort <1-5>
  --max-ranked-groups <max-groups..generated-maximum>
  --relationships <relationship-id,...>
  --nullable-relationship <relationship-id> --unmatched-rows <exclude|keep_null>
  --actor <human> --reason <review-reason>
  --apply [--confirm "APPLY REVIEW sha256:..."]

Resource review can resolve only inspected identity/scope candidates and narrow
fields or relationships. It previews a semantic diff and saves disabled review
state; it never activates authority. A versioned decision file can apply several
resource decisions atomically, but the file is not authority: application still
requires an exact digest gesture or a verified signed-key/OIDC operator proof.
Auto Boundary keeps the minimum group size at 5 by default. An owner may lower it
to 1-4 only through --minimum-cohort with a recorded actor and reason. A value
of 1 disables small-group suppression and can identify individuals; Protect and
protected-capability activation require separate explicit re-confirmation.

Ranked top/bottom and two-period mover questions return at most the reviewed
top-N (25 by default). --max-ranked-groups separately narrows how many
candidate groups Runner may validate before small-group suppression and ranking.
New boundaries default to 500; a human may only keep or narrow that generated
ceiling. Runner refuses an incomplete candidate population, suppresses small
groups, and only then ranks the remaining groups. The setting is digest-bound
and operator-owned, and no MCP tool or model plan can set it.

Headless activation is accepted only with an exact exported review bundle,
exact digest confirmation, a short-lived nonce-bound decision, and a configured
signed_key or jwt_oidc operator identity carrying the required role. --yes and
an actor string are never sufficient. Workbench and CLI converge on the same
activation checks. After activation, --authoring installs exactly
app.describe_data and app.explore_data in the selected Cursor, Claude Code, or
VS Code project. Scoped
Explore remains local stdio only and is absent from production and remote HTTP.
`,
    action: `Usage:
  ${cmd} action validate ./synapsor/actions/billing.propose_refund_order.ts [--config ./synapsor.runner.json]
  ${cmd} action watch ./synapsor/actions/billing.propose_refund_order.ts
  ${cmd} action status [--json]

Parse the restricted code-first TypeScript authoring subset without importing
or executing agent-authored code. A successful validation writes a canonical,
digest-addressed disabled draft and deterministic contract-test artifact.
Editing or validating a draft never changes active Runner tools or source data.

There is intentionally no action activate CLI command. Activation requires
review of the exact digest and unresolved-authority checklist in the secured
localhost Workbench. Activation, approval, apply, commit, and revert remain
outside model-facing MCP tools.
`,
    inspect: `Usage:
  ${cmd} inspect --from-env DATABASE_URL [--engine auto|postgres|mysql] [--schema public] [--json]
  ${cmd} inspect --engine postgres --url-env DATABASE_URL
  ${cmd} inspect "<postgres-or-mysql-url>" [--engine auto|postgres|mysql] [--schema public] [--json]

Inspect schema metadata without mutating the database or printing credentials.
`,
    init: `Usage:
  ${cmd} init --wizard --from-env DATABASE_URL [--mode read_only|review|shadow] [--out synapsor.runner.json]
  ${cmd} init --engine postgres --url-env DATABASE_URL --mode review --table public.invoices --operation update
  ${cmd} init --inspection-json schema.json --table invoices --mode review --operation update --patch late_fee_cents=fixed:0,waiver_reason=arg:reason
  ${cmd} init --inspection-json schema.json --table account_credits --mode review --operation insert --dedup request_id=proposal_id,tenant_id=trusted_tenant --receipt-mode runner_ledger --patch amount_cents=arg:amount_cents
  ${cmd} init --inspection-json schema.json --table sessions --mode review --operation delete
  ${cmd} init --answers answers.json --yes
  ${cmd} init --inspection-json schema.json --table invoices --mode review --writeback http_handler --handler-url-env APP_WRITEBACK_URL --emit-handler [--handler-signing-secret-env APP_WRITEBACK_SIGNING_SECRET]
  ${cmd} init from-prisma ./prisma/schema.prisma --output ./synapsor-prisma-candidates
  ${cmd} init from-drizzle ./src/schema.ts --output ./synapsor-drizzle-candidates
  ${cmd} init from-openapi ./openapi.yaml --output ./synapsor-openapi-candidates

Generate a reviewed Synapsor Runner contract. Defaults to read-only in the wizard.
Native direct SQL operations are update, insert, and delete. Existing configs default to update.
Receipt modes are source_auto_migrate, source_precreated, and runner_ledger.
Runner-ledger mode creates no Synapsor table in the source database, but an ambiguous
post-commit crash must be reconciled by an operator instead of retried automatically.
Rich or externally visible writes still use http_handler or command_handler.
If --namespace is omitted, init derives one from the table name instead of using source.*.
Use --read-tool and --proposal-tool to override the exact model-facing capability names.
The guided wizard shows a final preview and lets you revise visible fields or capability names before writing files.
Use --yes/--non-interactive plus explicit flags, or --answers, for script/agent-friendly setup without prompts.

The from-prisma, from-drizzle, and from-openapi commands inspect developer
artifacts and emit a separate, deterministic review directory. They infer
structure only. Tenant/principal authority, sensitive-field decisions, write
policy, and business bounds remain explicit review tasks. Generated writes are
disabled, the Runner config is shadow-only and source-less, and existing output
is never replaced unless --force targets a directory owned by this generator.
Drizzle input is parsed as a bounded TypeScript AST and is never imported or run.
	`,
    mcp: `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp serve --transport streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp serve-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp config --absolute-paths --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp install <cursor|claude-code|vscode> --project --authoring [--project-root .] [--dry-run]
  ${cmd} mcp install <cursor|claude-code|vscode> --project [--dry-run] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp status <cursor|claude-code|vscode> --project [--check-launch]
  ${cmd} mcp uninstall <cursor|claude-code|vscode> --project [--dry-run]
  ${cmd} mcp audit --example dangerous-db-mcp
  ${cmd} mcp audit ./tools-list.json
  ${cmd} mcp audit generate ./tools-list.json --output ./synapsor-audit-candidates

Use stdio for local MCP clients that launch the runner. Use Streamable HTTP for standard HTTP MCP clients. Use serve-http only when you explicitly want the lightweight JSON-RPC bridge.
Stdio opens no network socket and needs no HTTP credential. Networked MCP is authenticated by default and non-loopback listeners require an explicit protected channel.
MCP clients see semantic tools. They do not receive raw SQL, write credentials, approval tools, or commit tools.
`,
    "mcp install": `Usage:
  ${cmd} mcp install <cursor|claude-code|vscode> --project --authoring [--project-root .] [--dry-run] [--yes]
  ${cmd} mcp install <cursor|claude-code|vscode> --project [--project-root .] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db] [--dry-run] [--yes]

Preview, confirm, and merge a project-scoped Synapsor entry into
.cursor/mcp.json, .mcp.json, or .vscode/mcp.json.
Runner preserves other servers/settings, creates a backup before changing an
existing file, records explicit ownership, and never writes database URLs,
credentials, trusted identity, approval, apply, revert, or policy authority.
--authoring installs the active local development/staging Scoped Explore
boundary with exactly app.describe_data and app.explore_data. It validates the
current generation lock and database role before installation and never uses a
runtime config. Re-run without --authoring after Protect activates a production
named capability.
`,
    "mcp status": `Usage:
  ${cmd} mcp status <cursor|claude-code|vscode> --project [--project-root .] [--check-launch] [--timeout-ms 10000] [--json]

Verify Runner's project-scoped client ownership marker and print the exact
reviewed model-facing tools. --check-launch performs a real stdio initialize +
tools/list handshake with the configured command.
`,
    "mcp uninstall": `Usage:
  ${cmd} mcp uninstall <cursor|claude-code|vscode> --project [--project-root .] [--dry-run] [--yes] [--json]

Remove only the Runner-owned Synapsor entry. Other client MCP servers and
project settings are preserved, and edited/unowned entries fail closed.
`,
    tools: `Usage:
  ${cmd} tools list --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools list --aliases --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools catalog --config ./synapsor.runner.json [--result-format v1|v2] [--json]

List the model-facing MCP tools generated from a reviewed Runner config.
Use --aliases to show canonical Synapsor names and OpenAI-safe aliases.
tools catalog emits the deterministic synapsor.analytics-catalog.v1 metadata
for active, digest-pinned analytical capabilities. Ambiguous reads are omitted.
This command never prints database URLs or write credentials.
`,
    "mcp serve": `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db [--transport stdio] [--read-only] [--local] [--alias-mode canonical|openai|both] [--result-format v1|v2]
  ${cmd} mcp serve --authoring --project-root .
  ${cmd} mcp serve --transport streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN [--result-format v2]
  ${cmd} mcp serve --transport streamable-http --production-explore --config ./synapsor.runner.json --host 0.0.0.0 --trusted-tls-proxy

Start the stdio MCP server for local MCP clients such as Claude Desktop, Cursor, or local agent tools. Startup logs stay off stdout so the MCP protocol remains clean.
Stdio is the recommended local-desktop path: it opens no HTTP listener and therefore needs no HTTP token, TLS, OAuth flow, or MCP HTTP session.
The explicit --authoring route exposes only app.describe_data and app.explore_data after a local human activates the current development/staging boundary. It refuses HTTP, production/unknown profiles, stale generation locks, and credentials that are not demonstrably SELECT-only and non-owner.
The explicit --production-explore route exposes the same two read-only tools
from separately reviewed production boundaries. It requires asymmetric JWT
tenant/principal claims, the configured OAuth scope, direct TLS or a trusted
TLS proxy, and atomic shared-Postgres per-principal plus tenant privacy
accounting. Static tokens, no-auth, cleartext break glass, Protect, approval,
apply, configuration, credentials, and SQL are unavailable on this surface.
Production Explore also fixes the public names to app.describe_data and
app.explore_data and fixes the reviewed result envelope. It rejects
--alias-mode, --tool-name-style, --openai-tool-aliases, and --result-format
instead of silently ignoring them.
For Streamable HTTP, Bearer may present either an operator-provisioned opaque endpoint token or an identity-provider-issued signed JWT. Runner never issues or refreshes these credentials.
Use --alias-mode openai, or --openai-tool-aliases, for clients that reject dotted tool names. Use --alias-mode both to expose canonical and alias names.
Use --result-format v2 to return one stable ok/summary/data/proposal/error envelope from every tool call.
`,
    "mcp serve-streamable-http": `Usage:
  export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db [--host 127.0.0.1] [--port 8766] [--auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN] [--alias-mode canonical|openai|both] [--result-format v1|v2]
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --host 0.0.0.0 --trusted-tls-proxy --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --tls-cert-env SYNAPSOR_TLS_CERT_PEM --tls-key-env SYNAPSOR_TLS_KEY_PEM --tls-ca-env SYNAPSOR_TLS_CA_PEM --require-client-cert
  ${cmd} mcp serve-streamable-http --production-explore --config ./synapsor.runner.json --host 0.0.0.0 --trusted-tls-proxy

Start the spec-compatible MCP Streamable HTTP endpoint for clients and SDKs that support HTTP MCP.
With --production-explore, tool names and the reviewed result envelope are
fixed. Presentation alias and result-format flags are rejected explicitly.
HTTP Bearer is the credential presentation scheme. It carries either an opaque
single-service endpoint token or a signed per-session JWT; Bearer does not make
the credential a JWT. Runner never issues either credential. An operator creates
and provisions the opaque token out of band. A configured identity provider
issues JWTs for shared deployments, and Runner verifies them on every request.
Never put token values or PEM contents on the command line or in config JSON.

Behavior:
  - Uses the official MCP Streamable HTTP initialize/session transport.
  - Use --alias-mode openai, or --openai-tool-aliases, for clients that reject dotted tool names.
  - Use --alias-mode both to expose canonical names and aliases.
  - Use --result-format v2 for the stable ok/summary/data/proposal/error envelope.
  - OpenAI aliases expose names such as billing__inspect_invoice while preserving the canonical Synapsor name in _meta.
  - Use /mcp, minimal /healthz, dependency-aware /readyz, and separately authenticated /metrics.
  - Sessions are bounded and in-memory. Restarting Runner clears active HTTP MCP sessions.

Security:
  - Defaults to 127.0.0.1:8766.
  - Authentication is required by default; --dev-no-auth is loopback-development-only.
  - A non-loopback listener refuses to bind unless it has Runner TLS, an explicit trusted TLS proxy/private hop, or the authenticated --unsafe-allow-cleartext-http break glass.
  - --previous-auth-token-env accepts exactly one previous opaque token during a bounded rotation window.
  - mTLS supplements Bearer authentication; it does not replace tenant/principal claims unless your deployment is explicitly single-tenant.
  - CORS is disabled by default. --cors-origin accepts one exact origin, never a wildcard.
  - Shared deployments require http_claims, signed session_auth, exact issuer/audience, and RFC 9728 oauth_resource metadata in Runner config.
  - Production Explore additionally requires an active production boundary,
    a mandatory principal claim, one shared HMAC key, and shared Postgres
    atomic privacy accounting. Run doctor before serving.
  - Diagnose the exact posture with: ${cmd} doctor --config ./synapsor.runner.json --transport streamable-http --host 127.0.0.1
`,
    "mcp serve-http": `Usage:
  export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  ${cmd} mcp serve-http --config ./synapsor.runner.json --store ./.synapsor/local.db [--host 127.0.0.1] [--port 8765] [--auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN] [--result-format v1|v2]
  ${cmd} mcp serve-http --config ./synapsor.runner.json --tls-cert-env SYNAPSOR_TLS_CERT_PEM --tls-key-env SYNAPSOR_TLS_KEY_PEM

Start the lightweight HTTP JSON-RPC bridge for app/server deployments that want simple POST calls.
Bearer auth is required by default.

Supports POST /mcp methods tools/list, tools/call, and resources/read.
It does not implement MCP Streamable HTTP initialize/session behavior. Use ${cmd} mcp serve-streamable-http for standard HTTP MCP clients.

Security:
  - Defaults to 127.0.0.1:8765.
  - Uses the same remote-channel, static-token rotation, TLS/mTLS, Origin/Host, and request-bound enforcement as Streamable HTTP.
  - It intentionally rejects http_claims because it has no standard MCP session on which to bind per-session identity.
  - Use --dev-no-auth only for loopback development. Exact optional CORS: --cors-origin http://localhost:3000
`,
    "mcp config": `Usage:
  ${cmd} mcp config [claude-desktop|cursor|generic|vscode|openai-agents] [--absolute-paths] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client openai-agents [--transport streamable-http] [--port 8766] [--alias-mode openai] [--client-access-token-env SYNAPSOR_MCP_ACCESS_TOKEN] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Print MCP client configuration that references the local runner command and credential environment names, never database URLs or credential values. Defaults to claude-desktop.
OpenAI Agents SDK output uses Streamable HTTP and OpenAI-safe aliases by default.
`,
    "mcp client-config": `Usage:
  ${cmd} mcp client-config --client claude-desktop [--absolute-paths] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client cursor [--absolute-paths] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client openai-agents [--transport streamable-http] [--port 8766] [--alias-mode openai] [--client-access-token-env SYNAPSOR_MCP_ACCESS_TOKEN] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Print MCP client configuration that references the local runner command, auth metadata, and environment-variable names, not database URLs or credential values.
Opaque endpoint tokens are generated and provisioned by the operator. Signed JWT access tokens are issued by the configured identity provider. Runner verifies them but does not issue or refresh them.
OpenAI Agents SDK output uses Streamable HTTP and OpenAI-safe aliases by default.
Use --include-instructions to include the recommended propose-first agent prompt.
`,
    smoke: `Usage:
  ${cmd} smoke call [capability-name] [--sample] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} smoke call [capability-name] --json '{"record_id":"..."}'
  ${cmd} smoke boundary [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Call a generated semantic tool locally before wiring Claude, Cursor, or another MCP client. The call uses the same runtime as MCP, records evidence/query audit/proposals in the local store, and does not expose raw SQL or write credentials.
`,
    writeback: `Usage:
  ${cmd} writeback setup [--config ./synapsor.runner.json] [--source <name>] [--profile development|staging|production]
  ${cmd} writeback setup --apply --profile staging --confirm "APPLY WRITEBACK SETUP sha256:..." [--writer-role app_writer] [--setup-url-env APP_SETUP_DATABASE_URL]
  ${cmd} writeback doctor --config ./synapsor.runner.json [--check-db]
  ${cmd} writeback migration --engine postgres [--schema synapsor] [--table synapsor_writeback_receipts]
  ${cmd} writeback migration --engine mysql [--schema appdb] [--table synapsor_writeback_receipts]
  ${cmd} writeback grants --engine postgres --writer-role app_writer [--schema synapsor] [--table synapsor_writeback_receipts]
  ${cmd} writeback grants --engine mysql --writer-role "'app_writer'@'%'" [--schema appdb] [--table synapsor_writeback_receipts]
  ${cmd} writeback reconcile list --status reconciliation_required --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} writeback reconcile inspect latest --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} writeback reconcile resolve wbi:... --outcome applied --reason "verified source state" --yes --config ./synapsor.runner.json --store ./.synapsor/local.db

Preview or safely apply receipt setup for direct writeback. setup is plan-only
unless a development/staging profile and the exact plan digest are confirmed.
Production and unknown profiles never apply DDL. source_db + auto_migrate
creates the fixed receipt table idempotently; source_db + precreated verifies
rollback-only permissions and never runs DDL. runner_ledger creates no receipt
table in the source database and sends ambiguous post-commit outcomes to the
operator reconciliation queue. Reconciliation re-reads only reviewed,
tenant-scoped metadata and never retries or guesses an ambiguous source commit.
Rich or externally visible writes should use app-owned handlers.
`,
    handler: `Usage:
  ${cmd} handler template --list
  ${cmd} handler template node-fastify [--output ./synapsor-writeback-handler.mjs] [--force]
  ${cmd} handler template python-fastapi [--output ./synapsor_writeback_handler.py] [--force]
  ${cmd} handler template command [--output ./synapsor-command-handler.mjs] [--force]

Write starter app-owned writeback handlers for approved proposals. Use these when rich writes should run through your application service instead of Runner-managed SQL.
`,
    "handler template": `Usage:
  ${cmd} handler template --list
  ${cmd} handler template node-fastify [--output ./synapsor-writeback-handler.mjs] [--force]
  ${cmd} handler template python-fastapi [--output ./synapsor_writeback_handler.py] [--force]
  ${cmd} handler template command [--output ./synapsor-command-handler.mjs] [--force]
  ${cmd} handler template node-fastify --stdout

Templates:
  node-fastify    HTTP handler for a Node/Fastify application service
  python-fastapi  HTTP handler for a Python/FastAPI application service
  command         Local command handler for scripts or job runners

The template receives an approved proposal writeback request and must return an applied/conflict/failed receipt. Re-check tenant, principal, idempotency, row/version guards, and business policy before mutating state.
`,
    onboard: `Usage:
  # Interactive artifact setup
  ${cmd} onboard db --from-env DATABASE_URL [--schema public]

  # Canonical non-interactive read-only setup
  ${cmd} onboard db --from-env DATABASE_URL --table public.invoices --mode read_only --tenant-key tenant_id --yes --no-open

  ${cmd} onboard db --from-env DATABASE_URL --table public.invoices --mode review --operation update --tenant-key tenant_id --conflict-column updated_at --patch late_fee_cents=fixed:0 --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes --no-open
  ${cmd} onboard db --from-env DATABASE_URL --table public.account_credits --mode review --operation insert --tenant-key tenant_id --dedup request_id=proposal_id,tenant_id=trusted_tenant --receipt-mode runner_ledger --patch amount_cents=arg:amount_cents --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes --no-open
  ${cmd} onboard db --from-env DATABASE_URL --table public.invoices --mode review --operation update --tenant-key tenant_id --conflict-column updated_at --patch late_fee_cents=fixed:0 --writeback http_handler --handler-url-env APP_WRITEBACK_URL --emit-handler --yes --no-open
  ${cmd} onboard db --answers answers.json --yes

Guided own-database setup: inspect schema, choose one object, create trusted
context, choose read-only/shadow/review mode, select guarded single-row
INSERT/UPDATE/DELETE or an app-owned handler, select receipt authority, generate
semantic tools, validate config, and run a tool-boundary smoke check.
In a terminal, Runner prompts for mode and trusted tenant scope. For CI, pass
--table, --mode, and either --tenant-key or --single-tenant-dev together; write
modes also require their reviewed patch and --yes. Missing automation decisions
are reported together. Use --answers for a stable file-driven run, and add
--force only after reviewing existing generated files.
`,
    propose: `Usage:
  ${cmd} propose <capability-name> --sample [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} propose <capability-name> --input ./input.json
  ${cmd} propose <capability-name> --json '{"invoice_id":"INV-3001","reason":"support-approved waiver"}'
  ${cmd} propose <capability-name> --sample --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL

Examples after running ${cmd} demo:
  ${cmd} propose billing.propose_late_fee_waiver --sample
  ${cmd} propose support.propose_plan_credit --sample
  ${cmd} propose orders.propose_status_change --sample

Create the same evidence-backed proposal the MCP tool would create. The source database is not mutated.
Use --shared-ledger-mirror only when the shared Postgres ledger migration has
been applied; it restores the shared ledger before mutation and syncs after
mutation while the local SQLite store remains the live runtime store. Mirror
mode holds a schema-scoped Postgres advisory lock while it runs; adjust the
default 10000ms wait with --shared-ledger-lock-timeout-ms.
`,
    audit: `Usage:
  ${cmd} audit --example dangerous-db-mcp
  ${cmd} audit --example dangerous-db-mcp --verbose
  ${cmd} audit --example dangerous-db-mcp --format json
  ${cmd} audit --example dangerous-db-mcp --format markdown
  ${cmd} audit --example dangerous-db-mcp --format sarif
  ${cmd} audit generate --example dangerous-db-mcp --output ./synapsor-audit-candidates [--open-ui]
  ${cmd} audit generate ./tools-list.json --output ./synapsor-audit-candidates [--force]
  ${cmd} audit ./synapsor.runner.json
  ${cmd} audit --mcp-config ./claude_desktop_config.json
  ${cmd} audit --mcp-config ./.cursor/mcp.json --live-server synapsor --yes
  ${cmd} audit --stdio "node ./server.js"
  ${cmd} audit --url http://localhost:3000/mcp

Default text groups repeated findings into the top three root causes. Use
--verbose for every finding. Candidate generation uses the same scanner and
writes a separate canonical contract, shadow-only scaffold, deny/redaction
tests, and before/after tool surface. It never activates or rewrites production
configuration. --open-ui opens the blocked candidate in the secured localhost
workbench; the source map and writeback remain empty until separately reviewed.

Static MCP/database risk review only by default. --mcp-config never launches
configured commands unless one exact --live-server is named with --yes. Live
mode calls only initialize and tools/list, never a business tool. This is not a
security guarantee.
`,
    doctor: `Usage:
  ${cmd} doctor --config synapsor.runner.json
  ${cmd} doctor --config synapsor.runner.json --setup
  ${cmd} doctor --config synapsor.runner.json --json
  ${cmd} doctor --config synapsor.runner.json --check-handlers
  ${cmd} doctor --config synapsor.runner.json --check-writeback
  ${cmd} doctor --config synapsor.runner.json --check-rls
  ${cmd} doctor --config synapsor.runner.json --check-mcp-client <cursor|claude-code|vscode>
  ${cmd} doctor --config synapsor.runner.json --transport streamable-http --host 127.0.0.1 --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} doctor --config synapsor.runner.json --transport streamable-http --host 0.0.0.0 --trusted-tls-proxy
  ${cmd} doctor --config synapsor.runner.json --transport streamable-http --host 0.0.0.0 --tls-cert-env SYNAPSOR_TLS_CERT_PEM --tls-key-env SYNAPSOR_TLS_KEY_PEM
  ${cmd} doctor --config synapsor.runner.json --report --redact --output synapsor-doctor.md
  ${cmd} doctor --first-run

Validate local config, environment bindings, semantic tool boundary, source metadata when reachable, handler signing/reachability, operation-specific direct SQL writeback readiness, receipt authority, and local store stats. Reports are redacted; do not paste secrets into issues.
Use --setup immediately after onboarding. Deferred trusted-context and writer
bindings are shown as setup incomplete next steps. A missing primary read
credential, required HTTP session-auth key, or invalid configuration reports
setup failed. Normal doctor remains strict.
With --transport streamable-http/http, doctor also reports bind scope, channel protection, auth/identity mode, issuer/audience/resource, key readiness, static-token strength/rotation, exact Origin/Host policy, request/session limits, rate-limit scope, and remediation without printing credential values.
Use --check-writeback to verify the configured receipt mode. source_db/precreated uses rollback-only probes and never runs CREATE; source_db/auto_migrate verifies the fixed migration; runner_ledger verifies its durable intent store and requires no source receipt table.
Use --check-rls only on a disposable or explicitly approved live PostgreSQL target to run read-only cross-tenant/principal and pooled-context canaries for sources configured with database_scope.mode=postgres_rls.
Without --config, doctor is the legacy Cloud worker check and requires SYNAPSOR_CONTROL_PLANE_URL plus the scoped worker environment.
`,
    proposals: `Usage:
	  ${cmd} proposals list [--tenant acme] [--capability billing.propose_late_fee_waiver] [--object invoice:INV-3001] [--status applied]
	  ${cmd} proposals show latest
	  ${cmd} proposals show latest --details
	  ${cmd} proposals check-freshness latest --config ./synapsor.runner.json --store ./.synapsor/local.db
	  ${cmd} proposals check-freshness latest --details --json --config ./synapsor.runner.json --store ./.synapsor/local.db
	  ${cmd} proposals approve latest --yes
	  ${cmd} proposals reject latest --reason "..."
	  ${cmd} proposals approve latest --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL

	Review decisions happen outside the model-facing MCP tool surface. A freshness-required approval performs the same live check automatically and binds the approval to its immutable proof. Freshness at approval improves review quality; apply rechecks again before mutation. Human output is concise by default; use --details for reviewer metadata or --json for complete records.
	`,
    lifecycle: `Usage:
  ${cmd} lifecycle [--store ./.synapsor/local.db]
  ${cmd} lifecycle list [--tenant acme] [--capability billing.propose_late_fee_waiver] [--object invoice:INV-3001] [--status applied] [--limit 20]
  ${cmd} lifecycle show [latest] [--details|--json]
  ${cmd} lifecycle show --object invoice:INV-3001 --details
  ${cmd} lifecycle show <proposal|evidence|replay|job|intent-handle> --details
  ${cmd} lifecycle show receipt:<numeric-id> --details
  ${cmd} lifecycle show audit:<numeric-id> --details

Inspect one complete proposal lifecycle without querying internal ledger tables.
Bare lifecycle, lifecycle show, and lifecycle show latest select the newest
proposal deterministically. Filters select the newest match and report how many
matched; use lifecycle list to browse all matches. Any already-known linked
domain handle can be used as an alternate starting point. Numeric receipt and
query-audit ids require an explicit receipt: or audit: namespace; Runner never
guesses between domains.

The command is read-only: it does not materialize replay records, create jobs or
intents, acquire leases, contact a source database, or call Cloud. The default
view answers what was requested, trusted scope, approval/apply state, whether
the source changed, and the next safe command. --details prints the linked
causal timeline; --json emits the versioned synapsor.lifecycle-view.v1 document.
`,
    evidence: `Usage:
	  ${cmd} evidence list [--tenant acme] [--capability billing.inspect_invoice] [--object invoice:INV-3001]
	  ${cmd} evidence show ev_...
	  ${cmd} evidence show ev_... --details
	  ${cmd} evidence export ev_... --format json --output evidence.json
  ${cmd} evidence export ev_... --format markdown --output evidence.md

Inspect captured local evidence bundles and query-audit links without rerunning external DB reads.
`,
    "query-audit": `Usage:
	  ${cmd} query-audit list [--evidence ev_...] [--source app_postgres] [--table invoices]
	  ${cmd} query-audit show <audit_id>
	  ${cmd} query-audit show <audit_id> --details
	  ${cmd} query-audit export <audit_id> --format json --output audit.json

Inspect local query fingerprints, table names, row counts, and redacted-parameter metadata.
`,
    receipts: `Usage:
	  ${cmd} receipts list [--proposal wrp_...] [--status applied]
	  ${cmd} receipts show <receipt_id>
	  ${cmd} receipts show <receipt_id> --details

	Inspect guarded writeback receipts recorded by the trusted runner path. Use --details for idempotency keys, receipt hashes, and runner metadata.
`,
    apply: `Usage:
  ${cmd} apply <proposal-id> [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} apply latest [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} apply --all-approved --yes [--capability name] [--tenant id] [--max N] --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} apply --all-approved --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL
  ${cmd} apply --job job.json --config ./synapsor.runner.json --store ./.synapsor/local.db

Apply an approved proposal through guarded writeback. Requires a trusted write credential.

With --config, the writer connection comes from source.write_url_env, such as
SYNAPSOR_DATABASE_WRITE_URL. SYNAPSOR_DATABASE_URL is only the legacy fallback
for direct worker/apply flows without a local config.

Direct SQL writeback supports reviewed single-row INSERT, UPDATE, and DELETE.
With source_db receipt authority, mutation and receipt commit atomically; the
trusted writer needs receipt-table permissions and auto_migrate additionally
needs CREATE. With runner_ledger authority, no Synapsor source table is created,
but a crash after source commit can require explicit operator reconciliation.

When operator_identity.provider is signed_key, pass --identity <operator> and
--identity-key <private-key.pem>. Batch apply handles each approved proposal
independently; conflicts do not abort the remaining queue.
Shared-ledger mirror mode is opt-in. It restores from Postgres before the local
mutation and syncs back after while holding a schema-scoped Postgres advisory
lock. For MCP serving with Postgres as the primary proposal/evidence/replay
store, configure storage.shared_postgres.mode = "runtime_store".
`,
    revert: `Usage:
  ${cmd} revert <applied-proposal-id> --config ./synapsor.runner.json --store ./.synapsor/local.db --reason "..."
  ${cmd} revert latest --config ./synapsor.runner.json --store ./.synapsor/local.db --reason "..."

Create a new review-required compensation proposal from an unambiguous applied
receipt with an available bounded inverse. This command never approves or
mutates the source database. The new proposal inherits the original reviewer
role/quorum and must pass normal approval and guarded apply.

Only opt-in direct SQL capabilities are supported. Hard DELETE, app-owned
executors, external effects, stale rows, ambiguous outcomes, duplicate active
compensations, and invalid lineage fail closed. Revert is operator-only and is
never exposed as a model-facing MCP tool.
`,
    replay: `Usage:
  ${cmd} replay list [--tenant acme] [--object invoice:INV-3001]
	  ${cmd} replay show latest
	  ${cmd} replay show latest --details
	  ${cmd} replay show --proposal wrp_...
  ${cmd} replay show --replay replay_wrp_...
  ${cmd} replay show --evidence ev_...
  ${cmd} replay export --proposal wrp_... --format json --output replay.json
  ${cmd} replay export --proposal wrp_... --format markdown --output replay.md

	Show evidence, proposal events, receipts, and replay state without rerunning side effects. Human output is concise by default; use --details for reviewer metadata or --json for complete records.
`,
    activity: `Usage:
	  ${cmd} activity search --tenant acme --object invoice:INV-3001
	  ${cmd} activity search --tenant acme --object invoice:INV-3001 --details
	  ${cmd} activity search --capability billing.propose_late_fee_waiver --from 2026-06-01 --to 2026-06-23

Search the local SQLite evidence/replay ledger across proposals, evidence, query audit, receipts, and replay records.
`,
    events: `Usage:
  ${cmd} events tail --store ./.synapsor/local.db
	  ${cmd} events tail --proposal wrp_...
	  ${cmd} events tail --kind writeback_applied
	  ${cmd} events tail --follow --interval-ms 1000
  ${cmd} events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created
  ${cmd} events webhook --url-env SYNAPSOR_EVENT_WEBHOOK_URL --auth-token-env SYNAPSOR_EVENT_WEBHOOK_TOKEN --follow
  ${cmd} events webhook --url http://127.0.0.1:8788/synapsor/events --dry-run

Show or push local proposal/writeback lifecycle events such as proposal_created, proposal_approved, writeback_applied, writeback_conflict, and writeback_failed. Webhook delivery POSTs one local event envelope per event and never exposes database credentials.
	`,
    metrics: `Usage:
  ${cmd} metrics show --store ./.synapsor/local.db
  ${cmd} metrics show --tenant acme --capability billing.propose_credit
  ${cmd} metrics show --format json

Export Prometheus/OpenMetrics counters for proposals, approvals, rejections,
successful applies, conflicts, and failures, grouped by trusted tenant and
reviewed capability. No database credentials or business-row values are emitted.
`,
    activation: `Usage:
  ${cmd} activation show [--project-root .] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} activation show --json
  ${cmd} activation export --out ./.synapsor/activation-report.json
  ${cmd} activation show --try-state ./custom-try-container

Inspect the local try -> own-data onboarding -> Cursor -> first read -> first
proposal funnel. The report derives timestamps from owned try state, the
onboarding manifest, the Cursor ownership marker, and the local SQLite ledger.
It contains no database rows, object IDs, tenant IDs, credentials, or project
paths and sends no telemetry. Product activation time excludes initial npm
download/cache population; record cold npx timing separately.
`,
    attention: `Usage:
  ${cmd} attention list [--status open] [--severity critical] [--json]
  ${cmd} attention show
  ${cmd} attention show <attention_id>
  ${cmd} attention acknowledge [<attention_id>] [--actor local_operator]

Inspect the durable Human Attention Inbox without copying proposal ids. Bare
"attention show" resolves the highest-priority matching item. Acknowledgement
records that a human saw an item; it never approves a proposal, applies a write,
or changes the source database.
`,
    notifications: `Usage:
  ${cmd} notifications status [--json]
  ${cmd} notifications test [--sink operations]
  ${cmd} notifications dispatch [--sink operations] [--limit 20]
  ${cmd} notifications replay [<delivery_id>|latest] --yes --reason "sink repaired" [--identity alice --identity-key ./alice.pem]

Plan and deliver operator-owned attention events through the configured signed
HTTPS webhook or JSONL development sink. Notifications are disabled by default.
The default route is quiet: successful lifecycle events stay in the ledger and
Workbench, related incidents coalesce, transient retries stay internal, and
timely human-attention states are delivered. A webhook response cannot approve,
apply, cancel, acknowledge, or otherwise mutate Runner authority. Dead-letter
replay requires an exact signed-key or OIDC operator decision and requeues only
the immutable redacted event, never its proposal or database mutation.
`,
    worker: `Usage:
  ${cmd} worker run --yes --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} worker run --once --yes --max-attempts 5 --retry-base-ms 1000
  ${cmd} worker run --drain --yes --capability support.propose_plan_credit --tenant acme
  ${cmd} worker run --once --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL
  ${cmd} worker run --yes --config ./synapsor.runner.json
  ${cmd} worker status --store ./.synapsor/local.db [--status dead_letter] [--json]
  ${cmd} worker pause --yes --config ./synapsor.runner.json
  ${cmd} worker resume --yes --config ./synapsor.runner.json
  ${cmd} worker drain --yes --config ./synapsor.runner.json
  ${cmd} worker enable <capability> --digest sha256:<exact-digest> --yes --config ./synapsor.runner.json
  ${cmd} worker disable <capability> --digest sha256:<exact-digest> --yes --config ./synapsor.runner.json
  ${cmd} worker revoke <capability> --digest sha256:<exact-digest> --yes --config ./synapsor.runner.json
  ${cmd} worker cancel [latest|<proposal_id>] --yes --config ./synapsor.runner.json
  ${cmd} worker dead-letter list --config ./synapsor.runner.json
  ${cmd} worker dead-letter show wrp_... --config ./synapsor.runner.json
  ${cmd} worker dead-letter requeue wrp_... --retry-budget 3 --yes --config ./synapsor.runner.json --identity alice --identity-key ./alice.pem
  ${cmd} worker dead-letter discard wrp_... --reason "closed by operator" --yes --config ./synapsor.runner.json --identity alice --identity-key ./alice.pem

Run a supervised local writeback worker over approved proposals. Automatic
execution is disabled by default. It requires public contract permission plus
an independent deployment allowlist for the exact active digest. Contracts
without both opt-ins, including legacy AUTO APPROVE contracts, still wait for
manual apply. The worker reuses guarded apply and
rechecks approval, policy, limits, scope, target/supporting-row freshness,
credential posture, idempotency, and receipt authority before execution.

Queue claims use fenced leases, transient failures use bounded exponential
retries, terminal or exhausted failures enter the dead-letter queue, and
durable idempotency receipts prevent duplicate effects. Ambiguous outcomes
require reconciliation and are never blindly retried. Pause/drain and
capability controls preserve queued truth and are operator-only. Signed-key
configs still require a writeback operator identity through
--identity/--identity-key or their documented environment vars.
Shared-ledger mirror mode is only allowed for finite worker runs (--once or
--drain). It holds a schema-scoped Postgres advisory lock during the bounded
run. With storage.shared_postgres.mode=runtime_store, worker runs use repeated
bounded drain cycles through the Postgres-backed bridge and release the advisory
lock while idle, so multiple workers can share one runtime ledger safely.
Dead-letter requeue and discard require verified operator identity, preserve all
receipts/events, and refuse requeue when a durable receipt already proves the
database effect completed.

See docs/supervised-automatic-apply.md and
docs/human-attention-notifications.md.
`,
    store: `Usage:
  ${cmd} store stats --store ./.synapsor/local.db
  ${cmd} store vacuum --store ./.synapsor/local.db
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --dry-run
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --yes
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --yes --force
  ${cmd} store reset --store ./.synapsor/local.db --yes
  ${cmd} store shared-postgres migration --schema synapsor_runner
  ${cmd} store shared-postgres apply-migration --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres status --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner
  ${cmd} store shared-postgres sync --store ./.synapsor/local.db --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres restore --store ./.synapsor/restored.db --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres backup --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --output ./ledger-backup.json
  ${cmd} store shared-postgres verify-backup --input ./ledger-backup.json
  ${cmd} store shared-postgres restore-backup --input ./ledger-backup.json --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner_restore --yes
  ${cmd} store shared-postgres retention --older-than 30d --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --dry-run
  ${cmd} store shared-postgres retention --older-than 30d --output ./ledger-archive.json --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes

Local store maintenance only. Prune defaults to dry-run and reset requires --yes. These commands never touch your source Postgres/MySQL database. Destructive operations refuse while an active server lease exists unless --force is provided.
Shared Postgres commands create, inspect, sync, and restore the schema used by a shared ledger deployment; they never print the database URL.
Backups include a manifest digest. Retention archives terminal proposal graphs
before deletion and never removes pending review, approved, pending-worker,
failed/retry, or dead-letter records.
	`,
    shadow: `Usage:
  ${cmd} shadow study create --name "Support pilot" --capability billing.propose_late_fee_waiver --store ./.synapsor/local.db
  ${cmd} shadow study list --store ./.synapsor/local.db
  ${cmd} shadow study show sst_... --store ./.synapsor/local.db
  ${cmd} shadow study sync sst_... --store ./.synapsor/local.db
  ${cmd} shadow study add-proposal sst_... wrp_... --request-id request_123 --store ./.synapsor/local.db
  ${cmd} shadow case record --study sst_... --input case.json --store ./.synapsor/local.db
  ${cmd} shadow case import --study sst_... --input cases.jsonl --store ./.synapsor/local.db
  ${cmd} shadow outcome record --study sst_... --input outcome.json --store ./.synapsor/local.db
  ${cmd} shadow outcome import --study sst_... --input outcomes.jsonl --store ./.synapsor/local.db
  ${cmd} shadow report --study sst_... --output shadow-report.json --store ./.synapsor/local.db
  ${cmd} shadow study close sst_... --store ./.synapsor/local.db

Shadow studies compare what an agent proposed with explicit outcomes recorded
by an authorized application or operator. Shadow proposals cannot be approved,
queued, or applied, and report suggestions never activate policy automatically.
JSON and JSONL imports are bounded, scope-bound to trusted tenant/object/request
identity, and rejected when they contain obvious secret material.

Legacy compatibility:
  ${cmd} shadow list
  ${cmd} shadow record-human-action wrp_... --patch human-action.json
  ${cmd} shadow compare wrp_...
  ${cmd} shadow report
`,
	    demo: `Usage:
	  ${cmd} demo [--force]
	  ${cmd} demo --quick
	  ${cmd} demo --quick --guided
	  ${cmd} demo --quick --no-interactive
	  ${cmd} demo --quick --details
	  ${cmd} demo inspect
	  ${cmd} demo inspect --npx

	Start a disposable local Postgres demo and write ./synapsor.runner.json for the first-run flow.
	Use --quick as a backward-compatible alias for the isolated real try pipeline. Use demo inspect after try to print follow-up commands for its proposal, evidence, receipt, and replay.
	`,
    ui: `Usage:
  ${cmd} ui [--open] [--tour] [--profile development|staging|production|unknown] [--config synapsor.runner.json] [--store ./.synapsor/local.db]

Open the localhost review UI for proposals, diffs, evidence, receipts, replay,
and local shadow-study reports.
Use --open to launch the URL in your browser when a desktop opener is available.
Local Workbench approval and guarded apply require an explicit development or
staging profile. Production, unknown, and Cloud-governed authority routes to
the configured trusted operator/control-plane path.
`,
  };
  process.stdout.write(help[key] ?? help[command ?? ""] ?? help[""] ?? "");
}
