# Auto Boundary, Scoped Explore, And Protect

Runner 1.7.0 provides a deterministic, resumable authoring path for a real
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
existing reviewed Synapsor contract, a config-declared exact column, or an
explicit human override. When `trusted_context.principal_binding` exactly names
a non-null inspected column, `boundary draft` seeds that column as the disabled
boundary's reviewed principal policy. It does not activate the decision. In
`/access`, select the table, press `Enter`, then press `O` to choose no
per-user limit, a direct column, or a proven derived path; the editor returns to
the same columns with unsaved column choices intact. Workbench exposes the same
choice under **Record and customer limits**. The principal value still comes
only from the configured environment or verified HTTP claim and is never a
model argument.

### Whole-Organization And Shared-Reference Tables

For a database that belongs to exactly one organization and has no tenant
columns or tenant RLS, review that posture once for the complete boundary:

```bash
npx -y @synapsor/runner start \
  --from-env DATABASE_URL \
  --single-tenant \
  --organization-id internal-finance \
  --cli
```

This is boundary-wide single-organization mode. Reviewed tables need no fake
`tenant_id` column and Runner emits no tenant predicate. Principal scope,
field controls, cohort suppression, budgets, schema locking, and read-only
credential checks still apply. Runner refuses this mode when inspection finds
tenant columns, tenant RLS, or other multi-tenant evidence.

Mixed databases use a narrower authority. A tenant-scoped boundary may include
a genuinely global reference table, such as a product catalog or currency list,
only after a reviewer marks that exact table **Shared reference** and confirms
that it contains the same rows for every tenant. Runner never infers this
posture. A table with tenant-column evidence, a proven path to tenant-scoped
rows, or tenant/RLS evidence remains ineligible.

The terminal editor offers **Shared reference** while resolving an eligible
table. The equivalent noninteractive review is explicit and audited:

```bash
synapsor-runner boundary review resource public.product_catalog \
  --include \
  --shared-reference \
  --acknowledge-table-has-no-per-tenant-rows \
  --actor owner@example.com \
  --reason "Every tenant receives the same reviewed catalog rows"
```

The change remains a disabled draft until the boundary is reviewed and
activated. It applies no tenant predicate only to that table. Kept-out and
model-withheld fields, enum allowlists, principal scope, small-group privacy,
query/extraction/differencing budgets, and relationship proofs remain intact.
The same compiled authority is used by local Explore and explicitly enabled,
secured production HTTP Explore. Production still requires verified JWT
tenant/principal context for authentication and per-principal privacy
accounting; the shared table simply does not use the tenant value as a SQL row
predicate.

A fresh interactive invocation with no existing config, selector, or automation
input enters Auto Boundary. It scans the whole selected schema and opens the
secured loopback Workbench. The initial npm download is not part of Runner's
measured onboarding time.

An existing guided project resumes its pinned review and does not inspect the
database again. Add `--rescan` to the same Start command to deliberately
re-inspect either a single-organization or multi-tenant source. Runner
reconciles every saved boundary: manual tables and reviewed settings whose
exact inputs are unchanged stay intact, while only decisions affected by real
schema, role-posture, or config-derived trusted-context changes are invalidated.
The generation lock fingerprints the normalized provider, environment/claim
names, and configured tenant/principal column bindings without storing any
credential or claim value. Adding `principal_binding` therefore creates a
disabled revision that offers that inspected non-null column for review while
preserving unrelated derived paths, shared-reference acknowledgments, field
visibility, enums, metadata, bands, and measures. Removing or changing a binding
retracts only its config-managed scope decisions. New columns stay kept out and
new relationships stay unused until reviewed. The itemized result is a disabled
boundary revision; it does not replace active authority until a human reviews
and activates it. On this Start path, `--force` performs the same guarded
reconciliation; prefer `--rescan` because it states the intent clearly.

For newly generated production locks, startup also compares the loaded HTTP
claim names and configured tenant/principal column bindings with that reviewed
authority. A mismatch stops Production Explore and points back to the same
reconciling rescan; restarting cannot silently accept a changed identity contract.

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
  auto-boundary-policy-baseline.json
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

`boundary-review-progress.json` owns the selected boundary's policy under an
immutable boundary ID. The generated `review-overrides.json` files are
compatibility mirrors for that selected boundary; they are not project-wide
authority and are never merged into another boundary. Database facts such as
keys, relationships, enum declarations, and role posture remain shared through
the generation lock and policy-neutral baseline. Human choices such as field
visibility, operations, scope-path selection, relationships, and privacy limits
remain independent for each boundary.

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
- aggregate-safe numeric, dispersion, and missing-data measures;
- identifiers allowed only for `count_distinct`;
- timestamp fields and permitted hour/day/week/month/quarter/year/day-of-week
  buckets;
- named derived measures, post-suppression calculations, fixed numeric bands,
  reviewer-approved automatic numeric-band methods, and safe child-count paths;
- optional reviewed labels and descriptions for resources and fields;
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
shared, and remote routes do not gain Scoped Explore. Production remains off by
default. An operator may enable it only through the separately attested
production-Explore profile over secured Streamable HTTP, with verified JWT
claims, a trusted principal, atomic per-principal privacy budgets, and rate
limits.

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

### Reviewed Names And Descriptions

Legacy or abbreviated database names can be given bounded business context
without changing the database or granting new authority. In `/access`, press
`I` on a selected table or column. Workbench exposes the same **Reviewed label**
and **Reviewed description** controls. The noninteractive equivalent is:

```bash
synapsor-runner boundary review resource public.t_0031 \
  --label "Customer subscriptions" \
  --description "One reviewed subscription record per customer account" \
  --field-label "c7=Subscription state" \
  --field-description "c7=Reviewed billing lifecycle state" \
  --actor reviewer@example.com \
  --reason "Clarify legacy identifiers without changing access"
```

Labels are at most 64 characters and descriptions at most 280 characters.
Control characters, multiline text, and secret-like material are rejected.
Each change records actor, reason, and decision time, changes the disabled
boundary digest, and requires the normal exact activation. Use `-` as one flag
value to clear that value.

`app.describe_data`, `/catalog`, and Workbench show the reviewed words beside
the exact database ID. Plans still reference only exact field IDs and the
canonical reviewed resource ID. A custom label is never accepted as a resource,
field, relationship, or formula. Runner retains its bounded recovery for one
unambiguous bare table name, but does not add custom labels to that resolver.

The review screens and sign-off also report vocabulary coverage: model-facing
field count, label count, description count, and any clearly placeholder-like
IDs such as `t_0031`, `dim_a`, `c7`, or `val_1`. A new activation fails closed
while one of those opaque table/field IDs has neither a reviewed label nor a
reviewed description. Press `I` on the named table or column, or use the flags
above, then review the new digest. This check is deliberately narrow and does
not require ordinary descriptive identifiers such as `orders`, `carrier_mode`,
or `warehouse_zone` to be relabelled. An older active boundary remains readable
for compatibility; `doctor` warns until its next reviewed revision supplies the
missing vocabulary.

A separate non-blocking check covers bounded categorical vocabularies made only
of short letter-and-number codes, such as `P1 | P2 | P3` or
`W1 | W2 | W3 | W4`. The database proves that those values are allowed, but it
does not prove what they mean. Runner reports `review_advised` in the coverage
summary, names the affected fields in the CLI, Workbench, and `doctor`, and
keeps activation available. Add a reviewed label or description when a model
should map business language to that field. Until then, clients are instructed
to use an exact field or code only and never infer meaning from the abbreviation
or code sequence.

`app.describe_data` makes this state machine-readable. Every model-facing field
has `plan_reference: "exact_id_only"` and one `semantic_status`:

- `reviewed_vocabulary`: a human supplied a label or description;
- `descriptive_identifier`: the physical ID is not clearly a placeholder;
- `coded_values`: the physical ID may read like a name, but its schema-proven
  allowed values are structural codes whose business meaning is not reviewed;
- `opaque_identifier`: the client must not guess its business meaning.

The compact resource index includes those mappings plus the resource-level
operation allowlists. A focused `app.describe_data` call for one exact resource
adds complete per-field operations, reviewed enum values, and relationship
field grammar. When more active resources exist, `next_cursor` and the
model-facing `next_action` explicitly require the client to continue paging
before it concludes that requested data is unavailable. This avoids repeating a
large grammar on the first page while still making every reviewed table and
boundary discoverable. Metadata-only catalog calls return no source rows and
consume no Explore query budget.

This metadata is descriptive only. It cannot make a field selectable,
filterable, groupable, sortable, aggregatable, or relationship-reachable. A
label on a kept-out field remains available to the human reviewer but is absent
from model-facing catalog output. Relabeling an opaque field as `SSN` does not
automatically classify or expose it; the reviewer must still explicitly keep
that field out. Metadata survives unrelated rescans and is removed when its
exact table or field disappears.

For model-visible, non-sensitive categorical fields, Runner may derive a small
complete value vocabulary from schema metadata: native enum types or simple
`CHECK field IN (...)` / `field = ANY(...)` constraints. It never samples
`DISTINCT` row values. Oversized vocabularies are omitted whole rather than
truncated. The CLI column editor and Workbench **Allowed values** control let an
operator remove values or disable the vocabulary, but never add values absent
from the schema declaration. The decision records actor and reason and takes
effect only after the updated boundary is reviewed and activated.

A present reviewed vocabulary is also an execution allowlist for filters and
groups. A removed or unknown value is refused before source execution. Disabling
the vocabulary disables filter and group operations for that field; it does not
silently reopen free-text filtering. Model-withheld and kept-out fields never
send their value vocabulary to a model.

Workbench activation requires every generated decision and the operator
identity. Its single **Activate and ask** action computes, displays as an
advanced detail, revalidates, and activates the exact reviewed fingerprint
before opening Ask. Once the last Workbench sign-off is saved, the UI advances
directly to that action. The CLI offers the same activation immediately after
final sign-off with a default-yes prompt; the operator does not copy a digest.
Noninteractive automation still supplies the complete
`ACTIVATE sha256:...` confirmation with a verified signed-key or OIDC decision.

The immutable digest covers the reviewed resources, labels/descriptions, field
permissions, relationships, scope, role posture, generation lock, compiler/spec
version, profile, and every query/privacy budget. Model arguments cannot widen
it.

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
  --label "Orders" \
  --field-label "status=Order state" \
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

The exhaustive map remains human-first: it shows compact table counts and
readable relationship chains, and omits canonical constraint/path IDs from the
scan view. Add `--details` when a scripted review needs those exact IDs:

```bash
synapsor-runner boundary review --map --all --details
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
list, `I` edits a selected table or field's reviewed display metadata, `M` opens
the paginated complete map, `N` renames the pack, and `C` guides every remaining
sign-off. One table sign-off records the exact individual
decisions for column access, allowed operations, trusted scope, privacy limits,
and relationship paths. Those decisions remain separately digest-bound
underneath; they are not separate boundaries or unsaved column changes.
Workbench uses the same progressive disclosure: its first view lists saved
boundaries and identifies the selected draft and active authority. **New
boundary**, **Open**, **Edit**, and **Delete** use the same lifecycle as the
CLI. These actions update only disabled drafts.

Active boundaries add reviewed choices to one authoring catalog; they do not
create more tools or merge authority. `app.describe_data` lists each boundary
and tags its resources. The model-facing catalog exposes one canonical ID for
each resource, field, and relationship, plus any optional reviewed label and
description as display metadata. Those words are not aliases and are never
accepted as plan input. The catalog still includes the reviewed
operations, enum allowlists, time coverage, relationship paths and cardinality
proof, scope posture, privacy limits, and suggested plan shapes the model needs
to form a legal request. Every `app.explore_data` request routes to exactly one
boundary. A resource that appears in only one boundary routes automatically; an
overlapping resource requires the exact boundary name. Runner may recover an
unambiguous bare or humanized resource name, but that is error recovery rather
than an alternative vocabulary exposed to the model. Cross-boundary joins,
unions, and relationship traversal are unavailable. Query, extraction, rate,
and differencing history is shared across the stable reviewed source and
trusted scope. Differencing variants share a root-resource pool over a rolling
24-hour window, so changing boundaries, crossing UTC midnight, restarting
Runner, or changing the plan shape cannot reset privacy budgets.

The human-operated Analytics shell adds a relationship-aware view without
changing the model-facing tools:

```text
/catalog
/catalog --diagram --boundary reviewed_staging
/catalog --diagram --boundary reviewed_staging --export
```

Each diagram represents exactly one active boundary. If only one boundary is
active, `--boundary` may be omitted. With several active boundaries an
interactive shell opens an Up/Down selector rather than merging them; scripts
may pass the exact boundary name. Large maps export to a digest-bound Markdown
file containing the readable relationship topology, reviewed analysis, and
question prompts. The CLI remains terminal-native and does not print Mermaid.
Workbench uses the same catalog model and provides the same boundary selector,
a rendered visual relationship graph, suggested cross-table questions,
Mermaid source, and download. The map is generated from activated metadata
only; it reads no source rows.

Activating access through the Analytics shell's `/access` editor immediately
rebinds that same shell after the separate human confirmation; no restart or
provider-key re-entry is required. If access was activated in Workbench or a
different terminal, run `/refresh-access` in the existing shell. Runner shows
the exact new authority and provider-egress consequence, requires one explicit
operator confirmation, clears the old conversation, and rebinds without making
a provider request or restarting the process.

Protected named capabilities remain the default production surface. Flexible
Scoped Explore may also be served in production only through the explicit,
attested secured-HTTP mode described in
[Production Scoped Explore Over HTTP](production-scoped-explore-http.md).
Without that opt-in and all of its trusted-principal, per-principal budget,
rate-limit, and transport prerequisites, production Explore remains refused.
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

Moving a field from **Kept out** back to either usable tier restores only the
operation suggestions that Runner can currently derive from the inspected type,
the reviewed categorical allowlist, and the database-server grammar tier. The
editor names those staged operations after saving, and the access map shows the
exact result before activation. Existing custom relationships, bands, and named
metrics are not resurrected. Advanced field operations may narrow the restored
suggestions before the boundary is reviewed and activated. Moving between
**Model + Runner** and **Raw values: Runner only** preserves existing operation
grants and changes only where raw values may appear.

Boundaries reviewed before Runner 1.7.0 may contain a usable field with return
access but no filter, sort, group, or measure operation even though the current
inspection has safe suggestions. `/access`, the resource access map, and
Workbench mark that state as an optional operation restore. Select the field
and press **S** in `/access`, use **Restore current suggested operations** in
Workbench, or run the existing reviewed exposure command again:

```bash
synapsor-runner boundary review resource public.events \
  --allow-reviewed-field event_type \
  --actor "$USER" \
  --reason "Restore the current inspected analytical operations." \
  --apply
```

For a Runner-only field, use `--withhold-from-model` instead. Repair is an
explicit reviewed widening: it restores only current type-, allowlist-, and
database-version-compatible suggestions, creates a disabled digest, and still
requires exact activation. A normal rescan does not restore operations
automatically because an operator may have deliberately narrowed them.
The notice is therefore advisory: leaving the field return-only is valid.

Trusted tenant and principal columns use the same three output tiers, but their
scope semantics never change. Runner still injects the verified value outside
model arguments. Keeping the column out hides it from results; Runner output
only shows it in the local verified result and sends a response-local token to
the model; Model + Runner may send the reviewed value to the configured model.
Either disclosure choice requires a recorded human reason and changes the exact
boundary fingerprint. It never creates a tenant or principal tool argument.
Principal selection is independently reviewed per boundary. Two overlapping
boundaries may therefore apply different user/owner limits to the same table
without either policy leaking into the other.

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
uses one aligned ASCII matrix so operation differences are visible by column:
`RET` return, `FLT` filter, `SRT` sort, `GRP` group/band, `MEA` numeric measure,
`PRE` missing-data measure, `DST` distinct count, and `TIM` time bucket. `Y`
means reviewed and `-` means unavailable. Empty access tiers are not printed.
Relationships lead with the readable table chain and joining columns. Press
`D` to reveal exact filter/time vocabularies and canonical path IDs only when
needed. The same safe map is printable without interaction:

```bash
synapsor-runner boundary review resource public.orders --map
```

Use `--map --details` for that exact detail layer, or `--json` for the complete
machine-readable review record. The matrix has an ASCII-only compact layout for
narrow terminals and does not rely on color to communicate authority.

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

Use the boundary commands according to the step you need:

- `boundary rescan` re-inspects schema and database-role posture, reloads the
  normalized trusted-context authority from Runner config, and writes a disabled
  reconciliation report. It does not open review or activate.
- `boundary review --access` opens the focused table, column, relationship, and
  scope-path editor without another inspection. It is the shell equivalent of
  `/access` in an active Ask session.
- `start --from-env DATABASE_URL --cli --rescan` combines those steps and then
  enters Ask. If `boundary rescan` has already run, omit `--rescan` from
  `start`; the existing reconciled revision is reused instead of inspecting the
  database twice.

After standalone activation, Runner prints both a guided `start` command and a
direct `try ask` command, so returning to analytics does not depend on knowing
an undocumented handoff.

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

In the interactive CLI, this setting is labelled **minimum group size**. To
change it for one table:

1. Type `/access` in Analytics, or run
   `synapsor-runner boundary review --access` from the shell.
2. If the boundary list appears, highlight the boundary and press Enter.
3. Highlight the table in the table list. Do not press Enter, because Enter
   opens the column editor. Press `P`; Privacy applies to the highlighted table.
4. Enter a number from 1 through 5 and a short reason. Runner hides aggregate
   groups with fewer rows than that number. A value of 1 turns small-group
   suppression off.
5. Press Enter at `Save this privacy change? [Y/n]` to save the disabled draft.
6. Press Enter at `Review and activate this boundary change now? [Y/n]` to
   review and activate it. If activation is postponed, return to the boundary
   screen and press `C` (**Review + activate**).

Press `P` while the boundary is highlighted to set the same minimum group size
for all included tables as one atomic disabled change. Saving never activates
authority by itself.

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

- OpenAI with the `gpt-5.6-luna` terminal default;
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

Terminal Ask uses the `gpt-5.6-luna` OpenAI default and the tested
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

Let Runner resolve a reviewed relative UTC window instead of asking an AI client
to calculate dates:

```bash
synapsor-runner try explore \
  --resource public.orders \
  --count \
  --group-by channel \
  --time-window created_at:previous_month

synapsor-runner try explore \
  --resource public.orders \
  --sum total_cents \
  --group-by channel \
  --time-bucket created_at:month \
  --compare-window created_at:previous_month \
  --compare-to preceding_period
```

Relative windows are available only for fields already reviewed for time
bucketing. Runner captures one clock instant and resolves a fixed vocabulary in
the boundary's authority-bound UTC timezone. `this_month` is the complete UTC
calendar month; `month_to_date` ends at the captured instant. The same distinction
applies to week, quarter, and year. Ranges are half-open `[start, end)`. Existing
absolute ISO ranges remain supported.

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

After activation, let Runner manage only its own project entry. Runner detects
that this is an active local Explore-only project; `--authoring` below remains
the explicit, copyable form:

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

`mcp client-config` and `mcp install` now emit that authoring command
automatically for an active read-only development/staging boundary with no
named capabilities. Older config/store-shaped stdio entries are recognized at
startup as well. If no local boundary is active, Runner refuses rather than
starting or generating a server with no tools.

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
- `sum`, `avg`, sample/population standard deviation, and sample/population
  variance on explicitly reviewed numeric measures;
- reviewed missing-value counts and completion rates;
- reviewer-named ratios, percentages, and per-unit averages assembled only from
  reviewed base aggregates;
- reviewer-fixed numeric bands and reviewer-approved automatic numeric bands;
- reviewed categorical dimensions;
- hour, day, week, month, quarter, year, and day-of-week buckets on reviewed
  timestamps;
- reviewer-named running totals, ranks, previous-period changes, moving averages,
  and shares of released totals, calculated by Runner only after small-group
  suppression;
- reviewer-named total or average child counts through one exact non-null,
  catalog-proven child-to-parent relationship. Runner uses a scoped correlated
  subaggregate, not a one-to-many join, and releases only parent cohorts of at
  least five;
- typed bounded filters;
- ordering by a returned aggregate;
- bounded top-N and bottom-N results;
- one range or an exact comparison of at most two reviewed time ranges;
- one reviewed relative UTC window on rows or aggregates, or a relative
  two-period comparison against the preceding period or the same period last
  year; the model supplies a fixed name, never date arithmetic;
- ordering an exact two-period comparison by signed absolute or percentage
  change;
- one resource by default;
- up to three activated relationship paths in one plan;
- one or two inspected, reviewed many-to-one foreign-key links per path by
  default, or exactly three after the reviewer raises the separate derived-
  scope or analysis-path depth control; every link has maximum fan-out one.

It does not accept arbitrary `DISTINCT`, `HAVING`, formulas, model-authored
window functions, unions, nested queries, many-to-many joins, system catalogs,
user-defined functions, or a general join planner. The reviewed running, lag,
rank, moving-average, and share operations are fixed names evaluated over
already released groups; the model never sends an expression or SQL window.
Scope is enforced independently on every participating relation. Runner refuses
a plan when cardinality, fan-out, counted entity, or scope cannot be proven.

### Exact Database Identifiers

Plans copy exact reviewed resource and field IDs from `app.describe_data`.
Those physical database names do not have to look like programming-language
identifiers: reserved words, mixed case, Unicode, and printable names containing
spaces are supported. Runner first resolves the supplied string against the
exact activated boundary, then quotes each schema/table/column for the selected
dialect (`"..."` on PostgreSQL and `` `...` `` on MySQL), doubling an embedded
delimiter. Literal filter values remain separate bound parameters.

This does not create alias resolution. A reviewed label or description is still
display-only, and an unknown, differently-cased, or unreviewed name is refused
before compilation. Empty, over-bounded, control-character, or otherwise
malformed identifiers in a tampered activated artifact also fail closed. The
release compatibility matrix executes space-bearing and Unicode reviewed fields
on every supported PostgreSQL and MySQL line and through representative local
and production HTTP MCP paths.

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

Query volume and disclosure protection are separate reviewed controls. New
1.7.0 boundaries default to 1,000 queries per trusted scope in a rolling
24-hour window and 120 requests in a rolling minute. These are throughput
ceilings. The generated disclosure defaults remain 4,000 released cells and 16
distinct differencing variants per rolling 24 hours, together with the reviewed
cohort, suppression, response, and group limits. Raising query volume never
raises a disclosure limit.

Use `/access`, select the boundary, then choose `L Limits` to review query
volume, request rate, ranked-result limits, returned rows/groups/top-N,
measure/dimension counts, response cells/bytes, statement timeout, and the
separate derived-scope and analysis-relationship depth caps. Workbench exposes
the same settings under **Query volume**, **Ranked result settings**, and
**Result shape, timeout, and path depth**. The non-interactive equivalents are
`boundary review resource --max-top-n`, `--max-groups`,
`--max-response-cells`, `--max-response-bytes`, `--statement-timeout-ms`,
`--max-measures`, `--max-dimensions`, `--max-derived-scope-hops`, and
`--max-analysis-relationship-hops`.

Every value has an implementation ceiling. Depth defaults to two and has a
hard ceiling of three. Raising a depth cap does not activate a path: the exact
continuous, non-null, many-to-one path still needs separate review. Deep
derived paths can be materially slower than a direct tenant column, so the
terminal and Workbench show a cost advisory and `doctor` warns when estimated
path pressure approaches the reviewed statement timeout. The advisory never
blocks an otherwise valid path and performs no hot-path source scan.

A saved limit change creates a disabled boundary revision and takes effect only
after normal review and activation. These controls cannot change small-group
suppression or raise extracted-cell and differencing disclosure allowances.
`/details` and Workbench show operator-only used/remaining counters and warn
when a budget first crosses 80 percent; those counters are removed from the
model-facing tool result.

Every Explore request still re-proves current database authority before SQL is
compiled. For current generation locks, that live inspection fetches complete
metadata only for lock-bound resources and their reviewed relationship or
derived-scope proof resources. Dedicated lightweight checks retain global
credential/read-only/grant/ownership posture; RLS is re-proved for every
reviewed dependency. The whole-database single-organization refusal guard also
checks for tenant-shaped columns or RLS evidence anywhere in its inspected
schema. Nothing is cached between queries. Draft and rescan continue to inspect
the whole schema because they must discover new tables, columns, and paths;
legacy locks also retain the whole-schema compatibility path.

### Database Capability Profiles

Inspection resolves one server capability profile before review. PostgreSQL
13-18 and MySQL 8.0.16+ receive the complete grammar. MySQL 8.0.11-8.0.15
receives a supported profile without unenforced `CHECK`-derived categorical
vocabularies. MySQL 5.7 also omits automatic bands. Native `ENUM`, fixed bands,
dispersion, relative time, relationships, trusted scope, and Runner-side
post-suppression metrics remain available. PostgreSQL below 13 or above 18,
MySQL below 5.7, pre-GA MySQL
8.0.0-8.0.10, or MySQL above major 8,
MariaDB, and unrecognized products are refused.

This filtering is part of authoring authority. Unsupported controls are absent
from CLI and Workbench, absent from `app.describe_data`, and cannot enter the
activated pack. The compiler therefore never receives a reviewed feature and
then silently changes its meaning for an older server. The exact detected
version, resolved tier, and stable capability line are immutable fields in the
draft, generation lock, and activated boundary. A major/tier change requires
reconciling rescan and explicit activation; a patch update in
the same line does not create false drift. See
[Database Server Compatibility](database-server-compatibility.md) for the
tested matrix and operational support distinction.

### Reviewed Automatic Numeric Bands

A reviewer may opt one model-visible numeric measure into automatic grouping.
The policy fixes the allowed method (`quantile`, `equal_width`, or both), the
minimum and maximum bucket count, and the label style. Equal-width policies
also fix a minimum bucket width. Rounded-label policies fix an outward-rounding
unit. The model may then choose only an allowed method and an integer bucket
count in the reviewed range:

```json
{
  "numeric_band": {
    "field": "monthly_revenue_cents",
    "method": "quantile",
    "buckets": 5
  }
}
```

The model cannot send edges, widths, offsets, formulas, or labels. Runner
computes bands inside the same read-only transaction after applying every
trusted tenant, principal, and derived-scope predicate. Quantile computation
uses cumulative distribution rather than `NTILE`, so equal values stay in the
same bucket. Ties may therefore collapse requested buckets. Equal-width
grouping reduces the effective bucket count when the reviewed minimum width
would otherwise be violated. The response says when a reduction occurred.

Computed edges never enter model-facing results, `app.describe_data`, evidence,
or query audit. Ordinal labels such as `Q1 of 5` contain no data-derived value.
A reviewed rounded label widens both endpoints to the configured unit; it never
prints the exact computed edge. Operator-only execution diagnostics may inspect
internal edge metadata, but the model-facing two-tool surface may not.

Automatic bands do not make arbitrary numeric grouping safe by themselves.
Each released bucket still needs at least `max(reviewed minimum group size, 5)`
contributors, including when the ordinary owner-reviewed cohort is one. Ties
remain together, undersized groups are suppressed, and fixed and automatic
bands share the existing root-resource differencing pool. Changing the method
or bucket count is a variant in that same family, not a new privacy allowance.
The reviewed policy is absent by default, digest-bound, audited with actor,
reason, and time, and revalidated on rescan.

Automatic bands use the same compiler for local stdio and production HTTP
Explore. They are not currently Protect-convertible: use a reviewer-fixed named
band when a local analysis must become a fixed protected capability. This keeps
computed-edge semantics out of the protected DSL until that authority has a
separate design.

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

Relative windows use that same UTC authority and the same compiler in local
stdio and production HTTP. The operator-facing result and evidence record the
original name, captured instant, and resolved range. Model-facing results omit
the resolved timestamps. A protected analysis freezes those absolute timestamps;
it does not become a moving "previous month whenever invoked" capability.

## Structured Results And Safe Catalog

Both authoring tools advertise JSON `outputSchema` through MCP `tools/list`.
The schema covers success, empty, suppression, incomplete comparison, and safe
refusal outcomes. Successful analytical metadata includes the counted entity,
result grain, semantic measure/dimension aliases, reviewed relationship paths,
UTC authority, snapshot state, suppression, response usage, remaining budgets,
query-audit handle, and `source_database_changed: false`.

The differencing remainder is not a principal-wide sum over every table. It is
the remaining distinct-plan allowance for the current reviewed root resource in
the durable rolling 24-hour pool. `differencing_variants_for_root_resource`
names that resource and reports used, limit, remaining, and
`persists_across_sessions: true`; the older `differencing_queries` scalar remains
as a compatibility alias for its `remaining` value. Query, rate, and
extracted-cell remainders continue to cover the whole trusted scope.

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

Scoped Explore is disabled by default. Local authoring Explore starts only when
all of these are true:

- the trusted launch/configuration context establishes `development` or
  `staging`;
- the transport is local stdio or secured loopback Workbench traffic;
- the exact exploration-boundary digest is active;
- the generation lock and compiler/spec versions are current;
- the role/grant/ownership/RLS fingerprint still matches;
- the credential is demonstrably SELECT-only and non-owner;
- every query also runs in an enforced read-only transaction.

Missing, malformed, unknown, and production profiles cannot enter the local
authoring runtime. A superuser, relation owner, write-capable role, `BYPASSRLS` role,
or unverifiable role may inspect metadata with a warning but cannot read source
rows through Scoped Explore.

Production Explore is a separate explicit register. It requires a separately
reviewed production boundary, secured shared Streamable HTTP, asymmetrically
verified JWT tenant/principal claims, atomic shared-Postgres per-principal and
tenant accounting, rate limits, current schema/role/generation-lock posture,
and an enabled `production_explore` runtime config. The recommended
`--production-explore` launch marker makes that selected surface explicit but
is not a separate authority gate. It exposes the same exact two
read-only tools and no authoring or activation surface. See
[Production Scoped Explore Over HTTP](production-scoped-explore-http.md).

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
production Explore default-off refusal, protected-capability survival, guarded
proposals and apply, durable redacted audit, and unchanged source data on every
analytical path. Live PostgreSQL/MySQL relationship gates separately prove
database parity without claiming MySQL RLS.

For the timed first-read, Explore, Protect, proposal, and writeback walkthrough,
use [Database To First Safe Tool](guided-onboarding.md).
