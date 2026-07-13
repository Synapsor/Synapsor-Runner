# Bounded Set Local Measurements

These measurements are test evidence, not throughput claims or capacity
guidance. They record one run of `corepack pnpm test:bounded-set` on 2026-07-13
using synthetic rows and disposable local Docker databases.

Environment:

- Linux laptop, Intel Core i7-13800H, 20 logical CPUs, 30 GiB RAM;
- Node.js 22.22.2 and pnpm 10.14.0;
- Docker 29.5.2;
- PostgreSQL 16 and MySQL 8 containers;
- source-database receipt authority with an administrator-precreated receipt
  table;
- one sequential set UPDATE per measurement, including connection setup,
  source receipt, lock/preflight, transaction, and exact receipt generation.

| Engine | 1 row | 10 rows | 100 rows |
| --- | ---: | ---: | ---: |
| PostgreSQL | 30.42 ms | 53.88 ms | 154.90 ms |
| MySQL | 25.30 ms | 53.91 ms | 163.20 ms |

These figures are not portable across hardware, network topology, source
indexes, lock contention, triggers, database configuration, or receipt mode.
The claim supported by this gate is only that execution stays bounded and the
hard 100-row ceiling is exercised on both adapters. Operators must benchmark
their own reviewed contracts and database topology.
