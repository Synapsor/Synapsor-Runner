# Owner-Controlled Agent Rules

Owner delegation is optional. A normal database integration still starts with
`runner start --from-env DATABASE_URL --cli`; it does not require this setup,
a separate control database, or a new identity provider.

Use delegation when authorized customers or account administrators should be
able to customize what their agents may do. The application operator reviews
the supported operations and hard safeguards. Owners can edit only the
explicitly delegated part. Their agents cannot activate their own policies.

## Local Operator Setup

The local prototype uses the project's configured SQLite control store or
PostgreSQL `runtime_store`, not an audit mirror. Existing file-backed projects
need one explicit migration:

```bash
runner policy storage --config ./synapsor.runner.json --project-root .
```

Runner previews the existing active and disabled authority, destination and
exact configuration before asking for confirmation. It preserves reviewed
Read/Action digests, selected boundaries, disabled drafts and execution
settings. Changed artifacts invalidate the preview. An interrupted committed
migration resumes from its frozen receipt. After cutover, files are exports
and recovery inputs, not a second writable source of active authority.

Parent delegation is a separate operator decision:

```bash
runner policy delegation --config ./synapsor.runner.json \
  --name customer_agent_rules --input ./owner-delegation.json
```

The document uses `synapsor.policy-management-parent.v1`. Its sections are:

| Section | Operator Decision |
| --- | --- |
| `managers` | Authenticated subjects, personal/shared scopes, inspect/draft/activate/revoke rights |
| `delegation` | Agent names, existing compiled outcomes, verified fact vocabulary, operators and hard limits |
| `agent_owners` | Which owner or shared account may manage each agent |
| `runtime_delegations` | Acting agent, delegator, owner and mandatory policy layers for each workload |

The exact document is available in the review; inspect it before enabling
delegation. Runner checks vocabulary against the current compiled Action
rules, not column-name guesses. Unknown facts, unsupported effects and stale
Action digests are rejected. Replacing the parent requires affected child
policies to be revalidated. Spent and reserved allowance is not reset.

This command is a trusted local deployment-operator surface. Someone who can
replace the Runner process or modify its control store is outside Runner's
service-level enforcement boundary. Do not give untrusted tenants filesystem
access to this process or distribute the SQLite file to owners.

## Configure Owner Chat

Configure `action_rules.owner_management` in the existing Runner config:

```json
{
  "action_rules": {
    "project_root": ".",
    "owner_management": {
      "parent_name": "customer_agent_rules",
      "policy_name": "my_agent_rules",
      "scope": "personal",
      "credential_env": "OWNER_ASSISTANT_TOKEN",
      "authentication": {
        "provider": "jwt_asymmetric",
        "issuer": "https://identity.example",
        "audience": "runner-owner-assistant",
        "public_key_env": "OWNER_IDENTITY_PUBLIC_KEY"
      },
      "human_review": {
        "credential_env": "OWNER_HUMAN_REVIEW_TOKEN",
        "audience": "runner-owner-human-review"
      }
    }
  }
}
```

Merge the block with existing settings; do not replace unrelated source,
execution or Read configuration. `scope: "tenant"` selects a shared-account
policy only when the current authenticated grant permits it. A config entry
alone grants no management rights.

The trusted backend issues short-lived signed credentials with subject,
tenant, principal, actor kind, session and policy channel. Human review and
assistant access use separate audiences and credentials; never give the
human-review token or signing key to the model. Runtime agents use the
separate `action_rules.owner_delegation` workload credential and reviewed
agent/delegator association. Caller-supplied tenant/principal text is not
authentication.

Start local Ask or the existing stdio MCP integration. Owner management is
currently a local Ask/stdio prototype. HTTP serving explicitly refuses this
configuration rather than silently exposing a different authority surface.

## Edit From The Same Client

The tool names stay fixed:

| Tool | Authorized Settings Operation |
| --- | --- |
| `app.describe_data` | Discover the selected owner's settings and delegable vocabulary |
| `app.explore_data` | Read current settings and issue a scoped policy reference |
| `app.describe_actions` | Describe the permitted policy-revision request |
| `app.request_change` | Validate and save a disabled revision |

Settings requests use `policy_view: "agent_rules"`. They are explicitly
separate from source-row reads and changes. A settings-only session does not
claim Read authority is active. Discovery is scoped and paginated; inaccessible
owners are not a searchable source catalog.

Ask, for example: "For my replenishment agent, require my review above 20
units and allow only routine requests." The assistant receives only the
authorized policy and verified vocabulary. Runner validates typed conditions,
parent bounds and affected agents, then returns a disabled draft and a review
continuation. Unsupported requirements remain unresolved, not approximated.

In local Ask, `/review-rules` opens the deterministic before/after review.
Inspect full details or leave the draft disabled. Activation requires the
separate human-review credential and an explicit decision bound to the exact
revision. A plain model message saying "yes" cannot activate it. Generic MCP
clients can propose the same edit and reach this trusted continuation; their
ordinary tool-execution confirmation is not owner-policy authorization.

## Enforcement And Receipts

Each request and queued execution rechecks current parent and required owner
policies. Revocation blocks new dispatch; it cannot recall an already
committed external effect. Missing or stale policy layers fail closed.

Hard shared allowances measure their declared successful effects plus
outstanding reservations, not merely approvals. Two agents cannot allocate
the same allowance. A new revision, agent or session does not reset it.
Unknown outcomes keep capacity reserved until reconciled against a receipt.
Human approval cannot override an independent hard cap.

The supported local execution path is guarded same-database writeback with
current scope, freshness, version and exact-effect checks. Approval is not
execution. Only a successful durable source receipt establishes completion;
this feature is not an external payments service or a cross-system transaction.

Read/Action/execution authority, owner management, authenticated workload
binding and worker readiness are separate prerequisites. Enabling owner
management alone does not grant source reads, approve operational requests,
start a worker, or execute a source change.
