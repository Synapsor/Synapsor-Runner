# Why Synapsor Over Prompt And Application Guardrails

**Synapsor Runner is a database-authority layer for AI agents.** MCP defines how
a client calls tools, identity verifies who is calling, and database grants
constrain the credential. Runner adds the reviewed authority between them: what
data grammar or named effects the model may request, which trusted scope is
injected, and which decisions and execution paths remain outside the model.

You can build a safe database tool in application code. The important question
is not whether the code is custom or packaged. It is where authority lives and
which safety properties are enforced outside the model.

Synapsor Runner is useful when a narrow application function is no longer the
whole requirement. It adds a shared, reviewable contract and an operational
record around model-facing reads and writes: trusted context, evidence, query
audit, proposals, approval outside MCP, guarded writeback, idempotency
receipts, replay, and opt-in reviewed compensation.

It does not make prompts trustworthy, prevent prompt injection, replace
database permissions, or make an application compliant by itself.

## The Authority Path

```text
Explore -> Protect -> Propose -> outside-model decision -> Commit -> Receipt
```

- **Explore** compiles only the activated read grammar, injects trusted scope,
  and returns bounded, suppression-aware results. It is flexible without being
  raw SQL.
- **Protect** optionally freezes one useful analysis into a disabled,
  digest-bound named capability for separate review and activation.
- **Propose** records an exact business effect and evidence while leaving the
  source unchanged.
- **Decide** is a human or separately reviewed policy action outside the
  model-facing MCP surface.
- **Commit and receipt** belong to trusted execution. Runner-managed direct
  writes revalidate current authority and conflicts; app-owned executors own
  their final transaction and external effects.

Protect is optional. Reviewed production HTTP Explore can remain the read
surface for ad-hoc analytics, while named capabilities remain the narrowest
choice for stable production questions.

## Prompt Instructions Are Not A Security Boundary

A system prompt can improve normal model behavior. It cannot grant or remove
database authority. **Prompt-only enforcement is not a security boundary.** A
confused or prompt-injected model can ignore an instruction, so a rule such as
"only access this tenant" must be enforced by trusted code, database policy,
or both.

This is a general agent-security issue, not a hypothetical specific to one
vendor:

- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
  describes direct and indirect prompt injection and recommends constrained
  model behavior plus human approval for high-risk actions.
- [General Analysis published a controlled Supabase MCP
  demonstration](https://generalanalysis.com/blog/supabase-mcp-blog) in which
  untrusted support-ticket content influenced an agent with broad database
  access and exposed integration-token data. The demonstration disabled
  read-only mode and used a privileged `service_role`; it was a controlled
  security test, not evidence that every Supabase MCP deployment is
  vulnerable.
- [Supabase's defense-in-depth
  response](https://supabase.com/blog/defense-in-depth-mcp) likewise recommends
  a protective layer, least privilege, and avoiding direct production access.

The lesson is not that a prompt can never be useful. It is that prompt text
must not be the control that protects tenant scope, hidden fields, approval,
or commit authority.

## First Ask: Who Produces The SQL?

### The model produces SQL

If the model emits arbitrary SQL and application code decides whether to run
it, that validator must correctly understand the database grammar,
subqueries, functions, views, permissions, row scope, side effects, and future
schema changes. A blocklist or regular expression is not an authorization
system. This remains the `execute_sql` problem with an extra parser in front
of it.

Prefer fixed, parameterized statements selected by trusted application code,
restricted database roles, views, and row-level security. Do not make the
model the query planner for privileged production access.

### Your application produces SQL

If application code selects a fixed parameterized statement and exposes a
narrow function such as `billing.inspect_invoice`, you have already made the
most important architectural move: a semantic business tool replaces raw SQL.
For a small application, that may be enough.

The next question is whether you also need a consistent review and operations
layer. Without one, each function must separately implement and preserve:

- trusted tenant and principal binding;
- read and write field allowlists;
- evidence and query-audit records;
- exact proposed diffs before a write;
- approval identity and quorum outside the model;
- conflict, transition, numeric, row-count, and aggregate guards;
- idempotent execution and receipts;
- activity search and replay;
- bounded, separately approved compensation where reversibility is possible.

Synapsor centralizes those mechanics in a contract and runtime instead of
requiring every tool handler to invent them independently.

## What Runner Adds

| Concern | Prompt or one-off handler | Synapsor Runner |
| --- | --- | --- |
| Model-facing authority | Depends on instructions and handler design | Only reviewed semantic capabilities are served |
| Tenant/principal scope | Often passed as model arguments or scattered checks | Bound from trusted environment or authenticated session context |
| Data exposure | Handler-specific projection | Contract-reviewed visible fields and kept-out fields |
| Risky writes | Handler may write during the tool call | MCP creates a proposal; approval and apply stay outside MCP |
| Concurrency | Must be designed per handler | Version/conflict guards and frozen-set drift checks fail closed |
| Retry behavior | Must be designed per handler | Idempotency keys and source or Runner-ledger receipts |
| Investigation | Application logs | Evidence handles, query audit, proposal events, receipts, activity, and replay |
| Undo | Usually another bespoke endpoint | Opt-in reviewed compensation for supported direct writes |
| Review surface | Prompt, code, and policies may diverge | Portable canonical contract plus SQL-like DSL |

This is structural enforcement only for traffic that actually passes through
Runner and its reviewed capabilities. An unrestricted credential, a second raw
SQL MCP server, or a bypass path in the application remains outside the
boundary.

## Approve The Effect, Not Merely The Tool Call

A host can ask a person whether a tool invocation should run. That is not
always the same as showing the exact database effect or binding approval to the
current source state. If the tool writes during that invocation, proposal,
decision, and commit remain one operation.

Runner separates them. The model creates a proposal bound to the exact active
capability digest, trusted owner, target, before/after change, evidence, limits,
and idempotency identity. Approval refers to that proposal rather than to a
generic tool name. A later contract activation cannot reinterpret it.

The execution guarantee is intentionally executor-specific:

| Executor | Runner guarantee | Remaining boundary |
| --- | --- | --- |
| Direct SQL with source-database receipts | Final scope, freshness, conflict, bounds, and idempotency checks occur in the source transaction; mutation and receipt commit atomically | Database permissions, triggers, and administrator access remain outside Runner |
| Direct SQL with Runner-ledger receipts | Durable intent and guarded source execution; ambiguous post-commit crashes stop for reconciliation | No distributed exactly-once claim across ledger and source |
| App-owned HTTP or command handler | Runner validates the exact approved proposal before invoking the trusted handler | The application must enforce final scope, conflict, idempotency, transaction/rollback, external effects, and safe receipts |

The local SQLite or shared Postgres ledger is durable through Runner's
supported interfaces, but a trusted host or database administrator can alter
local state. Use Synapsor Cloud or your own tamper-evident retention and access
controls when organizational audit requirements demand a stronger shared
record.

## Build Or Adopt

Your own code is probably enough when all of these are true:

- the agent is read-only or has one or two fixed, low-risk functions;
- the application already derives tenant scope from authenticated server
  state;
- database roles, views, and row-level security provide the required floor;
- you do not need approval history, evidence, receipts, replay, or reviewed
  compensation;
- one team owns every tool and can test every change consistently.

Consider Runner when one or more of these are true:

- agents can propose writes to customer, billing, support, health, finance,
  or other consequential data;
- tenant or principal isolation must not depend on model-supplied arguments;
- a human or operator must approve some changes outside the agent loop;
- retries, stale writes, bounded sets, or partial failures need explicit
  fail-closed behavior;
- investigators need to answer what the agent read, requested, approved, and
  changed;
- capabilities are growing across teams, agents, databases, or MCP clients;
- the safety boundary needs to be reviewed in source control as one portable
  contract.

This is not a claim that the mechanics are impossible to build. It is a choice
between maintaining them independently in every integration and adopting a
tested contract/runtime that makes the same controls visible and repeatable.

## Regulated And High-Consequence Data

Health, finance, and other regulated workloads make the distinction more
important, but Runner does not confer HIPAA, PCI DSS, SOC 2, or any other
compliance status. A real deployment still needs the appropriate legal and
organizational controls, least-privilege roles, encryption, retention,
monitoring, incident response, vendor agreements, and human access policy.

Runner can contribute technical evidence for that program: tenant-bound
capabilities, explicit field projections, proposal/approval separation,
signed operator identity where configured, guarded writeback receipts, and
replay. Validate those controls with your security and compliance owners
before using production regulated data.

## Evaluate It Against Your Existing Layer

1. Run the static MCP risk review against your current tools:

   ```bash
   npx -y @synapsor/runner audit ./tools-list.json
   ```

2. List every rule currently enforced only by a prompt.
3. Identify whether the model or trusted code chooses SQL, tenant scope,
   columns, predicates, approval, and commit timing.
4. Pick one consequential staging workflow and compare its current evidence,
   retry, conflict, approval, receipt, and investigation behavior with the
   [own-database Runner flow](getting-started-own-database.md).

Keep your existing database permissions either way. Runner shapes the
agent-facing interface; it does not replace the database's own authorization
boundary.
