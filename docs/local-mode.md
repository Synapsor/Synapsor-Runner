# Local mode

Local mode runs Synapsor Runner inside the developer or customer environment. No Synapsor Cloud account is required for local review flows.

Current local-mode foundation:

- strict JSON capability config validation in `packages/config`;
- local SQLite proposal/event/evidence/query-audit/writeback/replay store in `packages/proposal-store`;
- local proposal review CLI in `apps/runner`;
- static MCP database risk review with `synapsor mcp audit`;
- guarded Postgres/MySQL writeback adapters for approved structured jobs.

Still pending:

- `synapsor mcp serve`;
- local semantic capability execution from config;
- MCP `tools/list` and `tools/call` backed by local config;
- MCP resource reads for proposals/evidence/replay;
- Docker-backed MCP demos.

## Store path

Commands use `--store` or `SYNAPSOR_LOCAL_STORE`.

```bash
export SYNAPSOR_LOCAL_STORE="./.synapsor/local.db"
```

If neither is set, the CLI uses:

```text
./.synapsor/local.db
```

## Proposal review

List proposals:

```bash
synapsor proposals list --store ./.synapsor/local.db
```

Show a proposal:

```bash
synapsor proposals show wrp_123 --store ./.synapsor/local.db
```

Approve:

```bash
synapsor proposals approve wrp_123 \
  --store ./.synapsor/local.db \
  --actor local_reviewer \
  --yes
```

Reject:

```bash
synapsor proposals reject wrp_123 \
  --store ./.synapsor/local.db \
  --reason "policy evidence is incomplete" \
  --yes
```

`approve` and `reject` require either interactive confirmation or explicit `--yes`.

Approval records the approver against the exact proposal hash/version. The proposal patch is immutable after creation.

## Replay

Show replay:

```bash
synapsor replay show wrp_123 --store ./.synapsor/local.db
```

Export replay:

```bash
synapsor replay export wrp_123 \
  --store ./.synapsor/local.db \
  --output replay.json
```

Replay records include proposal metadata, before/after diff, events, writeback receipts, evidence summaries, and query audit rows currently stored for the proposal.

## Boundary

Local mode does not expose `approve_proposal` or `commit_proposal` as model-callable MCP tools. The intended flow is:

```text
MCP tool call
  -> reviewed semantic proposal
  -> local store
  -> human/policy approval outside the model
  -> guarded worker writeback
  -> terminal receipt
  -> replay
```

The external Postgres/MySQL database is not physically branched. It remains unchanged until a trusted runner applies an approved writeback job.
