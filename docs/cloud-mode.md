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

The local runner still keeps database credentials in your environment. MCP
client config snippets should contain command paths and runner arguments, not
database URLs or write credentials.

Push and retrieve the portable contract without moving database credentials
into Cloud:

```bash
synapsor-runner cloud push ./synapsor.contract.json --dry-run
synapsor-runner cloud push ./synapsor.contract.json \
  --workspace "$SYNAPSOR_WORKSPACE_ID" \
  --name support-plan-credit
```

See [Cloud Push](cloud-push.md) and [Runner Bundles](runner-bundles.md).

Cloud registry storage preserves approval policies but does not, by itself,
mean hosted policy enforcement is enabled. Local Runner enforcement and hosted
Cloud approval enforcement are separate runtime boundaries.

Run the local smoke for this mode with:

```bash
corepack pnpm test:mcp-cloud-linked
```
