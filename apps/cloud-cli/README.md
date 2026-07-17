# `@synapsor/cli`

The Synapsor Cloud CLI manages the shared control plane: projects, canonical
contract versions, scoped API keys, Runner connections, proposal decisions,
activity, metadata-only evidence references, receipts, replay references, and
audit exports.

It is deliberately separate from `@synapsor/runner`:

- `synapsor-runner` is the open-source MCP and database safety boundary. It
  reads customer databases, creates local proposals/evidence, and performs
  guarded writeback.
- `synapsor` is the Cloud administration, human review, and audit client. It
  never opens a Runner SQLite file and does not receive database credentials.

## Install

```bash
npm install --global @synapsor/cli
synapsor --help
```

For an isolated one-off invocation:

```bash
npx -y -p @synapsor/cli synapsor --help
```

## Human Login

```bash
synapsor auth login --open
synapsor auth whoami
synapsor workspaces list
synapsor projects list
synapsor projects use <project-id>
synapsor entitlements show
```

Login uses a short-lived browser/device flow. The CLI uses the operating-system
keychain when `secret-tool` is available and otherwise uses a mode-`0600`
fallback file. Profiles store only non-secret endpoint and selection metadata.

## CI With A Scoped API Key

Create a least-privilege key from an authorized human profile and write its
one-time value to a protected file:

```bash
synapsor api-keys create \
  --project <project-id> \
  --name contract-ci \
  --scopes project:read,contracts:read,contracts:write \
  --expires-at 2026-12-31 \
  --secret-file ./.synapsor/contract-ci.key

export SYNAPSOR_API_KEY="$(cat ./.synapsor/contract-ci.key)"
synapsor contracts push ./synapsor.contract.json --project <project-id>
```

The CLI does not accept Cloud secrets as command-line values. It can resolve a
service key from `SYNAPSOR_API_KEY`, a named environment variable, or an
explicit mode-`0600` file reference:

```bash
synapsor auth configure-service \
  --profile ci \
  --api-url https://dev-api.synapsor.ai \
  --project <project-id> \
  --credential-env SYNAPSOR_API_KEY
```

Service API keys cannot record human proposal decisions unless Cloud explicitly
grants that authority. Runner tokens are a separate machine credential and are
rejected by Cloud administration routes.

## Contract And Runner Flow

```bash
synapsor contracts validate ./synapsor.contract.json
synapsor contracts diff ./before.json ./synapsor.contract.json
synapsor contracts push ./synapsor.contract.json --dry-run --project <project-id>
synapsor contracts push ./synapsor.contract.json --project <project-id>
synapsor contracts list --project <project-id>

synapsor runners create \
  --project <project-id> \
  --sources <source-id> \
  --secret-file ./.synapsor/runner.token
```

Omitting `--permissions` requests Cloud's bounded Runner-protocol permission
set. Supply `--permissions <csv>` to narrow the machine token further.

`synapsor-runner cloud push` remains supported for Runner-centric workflows and
uses the same canonical digest, API, idempotency, and scoped service credential
as `synapsor contracts push`.

## Human Review

```bash
synapsor proposals list --project <project-id>
synapsor proposals show <proposal-id> --project <project-id>
synapsor proposals approve <proposal-id> --project <project-id> --yes
```

Approval changes Cloud governance state only. A trusted Runner still needs an
authorized lease and must enforce the reviewed tenant/principal scope, contract
digest, version/conflict guards, bounds, and receipt policy before changing the
source database.

## Output And Automation

Use `--json` for stable machine-readable output, `--no-interactive` in CI,
`--limit`/`--cursor` for one page, and bounded `--all` pagination when needed.
Errors include a stable `error_code`, retryability, retry timing when available,
and a request ID when Cloud provides one. Diagnostics go to stderr; requested
data goes to stdout.

Full command and security reference:
[docs/cloud-cli.md](https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/cloud-cli.md).
