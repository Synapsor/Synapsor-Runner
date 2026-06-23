# Capability Recipes

Recipes are reviewed starter contracts for common database-backed agent actions.

They do not introspect and silently guess write authority. They generate a
starter config that you must map to your actual staging table names, columns,
tenant key, conflict column, and business limits.

List recipes:

```bash
npx -y -p @synapsor/runner@alpha synapsor recipes list
```

Inspect one:

```bash
npx -y -p @synapsor/runner@alpha synapsor recipes show billing.late_fee_waiver
```

Initialize a starter config:

```bash
npx -y -p @synapsor/runner@alpha synapsor recipes init billing.late_fee_waiver --output synapsor.runner.json
npx -y -p @synapsor/runner@alpha synapsor config validate --config synapsor.runner.json
```

Built-in recipes are JSON files under `recipes/`. They are starter data, not
runtime hardcoding. You can copy one, edit table/column/tool names for your
domain, and initialize from your file:

```bash
cp recipes/billing.late_fee_waiver.json my-recipe.json
npx -y -p @synapsor/runner@alpha synapsor recipes show ./my-recipe.json
npx -y -p @synapsor/runner@alpha synapsor recipes init ./my-recipe.json --output synapsor.runner.json
```

Available recipes:

- `billing.late_fee_waiver`
- `support.ticket_resolution`
- `orders.refund_review`
- `accounts.trial_extension`
- `credits.account_credit`

Each recipe includes:

- expected table type;
- required columns;
- recommended primary key;
- recommended tenant key;
- recommended conflict/version column;
- visible columns;
- allowed write columns;
- patch mapping;
- numeric/status bounds where relevant;
- semantic MCP tool names;
- staging-first notes.

Start with staging or a disposable database. Keep production write credentials
out of the MCP client.
