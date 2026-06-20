# Architecture

Synapsor Runner is the local-first MCP and database safety runtime. It is not the Synapsor C++ DBMS and it does not physically branch Postgres or MySQL.

The product boundary is:

```text
MCP connects the agent. Synapsor controls the commit.
```

## Local mode

The target architecture for local mode is:

```text
MCP client
  -> local Synapsor MCP server
  -> reviewed capability config
  -> trusted local context provider
  -> read-only Postgres/MySQL connection
  -> local evidence and exact proposal diff
  -> local proposal/event store
  -> CLI or localhost approval
  -> guarded worker with separate write credential
  -> local receipt and replay
```

Current implementation status: the guarded worker, protocol validation, Postgres/MySQL adapters, receipt table, and Docker smoke fixtures exist. The standalone MCP server, local proposal/event store, approval CLI, and replay CLI are next implementation phases.

## Cloud-linked mode

Synapsor Cloud owns proposal, evidence, approval, replay, and job lease state. Synapsor Runner runs in the customer environment and owns the write credential, transaction, receipt table, and result callback.

```text
Synapsor Cloud -> approved structured job -> local runner -> Postgres/MySQL
       ^                                                   |
       |---------------- result/replay callback ------------|
```

The runner does not receive arbitrary SQL. It receives target schema/table, primary key, tenant guard, allowed columns, patch values, conflict guard, idempotency key, and lease expiry.

## Execution authority split

```text
MCP tool call = request/proposal authority
Trusted runner = execution authority
```

The model-facing path can request an inspect/proposal tool. It cannot call approval or commit tools by default. The runner only applies an already-approved, scoped, conflict-checked job.
