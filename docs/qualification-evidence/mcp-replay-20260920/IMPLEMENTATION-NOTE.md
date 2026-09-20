# M3/replay: projection contract (before implementation)

Baseline 7be8d2a14b21bb6339e39d0afea519b841a909a4. Recovery product ae96fb0 and subsequent evidence checkpoints are ancestors; product unchanged since ae96fb0. Exact independent capture is indexed by the tester’s mcp-replay-status-prework-20260920/EVIDENCE-MAP.json. Raw capture SHA256 2455368314db7a48ebb6c81b32adeb49e8a680fd2d15ad7a3a8f4d2033ad5a7b.

`captured-before-3` reproduced the actual internal result builder and MCP text/structured projection from a read-only whole-project final-state copy. This bypasses reference acquisition only for diagnostic inspection; it is NOT a current public replay or access/TTL test. The original request's consumed reference maps to its original claim/proposal. No original store, source, clock or reference was edited. Two earlier harness errors (missing test environment forwarding, wrong stored reference property) are retained separately. The product assertion failed: recorded automatic approval was returned as `approved`; both execution fields said `human_review`; approval prose claimed a limit failure. Original response bytes remain untouched.

## Traced cause

The Runner continuation returns `human_review` for every proposal state except approved/pending_worker/applied. The MCP result builder gives that label precedence over failed durable state. Its approval helper skips approval-history lookup for failed states and defaults to `approved`. Its prose independently interprets the old automatic-eligible proof as evidence of a later quota denial. Thus text and machine fields share some wrong state assumptions and also disagree with each other. Replay does not call the accounting evaluator. `eligibility: verified from current authoritative facts` also incorrectly describes a historical verification on this branch. Final text is serialized from the same model-safe structured value; transport formatting is not the cause.

## Bounded presentation mapping

| Durable observations | Existing summary/execution | Additive lifecycle | Approval / next step |
|---|---|---|---|
| Actual pending review | pending_human_review / human_review | not_started/open, no attempt | pending_human_review; reviewer decision remains separate. Mention quota only with applicable recorded deferral evidence, never current allowance. |
| Matching automatic/human approval, queued | approved_pending_execution / queued | queued/open; no retry inferred | automatic/human; wait for eligible worker. |
| Leased attempt | approved_pending_execution / held | in_progress/open | retained recorded approval; await outcome, do not resubmit as new work. |
| Durable retry_wait | approved_pending_execution / held | retry_wait/open and exact retry time | only this state schedules an automatic retry, still subject to normal guards. |
| Applied proposal + matching successful receipt | completed / completed | applied | retained approval; current permitted Read is a separate readback. |
| Failed proposal + failed receipt, blocked | attention_required / held | failed/blocked, no retry | retained approval; operator inspection, no promise of retry. |
| Same failed request, discarded queue | closed / held | failed/closed, no retry | original failed receipt/history remain; fresh request needs a fresh reference and all ordinary checks. |
| Missing/contradictory outcome evidence, reconciliation | attention_required / held | unknown (or failed receipt retained with reconciliation disposition) | do not invent approval, quota reason, effect proof or retry. Ask operator to inspect/reconcile. |

Keep existing execution enum (`held` for failure/running/retry); add a small `lifecycle` object for the distinctions it cannot express. `authorization.approval` may explicitly be `unknown` rather than falsely `approved` without applicable durable evidence. Existing pending and rejection meanings remain. Current failed/closed state never erases matching approval history. Each approval must match proposal ID/hash/version. No new private reason or identifier is exposed.

`source_database_changed` describes the ORIGINAL request's established effect, not current row equality. It becomes null when unavailable; success requires its matching applied receipt. Stronger no-effect statements reuse the existing read-only blocked-closure assessment (acknowledged rollback / accepted closure) and matching failed receipt, never error code/zero rows/absence alone. No source lookup, reconciliation or closure is performed. Add invocation information to distinguish an existing replay's lack of new source effect from the original outcome; never borrow a later request’s receipt.

Reads remain bounded ordinary control-store reads, not an atomic snapshot. Re-read proposal, queue, approvals, receipts, events and the complete existing control-only closure assessment after evidence collection; changes or incompatible receipt/state combinations yield conservative unavailable details rather than a fabricated mixture. No new locks, store schema, recovery predicate, admission decision, worker dispatch/retry behavior or source execution changes. Existing callback side effects/authorization path stay intact; only its presentation label is subordinate to durable outcomes.

No MCP output schema currently constrains semantic request result fields. Text and structured output continue sharing the existing final projection; `ok:true` reports a successfully returned status and does not mean business execution succeeded. Business failure is not globally a transport error. Four input tools, access checks, reference TTL and authority checks are unchanged.

## Resolved mapping challenge and compatibility

Tester pre-freeze MAPPING-CHALLENGE.md is retained under `test-1.8.0/mcp-replay-status-prework-20260920`. Each projected record set is compared on a second bounded read. The reused assessment covers its job/idempotency/intent/admission lineage; a different assessment invalidates the no-effect statement. This is conservative observation, not a new atomic read protocol. Proof assessment failure is unavailable evidence, never permission to inspect the source.

Matching approval requires the original proposal ID, version and hash. No matching approval is unknown; contradictory approved/rejected or automatic/human records and multiple automatic approvals are unknown. Multiple distinct human approvals can retain a human provenance without re-evaluating current rules. Actual pending review remains pending even with a partial human quorum. Historical eligibility explicitly names its original-request basis.

Executable tri-state controls: completed+matching applied receipt -> true; pending/unstarted or queued attempt0 -> false; the existing qualified rollback/closure assessment matched to the failed receipt and recorded producer -> false; failed zero-row receipt alone, missing/contradictory records, leased/retry/uncertain outcome -> null. Changed observations -> null with unavailable details. The separate replay invocation is false regardless of a later request's effects. MCP text is parsed and compared against structured content in every transport control.

A further Runner presentation wrapper unconditionally replaced every `held` next step with an execution-setup retry instruction. Its condition now requires approved_pending_execution and not_started. Terminal failure/closure, running, retry-wait and unknown instructions survive. No continuation enqueue/admission/worker code was changed.

Normal regression fixtures that previously recreated receipt timestamps on every read were corrected to represent one durable receipt. The queue-positive callback now actually enqueues; a callback label without queue evidence cannot establish queued state. Missing completion evidence now expects null/attention instead of a false effect assertion. Original failed focused attempts remain recorded. Exact captured baseline equals the original structured response byte-for-value; only whitespace differs in tool text serialization.
