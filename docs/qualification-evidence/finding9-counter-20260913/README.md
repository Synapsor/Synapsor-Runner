# Finding 9 — model-free maintained-counter review

Implemented and verified on an installed candidate; stopped for review. This is implementer-owned freight verification, not independent acceptance or an overall onboarding qualification. Original Stage B remains **NOT PASSED**. Historical Stage A acceptance remains attached only to artifact `278b66c357a94d3b0dc1a67300976b69b66b5ac026a0f84077660670600d30d2`.

## Delivered change

Product commit: `811ed6a33a00d113c5c35d5f3a10c4fa9363dc66`, based on delivered repair `454a0d29c0c2f5fbaec9b883a54ee0df2cff3a60`. Branch: `codex/model-free-reviewed-counter`. All product work occurred in `/home/sandesh-tiwari/.codex/worktrees/9997/synapsor-runner`.

The public operator route is:

```sh
synapsor-runner start --export-draft dispatch.json --project-root .
# Enter the typed business rule in the exported envelope.
synapsor-runner start --draft dispatch.json --review-counters --project-root .
```

`onboard db --draft ... --review-counters` uses the same route. These commands describe this candidate; this task did not publish a package.

The route invokes the existing maintained-counter review for each submitted UPDATE target, including atomic companion updates. The operator explicitly chooses an inspected integer field and confirms the existing source-owner `all_writers_increment` contract. Neither integer shape nor the name `rev_no` establishes maintenance. The selection and confirmation start unselected/cancelled or pending. Files, `--json`, and `--yes` cannot supply consent; a real operator terminal is required.

Prepared counter mappings remain transient until the full typed Action compiles and the guarded disabled-draft save succeeds. Metadata and exact review bindings are checked during review, and fresh metadata is checked again under mutation exclusion before save. Existing catalog representation, compiler, scope, policy, execution, lease, and publication checks remain in use. Read activation, Action activation, writer verification, execution consent, and worker execution remain separate.

No counter-name recognition, second counter mechanism, identity/authentication change, manual-editor parity expansion, provider call, or model-facing authority tool was added. Source changes are limited to structured authoring, its existing diagnostic, help/docs, and regression tests. See `design-note.md`.

## Candidate and checks

The complete installed tree was built offline from the committed product, then used read-only for every installed invocation. The server had no network namespace connectivity; it reached only the owned Postgres Unix socket. Only existing installed dependencies and the already-present Postgres image were used.

| Item | Result |
| --- | --- |
| Frozen installed tree | `6556061d821319bb3184a70b8efb4116a5acb7db4df17ff873688ad97094c10b` |
| Tree entries / Node | 7,569 / 22.22.2 |
| Final installed-tree verification | Exact hash unchanged |
| Focused integrated regression suite | 244 passed across 9 files, including 10 new route tests |
| Final TypeScript check | Passed |
| Offline checks | 10 passed: dependencies, license, human commands, DSL sources, Cursor plugin, MCP configs, local runner, bundle freshness, public commands, packed runner |
| Full repository suite | Not rerun for this scoped route change |
| Preserved installed-run assertions | 25 passed |
| Installed fixture attempts / provider calls | 1 / 0 |

The tests cover ambiguous fields, preview without persistence, disabled save and re-export, pending/cancelled/refused confirmation, invalid selection, stale metadata before/during/after review, concurrent authority changes, and rejection of nonterminal or `--yes` consent.

An early uncommitted manual-editor placement prototype was discarded because it coupled counter review to restricted form shapes. Its intermediate failures and patch remain in owned evidence; it is absent from the delivered product. Final test receipts are in `test-summary.json` and `logs/`.

## Installed freight journey

The fresh owned database copied only the synthetic freight DDL/roles/seed. Original tutorial stores, queues, credentials and frozen installations were never used for runtime. The reader retained trusted `carrier_id` tenant scope and `account_id` principal scope. Both identities came from operator environment configuration, never MCP arguments.

The typed rule dispatches a ready shipment whose related slot is reserved, atomically setting shipment status to `dispatched` and slot status to `consumed`. Both `rev_no` fields must compare and increment. The synthetic policy explicitly declares automatic approval for weight at most 1,000 kg, carrier count 10 and overall Action count 20 per rolling 86,400 seconds; other eligible requests require one dispatcher approval.

| Step | Observed result |
| --- | --- |
| No reviewed counter | Existing typed compile rejected UPDATE as not source-proven |
| Counter choices | Dock slots offered `rev_no`; shipments offered both `rev_no` and `weight_kg` |
| Cancel first field / refuse second owner confirmation | Complete ledger and source unchanged; first reviewed mapping was not partially saved |
| Live metadata drift during confirmation | `ACTION_VERSION_REVIEW_STALE`; no draft or source mutation |
| Explicit `rev_no` selection on both targets | Complete Action saved disabled; re-export retained both UPDATE mappings |
| Separate Read and Action activation | Completed; source unchanged and execution still off |
| Writer setup | Reviewed generated grants and exact carrier/account RLS applied only to owned fixture; reader credential unchanged |
| Rescan and dependency recheck | Existing model-free “Recheck saved changes against reviewed access” produced a disabled replacement; typed business rules remained exactly equal |
| Separate replacement activation and writer consent | Completed; source unchanged before requests/worker |
| Public MCP Read | Exactly NW-1001 through NW-1005 returned; other-carrier SL-9001 excluded |
| NW-1001, 800 kg | Automatically approved and queued; source unchanged until worker |
| NW-1002, 1,500 kg | Pending operator review; separate dispatcher CLI approval left source unchanged |
| NW-1003 consumed slot / NW-1004 cancelled | Both refused with `SEMANTIC_ACTION_NOT_ELIGIBLE`; no proposals created |
| Two finite supervised worker runs | Both successful proposals applied atomically; each receipt records two affected rows |
| NW-1005 secondary counter changed after approval | Third finite worker refused with `SEMANTIC_AUTHORITY_STALE`, zero affected rows, failure receipt; both business effects remained unapplied |
| Original-reference MCP replay | Both successes returned `completed`, `already_recorded`, verified execution receipts; stale request returned `attention_required`, `already_recorded` |
| Cancel counter review with active Read/Action/execution | Entire ledger and source digests unchanged |

Final owner row oracle: NW-1001/DOCK-A1 and NW-1002/DOCK-A2 changed status and advanced all four counters from 1 to 2. DOCK-A5 advanced from 1 to 2 only in the explicitly declared external-owner conflict injection; its status stayed reserved and NW-1005 stayed ready at counter 1. Every other row and value stayed unchanged. Repeated requests created no extra proposal. Three proposals and three receipts remain: two applied, one failed.

Successful receipt hashes:

- NW-1001: `sha256:433d3a10919be16ad9333d3f6ff04d0dd8d9aec27df8e2abb527c42acdd40d67`
- NW-1002: `sha256:e2b7e0cff914ee0b1df6c0242935bdfa9a8bab5170be63358bc17ff9cf15969b`
- Stale NW-1005 failure: `sha256:0960fe237f21b79e51598c96cbd5da2207038df45f9033e3dd7bd879470f16a6`

## Corrections and limits

The initial synthetic Read requested a relationship whose join fields were kept out; Runner rejected it without saving. The unnecessary public Read relationship was removed; the Action retained its separately inspected private foreign key. The initial synthetic Action declared only the carrier count, omitting the existing compiler's required overall accounting count. It was rejected after counter review with no partial save. The fixture then explicitly added overall count 20 while retaining carrier count 10. The rejected inputs and logs are preserved. This verifies the declared pair of limits, **not acceptance of the original single-count intent** or quota exhaustion behavior.

Writer RLS provisioning changed metadata, so immediate combined export correctly refused stale Action authority. The existing model-free dependency recheck repaired the disabled revision; no new revalidation mechanism or hand-edited authority was used.

This fixture used the existing development `dev_env` operator identity mode (`identity_verified=false`) and existing Runner-ledger receipt mode. It does not qualify production authentication, cryptographically verified dispatcher identity, source-database receipt provisioning, crash recovery, broader quota semantics, or the separate tournament/software blockers. No client model was connected. These boundaries are unchanged by Finding 9.

## Preservation, cleanup and handoff

Implementation budget was 90 minutes; product commit was ready at 17:52:52 UTC after starting at 17:30:30 UTC. The 45-minute installed verification budget started at 17:54:18 UTC; the fixture stopped at 18:17:28 UTC, within attempt 1. Evidence review and delivery followed without more fixture activity.

All 15,578 pre-existing protected entries match the original baseline. The strict whole-tree comparison reported 23 **added** files under the shared checkout's separate `quota-receipt-repair-20260913` evidence directory. Its failure is retained in `preservation-final.json`; `preservation-baseline-verification.json` separately proves zero modified or missing baseline entries. Concurrent source changes in that shared checkout are recorded, not reset or absorbed. This task wrote no shared-checkout product files. Original manual findings, old stores, accepted artifact and prior repair artifact remain unchanged.

Owned container `fd4afa7c5242164df32f8718887300b05110774e4ecc82fe3bcdf0754c337c61`, label `finding9-counter-20260913`, network `none`, was verified by exact identity and stopped with exit 0. All three workers were finite `--supervised --once` processes and exited. The blocked conflict request remains preserved, not retried. No original or unrelated process was stopped.

Full owned evidence: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913`. This directory retains the frozen install/manifest, logs, checkpoints, source oracles/dumps, and fixture. Generated ledgers, credentials, database dumps and package tarballs are excluded from Git; `owned-evidence-index.json` records hashes. Public MCP transcripts and bounded verification summaries are included here. Terminal/test `.log` copies have ANSI controls and trailing whitespace removed for review; original raw logs remain unchanged in owned evidence, with both hashes recorded in `transcript-normalization.json`.

See `fixture-verification.json`, `artifact-final-verification.json`, `cleanup.json`, and `logs/`. The private backup repository was verified as PRIVATE before delivery. No public push, release, deploy, or package publication was performed. Next action: review this scoped candidate and decide whether to independently re-test Finding 9; do not reopen unrelated assignments automatically.
