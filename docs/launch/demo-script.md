# Synapsor Launch Demo Script

## Short Safe Action Cut (36 seconds)

1. Cursor request: ask for one reviewed support plan credit.
2. Semantic proposal: show the real capability, proposal id, and evidence id.
3. Exact Data PR: show the before/proposed credit and reason.
4. Source unchanged: prove PostgreSQL remains at the before value.
5. Outside-MCP approval: show the operator-only Workbench control.
6. Guarded commit: show one affected row and the real receipt hash.
7. Idempotent retry: show no second mutation and the unchanged source value.
8. Stale refusal: show the separately approved proposal ending in
   `VERSION_CONFLICT`, zero affected rows, and no overwrite.

Every identifier and database value rendered in this cut must come from
`.synapsor/demo-video/results.json`. The Cursor request is the narrative host;
the semantic call and every lifecycle result are captured from the same
project-scoped MCP/Runner boundary and disposable support-plan-credit fixture.

Target: 177 seconds, caption-led, synthetic data only.

The recording harness renders these scenes from the actual output captured by
`scripts/demo-video/run-demo.sh`. Dynamic proposal, evidence, receipt, digest,
and version identifiers must come from that run. Do not substitute the sample
files under `expected-output/` for a real recording.

## Shot Map

| Time | Shot | Evidence source |
| --- | --- | --- |
| 0:00-0:08 | Hook | title card |
| 0:08-0:20 | Unsafe database MCP shape | built-in `dangerous-db-mcp` audit |
| 0:20-0:32 | Trusted context | authored contract excerpt |
| 0:32-0:45 | Reviewed capability | authored contract excerpt |
| 0:45-0:58 | Model-facing MCP tools | `tools preview` output |
| 0:58-1:10 | Scoped inspection and evidence | real `smoke call` result |
| 1:10-1:28 | Proposal and exact diff | real `$100` proposal result |
| 1:28-1:36 | Source DB remains unchanged | real Postgres queries before/after proposal |
| 1:36-1:48 | Operator approval outside MCP | real `proposals approve` output |
| 1:48-2:03 | Guarded writeback | real `apply` output and source query |
| 2:03-2:17 | Receipt and replay | real receipt/replay output |
| 2:17-2:35 | Cloud push | real authenticated Cloud response |
| 2:35-2:49 | Registry and Runner bundle | real Cloud UI capture and bundle manifest |
| 2:49-2:57 | CTA | title card with public links |

## Scene 1: Hook

On screen:

```text
Stop giving agents execute_sql.
Give them reviewed business actions instead.
```

No product state changes.

## Scene 2: The Unsafe Default

Command:

```bash
synapsor-runner audit --example dangerous-db-mcp --format markdown
```

Show the raw tool shape and high-signal findings. Do not execute SQL.

Expected concepts:

```text
execute_sql(sql: string)
arbitrary query authority
model-selected table/column scope
missing trusted tenant/principal context
```

## Scene 3: Trusted Context

Source:

```text
examples/support-plan-credit/contract.synapsor.sql
```

Show exact authored lines:

```sql
BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
TENANT BINDING tenant_id
PRINCIPAL BINDING principal
```

Claim: tenant and principal scope come from trusted environment bindings, not
model arguments.

## Scene 4: Reviewed Capability

Show exact authored lines:

```sql
ALLOW READ id, tenant_id, customer_id, plan, invoice_status,
  support_ticket_reason, plan_credit_cents, credit_reason, updated_at
KEEP OUT card_token, raw_payment_method, internal_risk_score, private_notes
ALLOW WRITE plan_credit_cents, credit_reason
BOUND plan_credit_cents 1..50000
APPROVAL ROLE support_reviewer
WRITEBACK DIRECT SQL
```

Claim: the contract is the reviewable boundary for what the tool can see and
what one proposal can change.

## Scene 5: MCP Surface

Command:

```bash
synapsor-runner tools preview \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./.synapsor/demo-video/local.db
```

Must show:

```text
Exposed to MCP:
  support.inspect_customer
  support.propose_plan_credit

Not exposed to MCP:
  execute_sql / raw query tools
  approval tools
  commit/apply tools
  database URLs
  write credentials
  model-controlled tenant authority
```

## Scene 6: Scoped Inspection

Command:

```bash
synapsor-runner smoke call support.inspect_customer \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./.synapsor/demo-video/local.db \
  --json '{"customer_id":"CUS-3001"}'
```

Must prove:

```text
tenant: acme
principal: local_support_agent
customer: CUS-3001
evidence bundle: ev_...
source database changed: false
```

## Scene 7: Proposal

Use the operator-reviewed tier, not the policy-approved `$25` tier:

```bash
synapsor-runner propose support.propose_plan_credit \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./.synapsor/demo-video/local.db \
  --json '{"customer_id":"CUS-3001","credit_cents":10000,"reason":"SLA outage ticket SUP-481"}'
```

Must show the real proposal and evidence identifiers plus:

```text
credit_reason: null -> SLA outage ticket SUP-481
plan_credit_cents: 0 -> 10000
approval required: true
writeback: not applied
source database changed: false
```

## Scene 8: Source DB Unchanged

Query Postgres before proposal and after proposal, before approval:

```sql
SELECT customer_id, plan_credit_cents, COALESCE(credit_reason, 'none')
FROM public.customers
WHERE id = 'CUS-3001';
```

Both results must be:

```text
CUS-3001 | 0 | none
```

## Scene 9: Operator Approval

Command:

```bash
synapsor-runner proposals approve latest --yes \
  --store ./.synapsor/demo-video/local.db
```

Must show:

```text
approval: pending required role support_reviewer
source database changed: no
approved wrp_...
```

The MCP tool list remains unchanged. Approval is not exposed to the model.

## Scene 10: Guarded Writeback

Command:

```bash
synapsor-runner apply latest \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./.synapsor/demo-video/local.db
```

Must show real checks:

```text
proposal approved: yes
primary key matched: yes
tenant guard matched: yes
allowed columns only: yes
conflict guard passed: yes
affected rows: 1
```

The source query must now show:

```text
CUS-3001 | 10000 | SLA outage ticket SUP-481
```

## Scene 11: Receipt And Replay

Commands:

```bash
synapsor-runner receipts list --proposal <proposal_id> \
  --store ./.synapsor/demo-video/local.db

synapsor-runner replay show --proposal <proposal_id> \
  --store ./.synapsor/demo-video/local.db
```

Must show:

```text
scoped read -> evidence -> proposal -> operator approval -> writeback -> receipt
status: applied
source DB changed after writeback: yes
```

An apply retry must return the existing applied state without a second source
mutation.

## Scene 12: Cloud Push

Use environment variables loaded off camera:

```bash
synapsor-runner cloud push \
  examples/support-plan-credit/synapsor.contract.json \
  --workspace "$SYNAPSOR_WORKSPACE_ID" \
  --name support-plan-credit \
  --json
```

Never display the token or credential setup. Show only the real response:

```text
contract id
version id / version number
server-computed digest
registry URL
```

## Scene 13: Cloud Registry And Bundle

Capture the authenticated Cloud Contract registry using a clean disposable
browser profile. Show:

```text
support-plan-credit
version and digest
2 semantic capabilities
1 proposal capability
trusted context
visible fields
kept-out fields
Download bundle
```

The downloaded ZIP must be fetched from the real version endpoint and verified
to contain placeholder environment names, not secrets.

## Scene 14: CTA

On screen:

```text
Try Synapsor Runner
github.com/Synapsor/Synapsor-Runner

Read the architecture
synapsor.ai/blog/stop-giving-agents-execute-sql

Synapsor Cloud design-partner beta
synapsor.ai/contact
```

Publication status for this goal: rendered locally for manual review, not
publicly uploaded.
