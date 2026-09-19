# Evidence index

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919`.

`raw-index.json` hashes the retained gate logs, attempts/replies, terminal logs, complete state snapshots, canonical differences, sealed starts/final states, source archives, database dumps and frozen package manifest/archive. Sensitive database credential files and transient caches are excluded. It does not replace the complete installed tree manifest, which independently hashes all 7,569 entries including modes and symlink targets.

- `full-stable.log` / `full-stable-exit.json`: actual complete suite, exit0.
- `stable-types-exit.json`, `postgres-stable-review-exit.json`, `postgres-stable-freshness-exit.json`: separate exact commands/exits.
- `offline-gates/`: ten offline checks, logs and plan.
- `public/zero-provider/`: no-op/numeric before-repair compile/save proof.
- `resume-baseline02*`, `resume-repair01*`, `resume-cuts01*`, `ready-focused*`: before/after recovery tests.
- `development-meter/`, `public/development/`: six-call development attempt, not final-build evidence.
- `final-meter/`:19 actual attempt records;18 replies, one declared pre-send interruption. Current provider settings in captured requests.
- `public/E{1,2,3}/`: complete terminal episodes, all 42table/source/config snapshots, actual candidate oracles and leaf differences, generated downstream evidence. E3 includes the precise stopped pending record and cut artifact.
- `saved-starts/`: untouched matched E1/E2/E3 and actual E3 interruption archive. Never run them in place.
- `saved-state/`: final projects, complete source/control database dumps, roles without passwords and container logs; historical queues remain unexecuted.
- `source-all-table-data-comparison.json`: offline original/final COPY data proof; first format-command setup error retained separately.
- `frozen/`: immutable complete installation, manifest, lockfile/dependency tree, entrypoint identities, archives and exact source checkpoint archive.
- `preservation.json`, `cleanup.json`, `backup-verification.json`: original/old/new hash verification, owned-container stop and private push target.

The Git-side `final-results.json` is the compact scorecard and full per-case semantic differences. FINAL-REPORT.md classifies management changes and limitations; REVIEWER-HANDOFF.md gives public navigation and safe restoration prerequisites. Product/source/evidence identities are intentionally distinct.
