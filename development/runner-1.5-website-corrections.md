# Runner 1.5 Website Corrections

Prepared from the deployed site and proprietary source at:

- public site checked: `2026-07-19`;
- proprietary source: `/home/sandesh-tiwari/Desktop/C++/Synapsor`;
- source commit checked: `0d672f55ed8c529c11421843336252d256f129bf`;
- OSS behavior source: `feature/runner-1.5-developer-experience`.

This is a handoff for a separately authorized website goal. Do not apply these
changes from the OSS branch.

## Already Correct

- `https://synapsor.ai/blog/stop-giving-agents-execute-sql` is public and has a
  canonical URL, Open Graph/Twitter metadata, `TechArticle` JSON-LD, sitemap
  inclusion, and blog-index linkage.
- `https://synapsor.ai/llms.txt` and `https://synapsor.ai/llms-full.txt` already
  link the article, OSS docs, GitHub repository, npm packages, and
  `support-plan-credit`.
- Website copy already states that external Postgres/MySQL stays the source of
  truth and is not physically branched or merged.
- Website copy already keeps model-facing approval/apply authority out of the
  external-database path.
- Native Synapsor Cloud replay/time-travel and branch features are separate from
  OSS Runner compensation. Do not globally remove those truthful Cloud claims.

## 1. Homepage: Show The Requested Business Effect

Public URL:

```text
https://synapsor.ai/
```

Source:

```text
services/control-panel/app/page.tsx
```

Current contradiction:

```text
Agent request: Can we waive the $55 late fee?
Proposed change: Ticket status Open -> Pending review
```

It appears in `HeroRunPreview` around source lines 314-326 and again in
`SafetyTrust` around lines 718-722.

Required replacement in both locations:

```text
Agent request: Can we waive the $55 late fee?
Proposed effect: late_fee_cents 5500 -> 0
Source DB changed before approval: No
```

Keep the seeded/demo label. Do not imply that this public visual mutated a
customer or production database.

## 2. Homepage: Replace Ambiguous Rollback Claims

Source locations in `services/control-panel/app/page.tsx`:

- hero paragraph around line 83;
- "Stage risky writes" around line 675;
- "Without Synapsor" comparison around line 732.

Current text:

```text
... audit logs, replay, and rollback.
... proposals with approval, rollback, and replay ...
Approval tables, audit logs, and rollback scripts live in app glue
```

Required replacement:

```text
... audit logs, replay, and reviewed compensation.
... proposals with approval, guarded writeback, reviewed compensation, and replay ...
Approval tables, audit logs, and compensation handling live in app glue
```

OSS Runner compensation is not rollback or time travel. It captures a bounded
inverse after an unambiguous apply; `revert` creates a separate proposal that
needs its own approval and guarded apply.

## 3. Technical Article: Lead With The Complete Proof

Public URL:

```text
https://synapsor.ai/blog/stop-giving-agents-execute-sql
```

Sources:

```text
docs/blog/stop-giving-agents-execute-sql.md
services/control-panel/app/blog/article.ts
```

In the article's "Local-First Runner" and "Try It" sections, make the first
command:

```bash
npx -y @synapsor/runner try --prove
```

Show this real outcome summary:

```text
late_fee_cents: 5500 -> 0
source unchanged before approval
one guarded row changed
retry caused zero duplicate mutations
stale apply refused
```

Keep MCP audit immediately second:

```bash
npx -y @synapsor/runner audit --example dangerous-db-mcp
```

`demo --quick` may remain documented as a compatibility alias. Update
`technicalArticle.modifiedAt` when this article change is deployed.

## 4. Technical Article: State The Isolation Boundary Precisely

After the trusted-context paragraph around article lines 119-123, add:

```text
With application_scope and one shared database credential, tenant/principal
isolation is enforced by Runner's fixed predicates. A Runner bug or a process
that can choose arbitrary trusted context could cross that boundary. Production
deployments should layer database controls underneath. postgres_rls binds the
authenticated tenant/principal transaction-locally and lets PostgreSQL check the
same scope independently; it still cannot contain a process that controls the
trusted settings or credentials. tenant_bound uses a restricted per-tenant
credential or process selected from authenticated context. MySQL has no native
RLS equivalent, so use restricted views, tenant-bound credentials, or isolated
deployments.
```

Do not claim that an arbitrary request header, query parameter, MCP argument,
or unsigned metadata value is trusted context.

## 5. Name The Two Examples Correctly

The live production-oriented flagship is now:

```text
https://github.com/Synapsor/Synapsor-Runner/tree/main/examples/support-billing-agent
```

It proves disposable PostgreSQL RLS, tenant plus principal scope, kept-out
fields, the exact $55 diff, no pre-approval mutation, manual approval, guarded
writeback, idempotent retry, stale conflict, replay, strict shadow,
human-outcome comparison, and effect regression.

Retain:

```text
https://github.com/Synapsor/Synapsor-Runner/tree/main/examples/support-plan-credit
```

Label it the graduated-trust/guarded-write example, not the sole flagship.

Update:

- article text around `docs/blog/stop-giving-agents-execute-sql.md:242`;
- `services/control-panel/app/llms.txt/route.ts` public OSS links;
- `services/control-panel/app/llms-full.txt/route.ts` public OSS links;
- any homepage/docs card that calls only `support-plan-credit` the flagship.

## 6. Existing-Database Security Doc

Public URL:

```text
https://synapsor.ai/docs/existing-db-security
```

Source:

```text
services/control-panel/app/docs/data.ts
```

The page currently describes tenant-scoped generated capabilities but does not
distinguish application-level filtering from independently enforced database
scope. Add a short mode matrix matching the article language:

```text
application scope -> Runner/Cloud fixed predicates; retain DB controls
PostgreSQL RLS -> database checks the transaction-bound scope too
tenant-bound credential/deployment -> limits one credential/process blast radius
MySQL -> no native RLS; use restricted views/credentials/isolation
```

Keep Cloud external-source behavior distinct from customer-operated OSS Runner
deployment. Do not imply Cloud receives a customer's local Runner write
credential or SQLite ledger.

## 7. Verification For The Website Goal

Run the control-panel build and tests, including:

```text
services/control-panel/app/page.test.tsx
services/control-panel/app/blog/article.test.tsx
services/control-panel/app/blog/publication-surfaces.test.ts
```

After deployment, smoke:

```text
https://synapsor.ai/
https://synapsor.ai/blog/stop-giving-agents-execute-sql
https://synapsor.ai/docs/existing-db-security
https://synapsor.ai/llms.txt
https://synapsor.ai/llms-full.txt
https://synapsor.ai/sitemap.xml
```

Confirm:

- homepage displays `late_fee_cents: 5500 -> 0`, not a ticket-status diff;
- public Runner copy uses "reviewed compensation", not rollback/time travel;
- article starts with `try --prove`, then audit;
- isolation modes and attacker limits are explicit;
- both example links resolve and have distinct labels;
- article canonical/metadata/JSON-LD remain correct;
- sitemap and LLM files retain the article and OSS links;
- no secrets, TODOs, local paths, or unpublished version claims appear.
