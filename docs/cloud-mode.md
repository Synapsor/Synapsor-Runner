# Cloud Mode

Synapsor Runner is local-first. It does not require Synapsor Cloud for the local
demo, own-database onboarding, MCP serving, proposal creation, local approval,
guarded writeback, or replay.

Cloud-linked mode is for teams that need a shared control plane:

- versioned canonical contract registry and server-computed digests;
- Cloud-to-local runner bundle downloads;
- team approvals and RBAC;
- hosted evidence/replay search;
- runner registration and heartbeat;
- job leases;
- receipt reporting;
- retention and audit visibility.

The local Runner still keeps database credentials in your environment. MCP
client config snippets contain command paths and Runner arguments, not database
URLs or write credentials.

Keep Cloud and MCP credentials distinct:

| Credential | Purpose | Issuer/provisioner | Never substitutes for |
| --- | --- | --- | --- |
| Cloud user session | Human control-panel/CLI identity and subscription/RBAC checks | Synapsor Cloud identity system | MCP tenant identity or database access |
| Cloud service/API key | Contract push and scoped Cloud administration | Synapsor Cloud | MCP endpoint access |
| Source-scoped Runner token | Runner registration, heartbeat, lease, activity, and result calls for one Cloud source | Synapsor Cloud Connect Runner flow | Model-facing MCP access or operator approval |
| Opaque MCP endpoint token | Loopback or explicitly single-tenant HTTP endpoint access | Customer operator/secret manager | User/tenant identity |
| Signed MCP access JWT | Shared HTTP client identity and verified tenant/principal claims | Customer identity provider/authorization server | Cloud subscription credential or DB role |
| Operator credential | Activation, approval, apply, reconcile, dead-letter, and revert authority | Customer operator identity system | Model-facing MCP capability |
| Database/handler credential | Local read or trusted post-approval effect | Customer secret manager/database/application | Cloud or MCP authentication |

Cloud-linked mode does not require networked MCP: a desktop client can still
launch the local Runner over stdio. If the local Runner exposes Streamable HTTP,
the same [HTTP MCP](http-mcp.md) channel and identity profiles apply. Cloud API
keys and source-scoped Runner tokens are never accepted as shortcuts for MCP
session authentication.

## Trust Boundary

```text
agent / MCP client
  -> local Runner semantic tools
  -> local scoped read + evidence
  -> local proposal (source unchanged)
  -> reviewed diff + safe references synced to Cloud
  -> signed-in human approves or rejects in Cloud
  -> source-scoped leased job
  -> local trusted worker rechecks contract + proposal + DB guards
  -> local database write
  -> redacted receipt/activity linkage returned to Cloud
```

Cloud receives the contract/version/digest, capability, trusted scope
identifiers, reviewable allowlisted diff, safe evidence/query references,
decision identity, lease state, and receipt/replay links. Database URLs,
passwords, handler tokens, private keys, full source rows, and kept-out evidence
payloads stay local.

Maintainers must run the opt-in
[hosted Cloud-linked verification](./hosted-cloud-linked-verification.md) with a
packed Runner, disposable Cloud project, and synthetic source before claiming a
release is Cloud-linked end to end.

Push and retrieve the portable contract without moving database credentials
into Cloud:

```bash
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json \
  --workspace "$SYNAPSOR_WORKSPACE_ID" \
  --name support-plan-credit
```

Use the current design-partner API base:

```bash
export SYNAPSOR_CLOUD_BASE_URL="https://dev-api.synapsor.ai"
```

Then create a source-scoped Runner token in **Contract registry -> Connect
Runner**, download the selected version's bundle, and run:

```bash
cd ./<downloaded-runner-bundle>
cp .env.example .env
# Fill the placeholders in .env, including the one-time Runner token.
set -a && . ./.env && set +a

npx -y -p @synapsor/runner synapsor-runner config validate --config ./synapsor.runner.json
npx -y -p @synapsor/runner synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db
npx -y -p @synapsor/runner synapsor-runner cloud connect --config ./synapsor.cloud.json
npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Run the trusted worker in a second operator-controlled terminal:

```bash
set -a && . ./.env && set +a
npx -y -p @synapsor/runner synapsor-runner runner start --config ./synapsor.runner.json --store ./.synapsor/local.db
```

For deployment checks or an operator-controlled single claim cycle, use the
same installed worker with `--once`; it exits after applying at most one
Cloud-approved job and still rechecks the local contract, proposal, tenant,
version, bounds, and idempotency guards:

```bash
npx -y -p @synapsor/runner synapsor-runner runner start --once --config ./synapsor.runner.json --store ./.synapsor/local.db
```

When a local proposal exists:

```bash
npx -y -p @synapsor/runner synapsor-runner cloud sync latest --config ./synapsor.cloud.json --store ./.synapsor/local.db
```

See [Cloud Push](cloud-push.md) and [Runner Bundles](runner-bundles.md).

Cloud approval changes proposal state and creates a claimable job; it does not
touch the source database directly. If a lease expires, another compatible
Runner may claim the job, but source and ledger idempotency prevent a duplicate
effect. Stale row/set guards return a conflict. If the system cannot prove
whether a source write committed, it records an indeterminate/reconciliation
state instead of retrying blindly.

Runner tokens are scoped to one project, explicit source IDs, and named
operations. Rotate or revoke them from Connect Runner. Revocation blocks new
registration, heartbeat, proposal, claim, lease, activity, and result calls.

This is a single-node design-partner boundary, not managed Runner hosting,
multi-region HA, SAML/SCIM, legal hold/WORM retention, or an enterprise SLA.
Run the explicit hosted integration gate with synthetic staging data before
depending on a deployment; registry push alone is not proof that registration,
approval, leasing, and receipt synchronization are live.

Run the local smoke for this mode with:

```bash
corepack pnpm test:mcp-cloud-linked
```
