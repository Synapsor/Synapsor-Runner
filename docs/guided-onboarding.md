# Guided Onboarding: Database To First Safe Tool

This is the shortest path from an existing staging Postgres/MySQL database to
one useful agent tool. It requires no Synapsor account, Cloud login, database
replication, global install, MCP host, model API key, or hand-authored config,
DSL, JSON, SQL, DDL, or grants.

## The One-Minute Mental Model

Synapsor is creating the small set of database powers your agent may use. It
does not give the agent SQL access.

- Reads return only fields a human reviewed, under tenant and principal scope
  supplied outside model arguments.
- Scoped Explore is a temporary local development/staging authoring tool that
  supports repeated legal question combinations after one boundary review.
- Protect optionally turns one selected analysis into a narrow named
  capability for reuse or production.
- A model-facing write call creates an exact proposal. It does not commit.
- The model cannot activate authority, approve a proposal, or apply a write.
- A trusted operator or worker rechecks the effect and records a receipt.

## Operator Interface Status

Use the terminal CLI as the preferred interface for onboarding, access review,
Ask, Protect, diagnostics, and production setup. It is the most extensively
qualified operator surface for this release. Workbench supports the same core
review and Explore workflows, but its browser UI remains in preview. If its
guidance or behavior differs from the CLI, follow the CLI. This status does not
make the production Streamable HTTP MCP server a preview feature; it describes
only the local browser-based operator interface.

## Before You Start

Use a disposable or staging database and a dedicated SELECT-only, non-owner
credential. Keep row-level security, restricted views, or tenant-bound
credentials underneath Runner where available.

Do not put a database URL in project documentation or chat. The shortest path
uses a hidden terminal prompt:

```bash
npx -y @synapsor/runner start --cli
```

Runner can also use an already-exported `DATABASE_URL`. When a regular `.env`
or `.env.local` file exists, it asks before reading that file and holds the
selected value only for the current Runner/Workbench process. The URL is not
written to generated artifacts or the ledger. Runner requires Node 22.13 or
newer.

## Preview Workbench Path

Run this from an empty project directory or your application root:

```bash
npx -y @synapsor/runner start
```

The command automatically:

1. checks the database and credential posture;
2. inspects schema metadata without sampling source rows;
3. statically reads supported Prisma, Drizzle, OpenAPI, and existing Synapsor
   definitions when present;
4. drafts disabled public DSL, canonical JSON, tests, and a generation lock;
5. creates a valid zero-authority Runner config and local SQLite ledger;
6. validates every generated artifact;
7. opens one secured loopback Workbench URL.

## Preferred Terminal Path

To keep the same journey browserless, add `--cli`:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL --cli
```

Runner performs the same deterministic inspection and project generation, then
shows one conservative one-table, zero-relationship Quick Start boundary.
Pressing Enter once is the human gesture that reviews those exact defaults,
rechecks the schema and read-only role, activates only that digest, and starts
the provider and exact model displayed on the same screen. Press `M` to choose
OpenAI, Anthropic, a loopback OpenAI-compatible model, an existing MCP client,
or **Later**. Press `E` to open detailed multi-table/column review instead.
Running the command again resumes review, or goes directly to
model/client selection when a boundary is already active. `--no-open` remains
the noninteractive initialize/resume flag; it does not start terminal review.

## Scripted Artifact Setup

`start` is the recommended interactive first run. `onboard db` is the explicit
artifact generator for CI and established automation. A canonical read-only
run is:

```bash
synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --table public.orders \
  --mode read_only \
  --tenant-key tenant_id \
  --yes \
  --no-open
```

Noninteractive setup requires the table, mode, and one reviewed tenant-scope
choice in the same invocation. If several are missing, Runner lists all of
them together. Use `--single-tenant-dev` only for a reviewed single-tenant
development source. Use `--force` only after inspecting generated files that
already exist. In a real terminal, omit `--yes` and `--non-interactive`; table
selectors seed the wizard, which prompts for mode and tenant scope.

For shadow/review proposals, UPDATE and DELETE also require an explicit
`--conflict-column`; INSERT requires a source-enforced `--dedup` mapping. Review
mode additionally requires the credential name for its writeback path:
`--write-url-env`, `--handler-url-env`, or `--handler-command-env`. Runner lists
all missing choices together before inspecting or writing generated files.

After generation, deferred trusted-context and writer environment variables are
reported as `setup incomplete` with one next action. A missing primary database
read credential, a required shared-HTTP session-auth key, or an invalid config
reports `setup failed`. The strict reusable check remains:

```bash
synapsor-runner doctor --config ./synapsor.runner.json
```

Before human activation, the agent has no generated authority and no source row
has been read. The fresh local `start` route establishes a development
authoring profile for this secured loopback process. Supplying the selected
database URL is the environment-selection step; Workbench does not ask you to
declare or sign “development,” “staging,” or “not production” again.

For the configured-model golden path, first value has two human interactions:

1. press Enter to accept the exact conservative local boundary;
2. type the first natural-language question.

Before the second interaction, Runner displays the exact provider, model,
origin, and reviewed egress boundary. Submitting that first question confirms
the disclosure; no provider request occurs before submission. Review and
activation remain separate digest-bound records under the hood even though the
single Quick Start gesture authorizes both. The model performs neither action.

After first value, `/access` opens the terminal boundary editor and
`/access-workbench` opens the visual editor. Quick Start's active boundary is
saved as the reviewed baseline, so adding a table or changing a column does not
silently remove existing access. The edited or newly named boundary remains
disabled until separate human review and exact-fingerprint activation.

Both editors use the same two-step boundary flow:

1. edit included tables, column egress tiers, and reviewed relationship paths
   in one focused surface;
2. inspect one complete boundary summary and activate that exact boundary
   before returning directly to Ask.

Activating a differently named boundary adds it to the same authoring session;
activating an existing name updates only that boundary. Ask keeps the selected
provider/model and in-memory key, clears stale conversation history, and binds
egress to the new active-set digest. The model still sees only
`app.describe_data` and `app.explore_data`, and every data plan uses one
boundary rather than combining authority across boundaries.

Routine low-risk edits are staged immediately on the selected disabled boundary; no
per-table sign-off wall is inserted into this path. The advanced
`boundary review` workflow still exposes grouped table and boundary sign-offs
for governance work. Sensitive widening requires reviewer identity and reason.
Nullable relationships require a direct keep-unmatched or exclude-unmatched
choice because either answer changes business totals.

To add or change a per-user row limit in the terminal editor, select the table,
press `Enter` for columns, then press `O`. Choose a direct non-null column, a
proven mandatory relationship path, or explicitly keep no per-user limit, and
record the reason. Runner returns to the same column screen; press `Enter` to
save any staged column choices, then `C` from the boundary table view to review
and activate the exact disabled revision. Workbench provides the same control
under **Record and customer limits**. Trusted principal values remain outside
the model in both local and production HTTP Explore.

In the boundary overview, `D` means **Deactivate active boundary**. In a
boundary's table list, `R` means **Remove from draft** and never deactivates the
whole boundary. Runner never silently cascades that removal: if another table's
reviewed tenant/principal scope or named analytics policy depends on the selected
table, removal is blocked and the editor names the dependent tables in leaf-first
order. Remove or re-scope those dependents first. Analysis relationships that no
longer have both endpoints are narrowed out of the disabled draft and reported;
active authority remains unchanged until `C` review and activation. Deactivating
the last active boundary is a normal `/access` state: the editor stays open,
displays `Enter/C Review + activate`, and lets the
operator restore reviewed Ask access without restarting. Activation also
returns to `/access`; provider rebinding or model choice occurs only after the
operator presses `Q` or Escape to finish editing.

Explore may then answer repeated legal question combinations without another
review and without Protect. Protect is optional: it converts one selected
analysis into generated public DSL, canonical JSON, and tests, but creates only
a disabled named capability until a human separately activates its exact
digest.

Workbench then offers a fast lane:

1. verify the required trusted tenant/principal bindings are already supplied
   by the operator-owned environment or identity integration, outside
   Workbench and outside model arguments;
2. inspect the conservative starter-boundary summary and select **Activate
   this boundary**.

The single gesture is recorded against the exact boundary digest. Runner
rechecks schema and read-only role posture, activates only the exact reviewed
tables, fields, relationships, operations, and limits, and keeps sensitive and
uncertain fields out before routing to the model-first Ask setup. The request
cannot select or change the profile.
Direct `ui`, explicit production/unknown profiles, shared/remote surfaces,
widening, and write paths do not gain this shortcut. If a required binding is
absent, Quick Start remains unavailable and points to one operator-owned
identity setup action; it never asks the developer to type a raw tenant or
principal ID into the analytics UI.

After that proof, the primary action is **Ask here with a model**. Workbench
uses an available `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` by environment-variable
name without returning its value to the browser, or accepts a session-only
credential or loopback OpenAI-compatible model. A developer whose Cursor,
Claude, VS Code, Codex, or other MCP client already has a model can instead
choose **Use my existing AI client**. The exact-plan no-model composer remains
a secondary fallback.

Running the same command again resumes. Resume and Try do not rescan, rewrite
files, or change a digest. This also applies to a valid Runner-managed project
created with standalone `boundary draft` and `boundary review`: its draft and
generation lock are sufficient, so a missing guided-onboarding marker does not
strand it. To deliberately re-inspect the current database, run:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL --rescan
```

`--rescan` works for both single-organization and multi-tenant projects. It
reconciles all saved boundaries, preserves decisions whose exact reviewed
inputs are unchanged, and itemizes new, removed, or invalidated inputs. This
includes normalized, non-secret trusted-context config: provider, environment or
JWT claim names, and tenant/principal column bindings. A config-only change such
as adding `principal_binding` therefore produces a disabled review revision even
when the database fingerprints are unchanged; unrelated curated policy is kept.
New fields remain kept out and new relationships remain unused. Ask keeps using
the previous exact revision until a human reviews and activates the disabled update.
On this Start path, `--force` performs the same guarded reconciliation; prefer
`--rescan` because it states the intent clearly.

The three related commands have different jobs:

- `synapsor-runner boundary rescan` inspects the database, reloads config-derived
  trusted-context authority, and writes a disabled, reconciled revision plus a
  change report. It does not open an editor or activate anything.
- `synapsor-runner boundary review --access` opens the focused table, column,
  relationship, and scope-path editor without inspecting again. This is the
  same editor opened by `/access` inside the Ask shell.
- `synapsor-runner start --from-env DATABASE_URL --cli --rescan` performs the
  rescan, review, activation, and Ask handoff as one guided flow. After running
  standalone `boundary rescan`, use the same `start` command without
  `--rescan`; the saved reconciliation is already waiting for review.

When standalone review activates a boundary, Runner prints the exact command
to resume the guided Ask flow. It also prints a direct `try ask` command for an
operator who has already selected a provider and model.

If an old project has exactly one disabled boundary and rescan cannot reconcile
it because none of its saved resources remains in the inspected schema, Runner
prints one explicit recovery command:

```bash
synapsor-runner boundary delete <boundary-name> \
  --discard-curated-review \
  --yes
```

Ordinary deletion of the only boundary remains protected, and this recovery
refuses an active boundary or a project with several saved boundaries. It
deletes only the marked generated authoring tree and curated boundary review
state. The Runner config, `.synapsor/local.db` ledger and evidence, and source
database remain intact. Runner then prints the exact current-version draft
command. Preview Workbench provides the same guarded action as **Reset curated
review** and requires typing `DISCARD REVIEW <boundary-name>` exactly.

Workbench requires no additional terminal command. If you choose the CLI
fallbacks below after the first success, install Runner once:

```bash
npm install -g @synapsor/runner
```

The remaining examples then use `synapsor-runner` directly instead of
reacquiring the npm package for every command.

## Five Minutes: First Safe Read

The full Workbench path starts with an overview, not a permission matrix. It
shows:

- database and framework evidence found;
- resources inspected;
- fields already kept out;
- unresolved sensitive fields;
- row identity;
- tenant and principal scope;
- database-role and RLS posture;
- ready and blocked capabilities.

Review only the exceptions. Routine conservative defaults are already applied.
There is no global “approve everything” control.

For each selected resource, confirm the exact primary/unique row identity,
trusted scope, visible fields, kept-out fields, and any aggregate-only fields.
Then confirm the displayed review. Runner binds its digest to that human action
internally; the developer does not copy or type a hash. Changing a reviewed
decision creates a new disabled digest that must be reviewed again.

When a database uses opaque or legacy names, add a reviewed table or column
label and description in the same access editor. In the terminal press `I` on
the selected table or column; Workbench shows **Reviewed label** and **Reviewed
description**. These words help the human and `app.describe_data` explain the
schema, but grant no operation and are not valid plan identifiers. Exact
database IDs remain visible beside them. A label on a kept-out field stays
human-only and does not expose that field to a model.

Choose **Try first safe read**. Runner calls the real local runtime and shows:

```text
Your first safe tool is working.

Tool: <domain>.inspect_<resource>
Agent can see: <reviewed fields>
Agent cannot see: <kept-out fields>
Tenant scope: trusted outside model arguments
Principal scope: trusted outside model arguments
Source database changed: no
```

CLI fallback:

```bash
synapsor-runner try call --list --format json
synapsor-runner try call <returned-tool-name> --sample --json
```

The second command is for an activated named tool with valid generated sample
input. It does not invent tenant or principal values.

## Ask Through Your Own Model Or Existing Client

The first interactive analytics path is plain-language model access. After the
safe-read proof, choose **Ask here with a model** to open Workbench Ask, or
**Use my existing AI client** to install the same two reviewed authoring tools
into a host that already has a model. A provider key is never mandatory:
**Use without a model** opens the exact-plan composer as a fallback.

Workbench shows the exact reviewed tools first. Select OpenAI, Anthropic, or a
custom OpenAI-compatible endpoint, choose a named environment credential or a
session-only masked paste, and acknowledge that reviewed visible data may go
directly to that provider. When a conventional provider environment variable
is already present, Workbench selects its name automatically but never sends
its value to the browser. Synapsor does not relay the request.

The provider can request only the displayed tools. It cannot choose trusted
scope, activate or Protect authority, approve or apply a proposal, or configure
Runner. A write request produces the same inert proposal as external MCP:

```text
Proposal only
Source database changed: no
The model cannot approve or apply this proposal.
```

Changing the provider, model, endpoint, runtime config, or reviewed boundary
requires a new egress acknowledgement. Select **Clear** to cancel and discard
the in-memory provider configuration and conversation. See [Workbench Ask With
Your Model](workbench-ask.md) for key handling, endpoint security, fixed bounds,
the tested provider matrix, and the full no-model alternative.

## Ten Minutes: Explore Repeatedly, Protect Optionally

Scoped Explore is available only after its exact boundary is activated. The
guided Workbench and `try ask` flow here are local development/staging clients.
Production uses a separately reviewed production boundary and explicit secured
HTTP MCP opt-in; without every production prerequisite, Explore remains absent
from remote `tools/list`.

In Workbench, choose **Ask an aggregate question**. Select only reviewed
resources, dimensions, measures, filters, and time buckets. No SQL or plan JSON
is required.

The distinct-count permission has one human-facing name: **Count unique**. In
the terminal `/access` table screen, press `G` (**Reviewed metrics and numeric
bands**) and enable **Count unique** for the field. Workbench exposes the same
control in its reviewed metrics panel. For scripted review, the equivalent is
`boundary review resource <resource> --count-distinct-fields <field>`. This
grant permits the distinct aggregate only; it does not make the underlying
field values returnable.

The first release supports bounded:

- `count` and reviewed `count_distinct`;
- `sum`, `avg`, standard deviation, and variance over reviewed numeric measures;
- reviewed missing-data measures, named ratios, fixed numeric bands,
  reviewer-approved automatic numeric bands, and safe child-count metrics;
- exact scalar dimensions only after a human explicitly enables a safe field
  with `X` in the terminal, **Exact groups** in Workbench, or
  `--allow-exact-grouping`; numeric, date/time, UUID, and other fields that are
  not safe automatic categories remain non-groupable by default, and this grant
  is separate from bands;
- reviewed categorical dimensions;
- hour, day, week, month, quarter, year, and day-of-week buckets;
- reviewed running totals, ranks, lag changes, moving averages, and shares,
  calculated only from groups released after suppression;
- typed filters, bounded top/bottom-N, and an exact two-period comparison;
- up to three activated relationship paths, each containing one or two
  catalog-proven many-to-one links with fan-out one by default, or exactly
  three links after the reviewer raises the hard-capped depth control and
  activates that exact path.

If a question needs an inactive but proven path, Runner refuses it and
Workbench offers only that exact path for operator review. The model cannot
activate it. Optional links require an explicit missing-row choice because
excluding a row versus retaining an empty group can change business totals.
See [Reviewed Relationship Paths](reviewed-relationships.md).

Minimum cohorts, group limits, response limits, query limits, extraction
budgets, and anti-differencing budgets are fixed by the activated boundary.
Small groups are suppressed. Results describe changes or contributors; they do
not prove causation.

CLI fallback for the Workbench-suggested aggregate:

```bash
synapsor-runner try explore --suggested --json
```

Keep asking different legal combinations without another human review or a
Protect step. Workbench composer, Workbench Ask, CLI `try ask`, and authoring
MCP all use the same boundary, suppression, budgets, and denials:

```bash
synapsor-runner try ask \
  --provider openai \
  --model gpt-5.6-luna
```

Interactive CLI review does not stop after activation. It offers OpenAI,
Anthropic, a loopback OpenAI-compatible model, an existing MCP client, or
**Later**. Selecting a model enters this same shell in the current process.
Selecting **Later** leaves the reviewed boundary active, so the explicit command
above remains available. Automation and JSON output never enter the provider
picker.

This opens the natural-language terminal shell. Ask follow-ups directly, use
`/analyses` or `/details` only when advanced metadata is useful, and use bare
`/protect` to select the sole analysis from the current answer or open a picker
for a multi-plan answer. Supplying one quoted question before `--provider`
retains one-shot mode.

Each successful execution has an encrypted, expiring local Protect reference.
No protected artifact or named authority exists unless the operator chooses one
of those exact results.

Choose **Protect this analysis** directly on the successful result. Runner
freezes its reviewed resources, measures, grouping, time bucket, ordering,
scope, suppression, and limits into:

```text
synapsor/protected/drafts/<namespace>__<name>/capability.synapsor.sql
synapsor/protected/drafts/<namespace>__<name>/synapsor.contract.json
synapsor/protected/drafts/<namespace>__<name>/contract-tests.json
```

The capability remains disabled while Runner presents a separate exact review.
In the interactive shell, `/protect` then offers one default-yes human
activation gesture and returns to the same Ask session. Workbench provides the
equivalent **Activate this reviewed capability** button. Neither path requires
copying an analysis reference, opening the other surface, or typing a digest;
Runner binds and recomputes the previewed digest internally and fails closed if
the draft changed. Disabling Scoped Explore does not remove the protected named
capability.

Use `/details` to inspect the question, typed model request, normalized Runner
plan, boundary, reviewed paths, trusted-scope mechanism, read-only posture,
suppression, budgets, and execution metadata. `/details A2 --sql` adds a local
operator-only parameterized statement with every value redacted. That SQL is
never exposed through MCP or to the provider and is not stored in ordinary
evidence.

Workbench renders generated `.synapsor.sql` with local deterministic syntax
highlighting. Keywords, names chosen by the author, strings, numbers, comments,
and punctuation are visually distinct. The copy/plain-text value remains
byte-identical to the generated file; highlighting loads no CDN and escaped
source text never becomes HTML.

CLI fallback after a one-shot question, without copying a reference:

```bash
synapsor-runner try protect \
  --last \
  --name analytics.reviewed_weekly_summary \
  --json
```

If the latest answer ran several analyses, Runner lists `A1`, `A2`, and their
plain descriptions and requires an explicit `--from A2`.

## Fifteen Minutes: First Proposal

After the first read, open the preferred terminal control plane or choose
**Add a safe action** in the preview Workbench:

```text
synapsor> /actions
```

Or from the ordinary shell:

```bash
synapsor-runner action review --project-root .
```

Describe the allowed proposal in business language first. Runner ranks only
reviewed metadata and schema-proven candidates. Schema metadata supplies
structure, never business permission. The human specifies:

1. the business action;
2. target resource and exact row identity;
3. fields that may change;
4. allowed values, transitions, and numeric bounds;
5. trusted tenant and principal scope;
6. conflict/version guard;
7. approval role;
8. optional small bounded auto-approval;
9. per-operation and daily limits;
10. optional reviewed compensation.

The TUI can also import a bounded ActionSuggestion or request one suggestion
from OpenAI, Anthropic, or an OpenAI-compatible provider after explicit
structural-metadata egress consent. Suggestions contain no rows, SQL,
credentials, trusted scope, approval, writeback, or activation authority and
never replace the decisions above. See the [Safe Action Human Control
Plane](safe-action-control-plane.md).

Runner generates public DSL, canonical JSON, tests, an exact-effect preview,
and a disabled action. Unsupported or unsafe combinations fail closed. In
particular, DELETE, bounded-set, quorum, auto-approval, and reversibility cannot
be combined beyond what the canonical DSL supports.

After exact-digest human activation, call the named proposal tool in Workbench
or through the host-neutral Try path. The result must say:

```text
Proposal created.
Source database changed: no.
The model cannot approve or apply this proposal.
```

Inspect the latest lifecycle without copying a proposal ID:

```bash
synapsor-runner lifecycle --details
```

Approval and apply stay outside MCP:

```bash
synapsor-runner proposals approve latest --yes
synapsor-runner apply latest
synapsor-runner lifecycle show latest --details
```

Production should use a verified signed-key or OIDC operator identity rather
than unverified development identity. See [Approval Roles And Verified
Operator Identity](approval-roles-and-operator-identity.md).

These commands show the default human-approval/manual-apply path. A production
operator can separately opt an eligible action into exact-digest supervised
execution. That does not give the model an apply tool: the model creates a
bounded proposal, reviewed policy may approve it, and a separately trusted
worker repeats all guards before any later source mutation. Existing
`AUTO APPROVE` contracts remain manual-apply unless both opt-ins are present.
See [Operator-Supervised Automatic
Apply](supervised-automatic-apply.md).

## Guarded Development Writeback Setup

Preview is always the default:

```bash
synapsor-runner writeback setup \
  --profile staging \
  --json
```

The response contains one immutable plan digest and exact setup SQL, objects,
grants, receipt mode, and next action.

- `runner_ledger`: no Synapsor receipt table or receipt grant is added to the
  source database.
- `source_db` + `auto_migrate`: verifies the configured idempotent first-use
  path using the trusted writer.
- `source_db` + `precreated`: requires a separate setup/admin URL environment
  name and exact steady-state writer role.
- app-owned handlers receive no unnecessary source receipt setup.

DDL apply is refused for missing, unknown, or production profiles. In
development/staging, it requires the exact displayed confirmation:

```bash
synapsor-runner writeback setup \
  --profile staging \
  --writer-role '<steady-state-writer-role>' \
  --setup-url-env SYNAPSOR_SETUP_DATABASE_URL \
  --apply \
  --confirm 'APPLY WRITEBACK SETUP sha256:<reviewed-plan-digest>'
```

Never reuse the model/read credential as the elevated setup connection.

## Connect An MCP Client

Workbench generates ready-to-copy Cursor, Claude Code/Desktop, VS Code, Codex,
and generic stdio snippets for the same reviewed authority. Stdio opens no
network listener and needs no HTTP bearer credential.

Render the generic snippet:

```bash
synapsor-runner mcp config --absolute-paths
```

Preview a managed project change for the client you use:

```bash
synapsor-runner mcp install claude-code --project --dry-run
synapsor-runner mcp install cursor --project --dry-run
synapsor-runner mcp install vscode --project --dry-run
```

No client config contains database URLs, trusted scope values, approval,
activation, apply, or revert authority.

## Machine-Readable Output

Commands that support machine output write exactly one JSON value to stdout.
Operational logs and diagnostics use stderr:

```bash
synapsor-runner try explore --suggested --json | jq -e .
```

On a process-level failure, JSON output uses:

```json
{
  "ok": false,
  "error": {
    "code": "COMMAND_REJECTED",
    "message": "Safe redacted explanation"
  },
  "recovery": {
    "state_preserved": "What remains intact",
    "source_database_changed": null,
    "next_action": "One exact next action"
  }
}
```

`null` means Runner cannot honestly infer the source mutation outcome from a
generic command exception. Operation-specific receipts and reconciliation
states remain authoritative.

## Before And After

The earlier manual path could require roughly thirteen disconnected steps:
inspect, compile, create config, validate, doctor, initialize a store, start
Workbench, generate MCP config, create receipt DDL/grants, run a smoke call,
approve, and apply.

The guided path through the first proposal uses:

- one public shell command;
- deliberate Workbench review and activation;
- no manual file edits;
- no external documentation search;
- no Cursor requirement.

The packed FitFlow gate records the exact command count, human decisions, and
timings. Retail and healthcare clean-room gates add repeated Explore,
provider/CLI/MCP parity, PHI hiding, suppression, optional Protect, and
production narrowing. See:

- `development/runner-1.6.6-retail-results.json`
- `development/runner-1.6.6-healthcare-phi-results.json`

## Visual Reference

Repository screenshots cover desktop, mobile, light, dark, loading, blocked,
stale, failure, empty Protect, unavailable-action, optional Ask, refusal, and
proposal-only states:

- [Desktop overview](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-visual/workbench-overview-desktop-light.png)
- [Mobile overview](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-visual/workbench-overview-mobile-light.png)
- [All-blocked PHI review](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-healthcare-phi-visual/01-all-blocked-desktop.png)
- [Stale/failure recovery](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-visual/workbench-keyboard-stale-failure.png)
- [Ask kept-out-field refusal](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-retail-visual/05c-ask-refusal.png)
- [PHI-safe bounded result](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.6-healthcare-phi-visual/05-bounded-care-analytics.png)

For common blocked states and one-action recovery commands, use
[Troubleshooting First Run](troubleshooting-first-run.md).
