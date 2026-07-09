# Support Plan Credit Example

This example shows three enforcement tiers on one support action:

- `$25` (`2500` cents): policy-approved, then applied locally through guarded writeback.
- `$100` (`10000` cents): saved as `pending_review` until a local operator approves.
- `$1000` (`100000` cents): rejected before proposal creation by the contract bound.

## Prerequisites

- Docker
- Node 22.5+
- Port `55438` available

Install the stable CLI once for the commands below:

```bash
npm install --global @synapsor/runner
synapsor-runner --version
```

When working from this source checkout, use `corepack pnpm runner` in place of
`synapsor-runner`.

## No-Database Check

Validate the authored boundary before starting Docker:

```bash
synapsor-runner dsl compile examples/support-plan-credit/contract.synapsor \
  --out /tmp/support-plan-credit.contract.json \
  --strict
synapsor-runner contract validate /tmp/support-plan-credit.contract.json
synapsor-runner config validate \
  --config examples/support-plan-credit/synapsor.runner.json
synapsor-runner cloud push /tmp/support-plan-credit.contract.json \
  --dry-run \
  --workspace local-preview \
  --name support-plan-credit
```

This compiles, validates, and previews the Cloud payload without opening a
network connection or connecting to a database. From a source checkout,
`corepack pnpm verify:adoption` runs this boundary check plus the no-database
quick demo and MCP config validation.

## Quick Start

```bash
docker compose -f examples/support-plan-credit/docker-compose.yml up -d

set -a
. examples/support-plan-credit/.env.example
set +a

synapsor-runner tools preview \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db

# Run this in a second terminal if you want to attach an MCP client.
synapsor-runner mcp serve \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
```

The checked-in `.env.example` contains disposable localhost Docker credentials
only. Never reuse them for staging or production.

## Walkthrough

Inspect the customer first:

```bash
synapsor-runner smoke call support.inspect_customer \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db \
  --json '{"customer_id":"CUS-3001"}'
```

Propose a `$25` credit:

```bash
synapsor-runner propose support.propose_plan_credit \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db \
  --json '{"customer_id":"CUS-3001","credit_cents":2500,"reason":"SLA outage ticket SUP-481"}'
```

`proposals show` displays `policy:support_propose_plan_credit_auto_approval`.
The proposal is approved, but it is not applied until the local writeback step:

```bash
synapsor-runner proposals show latest --store ./tmp/support-plan-credit/local.db
synapsor-runner apply latest \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
synapsor-runner receipts list --proposal <proposal_id> --store ./tmp/support-plan-credit/local.db
```

Propose a `$100` credit:

```bash
synapsor-runner propose support.propose_plan_credit \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db \
  --json '{"customer_id":"CUS-3001","credit_cents":10000,"reason":"larger support credit"}'

synapsor-runner proposals approve latest --yes --store ./tmp/support-plan-credit/local.db
synapsor-runner apply latest \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
```

Propose a `$1000` credit:

```bash
synapsor-runner propose support.propose_plan_credit \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db \
  --json '{"customer_id":"CUS-3001","credit_cents":100000,"reason":"too large"}'
```

The contract bound rejects it before a proposal row exists.

Replay and stale-row checks:

```bash
synapsor-runner replay export --proposal latest --store ./tmp/support-plan-credit/local.db --output ./tmp/support-plan-credit/replay.json
synapsor-runner apply latest --config examples/support-plan-credit/synapsor.runner.json --store ./tmp/support-plan-credit/local.db
```

The live smoke test mutates `updated_at` before apply and proves stale proposals
return `VERSION_CONFLICT` without changing the source row.

Run the complete Docker-backed scenario, including all three policy tiers and
the stale-row conflict:

```bash
corepack pnpm test:live-apply
```

## What The Agent Never Sees

The contract keeps these fields out:

- `card_token`
- `raw_payment_method`
- `internal_risk_score`
- `private_notes`

`tools preview` should show only:

```text
support.inspect_customer
support.propose_plan_credit
auto-approval: enabled
```

No raw SQL, approval tools, commit tools, write credentials, or model-controlled
tenant authority are exposed to MCP.

Representative outputs are checked in under [`expected-output/`](expected-output/)
so you can compare the tool boundary, proposal, receipt, replay, and Cloud push
shape without guessing which state should change.

## Connect An MCP Client

Copy the matching template from [`mcp-client-examples/`](mcp-client-examples/):

- Claude Desktop: `claude-desktop.json`
- Cursor project/global: `cursor-project.mcp.json`, `cursor-global.mcp.json`
- OpenAI Agents SDK: stdio and Streamable HTTP TypeScript examples
- generic MCP: stdio and Streamable HTTP JSON examples

For Streamable HTTP, run:

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --alias-mode openai \
  --host 127.0.0.1 \
  --port 8766 \
  --config examples/support-plan-credit/synapsor.runner.json \
  --store ./tmp/support-plan-credit/local.db
```

The OpenAI client receives `support__inspect_customer` and
`support__propose_plan_credit`; Runner preserves the dotted canonical names in
tool metadata and results. For Claude, Cursor, or generic MCP clients, omit
`--alias-mode openai` to expose `support.inspect_customer` and
`support.propose_plan_credit`. Approval and apply remain outside MCP.

## How The Policy Is Governed

The auto-approval policy lives in `contract.synapsor`:

```sql
AUTO APPROVE WHEN plan_credit_cents <= 2500
```

That compiles into `synapsor.contract.json` as a reviewed approval policy. It is
stored in git, validated by `@synapsor/spec`, and included in Cloud push payloads.

To disable local policy approval without changing the contract:

```json
{
  "approvals": {
    "disable_auto_approval": true
  }
}
```

Auto-approval never applies the write. It only records an approval row and audit
event with actor `policy:<policy_name>`.

## Cloud

Dry-run the Cloud payload:

```bash
synapsor-runner cloud push examples/support-plan-credit/synapsor.contract.json --dry-run
```

Real push uses your Cloud env vars:

```bash
export SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai"
export SYNAPSOR_CLOUD_TOKEN="<workspace-scoped-token>"
export SYNAPSOR_WORKSPACE_ID="<workspace_id>"

synapsor-runner cloud push examples/support-plan-credit/synapsor.contract.json \
  --name support-plan-credit
```

After push, Cloud can return the registered version and a runner bundle with
placeholder env names:

```bash
curl -H "Authorization: Bearer $SYNAPSOR_CLOUD_TOKEN" \
  "$SYNAPSOR_CLOUD_BASE_URL/v1/control/projects/$SYNAPSOR_WORKSPACE_ID/agent-contracts/<contract_id>/versions/<version_id>"

curl -H "Authorization: Bearer $SYNAPSOR_CLOUD_TOKEN" \
  "$SYNAPSOR_CLOUD_BASE_URL/v1/control/projects/$SYNAPSOR_WORKSPACE_ID/agent-contracts/<contract_id>/versions/<version_id>/runner-bundle?download=1" \
  -o support-plan-credit-runner-bundle.zip
```

The push response supplies `<contract_id>` and `<version_id>`. The Cloud
workspace also exposes the same download from **Contract registry**.

No Cloud account is needed to run this local example.

## Clean Up

```bash
docker compose -f examples/support-plan-credit/docker-compose.yml down -v
rm -rf ./tmp/support-plan-credit
```

## Troubleshooting

- `synapsor-runner: command not found`: install `@synapsor/runner` globally or
  use `corepack pnpm runner` from this repository.
- port `55438` is busy: stop the previous example container or change the
  published port and both URLs in `.env.example` together.
- missing table/connection: wait for the Docker health check, then rerun the
  command from the repository root with the `.env.example` values exported.
- OpenAI rejects dotted tool names: start the MCP server with
  `--alias-mode openai` and use the OpenAI template.
- proposal stays pending: `$100` intentionally requires
  `proposals approve`; only the `$25` tier is policy-approved.
- apply reports a conflict: the row changed after the proposal read. Inspect
  the new row, create a fresh proposal, and do not bypass the version guard.
