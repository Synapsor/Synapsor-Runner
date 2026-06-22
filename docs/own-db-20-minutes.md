# Own Database In 10 Minutes

This path is for a developer who already understands the local demo and wants
to try one staging Postgres/MySQL table without writing `synapsor.runner.json`
by hand.

Do not start with your most sensitive production database. Start with staging,
a disposable database, or a least-privilege view.

## 1. Create A Read-Only Credential

Use a database user that can inspect metadata and read only the tables/views
needed for the experiment.

Set the connection string in an environment variable:

```bash
export DATABASE_URL="<postgres-or-mysql-read-url>"
```

Do not paste database URLs into MCP client configs or committed JSON files.

## 2. Inspect The Database

Fast path:

```bash
./scripts/use-your-db.sh
```

That command runs inspection, guided config generation, and tool preview. The
rest of this page shows the same steps explicitly.

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner inspect --from-env DATABASE_URL --engine auto
```

This prints discovered tables/views, primary keys, possible tenant/scope
columns, possible conflict/version columns, and fields suggested for review.
Inspection reads metadata and table shape. It does not expose raw SQL tools or
write credentials to the model.

For disposable staging databases, this shorter form also works:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner inspect "$DATABASE_URL" --engine auto
```

Prefer `--from-env` on shared machines so URLs do not land in shell history.

## 3. Run The Guided Wizard

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner init --from-env DATABASE_URL --mode review --wizard
```

The wizard asks for:

- database engine;
- read URL environment-variable name;
- schema/database;
- table or view;
- primary key;
- tenant/scope column;
- conflict/version column;
- read-visible fields;
- mode: `read_only`, `shadow`, or `review`;
- business object name and namespace;
- proposal patch mapping if you choose `shadow` or `review`;
- trusted tenant/principal env vars;
- approval role;
- final confirmation before files are written.

The default mode for unknown schemas should be treated as a cautious staging
path. Do not enable real writeback until the read/proposal path is reviewed.

You can still run the complete wrapper:

```bash
./scripts/use-your-db.sh
```

It runs inspection, guided init, tool preview, and next-step printing in one
flow. For the lower-level CLI path, `synapsor onboard db --from-env
DATABASE_URL` runs the same own-database onboarding from the runner command.

## 4. What Gets Generated

The wizard creates:

- `synapsor.runner.json`;
- `.env.example`;
- `.synapsor/mcp/generic-stdio.json`;
- `.synapsor/mcp/claude-desktop.json`;
- `.synapsor/mcp/cursor.json`;
- `.synapsor/mcp/vscode.json`.

The generated config stores environment-variable names, not database secrets.

## 5. Preview What The Model Sees

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner config validate --config synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor-runner doctor --config synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor-runner tools preview --config synapsor.runner.json --store ./.synapsor/local.db
```

`doctor` checks config shape, trusted context env vars, source env vars,
read/write credential separation, source metadata when reachable, handler env
vars, and the semantic MCP tool boundary.

`tools preview` lists what the model would see and confirms:

- semantic tools present;
- `execute_sql` absent;
- approval tools absent;
- commit tools absent;
- database URLs absent;
- write credentials absent.

## 6. Serve MCP

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"

npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The MCP server exposes only the configured semantic tools. It does not expose
raw SQL, approval tools, commit tools, database URLs, write credentials, or
model-controlled tenant authority.

## 7. Review Proposals

If a proposal is created:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner proposals list --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor-runner proposals show <proposal_id> --store ./.synapsor/local.db
npx -y -p @synapsor/runner@alpha synapsor-runner replay show <proposal_id> --store ./.synapsor/local.db
```

Open the UI:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner ui --tour --config ./synapsor.runner.json --store ./.synapsor/local.db
```

## 8. Apply Only After Review

For direct SQL writeback, set a separate writer credential only when ready:

```bash
export SYNAPSOR_DATABASE_WRITE_URL="<postgres-or-mysql-writer-url>"
```

Then:

```bash
npx -y -p @synapsor/runner@alpha synapsor-runner proposals approve <proposal_id> --store ./.synapsor/local.db --actor local_reviewer --yes
npx -y -p @synapsor/runner@alpha synapsor-runner proposals writeback-job <proposal_id> --store ./.synapsor/local.db --output job.json

SYNAPSOR_ENGINE=postgres \
SYNAPSOR_DATABASE_URL="$SYNAPSOR_DATABASE_WRITE_URL" \
npx -y -p @synapsor/runner@alpha synapsor-runner apply --job job.json --config synapsor.runner.json --store ./.synapsor/local.db
```

If your application should own the business write, configure an `http_handler`
or `command_handler` executor instead of direct SQL writeback. See
[writeback-executors.md](writeback-executors.md).

## Safety Rules

- Never infer write authority silently.
- Every allowed write column must be explicitly reviewed.
- Every patch mapping must be explicitly reviewed.
- If no tenant column exists, use a safe view or explicitly acknowledge
  single-tenant dev mode.
- If no conflict column exists, stay in `read_only` or `shadow` unless you
  intentionally accept a weak guard for local testing.
- Never write during onboarding.
- Never put secrets in generated config.
