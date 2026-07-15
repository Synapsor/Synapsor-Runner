# Export Scoped Ledger Reports

Runner can export a deterministic chronology for one business object or one
principal inside an explicit tenant scope:

```bash
synapsor-runner report --object invoice:INV-3001 --tenant tenant_acme \
  --store ./.synapsor/local.db --format markdown --out ./invoice-report.md

synapsor-runner report --principal support.operator --tenant tenant_acme \
  --store ./.synapsor/local.db --format pdf --out ./operator-report.pdf
```

Runner prints the output path and canonical `sha256:...` integrity digest. A
successful verification prints `PASS`, `REPORT_DIGEST_VERIFIED`, or
`REPORT_SIGNATURE_VERIFIED` when a public key is supplied.

For `storage.shared_postgres.mode = "runtime_store"`, include `--config
./synapsor.runner.json`; Runner reads through a bounded local bridge to the same
shared ledger.

Reports include scoped proposal, query-audit, approval/rejection, writeback,
receipt, replay, compensation, and graduated-trust decision metadata when those
records exist. Evidence rows are never exported. Kept-out values, credentials,
keys, raw driver errors, and database URLs are excluded.

JSON, Markdown, and PDF reports carry a canonical manifest digest. Optional
operator signing binds the export to the existing key model:

```bash
synapsor-runner report --object invoice:INV-3001 --tenant tenant_acme \
  --store ./.synapsor/local.db --format json --out ./invoice-report.json \
  --signing-key ./operator-private.pem --key-id review-key-1

synapsor-runner report verify ./invoice-report.json \
  --public-key ./operator-public.pem
```

Verification detects content, ordering, digest, and signature tampering. A
verified export is tamper-evident; it does not make local SQLite immutable,
append-only compliance storage. Protect report files and signing keys with the
same care as the ledger.
