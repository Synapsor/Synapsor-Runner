# Settled-source gates for transport candidate 1

These gates passed on source/tests `106c385357951cf72ad15c63cb8c156bc36963e7`. This report does not grant independent installed acceptance or authorize paid egress. The frozen artifact is identified in [ARTIFACT.json](ARTIFACT.json); its current acceptance status is in [CANDIDATE-HANDOFF.md](CANDIDATE-HANDOFF.md).

| Gate | UTC interval, 2026-09-29 | Result |
| --- | --- | --- |
| Standard unfiltered `corepack pnpm test` | 10:17:42–10:42:40 | Exit 0; 7,794 passed, 532 skipped; 375 passed files, 21 skipped. Includes the standard checks before/after Vitest. |
| Explicit `corepack pnpm typecheck` | 10:42:41 | Exit 0. |
| Selected real PostgreSQL integration | 10:42:44–10:49:15 | Exit 0; 192 passed, 4 skipped across five files. One worker and 20-second test/hook limits. |
| Ten offline/package checks | 10:49:15–10:53:58 | All exit 0. |

The PostgreSQL selection covers production Explore accounting, scoped composite Explore, owner policy/approver connections, semantic writeback authority and authoring review subjects. Its four explicit skips are PostgreSQL variants of installed local-CLI enrollment/key tests; their SQLite companions execute. It is a selected backend gate, not a claim that all backend variants or the full suite's 532 skipped tests ran.

The ten checks are trusted-core dependencies, licenses, human-command inventory, DSL sources, Cursor plugin, MCP client configuration, local package, bundle freshness, public commands and the packed offline installation. They use pinned local dependencies, including local Spec, without provider credentials. They do not depend on the cleared user npm cache. PostgreSQL uses a fresh owned synthetic fixture; no historical B queue or source state is involved.

Every one of the 13 gate records binds the same 1,273-entry source inventory digest, `96f41abf8d25225b6d73096b338c89de2aad195780404876be5d4397cb19d30c`, and identical before/after hashes for all five built entrypoints. No product or test edits occurred during these gates or after the freeze. Later documentation updates are report-only.

Independent records 095–097 inspect these commands, exits, source hashes, skip/filter scope and raw logs without repeating the heavy suite. Main rehashed all their indexed members. Raw `GATE-EVIDENCE-083.json` binds all 42 gate files (SHA-256 `f54774439c4b1a4e3b8cc179419c25afa50b8eaae6ac0a354ccc2621e6b1a99d`). The raw root is recorded in [CANDIDATE-HANDOFF.md](CANDIDATE-HANDOFF.md).

The failed gates remain evidence. Full 001 stopped at the import-cycle check before Vitest. Full 002 completed with 7,755 passed, 33 failed and 532 skipped on earlier source; it is not relabelled as passing. The bounded-drain defect and contract-based fixture corrections are described in [IMPLEMENTATION-NOTE.md](IMPLEMENTATION-NOTE.md), with original outputs and independent review retained. Focused filtered runs are not substituted for the complete full 003 gate.

Main has made zero real provider calls. These source and local simulated checks neither recover the historical 81 ms exception nor establish real-model completion of the 50-Action program.
