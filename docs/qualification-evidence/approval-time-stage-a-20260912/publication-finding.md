# Separate finding: superseded automatic authority admitted after publication

Product unchanged at a2b6b5f; baseline report a0942d1. Both governed SQLite and
PostgreSQL paths reproduced the failure. The earlier rule allowed three, one
approval was already committed, and a replacement lowering the limit to one
became current before the old request made its approval decision. The request
still received a second automatic approval using the old rule. Its ordinary
caller supplied no `now` override. A fresh request used the replacement and was
pending human review; replaying the old reference was rejected as stale.

SQLite waited at an acknowledged asynchronous test barrier immediately before
the real store admission call. PostgreSQL additionally waited at its actual
schema advisory writer lock: a separately owned transaction held the exact
`hashtext` lock while publication committed through the governed policy API.
Initial PostgreSQL attempt used `hashtextextended` in the harness, did not cause
a writer wait, and failed before replacement. It is a harness failure, preserved
in focused-03-publication.log and publication-attempt1; focused-04 is the corrected
single PostgreSQL schedule and fails the product assertion.

The trace starts with actual Read review/activation and governed migration,
then Action draft/exact-digest confirmation/publication APIs. No active pointer
was rewritten. The synthetic reviewer belongs to this isolated integration
fixture, as in existing tests; no claim of signed operator CLI or model review.
The rule and preference domain are reused from semantic-approval-current.test.ts.

Cause: semantic runtime checks the active rule in resolveContext and reference
claim before asynchronous facts/proposal work. approveProposalByPolicy receives
the captured boundary and limits but does not bind its transaction to the
current governed action revision. The runtime cutover gate is shared for normal
requests and explicitly excludes ordinary publication. Publication's authority
mutex/policy transaction and automatic admission's ledger transaction do not
establish a single current-revision ordering check. The timestamp repair works
for accounting history; it does not close this separate revision race.

Admission-first passed on both backends: the earlier legitimate decision and its
history survived replacement, a fresh request saw the stricter limit, and stale
reference replay was rejected. No worker was enabled in these integration cases;
old queued-worker behavior is therefore not qualified by these results.

Affected replacement paths are STOPPED, with no product fix or weakened assertion.
The strict reproduction remains in apps/runner/src/semantic-admission-publication.qualification.ts
and has an explicit Vitest config here. It is outside standard test discovery to
honor the instruction to stop the failed path, not an expected-failure pass. The
standard full suite must be reported separately and cannot override this failure.
Future bounded repair replay: node node_modules/vitest/vitest.mjs run --config
 docs/qualification-evidence/approval-time-stage-a-20260912/publication-vitest.config.mjs
with a scoped owned SYNAPSOR_TEST_POSTGRES_URL and optional SYNAPSOR_TEST_EVIDENCE_DIR.
The preserved source actually executed is also retained beside the logs.
