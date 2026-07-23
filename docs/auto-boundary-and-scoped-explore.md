# Auto Boundary, Scoped Explore, And Protect

Runner 1.6.0 adds a deterministic authoring path for a real application:

```text
Connect staging
-> draft the boundary
-> review and activate its exact digest
-> explore through two bounded MCP tools
-> protect a useful query
-> activate the named capability
-> disable exploration
-> serve only named production tools
```

This path does not give the model SQL, database credentials, tenant identity,
approval, activation, or commit authority. Auto Boundary and Protect use no
LLM. Existing hand-authored contracts and established onboarding commands
continue to work without this feature.

## Start With Staging

Use a dedicated SELECT-only, non-owner database role. Keep database-level
controls underneath Runner. PostgreSQL deployments should use forced row-level
security (RLS) where possible; MySQL deployments should use restricted views or
tenant-bound credentials.

Export the connection and trusted context in the process that Cursor will use:

```bash
export DATABASE_URL='postgresql://runner_reader:REPLACE_ME@127.0.0.1:5432/app'
export SYNAPSOR_TENANT_ID='acme'
export SYNAPSOR_PRINCIPAL='pm-1'

npx -y @synapsor/runner start --from-env DATABASE_URL --schema public
```

A fresh interactive invocation with no existing config, selector, or automation
input enters Auto Boundary. It scans the whole selected schema and opens the
secured loopback Workbench. The initial npm download is not part of Runner's
measured onboarding time.

For scripts or CI, draft without prompts or a browser:

```bash
synapsor-runner boundary draft \
  --from-env DATABASE_URL \
  --schema public \
  --project-root . \
  --json
```

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
  contract-tests.json
  REVIEW.md

.synapsor/
  generation-lock.json
  review-report.json
```

The `.synapsor.sql` files compile through `@synapsor/dsl` into the canonical
`@synapsor/spec` JSON contract. The generation lock records non-secret
fingerprints of the inspected schema, compiler/spec version, exact database
role, grants, ownership, and RLS posture. Generated read drafts and action
candidates start disabled. Auto Boundary never replaces an active contract.

No source rows, credentials, tenant values, or principal values are written to
these files.

## Review The Boundary

The Workbench requires a human to narrow and confirm:

- development or staging deployment profile;
- trusted tenant and principal bindings supplied outside model arguments;
- included resources and one-hop relationships;
- selectable fields;
- filterable fields and allowed operators;
- sortable and groupable fields;
- aggregate-safe numeric measures;
- identifiers allowed only for `count_distinct`;
- timestamp fields and permitted day/week/month buckets;
- kept-out fields;
- counted entity and relationship cardinality;
- minimum cohort size;
- row, group, measure, dimension, time-range, response, rate, extraction, and
  differencing budgets;
- the current schema fingerprint and exact database-role/RLS posture.

Kept-out fields are unavailable for selection, filtering, sorting, grouping,
joining, aggregation, and `count_distinct`.

Raw visibility and aggregate use are separate permissions. A reviewer may
allow `count_distinct(customer_id)` while keeping every `customer_id` value out
of results.

Workbench activation requires every generated decision, the operator identity,
and the exact confirmation:

```text
ACTIVATE sha256:...
```

The immutable digest covers the reviewed resources, field permissions,
relationships, scope, role posture, generation lock, compiler/spec version,
profile, and every query/privacy budget. Model arguments cannot widen it.

## Add The Authoring Tools To Cursor

After activation, let Runner manage only its own project entry:

```bash
synapsor-runner mcp install cursor \
  --project \
  --authoring \
  --project-root . \
  --yes

synapsor-runner mcp status cursor --project
```

The Cursor config contains command paths and package identity, not database
URLs, credential values, tenant values, or principal values. Authoring mode
uses local stdio and advertises exactly:

```text
app.describe_data
app.explore_data
```

`app.describe_data` is bounded and paginated over only the activated resource
pack. `app.explore_data` accepts a structured plan. Neither tool exposes SQL,
approval, apply, activation, commit, or revert.

## Scoped Row Explore

A row plan can select, filter, sort, and limit only fields and operators in the
activated boundary. Runner injects tenant and principal scope outside model
arguments and compiles the validated plan into parameterized SQL.

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
- bounded top-N results;
- at most two reviewed time ranges;
- one resource by default;
- at most one inspected, reviewed many-to-one foreign-key path with maximum
  fan-out one.

It does not support arbitrary `DISTINCT`, `HAVING`, formulas, window functions,
unions, nested queries, many-to-many joins, system catalogs, user-defined
functions, or a general join planner. Scope is enforced independently on every
participating relation. Runner refuses a plan when cardinality, fan-out,
counted entity, or scope cannot be proven.

Before returning groups, Runner enforces the reviewed minimum cohort size.
Small groups are suppressed and revealing totals are withheld. Durable
per-session extraction and differencing budgets block repeated slightly
different queries that could reconstruct a suppressed cohort. Pagination
cannot bypass the maximum group count.

Results describe changes, comparisons, correlations, and likely contributors.
They do not establish causation.

## Runtime Enforcement

Scoped Explore is disabled by default and authoring-only. It starts only when
all of these are true:

- the profile is explicitly `development` or `staging`;
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

Choose the useful query in Workbench. Protect freezes:

- resources and reviewed relationship path;
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

The public DSL compiles into the canonical Spec. The generated capability
starts disabled and includes positive, scope, suppression, differencing,
join-safety, deny, drift, and boundary tests. It becomes active only after a
human reviews and confirms its exact contract digest outside MCP.

When activation disables temporary Explore, the named capability remains
available. Update Cursor from authoring mode to the production config:

```bash
synapsor-runner mcp install cursor \
  --project \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

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

The packaged synthetic fixture is under `examples/auto-boundary-churn`.

From a source checkout:

```bash
corepack pnpm test:auto-boundary-explore
corepack pnpm test:auto-boundary-explore:packed
```

The packed gate proves the PostgreSQL + Next.js + Prisma + Cursor-compatible
MCP + Workbench flow, all aggregate denial/suppression/budget checks, Protect,
production Explore absence, protected-capability survival, durable redacted
audit, and an unchanged source database.
