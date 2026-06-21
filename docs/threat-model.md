# Threat Model

## Boundary

Synapsor Runner is the local trusted writeback boundary. The write credential stays in the customer environment. Synapsor Cloud sends approved structured jobs, not database URLs, passwords, raw SQL, prompts, or model confidence.

## Threats covered

- Compromised or prompt-injected model: runner ignores prompts and accepts only structured approved jobs.
- Malicious model arguments: target, tenant, allowed columns, conflict guard, and idempotency key come from Synapsor proposal state.
- Over-broad proposal target: runner requires primary key and tenant guard.
- Compromised runner token: token is scoped to one source and limited to configured runner permissions such as adapter read/invoke, runner heartbeat, job claim, and result reporting; it does not grant approval or arbitrary SQL authority.
- Replayed job: receipt table makes applied retries idempotent.
- Concurrent runners: receipt row and target row are locked inside a transaction.
- Stale row/version conflict: version-column mismatch returns `conflict`.
- Tenant mismatch: missing target row under tenant guard returns conflict and does not write.
- Multi-row impact: affected rows must equal one.
- Database outage mid-transaction: transaction rolls back and reports failed.
- Control-plane outage after commit: receipt table allows safe idempotent result retry.
- Log leakage: default logs redact tokens and database URLs.
- Dependency compromise: CI, lockfile review, and dependency audit are release gates.

## Limitations

v0.1 does not support arbitrary SQL, inserts, deletes, DDL, stored procedures, multi-row updates, cross-database transactions, automatic schema changes, or a self-hosted Synapsor control plane.
