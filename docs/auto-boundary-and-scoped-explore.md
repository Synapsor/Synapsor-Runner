# Auto Boundary, Scoped Explore, And Protect

Runner 1.6.6 provides a deterministic, resumable authoring path for a real
application:

```text
Connect staging
-> draft the boundary
-> review and activate its exact digest
-> repeatedly explore through two bounded MCP tools
   |-> ask another legal combination without another review
   `-> optionally protect one selected analysis
       -> activate the named capability
       -> disable exploration for production
       -> serve only named production tools
```

This path does not give the model SQL, database credentials, tenant identity,
approval, activation, or commit authority. Auto Boundary and Protect use no
LLM. Existing hand-authored contracts and established onboarding commands
continue to work without this feature.

A boundary is the reviewed set of tables, fields, relationships, trusted row
scope, privacy limits, and query budgets an agent may use. One boundary may
contain several related tables. A disabled boundary draft is editable and
grants no access; only a separately activated exact digest has authority.

## Start With Staging

Use a dedicated SELECT-only, non-owner database role. Keep database-level
controls underneath Runner. PostgreSQL deployments should use forced row-level
security (RLS) where possible; MySQL deployments should use restricted views or
tenant-bound credentials.

The shortest first run accepts a hidden URL paste or asks before reading
`DATABASE_URL` from a regular project `.env`:

```bash
npx -y @synapsor/runner start
```

For a tenant-bound PostgreSQL read credential whose reviewed RLS policies use
one stable session setting, the database login can establish scope itself:

```bash
export DATABASE_URL='postgresql://tenant_reader:REPLACE_ME@127.0.0.1:5432/app'
npx -y @synapsor/runner start --from-env DATABASE_URL --schema public
```

Runner reads that setting from the authenticated read-only session, verifies
that every included relation uses the same effective RLS binding, and rechecks
it before each Explore call. The value is never written to generated files or
made model-settable. This is the zero-manual-tenant first-run path used by the
FitFlow fixture.

For a shared database credential, trusted scope must instead come from the
operator-owned application/session environment:

```bash
export DATABASE_URL='postgresql://runner_reader:REPLACE_ME@127.0.0.1:5432/app'
export SYNAPSOR_TENANT_ID='acme'

npx -y @synapsor/runner start --from-env DATABASE_URL --schema public
```

Set a trusted principal such as `SYNAPSOR_PRINCIPAL='pm-1'` only when the
reviewed boundary explicitly selects per-principal row scope. Tenant-wide
analytics does not require a placeholder principal. A person-like foreign key
such as `trainer_id` is only a candidate relationship; it does not prove that
the current database role is authorized for only that person's rows. Auto
Boundary selects principal scope only from an applicable RLS policy, an
existing reviewed Synapsor contract, or an explicit human override.

A fresh interactive invocation with no existing config, selector, or automation
input enters Auto Boundary. It scans the whole selected schema and opens the
secured loopback Workbench. The initial npm download is not part of Runner's
measured onboarding time.

Runner never derives a tenant or principal from a connection-string name,
table contents, sample rows, or model input. If neither a verified credential-
bound PostgreSQL RLS setting nor configured application identity is available
for a scope the boundary actually requires, Scoped Explore remains disabled and
explains the missing external binding.

For the same continuous first run entirely in a terminal:

```bash
npx -y @synapsor/runner start \
  --from-env DATABASE_URL \
  --schema public \
  --cli
```

That route continues through terminal review, activation, provider/client
selection, and Ask. For scripts or CI, draft without prompts or a browser:

```bash
synapsor-runner boundary draft \
  --from-env DATABASE_URL \
  --schema public \
  --project-root . \
  --json
```

In a fresh directory this command also prepares the validated zero-authority
Runner config, local SQLite ledger, environment-name template, and MCP snippets
needed after review. It does not write credential values. If an established
Runner config already exists, `boundary draft` preserves it rather than
replacing it.

Established `--table`, `--answers`, `onboard db`, `--mode`, JSON, and
noninteractive routes keep their previous one-object behavior.

## What Auto Boundary Reads

Runner builds one deterministic evidence graph from:

- database catalogs, keys, constraints, grants, ownership, RLS, triggers, and
  cascades;
- statically parsed Prisma schema files;
- statically parsed Drizzle schema files;
- OpenAPI documents;
- existing Synapsor DSL, canonical JSON, and TypeScript definitions.

It does not import or execute adopter code. Database, ORM, and API comments are
naming evidence only. They never grant field access, trusted scope, write
authority, approval, or activation.

Runner can determine structure such as primary keys, foreign keys, enums,
likely version columns, and possible deduplication keys. It cannot determine
business authority such as:

- which column is the real tenant boundary;
- whether a principal may see every tenant row or only assigned rows;
- whether a field is appropriate for an agent;
- which state transition, refund, credit, or delete is permitted;
- which evidence, bounds, reviewers, or auto-approval policy are required.

Those decisions remain explicit human review.

## Generated Files

Auto Boundary writes disabled review artifacts:

```text
synapsor/generated/
  domain.synapsor.sql
  read-capabilities.synapsor.sql
  synapsor.candidate.contract.json
  exploration-boundary.draft.json
  generation-review.json
  review-overrides.json
  contract-tests.json
  REVIEW.md

.synapsor/
  generation-lock.json
  review-report.json
  review-overrides.json
  boundary-review-progress.json
```

The `.synapsor.sql` files compile through `@synapsor/dsl` into the canonical
`@synapsor/spec` JSON contract. The generation lock records non-secret
fingerprints of the inspected schema, compiler/spec version, exact database
role, grants, ownership, and RLS posture. Generated read drafts and action
candidates start disabled. Auto Boundary never replaces an active contract.

No source rows, credentials, tenant values, or principal values are written to
these files.

Workbench previews generated DSL with a local deterministic highlighter. It
distinguishes DSL keywords from reviewer-defined names, strings, numbers,
comments, and punctuation while preserving byte-identical plain/copy text.
Rendering uses escaped DOM text and no external CDN; if highlighting fails, the
same safe plain source remains visible.

## Review The Boundary

The Workbench requires a human to narrow and confirm:

- trusted tenant and principal bindings supplied outside model arguments;
- included resources and catalog-proven relationship paths;
- selectable fields;
- filterable fields and allowed operators;
- sortable and groupable fields;
- aggregate-safe numeric measures;
- identifiers allowed only for `count_distinct`;
- timestamp fields and permitted day/week/month buckets;
- whether each usable field is model-visible or model-withheld;
- kept-out fields;
- counted entity and relationship cardinality;
- minimum cohort size;
- row, group, measure, dimension, time-range, response, rate, extraction, and
  differencing budgets;
- the current schema fingerprint and exact database-role/RLS posture.

The deployment profile remains part of the digest-bound authority, but the
fresh secured-loopback `start --from-env` route establishes the development
authoring profile once. Workbench shows it as read-only status rather than
asking for another “development/staging/not production” declaration. Established
manual routes may still provide an explicit profile; missing, unknown,
production, shared, and remote routes do not gain Scoped Explore.

Workbench and `boundary review resource` expose three explicit field tiers:

- **Visible to model:** the field may be used by its reviewed operations and
  returned values may enter the selected model provider's context.
- **Withheld from model:** the field remains usable by its reviewed operations,
  but each distinct returned value is replaced with a non-derivable,
  response-local token in model-facing content. Workbench and CLI render the
  actual value only in the local Runner-verified result.
- **Kept out:** the field is unavailable for selection, filtering, sorting,
  grouping, joining, aggregation, and `count_distinct`.

The active catalog tells the model which usable field names have
`model_egress: "withheld"`; it retains reviewed type and operation metadata but
omits the field's enum/value domain and never sends the underlying values.
Tokens are stable only within one tool response so the model can compare groups
in that answer. They are deliberately randomized between responses to avoid
creating a correlation channel. A withheld value containing instructions is
inert because the provider never receives those instructions.

Withheld is an egress property, not a disclosure exemption. The human channel
still reveals the value, so trusted scope, cohort suppression, response limits,
extraction limits, and differencing budgets apply exactly as they do to
model-visible fields. Do not describe withheld values as private.

Raw visibility and aggregate use are separate permissions. A reviewer may
allow `count_distinct(customer_id)` while keeping every `customer_id` value out
of results.

Workbench activation requires every generated decision and the operator
identity. Its single **Activate and ask** action computes, displays as an
advanced detail, revalidates, and activates the exact reviewed fingerprint
before opening Ask. Once the last Workbench sign-off is saved, the UI advances
directly to that action. The CLI offers the same activation immediately after
final sign-off with a default-yes prompt; the operator does not copy a digest.
Noninteractive automation still supplies the complete
`ACTIVATE sha256:...` confirmation with a verified signed-key or OIDC decision.

The immutable digest covers the reviewed resources, field permissions,
relationships, scope, role posture, generation lock, compiler/spec version,
profile, and every query/privacy budget. Model arguments cannot widen it.

Workbench and CLI use the same review domain. A terminal operator can inspect
or narrow one blocked resource without reading rows or activating authority:

```bash
synapsor-runner boundary review resource public.orders --json
synapsor-runner boundary review resource public.orders \
  --include \
  --tenant-key tenant_id \
  --no-principal \
  --visible-fields id,status,internal_segment \
  --withhold-from-model internal_segment \
  --actor reviewer@example.com \
  --reason "Reviewed tenant-scoped order access"
```

Running `synapsor-runner boundary review` in a terminal opens the same
risk-first table order as Workbench. The first screen lists the named boundaries
saved in this project. Each boundary may contain many tables and reviewed
relationship paths; a `schema.table` entry is a table inside a boundary, not a
separate boundary. A project may keep several disabled drafts and up to eight
independently reviewed active boundaries for Scoped Explore. Opening or editing
a draft does not change active authority. Activating a new name adds that exact
boundary; activating an existing name updates only its digest. Workbench and
CLI can create, open, rename, and delete non-active drafts. The name is bound
into review and activation digests. With no saved review, both surfaces use the same
deterministic starter candidate of at most three related/high-value tables.
Quick Start remains a separately labeled one-table, zero-relationship fast
lane. In fresh local onboarding, one explicit operator gesture may review and
activate that exact conservative boundary after schema and read-only-role
revalidation. The model still cannot review or activate it. Declining the fast
lane opens the detailed editor, and any widening requires the full recorded
review. Quick Start never silently adds the rest of the schema.

Print a concise overview without entering the picker:

```bash
synapsor-runner boundary review --map
```

This first-run view explains that one boundary may contain multiple tables,
separates currently active authority from the disabled next candidate, previews
other reviewable or blocked tables, and highlights useful proven many-to-one
paths. It intentionally does not dump a large schema. Request the exhaustive
catalog only when needed:

```bash
synapsor-runner boundary review --map --all
```

The first interactive view contains only the saved boundaries that exist. `A`
creates a named disabled copy of the selected draft, Enter opens a boundary,
and `X` deletes a non-active draft after confirmation. Only then does Runner
list its member tables. Enter on an included table edits its columns; Enter on
an available table first adds it to the disabled boundary and then opens its
columns for review. `S` signs off the complete table
review, `P` explains what that sign-off covers, `R` stages its removal, and
`Esc` returns to the boundary list. `A` reveals every inspected table so another
can be added, `B` is the visible back action or returns to the boundary's table
list, `M` opens the paginated complete map, `N` renames the pack, and `C` guides
every remaining sign-off. One table sign-off records the exact individual
decisions for column access, allowed operations, trusted scope, privacy limits,
and relationship paths. Those decisions remain separately digest-bound
underneath; they are not separate boundaries or unsaved column changes.
Workbench uses the same progressive disclosure: its first view lists saved
boundaries and identifies the selected draft and active authority. **New
boundary**, **Open**, **Edit**, and **Delete** use the same lifecycle as the
CLI. These actions update only disabled drafts.

Active boundaries add reviewed choices to one authoring catalog; they do not
create more tools or merge authority. `app.describe_data` lists each boundary
and tags its resources. Every `app.explore_data` request routes to exactly one
boundary. A resource that appears in only one boundary routes automatically; an
overlapping resource requires the exact boundary name. Cross-boundary joins,
unions, and relationship traversal are unavailable. Query, extraction, rate,
and differencing history is shared across the stable reviewed source and
trusted scope. Differencing variants share a root-resource pool over a rolling
24-hour window, so changing boundaries, crossing UTC midnight, restarting
Runner, or changing the plan shape cannot reset privacy budgets.

Production still uses protected named capabilities or separate
project/configuration packs for persona-specific tool surfaces; broad Scoped
Explore remains local development/staging authority only.
Choose a table with the arrow keys, then choose each column's access explicitly:

- **V - Model + Runner:** reviewed values may appear in Runner's local verified
  output and may be sent to the configured model.
- **W - Raw values: Runner only:** Runner may use and display the real field locally,
  while provider requests receive response-local opaque tokens for raw values.
  Explicitly reviewed derived aggregates such as `count_distinct` remain
  model-visible because they do not contain the underlying field values. The field may
  still support separately reviewed filters, grouping, aggregates, or proven
  relationship paths; output visibility and operation authority are reviewed
  independently.
- **K - Kept out:** the field cannot be selected, filtered, sorted, grouped,
  joined, or aggregated.

Trusted tenant and principal columns use the same three output tiers, but their
scope semantics never change. Runner still injects the verified value outside
model arguments. Keeping the column out hides it from results; Runner output
only shows it in the local verified result and sends a response-local token to
the model; Model + Runner may send the reviewed value to the configured model.
Either disclosure choice requires a recorded human reason and changes the exact
boundary fingerprint. It never creates a tenant or principal tool argument.

The table picker shows `P` directly below its `TABLES` heading. Pressing it
explains what the highlighted table's single sign-off covers: field access,
operations, trusted row scope, privacy limits, and reviewed relationships.
These are audit details, not separate prompts; one `S` sign-off records them
together while retaining their exact individual digests. `C` **Review all
checks** walks through the boundary-wide sign-off and each remaining table
sign-off, then offers activation. Because the exact
review is already displayed and sign-off cannot activate authority, its prompt
uses `[Y/n]`: Enter records the sign-off and `n` declines it. Guided final
review uses the same default for each displayed boundary/table group.

Press the Spacebar key to change the selected column's access. Each press moves
through **Model + Runner -> Raw values: Runner only -> Kept out**, then repeats.
Press `V`, `W`, or `K` to choose one of those access levels directly. The
footer uses conventional terminal controls: Up/Down navigates, `Enter`
continues to a plain-language table sign-off, `B` or `Esc` returns without
saving, `M` shows the table's access map, and `Q` quits without saving. The map
includes current field tiers, allowed operations, trusted-scope column names,
candidate many-to-one paths, fan-out limits, and the cohort guard. The same safe
map is printable without interaction:

```bash
synapsor-runner boundary review resource public.orders --map
```

Neither map contains trusted tenant/principal values, source rows, SQL,
credentials, or activation authority. With unchanged field access, the picker
asks for a reviewer label and one table sign-off. If access changes, it also
requires a reason, previews the exact change, and shows `Y/n`: pressing Enter
saves that disabled decision immediately, while `n` discards it. No generated
command has to be rerun. This convenience cannot activate authority. Trusted
tenant and principal columns remain fixed outside model arguments and cannot be
widened in the picker. Stable decision IDs and input digests remain available
through `boundary review --json`; they are not routine first-run prompts.

Flag-based review remains the canonical noninteractive interface. Its first
invocation is a preview and says plainly that nothing has been saved. It ends
with the exact command, including `--apply`, that records the disabled
decision. Unknown column names fail before a preview and the error lists the
table's inspected columns. `--json` retains exact digests and the full semantic
diff for automation.

Auto Boundary generates a minimum cohort of 5 for every analytical resource.
Without a separate owner decision, review may keep that value or increase it;
it cannot lower it. A human owner may explicitly lower it to 1 through 4 by
recording their identity and a concrete reason in Workbench or CLI:

```bash
synapsor-runner boundary review resource public.check_ins \
  --minimum-cohort 1 \
  --actor owner@example.com \
  --reason "This owner-controlled staging analysis may return groups of one."
```

The command first prints a disabled semantic-diff preview. Applying it still
uses the existing signed operator review flow and does not activate authority.
Set `--minimum-cohort 5` to restore the default and remove the override.

A threshold of 1 disables small-group suppression: groups of one may identify
individuals. Workbench and CLI state that consequence directly. The recorded
decision changes the reviewed boundary digest; reviewer identity and reason
remain in review evidence. No MCP input, Explore plan, provider conversation,
or model-facing action can lower or confirm the threshold.

Ranked top/bottom and two-period mover questions have a separate reviewed
execution ceiling. New boundaries may inspect at most 500 underlying groups and
still return no more than the reviewed top-N (25 by default). Runner validates
that ceiling and applies small-group suppression before ordering. Reviewers can
narrow it in Workbench boundary settings, press `L` in the terminal boundary
editor, or use:

```bash
synapsor-runner boundary review resource public.orders \
  --max-ranked-groups 200 \
  --actor reviewer@example.com \
  --reason "Reviewed bounded ranking across this known customer population."
```

The choice changes the boundary digest and remains disabled until the complete
boundary is reviewed and activated. It is never an MCP field or model
argument. Existing boundaries that omit the additive setting retain their old
`max_groups` ceiling and canonical representation.

For a large schema, `boundary review --output boundary-review.json` exports an
exact review bundle and `--apply-decisions` can apply a versioned multi-resource
decision file atomically. The file is review input, not authority. Applying it
still requires an exact gesture or verified signed-key/OIDC operator proof;
activation remains a separate recorded human decision. Interactive review
offers that decision as the immediate next default-yes prompt rather than
requiring another command; headless activation remains explicitly digest-bound.
After interactive activation, Runner stays in the same terminal and offers:

- OpenAI with the tested `gpt-5-mini` default;
- Anthropic with the Workbench Claude Sonnet default;
- a loopback OpenAI-compatible endpoint and model;
- an existing MCP client; or
- **Later**.

The first three choices enter the canonical `try ask` shell directly. The MCP
choice prints the managed and generic stdio setup paths; **Later** leaves the
boundary active. Provider credentials still come only from environment or a
hidden in-memory prompt. Headless and JSON activation never launch Ask.

Disable active local Explore authority without deleting review work:

```bash
synapsor-runner boundary disable
```

Workbench exposes the same action beside the boundary editor. Disabling removes
only the current broad local authoring authority. It preserves the disabled
saved disabled boundaries, review decisions, protected named capabilities, evidence,
ledger, and source database. Noninteractive automation must bind the exact
active digest:

```bash
synapsor-runner boundary disable \
  --confirm "DISABLE sha256:..."
```

## Try Without An External MCP Host

Workbench can run the first safe read, bounded aggregate, and Protect flow
directly. CLI review offers Ask as soon as activation succeeds; the same
authority also remains available through explicit CLI Try:

```bash
synapsor-runner try call --list --format json
synapsor-runner try explore --suggested --json
synapsor-runner try ask --provider openai
```

OpenAI uses the tested `gpt-5-mini` default and Anthropic uses the tested
Claude Sonnet default when `--model` is omitted. A loopback OpenAI-compatible
endpoint still requires `--model` because its installed models are local
operator state.

Run a two-period comparison without hand-writing plan JSON:

```bash
synapsor-runner try explore \
  --resource public.orders \
  --sum total_cents \
  --group-by channel \
  --time-bucket created_at:week \
  --compare created_at \
  --period 2026-06-01T00:00:00Z..2026-06-08T00:00:00Z \
  --vs-period 2026-06-08T00:00:00Z..2026-06-15T00:00:00Z \
  --change percentage
```

`app.describe_data` reports cohort-safe minimum and maximum dates for reviewed
time fields. It returns dates only when at least the reviewed minimum cohort has
a value; otherwise coverage is marked empty, withheld, or unavailable. The
model uses that coverage to anchor phrases such as `latest week` against a
historical staging snapshot instead of silently assuming today's date. Startup
preflight defers this aggregate, so activation still reads schema metadata only.

Cursor, Claude, Codex, and generic stdio are optional clients, not onboarding
dependencies. The packed FitFlow gate proves Workbench, CLI Try, and an
official-SDK generic stdio client produce the same bounded result and denial
behavior.

With no positional question, `try ask` opens the natural-language shell. Keep
asking as long as the authoring boundary is active; no DSL, contract, or named
tool is created. Each successful analysis has a short-lived encrypted local
reference, hidden during normal conversation. Startup describes only the exact
active tables and reviewed operations, and any starter question is validated
against that active catalog rather than a broader disabled draft. Inside the
shell, use bare `/protect`; Runner selects the sole current analysis or opens a readable picker.
After one-shot Ask, protect an unambiguous latest result without copying an ID:

```bash
synapsor-runner try protect \
  --last \
  --name analytics.protected_analysis \
  --json
```

Use `--from A2` only when the latest answer ran several plans or an older
eligible analysis is intentionally selected.

Safely refused intermediate plans are hidden from normal successful output and
remain available through `/attempts` or `--verbose`. If a provider runs a valid
plan but emits no explanation, Runner gives it one bounded no-tools pass to
summarize the already returned values. Runner never sacrifices the verified
structured result when provider prose is absent.

If model prose repeats a long list of rows already rendered from the structured
result, CLI and Workbench collapse only the provable duplicates. The original
provider answer remains available in machine-readable output and Workbench's
advanced disclosure; Runner never rewrites the authoritative result.

For an unavailable relationship, local CLI or Workbench output may name one
source-proven disabled candidate path and deep-link the operator to access
review. That guidance is computed outside the provider and MCP surfaces; it
cannot activate or widen authority. A kept-out field does not receive such a
hint. When no data query ran, the normal human view uses a deterministic Runner
boundary explanation followed by this exact Runner-computed path rather than
displaying speculative schema or access advice. The original provider answer
remains available in JSON and Workbench's advanced disclosure. A derived ratio
or formula requires a reviewed view or named metric.

## Optional Workbench Ask Client

After the no-model composer succeeds, Workbench can optionally send a
plain-language question to a developer-selected model provider. This adds a
client, not authority:

```text
provider request
  -> exact active Workbench tool registry
  -> official MCP SDK
  -> existing Scoped Explore/runtime validator
  -> reviewed bounded result or refusal
```

While Explore is active, the provider sees exactly `app.describe_data` and
`app.explore_data`, even if the project also contains named read or proposal
tools. After Explore is disabled, a new Ask session sees only activated named
runtime capabilities. The two catalogs are never combined or silently
switched. Ask never receives Protect, activation, approval, apply, worker,
notification, recovery, credential, or filesystem tools.

Provider/model/origin and the exact authority digest require explicit
direct-egress acknowledgement. Keys come from the local Runner process
environment or a session-only masked paste; configuration and history remain
in memory and are cleared on request or shutdown. Ask is restricted to secured
loopback Workbench in development/staging and is absent from production and
shared/remote surfaces.

The no-model composer, CLI Try, and external MCP routes remain fully supported
when no provider is configured or a provider is unavailable. See [Workbench
Ask With Your Model](workbench-ask.md).

## Add The Authoring Tools To A Project MCP Client

After activation, let Runner manage only its own project entry:

```bash
synapsor-runner mcp install claude-code \
  --project \
  --authoring \
  --project-root . \
  --yes

synapsor-runner mcp status claude-code --project
```

Use `cursor` or `vscode` instead of `claude-code` for those clients. Runner
manages `.cursor/mcp.json`, `.mcp.json`, or `.vscode/mcp.json` and preserves
unrelated entries. The client config contains command paths and package
identity, not database URLs, credential values, tenant values, or principal
values. Authoring mode uses local stdio and advertises exactly:

```text
app.describe_data
app.explore_data
```

`app.describe_data` is bounded and paginated over only the activated resource
pack. `app.explore_data` accepts a structured plan. Neither tool exposes SQL,
approval, apply, activation, commit, or revert.

## Scoped Row Explore

A row plan can select, filter, sort, and limit only fields and operators in the
activated boundary. Runner injects tenant scope and, only where explicitly
reviewed, principal scope outside model arguments, then compiles the validated
plan into parameterized SQL.

Scoped Explore does not accept:

- a SQL string or fragment;
- arbitrary identifiers, functions, expressions, aliases, or subqueries;
- a model-supplied tenant or principal;
- unreviewed fields or relationships;
- model-widened row, byte, time, rate, or extraction limits.

## Scoped Aggregate Explore

The aggregate surface is a small reviewed analytical cube, not a generic
analytics database tool. It supports:

- `count`;
- `count_distinct` on explicitly reviewed identifiers;
- `sum` and `avg` on explicitly reviewed numeric measures;
- reviewed categorical dimensions;
- day, week, and month buckets on reviewed timestamps;
- typed bounded filters;
- ordering by a returned aggregate;
- bounded top-N and bottom-N results;
- one range or an exact comparison of at most two reviewed time ranges;
- ordering an exact two-period comparison by signed absolute or percentage
  change;
- one resource by default;
- up to three activated relationship paths in one plan;
- one or two inspected, reviewed many-to-one foreign-key links per path, each
  with maximum fan-out one.

It does not support arbitrary `DISTINCT`, `HAVING`, formulas, window functions,
unions, nested queries, many-to-many joins, system catalogs, user-defined
functions, or a general join planner. Scope is enforced independently on every
participating relation. Runner refuses a plan when cardinality, fan-out,
counted entity, or scope cannot be proven.

Auto Boundary does not activate every discovered path. When a useful question
needs one inactive but catalog-proven path, Runner refuses the plan and stages
that exact path for operator review. Workbench shows the foreign-key proof and,
for optional links, requires an explicit choice between excluding the unmatched
counted row and keeping it with an empty group value. Activating the new exact
digest is an operator-plane action; the model cannot perform it. See
[Reviewed Relationship Paths](reviewed-relationships.md).

Before returning groups, Runner enforces the reviewed minimum cohort size.
Small groups are suppressed. Every cohort-protected aggregate reserves query,
extraction, and differencing allowance atomically before source execution.
Variants share one root-resource pool over a rolling 24-hour window, including
unfiltered totals and trends; only an exact normalized-plan replay reuses a
variant. Shape changes, boundary revisions, restart, UTC midnight, and
concurrent requests do not open a fresh pool. Invalid plans and source failures
release extraction and differencing allowance. Runner also prevents release of
both a suppression-bearing grouping and its complementary scalar total, in
either order, so visible groups cannot be subtracted from a released total to
recover the hidden aggregate. Pagination cannot bypass the maximum group count.
New generated boundaries review at most 16 distinct cohort-protected variants
per root resource in that window. Existing boundaries keep their exact prior
value, and an operator may narrow the generated allowance during review.

If the owner explicitly reviewed a lower threshold, `app.describe_data`,
Workbench, and the safe analytics catalog show both the effective value and an
owner-override marker. A value of 1 produces no cohort-suppressed groups, while
suppression-aware totals remain enabled. Because there is no suppressed cohort
to reconstruct at `1`, the differencing check does not apply; the other query,
rate, extraction, response, and complexity limits remain enforced. The marker
is output metadata only; it does not create a model-settable threshold.

Results describe changes, comparisons, correlations, and likely contributors.
They do not establish causation.

New generated analytical boundaries bind reporting buckets to reviewed UTC
authority. A two-period comparison runs in one repeatable-read, read-only
snapshot and returns period values, absolute change, and percentage change only
when the earlier denominator is nonzero. Results distinguish an empty result,
a fully suppressed result, and an incomplete comparison rather than silently
turning any of them into zero.

## Structured Results And Safe Catalog

Both authoring tools advertise JSON `outputSchema` through MCP `tools/list`.
The schema covers success, empty, suppression, incomplete comparison, and safe
refusal outcomes. Successful analytical metadata includes the counted entity,
result grain, semantic measure/dimension aliases, reviewed relationship paths,
UTC authority, snapshot state, suppression, response usage, remaining budgets,
query-audit handle, and `source_database_changed: false`.

Production analytical capabilities are available through a deterministic,
versioned catalog:

```bash
synapsor-runner tools catalog \
  --config ./synapsor.runner.json \
  --json
```

MCP clients can read `synapsor://analytics/catalog/v1` and pin one capability
plus its exact contract digest. The catalog contains only derivable active
analytical authority. It omits SQL, credentials, trusted tenant/principal
values and columns, kept-out fields, and generation-lock internals.

When a plan returns a raw model-withheld field or group label,
`app.explore_data` executes the database plan once. Its model-facing MCP
`content` and `structuredContent` use response-local opaque tokens. Reviewed
derived aggregate values, such as a distinct count, remain visible without
disclosing the counted values. The full local result is attached only to the
MCP non-model `_meta` presentation channel used by Workbench and the analytics
CLI. A generic host that does not implement that local presentation channel
still receives the safe tokenized result; it does not receive the withheld
value. Protected named reads use the same split and advertise
`no_model_egress: true` for affected output fields.

## Runtime Enforcement

Scoped Explore is disabled by default and authoring-only. It starts only when
all of these are true:

- the trusted launch/configuration context establishes `development` or
  `staging`;
- the transport is local stdio or secured loopback Workbench traffic;
- the exact exploration-boundary digest is active;
- the generation lock and compiler/spec versions are current;
- the role/grant/ownership/RLS fingerprint still matches;
- the credential is demonstrably SELECT-only and non-owner;
- every query also runs in an enforced read-only transaction.

Missing, malformed, unknown, and production profiles are treated as
production. A superuser, relation owner, write-capable role, `BYPASSRLS` role,
or unverifiable role may inspect metadata with a warning but cannot read source
rows through Scoped Explore.

Shared HTTP, Streamable HTTP, remote, and non-loopback runtimes never register
or advertise broad Explore tools.

## Audit And Temporary Protect State

Every successful call records a normalized query audit in
`.synapsor/local.db`. Audit may retain:

- active boundary digest;
- reviewed resource/relationship aliases;
- operators and time buckets;
- keyed hashes of filter literals;
- timing, suppression decisions, and result-size metadata.

It does not retain returned rows/groups, credentials, raw sensitive literals,
or trusted tenant/principal values.

A successful query also creates encrypted, expiring local Protect state. The
Workbench discovers recent queries itself; developers do not copy opaque
handles.

## Protect This Query

Choose one useful query in Workbench or use `/protect` in the interactive CLI.
Runner selects a sole eligible current analysis automatically and opens a
readable picker when the answer used several plans. Advanced callers may still
select an exact unexpired analysis reference. Protect freezes:

- resources and reviewed relationship paths;
- counted entity, measures, dimensions, and bucket structure;
- filters, ordering, top-N, and comparison shape;
- tenant/principal as trusted bindings;
- cohort suppression and query/privacy budgets.

Reviewed literals remain fixed by default. A human may convert selected
literals into typed bounded arguments.

Protect writes:

```text
synapsor/protected/drafts/analytics__churn_contributors_by_week/
  capability.synapsor.sql
  synapsor.contract.json
  contract-tests.json
  REVIEW.md
  draft.json
```

For an analysis executed under a lowered owner-reviewed cohort, Protect requires
an explicit human reconfirmation naming the resource, threshold, and disclosure
consequence. Activating the disabled generated capability is a second human
action bound internally to its contract digest. Normal CLI and Workbench flows
do not ask the operator to type or copy the digest. Removing or changing the
recorded owner decision, draft metadata, boundary, or contract causes
activation to fail closed.

The public DSL compiles into the canonical Spec. The generated capability
starts disabled and includes positive, scope, suppression, differencing,
join-safety, deny, drift, and boundary tests. It becomes active only after a
human reviews the exact preview outside MCP. CLI uses one default-yes activation
gesture and stays in the current Ask session; Workbench uses one labelled
activation button. Both call the same canonical implementation, recompute the
digest immediately before activation, and reject stale previews. Workbench is
optional for a developer who chose the CLI path.

`/details` and the equivalent Workbench disclosure connect the original
question, typed model tool call, normalized validated plan, selected boundary,
runtime checks, suppression, result-size metadata, evidence, and Protect
eligibility. `/details A2 --sql` may additionally show an operator-only
parameterized PostgreSQL or MySQL statement with all values redacted. SQL is
never model-facing, MCP-facing, or persisted as ordinary evidence; the
normalized plan remains canonical.

Protect does not run automatically after Explore and does not interrupt
unrelated authoring questions. When the operator later activates the protected
digest and disables temporary Explore for production, the named capability
remains available. Update the selected project client from authoring mode to
the production config:

```bash
synapsor-runner mcp install claude-code \
  --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

Again, substitute `cursor` or `vscode` for the selected client.
Production then advertises only reviewed named capabilities. It does not
advertise `app.explore_data`.

## Schema Drift

Check generated authority against the current database:

```bash
synapsor-runner boundary status --json
synapsor-runner boundary diff --json
```

Additive schema fields and objects receive no authority. A changed schema,
database role, grant, ownership, RLS posture, compiler, or canonical Spec
invalidates the generation lock. Lock-bound generated authority fails closed
until the operator regenerates, reviews the semantic diff, and activates the
new exact digest.

This drift lifecycle applies only to generated authority explicitly bound to a
generation lock. Existing manually authored projects without a lock retain
their previous startup, `doctor`, contract, and tool behavior.

## Verify The Reference Journey

The polished packed-artifact journeys are:

- `examples/retail-clean-room`: a 45-table subscription/commerce application
  with ten legal combinations, provider/CLI/MCP parity, optional Protect, and
  the existing proposal/guarded-apply loop;
- `examples/healthcare-phi-clean-room`: a multi-tenant, principal-scoped
  healthcare application proving PHI hiding, suppression, stored-injection
  inertness, browser recovery, and production narrowing;
- `examples/fitflow-guided-onboarding`: the compact first-value timing gate.

`examples/auto-boundary-churn` remains a compatibility and focused
aggregate-security fixture.

From a source checkout:

```bash
corepack pnpm test:auto-boundary-explore
corepack pnpm test:auto-boundary-explore:packed
corepack pnpm test:guided-onboarding:packed
corepack pnpm test:clean-room:retail
corepack pnpm test:clean-room:healthcare-phi
corepack pnpm test:host-neutral-example:packed
```

The packed gates prove PostgreSQL + Next.js + Prisma + Workbench, ten repeated
analytical combinations before optional Protect, host-neutral CLI/official-MCP
parity, structured outputs/catalog pins, denial/suppression/budget checks,
production Explore absence, protected-capability survival, guarded proposals
and apply, durable redacted audit, and unchanged source data on every
analytical path. Live PostgreSQL/MySQL relationship gates separately prove
database parity without claiming MySQL RLS.

For the timed first-read, Explore, Protect, proposal, and writeback walkthrough,
use [Database To First Safe Tool](guided-onboarding.md).
