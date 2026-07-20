# Inline Proposal Review With MCP Apps

Synapsor Runner proposal tools advertise a display-only MCP App. A compatible
host can render the proposed business effect inline after the tool call. Hosts
without MCP Apps support continue to receive the same JSON and text result.

The app is a presentation surface, not an approval boundary:

- it shows the requested action, semantic capability, trusted tenant/principal
  provenance, evidence summary, kept-out-field status, exact diff, expected
  source version, policy state, receipt state, and reversibility state;
- it contains no database URL, write credential, approval token, review
  challenge, or reusable operator authority;
- it cannot call approve, apply, commit, or raw SQL tools because Runner does
  not expose those tools through MCP;
- approval and apply remain explicit operator actions in the standalone local
  UI or terminal.

## Protocol And SDK Baseline

The implementation is pinned to:

| Component | Version |
| --- | --- |
| MCP Apps specification | `2026-01-26` stable |
| `@modelcontextprotocol/ext-apps` | `1.7.4` |
| `@modelcontextprotocol/sdk` | `1.29.0` |

Proposal tools declare the standard `ui://synapsor/proposal-review.html`
resource through `_meta.ui.resourceUri`. Runner serves the resource as
`text/html;profile=mcp-app` and uses the standard `ui/initialize`,
`ui/notifications/initialized`, and `ui/notifications/tool-result` messages.
The official registration helper also supplies the compatibility
`ui/resourceUri` metadata key.

Repository tests use the official MCP SDK client and linked in-memory
transport. They verify tool discovery, resource discovery/read, Apps message
schemas, structured and text fallback results, and the absence of
model-callable approval/apply tools or embedded authority.

The upstream Apps SDK currently lists ChatGPT, Claude, VS Code, Goose, Postman,
and MCPJam as supported clients. Synapsor's repository CI does not exercise
those product hosts, so this project does not claim host-specific compatibility
beyond the official protocol tests. Host support varies by product version and
deployment.

Specification:
[MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Connect A Client

Generate a client-native MCP snippet:

```bash
synapsor-runner mcp config claude-desktop \
  --absolute-paths \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Runner does not require an Apps-specific switch. A supporting host discovers
the app from proposal-tool metadata and fetches the declared resource. A
non-supporting host renders or exposes the normal text/structured tool result.

Preview the model-facing boundary before connecting:

```bash
synapsor-runner tools preview \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The tool list may include inspect and proposal capabilities. It must not
include `execute_sql`, `approve`, `apply`, or `commit` tools.

## Optional MCPB Installation

The repository can build an MCP Bundle for hosts that install `.mcpb`
artifacts:

```bash
corepack pnpm build:mcpb
corepack pnpm verify:mcpb
```

The pinned build uses `@anthropic-ai/mcpb@2.1.2`, validates the `0.4`
manifest, packs it, unpacks it again, scans its paths/placeholders, and writes
an archive plus `SHA256SUMS` and `BUILD-INFO.json` under `dist/mcpb/`.
The verification command launches the unpacked artifact with the official MCP
client, checks semantic tool/resource discovery, reads the App resource, and
confirms that no model-facing approval/apply tool is present.

This profile is intentionally narrow:

- it runs the standard `synapsor-runner contract bundle` environment names;
- the installer asks for the Runner config, state directory, read/write URLs,
  tenant, and principal;
- sensitive values are installer configuration and are not embedded in the
  archive;
- contracts with custom environment names should use `mcp config` instead.

The generated archive is **unsigned** and reports `signed: false`. Signing is
a release-owner operation:

```bash
corepack pnpm exec mcpb sign \
  --cert /secure/release-cert.pem \
  --key /secure/release-key.pem \
  ./dist/mcpb/synapsor-runner-<version>-unsigned.mcpb

corepack pnpm exec mcpb verify \
  ./dist/mcpb/synapsor-runner-<version>-unsigned.mcpb
```

Do not use `--self-signed` and present the result as an official release.
The build inputs and manifest generation are repeatable, but the pinned packer
records archive timestamps, so byte-for-byte archive hashes may differ between
builds. The digest applies to the exact artifact that was built and reviewed.

## Complete Human Review

The inline card intentionally does not carry approval authority. Open the
standalone operator UI:

```bash
synapsor-runner ui \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Or review from a trusted terminal:

```bash
synapsor-runner proposals show <proposal_id> \
  --store ./.synapsor/local.db

synapsor-runner proposals approve <proposal_id> \
  --store ./.synapsor/local.db

synapsor-runner apply <proposal_id> \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Operator identity, approval state, proposal identity, source version, trusted
scope, and writeback guards are rechecked by Runner. Seeing a card never grants
authority and never implies that the source database changed.

## Why The Handoff Is Display-Only

The selected stable Apps SDK provides standardized presentation metadata and
app/host messaging, but it does not document a channel that Synapsor can prove
is hidden from model-visible tool content, transcripts, and ordinary logs
while carrying privileged review authority. Runner therefore does not embed a
signed review challenge in the app resource, resource URI, result, or query
string.

If a future standard defines and tests a model-hidden authority channel, an
inline approval flow would still need a one-time short-lived challenge bound
to the exact proposal, operator session, purpose, and expiry. Until then, the
standalone operator path is the security boundary.

## Fallback Behavior

| Client behavior | Result |
| --- | --- |
| Supports MCP Apps | Inline display-only proposal card |
| Supports MCP but not Apps | JSON/text proposal result |
| No graphical host | Terminal proposal commands |
| Human wants a browser review surface | Standalone loopback local UI |

All four paths use the same proposal review view model. Kept-out values remain
absent; the card only states that the reviewed allowlist excluded them.

## Security Checklist

- Keep MCP and the local UI on loopback unless you follow the authenticated
  production deployment guide.
- Treat proposal/evidence handles as scoped audit data.
- Never place database credentials or operator tokens in MCP client JSON.
- Verify trusted tenant/principal provenance for shared HTTP deployments.
- Keep least-privilege database roles and database-enforced isolation where
  appropriate.
- Treat `source_database_changed: false` as unchanged even when a proposal was
  created successfully.

See [MCP Client Configs](mcp-clients.md), [MCP Client Setup](mcp-client-setup.md),
[Local Mode](local-mode.md), and [Security Boundary](security-boundary.md).
