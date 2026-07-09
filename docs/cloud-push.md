# Push A Contract To Synapsor Cloud

Cloud push registers the same canonical contract that you validate and run
locally. Cloud stores a normalized immutable version, computes its digest,
records the actor, and makes the safety boundary visible in the workspace
registry.

## Preview Without A Network Call

```bash
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json --dry-run --json
```

Dry-run validates and normalizes locally. It performs no network request.

## Push

```bash
export SYNAPSOR_CLOUD_BASE_URL="https://api.synapsor.ai"
export SYNAPSOR_CLOUD_TOKEN="<workspace-scoped-token>"
export SYNAPSOR_WORKSPACE_ID="<workspace-id>"

synapsor-runner cloud push ./synapsor.contract.json \
  --name support-plan-credit
```

The response includes the contract id, immutable version id, server-computed
digest, summary counts, status, and registry path. Identical normalized content
is idempotent; changed content creates the next version.

Tokens are sent in the authorization header and are never part of the contract.
Database URLs, passwords, private keys, and model-controlled tenant bindings
are rejected by server-side validation.

## Cloud To Local

Open **Contract registry** in the workspace, choose a version, and download its
runner bundle. The ZIP contains the normalized contract, local runner wiring,
placeholder environment file, README, and MCP client examples. It contains no
live credentials or table rows.

Cloud currently preserves approval policy definitions in the contract and
bundle. Hosted approval-policy enforcement remains a separate Cloud feature;
do not infer it from registry storage alone.
