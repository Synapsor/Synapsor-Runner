# Threat Model

Synapsor Runner is a local MCP/database safety layer. It narrows what a model
can do with Postgres/MySQL by exposing reviewed business capabilities instead
of raw SQL or write credentials.

## Protected Boundary

Runner is designed to protect the model-facing database boundary:

- no model-facing `execute_sql`, raw SQL, approval, commit, apply, or writeback
  tools;
- trusted tenant/principal context comes from config/session/env values, not
  model arguments;
- proposal tools save a proposed change without mutating the source database;
- direct writeback enforces primary key, tenant/scope, allowed columns,
  expected-version/conflict guard, affected-row count, idempotency, and
  receipt/replay recording;
- app-owned executors are called only after approval outside MCP;
- local evidence, query audit, proposal, receipt, and replay records are
  inspectable without rerunning side effects.

## Main Threats Addressed

- A model or prompt asks for broad SQL access.
- A model tries to choose tenant scope or write credentials.
- A model proposes a stale update after the source row changed.
- A retry could duplicate a write without an idempotency key.
- A developer accidentally exposes approval or commit tools to the MCP client.
- A reviewer needs evidence/replay for what was read and proposed.

## Non-Goals

Runner does not claim to solve:

- prompt injection generally;
- malicious MCP hosts or compromised local machines;
- stolen database credentials;
- bugs in app-owned handler business logic;
- production HA, compliance certification, SOC 2, or SLA;
- physical branching of external Postgres/MySQL;
- generic safe execution of arbitrary SQL, DDL, INSERT, DELETE, UPSERT, or
  multi-row writes.

## App-Owned Handler Responsibility

For rich writes, Runner POSTs the approved change to your endpoint after
approval. Your handler is the final business-write boundary and must re-check:

- tenant/scope;
- expected row version or conflict guard;
- idempotency key;
- allowed business action;
- transaction/rollback behavior;
- safe error receipts.

Skipping those checks can reintroduce cross-tenant writes, lost updates, or
duplicate writes.

## Disclosure

Report security issues privately to `security@synapsor.ai`. Do not include
production credentials, customer data, full database rows, bearer tokens, or
private keys in reports.
