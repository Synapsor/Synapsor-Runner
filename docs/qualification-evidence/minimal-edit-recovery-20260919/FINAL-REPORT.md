# M4 minimal edit and recovery — verification in progress

Two bounded repairs are implemented: separately reviewed reconciliation of proven-stale verification annotations, and durable recovery of an acknowledged disabled Action edit. Final installed E1/E2/E3 results and artifact identity are pending. This is not an acceptance claim.

Baseline: canonical `codex/tui-safe-action-control-plane` at `bfc2f19826a66554fd65caec168baf4bdaacd8ec`, product/tests `097c446b88a2c908d511b75cfa278b65feebe2de`, frozen source `e0210e0cd2636460220b256b1a94d94daf56cc0c`. Prior installation `23c6ea7b3f128da6d0022efdb2b1ba70650794f1ec42b71086729282dde26fd7` remains unchanged. Full current identity will be recorded in delivery.json after freezing.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/minimal-edit-bfc2f19-20260919`.

## Meaning and repair

The exact software baseline has stale derived annotations: `candidate_state.model_visible=false` despite its pinned Read exposing the field, and `candidate.slot_id.model_visible=true` despite its pinned Read withholding raw values. Both flips reproduce without a model during no-op compilation. The producer already uses the correct pinned Read/catalog; blindly copying the old flags would preserve false evidence. No runtime leak or regression of manual RUNNER ONLY was established.

A narrow operator reconciliation now compares the whole verification envelope against a no-op host compile. Only boolean annotations may differ; resource/source/binding/scope, private collection membership and completeness, types and locks must agree. It records an exact separately approved reconciliation. A different Read or verification structure stays a dependency-review refusal. The operator separately reviews the complete disabled edit differences before save. The resulting count-three envelope includes this additional correction and is not represented as “only count changed.”

Actual downstream `policyCoverageDraft` evidence confirms candidate_state was already described as returned through independent Read access; its private-verification annotation changes. slot_id's false claim of returned values is removed. Analysis permissions and all other evidence are retained. See disclosure-trace.json, derived-evidence-development-diff.json and the complete raw before/after evidence.

The recovery bug occurred after planning: the resume path treated an existing outcome as separately saved work, reconstructed its old rule and skipped the missing drafting call. The repair stores the exact original request, Read/Action baseline and later prepared candidate digest in the existing typed pending revision. Restart drafts against the same baseline or acknowledges the exact already saved candidate; a competing revision refuses instead of rebasing. Save rechecks dependencies and Action CAS under the existing authority mutex. Provider work stays outside coordination. No new job ledger, patch language or runtime permission mechanism.

An unchanged model response does not complete a pending edit. Explicit cancellation and an operator-confirmed genuine no-op have distinct retained dispositions and save no replacement. Exact changed candidates require operator review; model changed_fields is not permission for extras. Existing unrelated unfinished work remains retained.

The disabled rule's legacy `activated_at` field is the compiler/draft creation timestamp; the separate active pointer determines authority. Each final comparison explains this timestamp and generated digests explicitly. No activation occurs in this task.

## Deterministic and development evidence

Failing-before post-plan regression: resume-baseline02 expected a second drafting call but observed one. The earlier resume-baseline attempt had an incorrect draft-only fixture assertion after activation and is retained separately. The no-op/count numeric compile/save probe establishes both metadata directions before implementation.

Controls cover explicit true/false/unknown; repeated field names under different bindings; a renamed structural twin; Read/verification drift; three save-boundary cuts; competing edit and failed acknowledgement; exact original request versus planner paraphrase; rejected extra effect/approval changes; genuine unchanged/cancelled states; and preservation of separate pending work. The local evaluator rejects two checks and accepts three with all other synthetic prerequisites held fixed. This is disabled evaluator evidence, not live published execution.

Development used six of six calls, OpenRouter / openai/gpt-5.6-terra, reported cost $0.0624727. One public recommended-entry run saved count three plus explicit metadata reconciliation, declining activation. Complete authority comparison passed; 42 ledger tables were compared, with only four control-policy bookkeeping tables changed. All active authority, application history, writer/source_db receipt configuration and 504 original source rows remained unchanged. Subsequent deterministic retention/closure hardening is not retroactively attributed to that run. No further development calls were spent.

## Remaining verification

Stable source digest: `a4f9422a2b1ad06900b7eb0932c6d8d0822f68771c75089a32259d37a726a91f`.

- Final focused batch: 81 pass, 317 filtered, exit 0.
- Types: exit 0 on the same source.
- Real PostgreSQL control-store review/persistence gate: 9 pass, 413 filtered, exit 0.
- Explicit domain/freshness gate: 5 pass, exit 0 (both SQLite and real PostgreSQL controls).
- Full stable suite: exit 0; 6,587 pass / 464 skip, 318 files pass / 21 skip, 1521.77 seconds. Source identical before/after.
- All ten offline checks: exit 0, including installed local package, bundle freshness, public commands and packed offline install using local Spec.
- E1/E2/E3 final immutable installed checks: NOT RUN.

Exact commands, source hashes, exits, timing and retained earlier failures are in development-and-focused-results.json and raw *-exit.json. focused04 changed source near its end and is exploratory only, even though it finished green. It is not combined into the stable verdict.

## Limits retained

Original Stage B remains ATTEMPTED / NOT PASSED. Historical acceptance remains artifact-specific. This is a known software edit case, not unseen onboarding or runtime qualification. No source effects, workers, application requests, approvals, permission changes or receipt provisioning were performed in public trials. Original source rows are restored alongside historical queues/receipts; this is not a reconstructed post-receipt source snapshot.

J3, M1/M2/M3/M5/M6, missing relationships, blocked-worker recovery, runtime intent binding and new providers remain outside scope. Terra's earlier three-response Read attempt stays INCOMPLETE, not a universal client failure. Its detail-plus-limit refusal belongs to app.describe_data, not the repaired app.describe_actions; DESCRIBE-DATA-FOLLOWUP.md preserves that distinction. No current test establishes multi-host coordination, arbitrary clock-skew handling or production readiness.
