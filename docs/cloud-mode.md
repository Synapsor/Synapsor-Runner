# Cloud Mode

Synapsor Runner is local-first. It does not require Synapsor Cloud for the local
demo, own-database onboarding, MCP serving, proposal creation, local approval,
guarded writeback, or replay.

Cloud-linked mode is for teams that need a shared control plane:

- team approvals and RBAC;
- hosted evidence/replay search;
- runner registration and heartbeat;
- job leases;
- receipt reporting;
- retention and audit visibility.

The local runner still keeps database credentials in your environment. MCP
client config snippets should contain command paths and runner arguments, not
database URLs or write credentials.

Run the local smoke for this mode with:

```bash
corepack pnpm test:mcp-cloud-linked
```
