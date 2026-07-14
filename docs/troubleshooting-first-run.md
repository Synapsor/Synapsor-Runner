# Troubleshooting First Run

Run the friendly doctor first:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --first-run
```

Use JSON for automation:

```bash
npx -y -p @synapsor/runner synapsor-runner doctor --first-run --json
```

## Smoke Proposal Missing From Another Runner

What happened:

`smoke call` returned a proposal id, but `proposals list --config ...` on a
second Runner cannot find it.

Fix:

1. Verify `synapsor-runner --version` is `1.4.12` or later.
2. Confirm both commands use a config whose
   `storage.shared_postgres.mode` is `runtime_store` and whose `url_env` and
   `schema` identify the same ledger.
3. Run `store shared-postgres status --url-env <ENV> --schema <SCHEMA>`.

In `runtime_store` mode, `--store` is not the authoritative ledger. Runner does
not fall back to that SQLite path when shared Postgres is unavailable. Versions
before `1.4.12` could orphan smoke-call artifacts locally; recreate that test
proposal after upgrading.

## Docker Missing

What happened:

```text
Docker CLI is missing.
```

Why it matters:

The first-run demo starts disposable Postgres/MySQL containers.

Fix:

Install Docker Desktop or Docker Engine, then rerun:

```bash
./scripts/try-synapsor.sh
```

## Docker Daemon Stopped

What happened:

```text
Docker daemon is not reachable.
```

Why it matters:

The demo cannot start disposable databases without the daemon.

Fix:

Start Docker Desktop or the Docker service, then rerun:

```bash
./scripts/try-synapsor.sh
```

If the doctor reports Docker socket permission problems, add your user to the
Docker group or start Docker Desktop.

## Port Conflict

What happened:

```text
Port 55433 is already in use.
```

Why it matters:

The fixtures bind predictable local ports.

Fix:

```bash
./scripts/try-synapsor.sh --reset
```

If another application owns the port, stop that application and rerun.

## Stale Containers

What happened:

Doctor reports stale Synapsor demo containers.

Why it matters:

Old containers can hold ports or stale fixture state.

Fix:

```bash
./scripts/try-synapsor.sh --reset
```

## Missing Source Dependencies

What happened:

```text
Dependencies are not installed yet.
```

Why it matters:

Source checkout commands such as `synapsor ...` need workspace
dependencies.

Fix:

```bash
corepack enable
corepack pnpm install
```

The Docker-only first-run demo does not require host Node dependencies.

## Config Missing

What happened:

```text
Runner config not found at synapsor.runner.json.
```

Why it matters:

Own-database MCP setup needs a reviewed config before serving tools.

Fix:

```bash
npx -y -p @synapsor/runner synapsor-runner init --from-env DATABASE_URL --mode review --wizard
```

Or pass an example config:

```bash
npx -y -p @synapsor/runner synapsor-runner tools preview --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db
```

## SQLite Store Missing

What happened:

```text
SQLite local store not found at ./.synapsor/local.db.
```

Why it matters:

The local UI and replay read proposal/evidence state from the store.

Fix:

Run a demo or create a proposal first:

```bash
./scripts/try-synapsor.sh
```

or:

```bash
corepack pnpm demo:reference
```

## DB URL Env Var Missing

What happened:

```text
SYNAPSOR_DATABASE_READ_URL is not set.
```

Why it matters:

Configured capabilities need a read credential to inspect/propose against your
database.

Fix:

```bash
export SYNAPSOR_DATABASE_READ_URL="<read-only-url>"
npx -y -p @synapsor/runner synapsor-runner doctor --config synapsor.runner.json
```

## Read/Write Credential Split Failed

What happened:

```text
Read and write env vars resolve to the same credential.
```

Why it matters:

Read/proposal authority and writeback authority must be separated.

Fix:

Use a read-only credential for MCP reads and a separate writer credential only
for trusted apply.

## MCP Client Config Contains A Secret

What happened:

Doctor reports a generated MCP client config appears to contain a database URL,
password, or token.

Why it matters:

MCP clients must receive only the local runner command and args.

Fix:

Regenerate the snippet:

```bash
npx -y -p @synapsor/runner synapsor-runner mcp config claude-desktop \
  --absolute-paths \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Keep database URLs in environment variables, not client JSON.

## Demo Did Not Prove The Boundary

What happened:

```text
Demo did not prove the Synapsor boundary.
```

Why it matters:

The first-run demo must prove semantic tools, proposal creation, source row
unchanged, approval outside MCP, guarded writeback/conflict, replay, and no
secret leakage.

Fix:

Inspect the printed log path, then reset:

```bash
./scripts/try-synapsor.sh --reset
./scripts/try-synapsor.sh
```
