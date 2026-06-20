# Contributing

Use small changes with tests. Do not add support for arbitrary SQL, multi-row updates, DDL, stored procedures, or model-generated write statements.

Before opening a change:

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

Keep logs and fixtures free of secrets and customer data.

