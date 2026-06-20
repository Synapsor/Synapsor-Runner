# Architecture

Synapsor Cloud owns proposal, evidence, approval, replay, and job lease state. Synapsor Runner runs in the customer environment and owns the write credential, transaction, receipt table, and result callback.

```text
Synapsor Cloud -> approved structured job -> local runner -> Postgres/MySQL
       ^                                                   |
       |---------------- result/replay callback ------------|
```

The runner does not receive arbitrary SQL. It receives target schema/table, primary key, tenant guard, allowed columns, patch values, conflict guard, idempotency key, and lease expiry.

