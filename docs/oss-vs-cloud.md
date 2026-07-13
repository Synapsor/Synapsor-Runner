# OSS Runner Vs Synapsor Cloud

Synapsor Runner and Synapsor Cloud share the canonical `@synapsor/spec`
contract, but they solve different operational problems.

Runner is the open-source runtime that stays next to your application and
database. It serves reviewed MCP tools, binds trusted context, stores local
evidence and proposals, keeps approval outside MCP, applies or routes approved
writeback, and records receipts and replay in the default local SQLite ledger
or an opt-in shared Postgres runtime store.

Cloud is the team control plane. It stores versioned contracts, produces
downloadable Runner bundles, and provides shared activity, evidence, approval,
and investigation surfaces for enabled design-partner deployments.

| Need | OSS Runner | Synapsor Cloud |
| --- | --- | --- |
| MCP runtime | Local stdio or Streamable HTTP server | Contracts export to local Runner bundles; managed runner fleet is future work |
| Contract source | Local files reviewed in Git | Shared registry with immutable versions and digests |
| Trusted context | Local environment/session bindings | Registered bindings plus deployment-specific Cloud session context |
| Capabilities | Local semantic MCP tools | Registry, version history, and capability inspection |
| Evidence and replay | Local SQLite ledger by default; optional shared Postgres runtime store | Shared activity and evidence surfaces where enabled |
| Approval | Local CLI or localhost UI | Team approval surfaces where enabled |
| Writeback | Guarded one-row update or app-owned executor | Cloud-linked jobs with local execution; managed production orchestration is future work |
| MCP risk audit | Static local audit | Organization-wide continuous audit is future work |
| Identity | Local operator boundary | Workspace RBAC where configured; SAML and SCIM are future work |
| Operations | Customer-operated single node or bounded small fleet | Managed fleet remains Cloud work; no enterprise SLA in the current beta |

## What Stays Local

- database read and write credentials;
- trusted application handler credentials;
- direct access to Postgres or MySQL;
- the process that executes guarded writeback;
- local development ledgers when Cloud linkage is not enabled.

Cloud contract registration does not require uploading database credentials or
business rows. A Runner bundle contains the normalized contract, placeholder
environment-variable wiring, and MCP client templates.

## Adoption Path

1. Run the OSS audit and quick demo without an account.
2. Connect Runner to a staging database and review the model-facing tools.
3. Keep contracts in Git and exercise proposal, approval, writeback, and replay.
4. Push the validated contract when the team needs a shared registry and review
   surface.

See [Cloud Push](cloud-push.md), [Runner Bundles](runner-bundles.md), and
[Cloud Mode](cloud-mode.md) for commands and deployment details. See
[Current Limitations](limitations.md) for the runtime boundary.
