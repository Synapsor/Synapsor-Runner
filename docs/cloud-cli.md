# Synapsor Cloud CLI

Use `synapsor-runner` for the local MCP/database boundary. Use `synapsor` from
`@synapsor/cli` for Cloud administration, shared review, and audit. Linking a
Runner to Cloud is optional; local-only Runner mode requires no account.

## Credential Boundaries

| Credential | Used by | Purpose |
|---|---|---|
| Human session | `synapsor`, web UI | Administration and human decisions, subject to role, policy, recent auth, and entitlement |
| Service API key | `synapsor` or `synapsor-runner cloud push` in CI | Explicit project scopes such as contract push or activity export |
| Runner token | `synapsor-runner` Cloud protocol | Register, heartbeat, proposal/activity sync, leases, and terminal results |
| Local MCP HTTP token | MCP client to local Runner | Local transport authentication only |

Authentication, project role/scope authorization, and paid feature entitlement
are independent checks. A valid key can remain authenticated after a billing
change while paid operations return `payment_required` or
`feature_not_entitled`. Neither API keys nor Runner tokens bypass plan state.

Never put a Cloud secret, database URL, or local MCP token on a CLI argument.
Use a masked environment variable or a mode-`0600` secret file.

## Command Index

```text
auth          login, logout, whoami, profiles, use, configure-service
status        selected profile, API, project, service health
entitlements  effective hosted features, limits, and blocked reason
billing       plan/payment lifecycle summary
workspaces    list, use
projects      list, show, use
sources       list, show (safe metadata only)
contracts     init, validate, format, inspect, diff, push, list, show,
              history, pull, activate, rollback
contexts      list, show, create, update, remove
capabilities  list, show, create, update, remove, preview
workflows     list, show, create, update, remove, validate
api-keys      list, show, create, rotate, revoke
runners       list, show, create, rotate-token, revoke-token,
              bundle download, doctor
proposals     list, show, decisions, approve, reject
activity      search, show
evidence      show
receipts      show
replay        show, verify
exports       create, status, download
```

Run `synapsor --help` for the compact index. All local context/capability/
workflow edits validate the complete canonical contract and use atomic file
replacement with a backup. Complex definitions can be supplied with
`--from-file`; the CLI does not invent unsafe defaults for proposal writeback.

`synapsor <group> --help` lists that group's real commands, and
`synapsor <group> <command> --help` shows the checked command syntax. The help
tree and this index are covered together by the CLI test suite.

## Human Login And Project Selection

```bash
npm install --global @synapsor/cli

synapsor auth login --open
synapsor auth whoami
synapsor workspaces list
synapsor projects list
synapsor projects use <project-id>
synapsor status
synapsor entitlements show
```

`status` reports authentication, selected project, service health, plan,
billing lifecycle, effective entitlement, grace deadline, and blocked reason.
Authentication, project role or service-key scope authorization, and paid
feature entitlement are separate checks. A valid credential does not bypass
`payment_required`, `feature_not_entitled`, or `project_inactive`.

## Author A Canonical Contract

Contexts, capabilities, and workflows are reviewed parts of one immutable
canonical contract, not mutable Cloud permission rows. Local edits are atomic,
fully validated, and followed by a semantic safety diff.

```bash
synapsor contracts init ./synapsor.contract.json --name support-contract

synapsor contexts create trusted_operator \
  --contract ./synapsor.contract.json \
  --from-file ./context.json

synapsor capabilities create billing.inspect_invoice \
  --contract ./synapsor.contract.json \
  --from-file ./capability.json

synapsor workflows create billing.invoice_review \
  --contract ./synapsor.contract.json \
  --from-file ./workflow.json

synapsor contracts validate ./synapsor.contract.json
synapsor contracts diff ./before.json ./synapsor.contract.json
synapsor contracts push ./synapsor.contract.json --dry-run
synapsor contracts push ./synapsor.contract.json
```

Push creates or reuses an immutable version. It does not silently rewrite an
existing version. Activation and rollback are separate authorized mutations:

```bash
synapsor contracts history <contract-id>
synapsor contracts activate <contract-id>/<version-id> --yes
synapsor contracts rollback <contract-id>/<older-version-id> --yes
```

The Runner-centric equivalent remains supported:

```bash
synapsor-runner cloud push ./synapsor.contract.json
```

It uses the same canonical validation, digest, endpoint, idempotency, and error
semantics as `synapsor contracts push`.

## Create And Use A CI API Key

Only an authorized human can create, rotate, or revoke keys. The secret is
returned once and must be written to a protected file; it is never printed by
normal or JSON output.

```bash
synapsor api-keys create \
  --name contract-ci \
  --scopes project:read,contracts:read,contracts:write \
  --expires-at 2026-12-31 \
  --secret-file ./.synapsor/contract-ci.key

export SYNAPSOR_API_KEY="$(cat ./.synapsor/contract-ci.key)"
synapsor auth configure-service \
  --profile ci \
  --api-url https://dev-api.synapsor.ai \
  --project <project-id> \
  --credential-env SYNAPSOR_API_KEY

synapsor auth whoami --profile ci --json
synapsor contracts push ./synapsor.contract.json --profile ci
```

`whoami` reports a service identity, key prefix/ID, scopes, project,
expiration, and entitlement summary. It never turns the key into a human
identity. Rotate and revoke through a human profile:

```bash
synapsor api-keys rotate <key-id> --secret-file ./.synapsor/contract-ci.next.key
synapsor api-keys revoke <key-id> --yes
```

After revocation, requests using the old value fail; they do not fall back to a
local profile or another credential.

## Connect A Customer-Operated Runner

Runner tokens are separate, source-scoped machine credentials. Create one and
store its one-time value without printing it:

```bash
synapsor runners create \
  --name support-runner \
  --sources <cloud-source-id> \
  --secret-file ./.synapsor/runner.token

export SYNAPSOR_RUNNER_TOKEN="$(cat ./.synapsor/runner.token)"
```

The credential-free Runner bundle contains the reviewed connection metadata
and sample configuration. Supply the Runner token separately:

```bash
synapsor runners bundle download <contract-id>/<version-id> \
  --source <cloud-source-id> \
  --out ./synapsor-runner-bundle.zip
synapsor runners doctor <runner-id>
```

Runner tokens authenticate only registration, heartbeat, proposal/activity
sync, leases, and terminal results. They are rejected by Cloud administration
and human-decision routes. Source database URLs and write credentials stay in
the Runner process environment and never enter the bundle, contract, Cloud
CLI, or Cloud registry.

## Review And Audit

```bash
synapsor proposals list --status pending
synapsor proposals show <proposal-id>
synapsor proposals approve <proposal-id> --reason "Reviewed evidence" --yes

synapsor evidence show <proposal-id>
synapsor receipts show <proposal-id>
synapsor replay verify <proposal-id>
synapsor activity search --lookup <business-id> --json
```

Proposal approval records Cloud governance state; it never changes the source
database directly. A trusted Runner must receive an authorized lease and
recheck the local proposal, exact contract digest, tenant and principal locks,
allowlists, bounds, conflict/version guard, idempotency, and affected-row rule.
Service API keys and Runner tokens cannot record human approval.

## Cloud-Linked Runner Authority

`governance.mode: cloud_linked` is explicit. Cloud is authoritative for active
contract versions, human decisions, job leasing, and terminal governance state.
The local/shared Runner store remains a durable operational spool and local
evidence/replay ledger; Cloud and the CLI never open or upload its SQLite file.

The initial evidence policy is `metadata_only`. Cloud receives bounded proposal
diffs, safe identities/fingerprints, IDs, counts, and integrity hashes. Source
rows, evidence payloads, SQL text/parameters, kept-out fields, credentials, and
local replay payloads remain local.

By default a Cloud-linked Runner durably queues proposals during a transient
Cloud outage. Set `governance.queue_when_unavailable: false` to fail before the
source read/proposal is created when authenticated Cloud readiness is not
available. In both modes, no Cloud approval or writeback proceeds offline.

Inspect and repair the local operational outbox with Runner, not the Cloud CLI:

```bash
synapsor-runner doctor --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner cloud outbox status --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner cloud outbox inspect latest --config ./synapsor.runner.json --store ./.synapsor/local.db
synapsor-runner cloud outbox reconcile --yes --config ./synapsor.runner.json --store ./.synapsor/local.db
```

Dead-letter or hash-divergence state requires operator inspection. Runner never
silently chooses a local copy over Cloud or creates a fake local human approval.

## Pagination And JSON

List/search commands accept `--limit`, `--cursor`, and bounded `--all`.
`--max-items` can lower the aggregate bound; raising it beyond the safe default
requires `--allow-large-result`. Use `--json` for scripts. Unknown or transient
failures are not retried as mutations; shared client retries are limited to
classified safe requests and honor server retry timing.
