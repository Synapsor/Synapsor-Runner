# Proven-no-effect blocked-work closure

Implemented and exercised the bounded lifecycle on one unchanged installed candidate. **R0, R1 and R2 lifecycle checks passed; independent operational acceptance remains pending.** One separate MCP replay wording defect is preserved, not repaired. Original Stage B remains **ATTEMPTED / NOT PASSED**.

## Identity and scope

- Canonical branch: `codex/tui-safe-action-control-plane`; baseline `4b22b460d80eaa246ad4fd0928dc541a49833c81`.
- Product/tests: `4bff1ba831904f94b1b36f9f9f735aa9616b61d7`, followed by `ae96fb0b2556cb2b9465adfc796fee76389f2eb9`.
- Frozen source/evidence checkpoint: `5b39c6d6e83bb33d0777390379e20b0f5ea3f4b4`. Later commits contain evidence/harness/report changes only.
- Complete installed tree: `fb6d6d923eb842b5bd2f17decb4b625a4b682b483d3a47aa510f96f8af6710a5`, 7,569 entries.
- Manifest SHA256: `770a356f7af23a8a010b4129e2a75ed7a07040b637aab9ee9cc2eff4bb6bcca0`; complete archive SHA256: `1d296b65f1800c4c25bbdfe7e177bdb5a1be44563cabc08194698f9687b648de`.
- Runner 1.8.0 / local Spec 1.11.0, complete dependency tree, lockfile, modes, symlink targets and entrypoint identities: `ARTIFACT.json` and its full external manifest. Version alone is not identity.

Raw evidence root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920`. Reports/harnesses: this directory. `EVIDENCE-INDEX.json` resolves durable captures. No provider calls, historical queue execution, public release or deployment occurred.

## Contract and implementation

Historical W2 is **ineligible**: its zero-effect failed receipt/error did not durably establish acknowledged whole-source rollback or the bound source endpoint. The independent challenge identified that missing provenance. Nothing migrates or infers proof retroactively.

New PostgreSQL semantic-v5 source_db workers emit `synapsor.postgres.source_db.rollback.v1` only after acknowledged rollback for the supported stale refusal. The canonical normalized job covers the whole atomic target set. The trusted host binds source/receipt namespace, store/deployment, lease/attempt, current execution configuration and nonempty existing apply-role requirements. The new event and unchanged canonical failed receipt persist in the same existing control transaction. Unknown COMMIT/ROLLBACK and applied/unsupported outcomes produce no qualifying proof.

One shared assessment requires exactly one resolved attempt, exact proposal/job/receipt/idempotency lineage, no live lease/admission/intent and correct store identity. A bounded, read-only lookup at the exact ordinary non-RLS source receipt table must succeed and find no contradiction. Absence alone, current row equality, zero affected rows and a safe error are insufficient. Later legitimate row changes do not invalidate historical acknowledged rollback.

`worker close-blocked` previews by default; exact digest/reason confirmation uses existing verified signed operator authentication and recorded role requirements. Source inspection/signing/confirmation occur before the control writer lock. Final SQLite BEGIN IMMEDIATE or native PostgreSQL schema-advisory writer transaction reassesses mutable state and requires a one-row CAS. Repeats must match the original accepted assessment/source/reason. No parallel ledger or distributed transaction was added.

Closure changes only blocked worker → discarded (`terminal_outcome: discarded`) plus one attributed `writeback_blocked_closed` event (`closed_no_effect`). The proposal stays failed; approval, job, attempt and receipt stay intact. It is **not retry, compensation, cancellation of an effect, replacement approval or a quota refund**. Exact transition/lock/producer details and upgrade limits are in `IMPLEMENTATION-NOTE.md`.

Failed proposals already leave the active-subject duplicate lookup. The composed `unclosed_legacy` regression proves a fresh normally issued reference already works before closure while the original legacy item stays blocked/ineligible. No deduplication override was added. Fresh work still requires current authority, facts, its own approval and execution identity. Actual tenant/boundary accounting tests retain old consumption at available and exhausted capacity.

## Installed operational scorecard

Topology: task-owned PostgreSQL business sources with SQLite control stores; generated reviewed local-development MCP clients; separate sequential finite worker processes. Native PostgreSQL CONTROL evidence is reported separately below.

| Check | Actual result |
| --- | --- |
| R0 missing writer | Check exit2; finite startup exit1. All42 control tables, configs, 504 source rows and receipts identical. Same item queued, attempts0. |
| R0 restored input | Check exit0 with no mutation; separate signed worker exit0. Same request completed at attempt1; exactly candidate+slot and both versions changed. Source receipt and separate canonical control receipt matched; all other rows unchanged. |
| R1 stale refusal | One valid request, then owner changed only selected candidate version1→2. Worker exit0 means process completion, not business success: durable failed proposal/receipt, blocked item, attempt1, SEMANTIC_AUTHORITY_STALE, new acknowledged rollback event, no Runner effect/source receipt. |
| R2 preview/cancel | Public preview available with exact digest and recorded role. Consequences/default cancel fit14 lines at100x30. Empty confirmation, EOF and Ctrl-C each exit1, all42 tables/configs/504 rows unchanged. |
| R2 close/repeat/restart | Verified signed-key exact close exit0. Only queue/event/sequence tables changed. Repeat exit0 adds nothing. New-process inspection says discarded, completed attempt1, no retry; original failure/approval/receipt unchanged. |
| R2 fresh request/effect | New normal Explore reference, own proposal/approval/job/idempotency key and current expected version2. Approval history1→1→2 across before/after close/fresh. Separate worker applies exact candidate+slot changes and version advances, with source receipt and separate applied control receipt. Old item remains discarded at attempt1. |
| Old reference replay | Original arguments return already_recorded/failed; unchanged work/approval/reference records corroborate old mapping, even with a distinct new approved request present. **Separate false human-review wording remains; see below.** |
| Already-applied R0 | Both public preview and confirm attempt exit2, BLOCKED_CLOSURE_NOT_TERMINAL_NO_EFFECT; complete state unchanged. |

`OPERATIONAL-RESULT.json` and raw per-step comparisons retain exact IDs, canonical receipt-byte hashes, commands and exits. The full original failed receipt stayed SHA256 `a41d58e41f3f1cab8c62a21feb6ddb91e83035922089aa6c07c8219be21b01ae`; the fresh applied receipt is separately `531bfc632b5652783e6592c1074c8685449c74cf708a355c98566ec0acda3d13`. Source receipts are separate idempotency/semantic records, not those control-receipt bytes.

Final schedule: 08:44:25–08:53:04 UTC, 519.13 seconds within90 minutes. Actual counts: **4 request_change, 4 finite workers, 2 intended effect transactions, 1 owner version increment, 10 closure/inspection commands, 0 provider calls**. Refusals/replay counted. Original windows were not reset: implementation4h; preparation2h (07:15:32 through independent prerequisite at08:44:25); stable/package2h (07:30:32–08:28:23).

## Gates and preserved failures

| Gate | Final result |
| --- | --- |
| Whole stable suite | Exit0; **6,653 passed / 476 skipped**, 321 passed files /21 skipped. Four workers,20s outer test/hook limits; product deadlines unchanged. Source digest `40b2373d47f37dbdd403ff1c4a0b5e3930e5aadb102ec1c69dca279d17a0831c` identical before/after. |
| Types | Exit0. |
| Ten offline checks | All exit0 on attempt3: trusted core, licenses, human command surface, DSL sources, Cursor plugin, MCP client configs, local package, bundle freshness, public commands, packed-offline with local Spec. |
| Explicit PostgreSQL | **48 passed**, exit0: actual source rollback producer, native CONTROL lifecycle/accounting/cancellation and runtime bridge. Actual advisory-lock waiting, competing closure/startup, save rollback and lost control-COMMIT acknowledgement covered. |
| Explicit SQLite contention | **1 passed**, exit0. Three independent connections refused after unchanged5s writer wait (~5,009–5,010ms); after release two close results and empty worker claim, one event and retained history. Derived lifecycle fixture, not public execution. |

Normal discovery includes closure/receipt/identity-role/state/rollback/CAS/repeat/source-contradiction tests and composed fresh-reference/current-authority/ineligible/removed-Action controls. Native PG gates use lifecycle-generated derived histories, not fabricated public-success claims. Unknown/in-progress/applied source receipt, ambiguous prior attempts, lease/admission, wrong role/store/source and partial-save cases remain strict refusals. Exhausted limits use the actual evaluator and route replacement to human review. Existing cancellation, dead-letter, retry/reconciliation, O2 preflight and P1 status regressions remain enabled.

Preserved attempts are indexed in `GATES.json`: initial lifecycle harness errors; new producer's noncanonical job-hash failure then canonical fix; type/import-cycle failures; full attempt1 deliberately interrupted (exit-15), and **completed full attempt2 exit1:6,650 passed/1 failed/476 skipped** (obsolete status-wording assertion). Attempt3 is a separate completed run, not a union of targeted reruns. A preview negative exposed an unsupported unconditional failure/no-retry claim; corrected in ae96fb0 with a before/after probe. No failed assertion was skipped or weakened.

## Reproducibility and independent scope

All four starts were built from empty projects and original504 business rows through public model-free disabled drafting and separate Read/Action/execution reviews. Existing signed operator configuration preceded those reviews. Exact generated receipt/grant provisioning used unique narrow writer roles, not an administrator at runtime. Live writer/rolled-back receipt probes passed; default worker startup was declined. Each generated local client passed own Read and worker check before sealing. Original JSON array order differs from PK-ordered SQL output; the recorded measurement correction compares every value by PK without changing rows.

Untouched `sealed-starts/{r0,r1,t0,t1}` includes whole project/home, separate private synthetic signing-key archives, matching schema/data/complete dumps, password-free roles, grants/readiness/all-table readbacks and public setup transcripts. Manifest SHA256 `479a3117daf3fe0e64cc6a6b436babc7a51f14c68265842f2988a2c0da7e7744`, 428 entries. `BOOTSTRAP.md` gives the executed fresh-key-from-empty fallback and logical-path restore; no reviewed bindings were rewritten.

The independent tester personally restored T0/T1 with fresh credentials into its own PostgreSQL17.10 containers, checked all42 tables/configs/504 rows, signed-key pairing, exact four tools, own Read and worker check. **Restoration prerequisite PASS only**: review SHA256 `477bd3fc6c65f5642f3da899389e86666e94ebf23d8317144a7702851b11f5bc`, resolved by `RESTORATION.json`. It did not run requests/workers in that lane or repeat the setup receipt probe/full suite. Independent operational acceptance is still pending.

Finished-state archives/dumps were saved before removing only this task's labelled container. The R1 `state-refused` full-table/source readback is supplementary failure evidence, never an untouched/executable start. Completed R0/R1 archives must not be reversed into starts. Candidate/original installed trees, original fixture inputs, historical W1/W2 receipt tables and all sealed entries were reverified unchanged. Reviewer containers were not touched.

## Remaining limits and next decisions

The supported class is future, single-attempt, nondelegated PostgreSQL semantic-v5/source_db/precreated stale refusal with exact qualified ordinary receipt namespace, new producer proof and recorded nonempty roles. Legacy/multi-attempt/uncertain/applied/in-progress/delegated/missing-provenance or uninspectable cases remain unavailable; use `worker dead-letter show` and existing source-outcome inspection/reconciliation. There is no force/refund/requeue. Update/restart cooperating workers for future evidence; mixed-version workers do not acquire proof retroactively.

Existing inclusive rolling windows and admission-time clock assumptions are unchanged. This is local reviewed identity and single-host evidence, not production authentication, multi-host durability, arbitrary clock-skew tolerance or universal exactly-once. Prior M6 and O2/P1 acceptance stay artifact-specific; prior W1/W2 were independently inspected, not executed. M4E2/E3 and original Stage B remain separate.

1. Independent operational acceptance of this exact candidate using the untouched T0/T1 starts is the immediate handoff.
2. Separately decide the bounded MCP failed-replay wording repair in `MCP-REPLAY-PRESENTATION.md`. The observed old replay correctly retains lifecycle identity but falsely mentions pending human review despite its retained approval. That excluded reporting path was preserved and not expanded here.

STOP for review; no new qualification or runtime campaign started.
