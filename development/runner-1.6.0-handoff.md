# Runner 1.6.0 Final Handoff

Status: implementation and local verification complete; not committed, merged,
pushed, tagged, published, released, submitted, or deployed.

## Executive Summary

Runner 1.6.0 implements the additive adoption path:

```text
Connect staging
-> deterministic Auto Boundary
-> human boundary review
-> bounded row or PM-style aggregate Explore
-> Protect This Query
-> exact-digest human activation
-> named production capability
-> Propose
-> Commit
```

It does not expose raw SQL, SQL-string arguments, model-selected tenant or
principal values, model activation, approval, or commit. Existing 1.x projects
remain on their established paths unless they explicitly adopt generated
authority.

## Before And After

| Before 1.6.0 | Prepared 1.6.0 candidate |
| --- | --- |
| Generators produced disconnected candidates | One deterministic whole-schema evidence graph and disabled Capability PR |
| Fresh onboarding selected one table/action | Fresh interactive selector-free onboarding enters Auto Boundary |
| Useful novel reads required authored capabilities or another DB tool | Two temporary local authoring tools accept reviewed structured plans |
| Existing fixed aggregates were named scalar capabilities | PM-style reviewed count/count-distinct/sum/avg exploration with grouping and time comparison |
| No path from an explored query to production authority | Protect emits public DSL, canonical JSON, tests, and a disabled named capability |
| Drift was not tied to generated authority | Generation-lock semantic drift affects only explicitly generated authority |
| Production and authoring were not a product lifecycle | Explore disappears; only the digest-activated named capability reaches production |

## Architecture

### Auto Boundary

Runner combines direct database metadata with statically parsed Prisma,
Drizzle, OpenAPI, and existing Synapsor definitions. It executes no adopter
code and uses no LLM. It emits:

```text
synapsor/generated/*.synapsor.sql
synapsor/generated/*.contract.json
.synapsor/generation-lock.json
.synapsor/review-report.json
.synapsor/tests/*
```

Drafts start disabled. The Workbench lets a human narrow, never widen, the
generated authority and activate its exact digest. The digest covers compiler
and Spec versions, schema-lock fingerprint, profile, budgets, stable role/grant/
RLS posture, trusted bindings, resources, fields, measures, dimensions, and
relationships. It contains no credentials, source rows, or trusted values.

### Scoped Explore

The canonical authority is the activated exploration boundary. Each row or
aggregate plan is transient runtime input, not a capability and not a generic
query AST in `@synapsor/spec`.

Before registering the authoring tools, Runner verifies an explicit development
or staging profile, local stdio or secured loopback authoring transport, current
generation lock and boundary digest, and a demonstrably SELECT-only non-owner,
non-superuser, non-`BYPASSRLS` role. Missing or unknown profile means
production. Production, shared HTTP, remote HTTP, and non-loopback surfaces
neither list nor execute Explore.

Plans select only reviewed aliases. Runner compiles them to parameterized SQL,
injects trusted tenant/principal scope outside model arguments, applies scope to
every participating relation, starts an enforced read-only transaction, sets a
statement timeout, suppresses small cohorts, charges durable privacy/query
budgets, and writes only normalized redacted audit metadata.

The entire model-facing authoring surface is:

```text
app.describe_data
app.explore_data
```

### Protect This Query

Workbench resolves a recent normalized audit entry through an internal
`query_ref`; no copied proposal/query ID is required. A human chooses the
capability name and which eligible literals become bounded typed arguments.
Trusted scope stays trusted and fixed policy literals stay fixed.

Protect emits public `.synapsor.sql`, canonical JSON, generated positive/scope/
suppression/differencing/join/deny/drift/boundary tests, and a disabled draft.
Exact-digest activation occurs outside MCP, disables Scoped Explore, and leaves
only the named capability in production.

## Backward Compatibility

| Surface | Result |
| --- | --- |
| Published baselines | Runner 1.5.4, DSL 1.4.4, Spec 1.4.2 pinned by npm SHA-1 |
| Canonical contracts | 7/7 source and normalized SHA-256 digests unchanged |
| Published DSL | 4/4 sources compile to their exact prior canonical digests |
| Legacy `tools/list` | Exact packed 1.5.4 surface retained |
| Manual JSON/DSL/TypeScript | Load, validate, and serve without migration |
| Existing configs/env/layouts | No Workbench, rescan, browser, or lock required |
| Existing active authority | Never regenerated, disabled, or drift-enrolled |
| New canonical field | Optional default-deny `protected_read`; absent legacy form is unchanged |
| Existing startup | No mandatory database scan or Workbench dependency |

## CLI Routing

| Invocation state | Route |
| --- | --- |
| Fresh interactive `start --from-env`, no config/selector/automation | Auto Boundary |
| `--table` or `--inspection-json --table` | Existing selected-object route |
| `--answers` and documented machine input | Existing noninteractive route |
| `onboard db` | Existing onboarding route |
| Existing config/contract | Existing runtime route |
| JSON, CI, headless, or noninteractive execution | Never prompts or opens a browser |
| `mcp serve --authoring` with active local staging boundary | Exactly two Scoped Explore tools |
| Production runtime after Protect | Named protected capabilities only |

## PM Aggregate Boundary

The default reviewed ceilings are 50 rows, 50 groups, top 25, 3 measures,
3 dimensions, 2 time ranges, 1 relationship hop, 500 response cells, 64 KiB,
3-second statement timeout, complexity 24, 40 queries/session, 4,000 extracted
cells/session, 6 differencing queries, and 20 requests/minute. Plans additionally
allow at most 8 filters and 20 values in an `IN` filter. Models cannot widen
these values.

The golden boundary is deliberately narrower: 20 rows, 12 groups, top 10,
3 measures, 2 dimensions, 2 time ranges, 1 reviewed many-to-one relationship,
12 queries/session, 1,000 extracted cells, and 3 differencing queries.

Supported aggregate grammar:

- `count`;
- reviewed `count_distinct`;
- reviewed numeric `sum` and `avg`;
- reviewed categorical dimensions;
- day/week/month buckets on reviewed timestamps;
- typed reviewed filters;
- aggregate ordering and bounded top-N;
- at most two bounded time ranges;
- one resource or one explicitly reviewed safe many-to-one foreign-key path.

The reference answer returned:

| Week | Region | Reason | Accounts | Sum monthly revenue | Average |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-06-01 | west | price | 5 | 60,000 | 12,000 |
| 2026-06-08 | east | service | 5 | 110,000 | 22,000 |
| 2026-07-06 | west | price | 10 | 130,000 | 13,000 |
| 2026-07-13 | east | service | 7 | 161,000 | 23,000 |
| 2026-07-20 | south | onboarding | 5 | 35,000 | 7,000 |

Two north/product cohorts of size 2 and 1 were suppressed. Globex rows,
customer identifiers, emails, risk scores, private notes, and suppression-aware
totals were not returned. This is bounded descriptive contributor analysis,
not proof of causation.

## Aggregate Acceptance

All 15 required checks pass:

1. Unauthorized dimension rejected.
2. Kept-out grouping and filtering rejected.
3. Model-selected tenant/principal rejected.
4. Unreviewed join rejected.
5. Many-to-many/fan-out-ambiguous join rejected.
6. Small cohorts suppressed without revealing totals.
7. Repeated differencing exhausts the durable budget.
8. Group/measure/dimension/bucket/range/top-N/cell/byte/complexity limits reject.
9. Verified SELECT-only role and enforced read-only transaction used.
10. Source database unchanged.
11. Protect creates public DSL plus canonical tested disabled authority.
12. Exact-digest human activation required outside MCP.
13. Production omits Explore and rejects guessed invocation.
14. Protected capability survives Explore shutdown.
15. Published contracts and established CLI workflows remain unchanged.

## Measurements

The product clock starts at Runner database inspection after package download
and fixture startup. The final isolated-cache packed run measured:

| Measurement | Result |
| --- | ---: |
| Fresh package install, isolated npm cache | 5,307 ms |
| Warm-cache package install | 4,930 ms |
| First useful own-data answer | 10,863 ms |
| First generated Data PR | 11,634 ms |
| First activated protected capability | 11,694 ms |
| Authoring `tools/list` | 6,325 bytes / about 1,582 tokens |
| Scale fixture `tools/list` | 6,359 bytes / about 1,590 tokens |

The 40-table scale fixture generated 40 disabled candidates while exposing only
two tools for the activated three-resource pack. True post-publication npm
tarball-download timing remains a manual follow-up because 1.6.0 is not
published.

## Verification

- OSS: 47 files and 709 tests passed.
- Focused release matrix: 8 files and 377 tests passed.
- Complete Runner release gate passed.
- Auto Boundary source, packed, scale, visual, and published compatibility
  gates passed.
- Guarded CRUD, bounded set, reversible, principal/database scope, aggregate,
  conformance, fleet, live apply, app-owned executor, and Cloud-linked suites
  passed.
- Packed network auth, lifecycle, principal scope, own-database, and
  backward-compatibility gates passed.
- C++ build passed; CTest passed 1,071/1,071.
- Python control-plane ran 274 tests with exactly the five documented baseline
  failures and zero new failures.
- C++/Spec/Runner contract round-trip passed all 23 focused C++ tests and all
  fixtures, including protected PM aggregate authority.
- Control panel passed typecheck, lint, 29 files/117 tests, and production build
  of 108 pages.
- Frozen lockfile install, 157 local Markdown links, strong-secret scans,
  package-content checks, and both repositories' `git diff --check` passed.

Package dry runs:

| Package | Packed | Unpacked | Files |
| --- | ---: | ---: | ---: |
| `@synapsor/spec@1.5.0` | 43.2 kB | 236.5 kB | 82 |
| `@synapsor/dsl@1.5.0` | 24.9 kB | 108.3 kB | 13 |
| `@synapsor/runner@1.6.0` | 1.3 MB | 6.0 MB | 273 |

## Assets

Reviewed screenshots:

```text
development/runner-1.6.0-visual/workbench-desktop-light.png
development/runner-1.6.0-visual/workbench-desktop-dark.png
development/runner-1.6.0-visual/workbench-mobile-light.png
development/runner-1.6.0-visual/workbench-loading.png
development/runner-1.6.0-visual/workbench-protect-empty.png
development/runner-1.6.0-visual/workbench-keyboard-failure.png
```

No new video was required or generated for this release. The screenshots are
ignored verification artifacts, not package contents.

## Changed Files By Phase

Auto Boundary, authoring MCP, Workbench, Protect, and CLI:

```text
apps/runner/src/authoring-mcp.ts
apps/runner/src/auto-boundary.ts
apps/runner/src/auto-boundary.test.ts
apps/runner/src/protect-query.ts
apps/runner/src/protect-query.test.ts
apps/runner/src/scoped-explore.ts
apps/runner/src/scoped-explore.test.ts
apps/runner/src/cli.ts
apps/runner/src/cli.test.ts
apps/runner/src/local-ui.ts
apps/runner/src/local-ui.test.ts
apps/runner/src/cursor-project.ts
apps/runner/src/cursor-project.test.ts
apps/runner/src/schema-candidates.ts
schemas/synapsor.runner.schema.json
```

Inspection, posture, configuration, privacy, and runtime:

```text
packages/config/package.json
packages/config/src/index.ts
packages/config/src/index.test.ts
packages/config/tsconfig.json
packages/schema-inspector/package.json
packages/schema-inspector/src/index.ts
packages/schema-inspector/tsconfig.json
packages/postgres/src/index.ts
packages/postgres/src/index.test.ts
packages/protocol/src/index.ts
packages/protocol/src/privacy-boundary.ts
packages/protocol/src/privacy-boundary.test.ts
packages/mcp-server/package.json
packages/mcp-server/src/index.ts
packages/mcp-server/src/index.test.ts
packages/mcp-server/src/generated-authority.test.ts
packages/mcp-server/src/protected-read.test.ts
packages/mcp-server/tsconfig.json
```

Public Spec and DSL:

```text
packages/spec/package.json
packages/spec/schemas/synapsor-contract.schema.json
packages/spec/src/index.ts
packages/spec/src/types.ts
packages/spec/src/validate.ts
packages/spec/test/validate.test.ts
packages/dsl/package.json
packages/dsl/src/index.ts
packages/dsl/test/dsl.test.ts
```

Golden fixture, compatibility, and verification:

```text
examples/auto-boundary-churn/README.md
examples/auto-boundary-churn/app/page.tsx
examples/auto-boundary-churn/docker-compose.yml
examples/auto-boundary-churn/package.json
examples/auto-boundary-churn/prisma/schema.prisma
examples/auto-boundary-churn/seed/postgres.sql
fixtures/compatibility/published-1.5.4/manifest.json
scripts/verify-auto-boundary-explore.mjs
scripts/verify-auto-boundary-scale.mjs
scripts/verify-auto-boundary-workbench-visual.mjs
scripts/verify-packed-auto-boundary-explore.mjs
scripts/verify-packed-backward-compatibility.mjs
scripts/verify-published-compatibility.mjs
scripts/verify-packed-lifecycle.mjs
scripts/verify-packed-network-auth.mjs
scripts/verify-packed-own-db.sh
scripts/verify-packed-principal-row-scope.sh
scripts/verify-packed-runner.sh
```

Packaging, release metadata, docs, and Cursor integration:

```text
.gitignore
package.json
pnpm-lock.yaml
apps/runner/package.json
apps/runner/README.md
apps/runner/llms.txt
README.md
llms.txt
CHANGELOG.md
scripts/build-runner-package.mjs
scripts/cursor-plugin-package.mjs
plugins/cursor/synapsor/.cursor-plugin/plugin.json
plugins/cursor/synapsor/README.md
plugins/cursor/synapsor/commands/synapsor-protect.md
plugins/cursor/synapsor/mcp.json
docs/README.md
docs/aggregate-reads.md
docs/auto-boundary-and-scoped-explore.md
docs/capability-authoring.md
docs/conformance.md
docs/current-scope.md
docs/cursor-plugin.md
docs/dsl-reference.md
docs/getting-started-own-database.md
docs/limitations.md
docs/release-notes.md
docs/schema-api-candidates.md
docs/troubleshooting-first-run.md
development/runner-1.6.0-progress.md
development/runner-1.6.0-handoff.md
```

Cloud/C++ canonical parity and public website:

```text
docs/blog/stop-giving-agents-execute-sql.md
docs/oss_contract_alignment.md
scripts/verify_contract_roundtrip.sh
services/control-panel/app/blog/article.test.tsx
services/control-panel/app/blog/article.ts
services/control-panel/app/docs/data.ts
services/control-panel/app/llms-full.txt/route.ts
services/control-panel/app/llms.txt/route.ts
services/control-panel/app/page.tsx
services/control-plane/app.py
src/agent/synapsor_contract_spec.cpp
tests/agent/synapsor_contract_spec_test.cpp
tests/aws_v1_control_plane_test.py
tests/fixtures/synapsor_spec/protected-read-aggregate.contract.json
```

External technical reference:

```text
/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md
```

## Branch And Commit Structure

```text
OSS:
  branch: feature/runner-1.6.0-auto-boundary-explore
  base/main/origin-main: 9d5d8e5
  new commits: none

Cloud/C++:
  branch: feature/protected-read-spec-1.5.0
  base/main/origin-main: 097bddd1
  new commits: none
```

Changes remain uncommitted so owner review can determine commit boundaries.

## Known Limits And Explicitly Unimplemented Scope

- Scoped Explore is local authoring only and never a production/shared HTTP
  surface.
- No raw SQL, free-form identifier, function/expression, arbitrary `DISTINCT`,
  `HAVING`, window, subquery, union, stored procedure, UDF, or catalog escape.
- No general join planner, many-to-many join, or ambiguous fan-out.
- Aggregate output is descriptive and privacy-bounded, not causal inference.
- Existing app-owned executors remain the path for rich transactions and
  external effects.
- No arbitrary application source/call-site analysis, new executor SDK,
  Toolbox/generic-MCP importer, or Slack/GitHub approval adapter was added.
- The five documented Python baseline failures remain.
- Physical macOS and Windows execution remains manual; Linux paths, spaces,
  packed artifacts, and current Cursor/Claude Code/Codex config parsing passed.
- True npm cold tarball-download timing can be measured only after publication.

## Owner-Only Release Commands

Do not run these until both branches have been reviewed, committed, merged, and
pushed with explicit authorization.

```bash
# OSS review/commit/merge
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
git add -A
git commit -m "Ship Runner 1.6.0 Auto Boundary and protected exploration"
git checkout main
git merge --ff-only feature/runner-1.6.0-auto-boundary-explore
git push origin main

# Cloud/C++ parity and website review/commit/merge
cd /home/sandesh-tiwari/Desktop/C++/Synapsor
git add -A
git commit -m "Add protected read contract parity and Runner 1.6 guidance"
git checkout main
git merge --ff-only feature/protected-read-spec-1.5.0
git push origin main

# npm publication, in dependency order
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
corepack pnpm --filter @synapsor/spec publish --access public
corepack pnpm --filter @synapsor/dsl publish --access public
corepack pnpm --filter @synapsor/runner publish --access public

# Keep next aligned with latest
npm dist-tag add @synapsor/spec@1.5.0 next
npm dist-tag add @synapsor/dsl@1.5.0 next
npm dist-tag add @synapsor/runner@1.6.0 next

# Registry verification
npm view @synapsor/spec@latest version dist.shasum
npm view @synapsor/dsl@latest version dependencies dist.shasum
npm view @synapsor/runner@latest version bin dependencies dist.shasum
npm dist-tag ls @synapsor/spec
npm dist-tag ls @synapsor/dsl
npm dist-tag ls @synapsor/runner
npx -y -p @synapsor/runner synapsor-runner --version
npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp

# Git tag and GitHub release after registry verification
git tag -a v1.6.0 -m "Synapsor Runner 1.6.0"
git push origin v1.6.0
gh release create v1.6.0 --title "Synapsor Runner 1.6.0" \
  --notes-file docs/release-notes.md
```

AWS remains stopped/undeployed. Only after separate deployment authorization,
from a clean Cloud `main`:

```bash
cd /home/sandesh-tiwari/Desktop/C++/Synapsor
scripts/deploy-dev.sh
```

That command builds and pushes the Cloud images, applies Terraform, waits for
ECS stability, invalidates CloudFront, updates the runtime, and runs the dev
smoke test. It is not required to publish the OSS npm packages.
