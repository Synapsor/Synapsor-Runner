# Reviewed Candidates From Prisma, Drizzle, And OpenAPI

Use these generators after schema or API inspection when you want a review
starting point without granting authority:

```bash
synapsor-runner init from-prisma ./prisma/schema.prisma \
  --output ./synapsor-prisma-candidates

synapsor-runner init from-drizzle ./src/schema.ts \
  --output ./synapsor-drizzle-candidates

synapsor-runner init from-openapi ./openapi.yaml \
  --output ./synapsor-openapi-candidates
```

Each command writes a separate deterministic directory containing:

- `synapsor.candidate.contract.json`: canonical `@synapsor/spec` candidates;
- `synapsor.candidate.runner.json`: source-less strict Shadow configuration;
- `synapsor.candidate.contract-tests.json`: deny, redaction, and operator
  boundary test candidates;
- `generation-review.json`: stable machine-readable review findings;
- `REVIEW.md`: the human review checklist;
- `.synapsor-schema-candidates.json`: Runner's ownership marker.

No candidate is active. Proposal writeback is `none`, no database source is
configured, and tenant/principal authority remains a visible placeholder.
Generation never edits the input or an active Runner configuration.

## What Is And Is Not Inferred

The generators can suggest structural facts and likely review targets:

- objects, fields, table mappings, primary keys, and version-like fields;
- potential tenant/principal fields based on names;
- potentially sensitive and kept-out fields;
- possible read and proposal capability names;
- operations that need business logic or an app-owned handler.

They do not decide which tenant or principal is authoritative, which fields are
safe to expose, which writes are valid, business bounds, approval policy, or
auto-approval. A field-name heuristic is not data classification.

Review `generation-review.json` and `REVIEW.md`, replace every
`review_required_*` placeholder, run the generated tests and a
[Shadow study](shadow-studies.md), then deliberately copy reviewed definitions
into an active contract through code review.

## Input Safety

Input is bounded to 2 MiB, 50 objects, 128 fields per object, and 200 generated
capabilities. Deep or oversized structures fail closed.

- Prisma uses Runner's bounded lexer/parser. Datasource URLs, defaults, enum
  values, generators, and plugins are not copied or run.
- Drizzle is untrusted executable TypeScript. Runner parses a documented static
  `pgTable`/`mysqlTable` object-literal subset with the TypeScript AST. It never
  imports, transpiles, type-checks, executes, or resolves the application.
  Dynamic table names fail; unsupported dynamic columns are called out for
  review.
- OpenAPI 3 JSON/YAML is parsed locally. Network/external references are
  rejected. Server URLs, examples, defaults, enum values, callbacks, webhooks,
  and credentials are not copied.

Existing output is never replaced unless `--force` points to a directory with
Runner's matching ownership marker. Hand-edited directories are refused even
with `--force`.
