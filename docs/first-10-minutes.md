# First 10 Minutes

This path is for a developer who cloned Synapsor Runner and wants to understand
the product without reading the full docs first.

## What You Need

- Docker CLI.
- Reachable Docker daemon.
- Free local ports: `55433`, `55434`, `55435`, and `53307`.
- A few GB of free disk for the local demo image and disposable databases.

You do not need:

- Synapsor Cloud account.
- API key.
- Hosted workspace.
- Host Node/Corepack setup for the first command.
- Database credentials.

## Run One Command

```bash
./scripts/try-synapsor.sh
```

The script writes noisy logs to:

```text
./.synapsor/logs/try-synapsor-<timestamp>.log
```

If something fails, it prints the failing check and the log path.

## What The Script Proves

The script runs disposable Postgres and MySQL MCP examples and checks that the
demo actually proves the Synapsor boundary:

- MCP `tools/list` contains semantic tools.
- MCP `tools/list` does not contain `execute_sql`.
- The agent inspects one business row through trusted tenant scope.
- The agent creates a proposal with an exact before/after diff.
- The source row is unchanged after proposal creation.
- Approval happens outside the model-facing MCP tool surface.
- The trusted runner applies a reviewed single-row writeback or blocks a stale
  row conflict.
- Replay exists for the proposal, evidence, approval, receipt, and conflict
  decision.
- The first-run log does not contain database URLs, passwords, bearer tokens, or
  write credentials.

## The Mental Model

```text
MCP client
  -> semantic business tool
  -> trusted tenant/principal context
  -> scoped read from Postgres/MySQL
  -> evidence and exact proposal diff
  -> local approval outside MCP
  -> guarded single-row writeback
  -> applied/conflict/failed receipt
  -> local replay
```

The model gets inspect/propose authority. The trusted runner owns commit
authority.

## Next Command 1: Open The Local UI

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner ui --tour \
  --config ./examples/mcp-postgres-billing/synapsor.runner.json \
  --store ./.synapsor/local.db
```

The UI binds to `127.0.0.1`, prints a local URL with a per-run token, and shows
the proposal/evidence/replay loop. Approval and rejection require CSRF
protection.

## Next Command 2: Run The Reference App

```bash
corepack pnpm demo:reference
```

The reference app uses a disposable support/billing Postgres database and proves:

- semantic MCP tools;
- source DB unchanged after proposal;
- approval outside MCP;
- guarded writeback;
- stale-row conflict;
- replay export.

## Next Command 3: Generate MCP Client Config

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config claude-desktop \
  --absolute-paths \
  --config ./examples/mcp-postgres-billing/synapsor.runner.json \
  --store ./.synapsor/local.db
```

Paste the printed JSON into your MCP client settings. The config contains
command paths only. It must not contain database URLs, passwords, approval
tools, commit tools, or write credentials.

Verify the configured tool boundary with:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner tools preview \
  --config ./examples/mcp-postgres-billing/synapsor.runner.json \
  --store ./.synapsor/local.db
```

## Next Command 4: Use Your Own Staging Database

After the fixture demo makes sense, point the local runtime at one staging
Postgres/MySQL database:

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
./scripts/use-your-db.sh
```

The wrapper inspects metadata, opens the guided config wizard, previews the MCP
tool boundary, and prints the serve/UI commands. It does not print your
database URL or write credentials.

## Reset

If a prior run left stale containers, ports, logs, or local stores:

```bash
./scripts/try-synapsor.sh --reset
```

For noninteractive cleanup in CI:

```bash
./scripts/try-synapsor.sh --reset --yes
```

The reset path removes demo containers, demo volumes, temporary local stores,
generated MCP snippets under `.synapsor/mcp`, and first-run logs.
