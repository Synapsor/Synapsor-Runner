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
- Scoped Explore is a temporary local development/staging authoring tool.
- Protect turns one useful analysis into a narrow named capability.
- A model-facing write call creates an exact proposal. It does not commit.
- The model cannot activate authority, approve a proposal, or apply a write.
- A trusted operator or worker rechecks the effect and records a receipt.

## Before You Start

Use a disposable or staging database and a dedicated SELECT-only, non-owner
credential. Keep row-level security, restricted views, or tenant-bound
credentials underneath Runner where available.

Do not put a database URL in project documentation or chat. The shortest path
uses a hidden terminal prompt:

```bash
npx -y @synapsor/runner start
```

Runner can also use an already-exported `DATABASE_URL`. When a regular `.env`
or `.env.local` file exists, it asks before reading that file and holds the
selected value only for the current Runner/Workbench process. The URL is not
written to generated artifacts or the ledger. Runner requires Node 22.13 or
newer.

## One Command To Workbench

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

Before human activation, the agent has no generated authority and no source row
has been read. On an explicitly asserted personal development database,
Workbench offers a fast lane:

1. confirm the database is your own development or disposable test data;
2. provide the trusted tenant/principal scope for this in-memory session;
3. inspect the one-resource summary and select **Activate this narrow read and
   show a real result**.

The single gesture is recorded against the exact boundary digest. Runner
rechecks schema and read-only role posture, activates one resource with no
relationships, keeps sensitive and uncertain fields out, and runs one real
bounded aggregate read. Shared, staging, production-like, remote, widening, and
write paths do not use this shortcut.

Running the same command again resumes. Resume and Try do not rescan, rewrite
files, or change a digest. Rescan and destructive Start over remain explicit
human choices.

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
Then sign the displayed digest. Changing a reviewed decision creates a new
disabled digest.

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

## Optional: Ask Through Your Own Model

The no-model Workbench composer is already complete; a provider key is never
required for onboarding. If you want a chat surface before installing Cursor
or another MCP client, open **Analyze -> Ask with your model**.

Workbench shows the exact reviewed tools first. Select OpenAI, Anthropic, or a
custom OpenAI-compatible endpoint, choose a named environment credential or a
session-only masked paste, and acknowledge that reviewed visible data may go
directly to that provider. Synapsor does not relay it.

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

## Ten Minutes: Explore And Protect

Scoped Explore is available only after its exact local authoring boundary is
activated. It is absent from production, unknown-profile, remote, shared HTTP,
and non-loopback `tools/list`.

In Workbench, choose **Ask an aggregate question**. Select only reviewed
resources, dimensions, measures, filters, and time buckets. No SQL or plan JSON
is required.

The first release supports bounded:

- `count` and reviewed `count_distinct`;
- `sum` and `avg` over reviewed numeric measures;
- reviewed categorical dimensions;
- day, week, and month buckets;
- typed filters and bounded top-N;
- up to three activated relationship paths, each containing one or two
  catalog-proven many-to-one links with fan-out one.

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

Choose **Protect this analysis** directly on the successful result. Runner
freezes its reviewed resources, measures, grouping, time bucket, ordering,
scope, suppression, and limits into:

```text
synapsor/protected/drafts/<namespace>__<name>/capability.synapsor.sql
synapsor/protected/drafts/<namespace>__<name>/synapsor.contract.json
synapsor/protected/drafts/<namespace>__<name>/contract-tests.json
```

The capability remains disabled until a human activates its exact digest.
Disabling Scoped Explore does not remove the protected named capability.

Workbench renders generated `.synapsor.sql` with local deterministic syntax
highlighting. Keywords, names chosen by the author, strings, numbers, comments,
and punctuation are visually distinct. The copy/plain-text value remains
byte-identical to the generated file; highlighting loads no CDN and escaped
source text never becomes HTML.

CLI fallback, without copying an opaque query handle:

```bash
synapsor-runner try protect \
  --name analytics.reviewed_weekly_summary \
  --json
```

## Fifteen Minutes: First Proposal

After the first read, choose **Add a safe action**. Schema metadata supplies
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
timings in `development/runner-1.6.4-fitflow-results.json`.

## Visual Reference

Repository screenshots cover desktop, mobile, light, dark, loading, blocked,
stale, failure, empty Protect, unavailable-action, optional Ask, refusal, and
proposal-only states:

- [Desktop overview](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-visual/workbench-overview-desktop-light.png)
- [Mobile overview](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-visual/workbench-overview-mobile-light.png)
- [Blocked identity review](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-visual/workbench-blocked-identity.png)
- [Stale/failure recovery](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-visual/workbench-keyboard-stale-failure.png)
- [Ask kept-out-field refusal](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-retail-visual/05c-ask-refusal.png)
- [Ask proposal-only result](https://github.com/Synapsor/Synapsor-Runner/blob/main/development/runner-1.6.4-community-solar-visual/13b-ask-proposal-only.png)

For common blocked states and one-action recovery commands, use
[Troubleshooting First Run](troubleshooting-first-run.md).
