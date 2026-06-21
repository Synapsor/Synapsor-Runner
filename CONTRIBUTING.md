# Contributing

Synapsor Runner is source-available software. Until Supsmall Inc. has a
counsel-approved CLA or inbound-rights process for this repository, external
code contributions are not being accepted.

What is welcome now:

- bug reports;
- documentation feedback;
- security reports through the process in `SECURITY.md`;
- feature requests and reproducible examples.

Please do not submit pull requests or code patches unless the maintainers have
explicitly requested them under an approved contribution process.

For maintainers, use small changes with tests. Do not add support for arbitrary
SQL, multi-row updates, DDL, stored procedures, or model-generated write
statements.

Before opening a change:

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

Keep logs and fixtures free of secrets and customer data.
