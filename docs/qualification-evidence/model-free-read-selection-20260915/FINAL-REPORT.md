# Model-free Read selection closure

Implemented warning option (b), with aggregate recommendations made explicit opt-in. Product/tests/docs: `ba1dd7ddfef7a7930026d1360657b7a89465e423` on `codex/tui-safe-action-control-plane`, descended from clean `89b66f0`.

The controlled exports agree with the code: workload minimization drops unused resources; the Action catalog uses resources retained by the reviewed Read candidate (plus exact retained Action authority), not every inspected table. This patch does **not** silently add excluded resources to private verification or grant new Read/Action authority.

The recommendation screen, question picker and textual fallback now explain that excluding questions can also remove private Action verification. Deselecting displays an immediate reminder. Guidance distinguishes raw `RUNNER ONLY` withholding from analytical permissions: operators must review all public operations, not assume a retained aggregate or withheld field is private-only access. The guide documents the same distinction. The narrow terminal picker reserves room for this guidance.

All metadata-recommended aggregate cards now start unselected; they remain available through explicit operator selection and normal validation/review. This is deliberately conservative for all model-free aggregate recommendations because keyword matches have no policy-permission proof. It does not parse policy prose or introduce software-specific exceptions. Existing row recommendations remain; excluded aggregates are not replaced with different questions. This adds an explicit choice for aggregate-only jobs. It does not certify that every suggested row read satisfies an attached policy.

## Evidence and checks

- Before repair: two focused failures, exit 1. The private-check aggregate was automatically recommended; deselection offered no private-verification warning.
- After initial repair: 206 tests passed, exit 0.
- Final combined selection/picker/Action compiler/catalog/public dispatcher controls: **211 passed, 309 filtered skips**, exit 0. Includes explicit aggregate selection, no substitute question, warning rendering, existing no-model disabled review/no activation and composite inverse-FK collection compilation.
- Types, trusted-core dependency boundary and local package gate: each exit 0, offline with existing dependencies. Exact commands/exits/log hashes in `VERIFICATION-INDEX.json` and `*-result.json`.
- No full suite, paid model run, new installed qualification, live software execution or PostgreSQL runtime campaign was run for this small patch. The previous 6,528-pass suite belongs to its prior source/artifact, not this change.

The unchanged exported schema already includes `verification.resources[].collection_consistency: complete_locked`. Both initial exports have zero Actions and zero Action skeletons; a missing value there is not a compiled collection failure. The existing passing compiler control uses the same three-column child-to-parent FK shape in reverse, derives `complete_locked` for aggregates/negative existence and preserves it through schema roundtrip and edits. This is implementation evidence, not a software runtime pass.

During this task the reviewer-owned `PROGRESS.md` grew a new section reporting successful model-free disabled validation of the exact software rule: candidate-to-checks inverse binding, `complete_locked`, bounded aggregates, negative existence and atomic candidate/slot updates. That is separately attributed reviewer evidence. The initial report hash is retained; it was not overwritten or restored. Both original exported-draft hashes remain unchanged. `COLLECTION-DIAGNOSIS.json` records the distinction and an owned read-only snapshot of the updated report/exports/authored draft. Execution, source_db receipt, writer/collection visibility and independent two-row readback remain unestablished by this patch.

## Preservation and delivery

No reviewer database, source rows, identity, policy, grants or saved authority were opened for writing. No provider calls or task-owned database containers were needed. Test processes exited; temporary state belongs to the isolated test directories. Logs are saved and read-only. The previous complete installation still verifies all 7,569 entries against `4cdd9cd65389a57de238c07775ca9bb22d824bccf9cf9dd8a1e1adb9e2b44284`; it remains the unchanged correction-review handoff, and does not contain this later UI patch.

The next useful verification is the reviewer’s existing model-free software continuation, using a newly built patch artifact if testing this UI. No new domain or unseen qualification is started. Original Stage B remains ATTEMPTED NOT PASSED. Private backup delivery and exact clean HEAD are recorded in `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/model-free-read-selection-89b66f0-20260915/delivery.json` after commit.
