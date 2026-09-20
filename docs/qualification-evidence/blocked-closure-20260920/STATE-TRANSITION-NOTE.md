# Proposed blocked closure — evidence challenge, before implementation

Baseline 4b22b460d80eaa246ad4fd0928dc541a49833c81. No product edits yet. Zero provider calls.

## Concrete W2 and producer boundary

Original read-only state is `Progress docs tracking/r13-e07-20260911/worker-handoff-63aa664-20260920/operational/w2/state-refused`. W2 has one failed proposal, one retained automatic approval, one blocked queue item, one claim (attempt 1), one v5 PostgreSQL job, one v5 source_db control receipt, no live lease, no delegated effect admission/receipt and no runner-ledger intent. The source receipt snapshot is empty. Its control receipt binds both reviewed atomic targets and all semantic proof digests, reports SEMANTIC_AUTHORITY_STALE/refused/zero effects. No source observation alone establishes the historical outcome.

The actual adapter path is `applyPostgresJob -> applyPostgresJobWithClient -> sourceTransaction -> claimSourceReceipt -> mutatePostgresSemantic`. All facts are verified before mutations; a failure in any atomic member throws. `sourceTransaction` acknowledges ROLLBACK before propagating an ordinary failure. Failure to acknowledge COMMIT or ROLLBACK becomes SourceOutcomeUnknownError and a reconciliation result, never the ordinary failed result. Source receipt claim and business writes share that transaction. The failed v5 result is converted by `toExecutionReceipt`, checking job/proof/every atomic target, then recorded in the control ledger before the lease is terminally blocked.

**Question under challenge:** does the combined canonical failed receipt + exact job + one complete lease attempt + this producer contract sufficiently establish an acknowledged whole-transaction rollback? The receipt does not itself persist a transaction-phase/rollback-ack field or historical database endpoint identity. Its semantic `refused` value is synthesized from the safe code, not independently persisted verifier-phase evidence. We must not infer more than the producer guarantees. If this is insufficient, legacy W2 must remain unavailable; any narrow future producer evidence must be emitted only at the authoritative acknowledged rollback boundary, never inferred retroactively.

Earlier uncertain attempts cannot be excluded from a final error alone. Initial support will require exactly one fully correlated claim/job/receipt/terminal event; all earlier/multiple/ambiguous attempts refuse. Delegated admissions, runner-ledger reconciliation, handler/MySQL modes remain unsupported. Live source lookup must use the exact bound source/idempotency identity and exclude any applied/in-progress/contradictory receipt. Missing/uninspectable/mismatched source binding refuses. Current business row equality is not required and cannot prove history.

## Transition and authentication proposal

Use the existing `discarded` worker disposition and preserve proposal `failed`, canonical receipt, job, approval, attempt count and every old event. Add one attributable no-effect closure event, bound to exact assessment evidence and signed decision. No new queue/job/proposal, no refund. A shared side-effect-free assessment supplies both preview and definitive transaction; mutable state is revalidated under the existing writer transaction/CAS. Source observation happens outside broad locks and must bind immutable attempt evidence. Competing closes acknowledge one durable event; stale previews/partial saves cannot release anything. Existing blocked states are not scheduler claim candidates; discarded remains terminal across reconstruction. Old receipt/job replay must remain old.

Use existing verified signed_key/jwt_oidc operator authentication, the queued cancellation-role snapshot where present, and existing apply/control role requirements. No dev_env or worker identity substitution. Existing public configuration is documented in `docs/runner-config-reference.md` (Signed operator keys): operator map with public key and roles, private key supplied by `--identity-key`, exact decision signed/verified. No new authentication mode. Administrative closure must not require current Action authority; fresh requests do.

## Duplicate/accounting trace and pending checks

`findActiveProposal` includes only pending_review/approved/pending_worker: failed W2 is excluded already. Thus no duplicate override is proposed. This is code inspection, NOT yet an executed fresh-reference result. Test old reference replay and newly issued reference separately before claiming behavior.

Actual semantic approval counting joins approved automatic approvals to proposals and filters boundary, inclusive timestamps and applicable selectors; it does not filter proposal state or queue disposition. Keeping both records untouched should retain consumption. Must exercise the real evaluator with legitimate history and available/exhausted tenant/overall controls.

## Live evidence prerequisites

Four untouched 504-row genesis starts (implementer R0/R1, tester R0/R1), source_db infrastructure, narrow writer, reviewed client and signed recovery operator are required. Historical final queues are supplementary readbacks only. Tester restoration validation precedes final scheduling. No final source effects or heavy gates started. Main task owns heavy window; request read-only challenge now, fixture package validation later.

## Challenge resolution (before product changes)

Read `recovery-independent-prework-20260920/CONTRACT-CHALLENGE.md`, hash 159d9bed2ae952b7fc62845dfe88ff243d1b1e12ead1ceac509226cc09285f0e. Accepted: historical W2 is ineligible, no retrospective proof. Add a narrow producer event for future v5 PostgreSQL source_db acknowledged rollbacks, recorded with the canonical failed receipt in the existing transaction. Bind exact normalized job, every effect, receipt bytes, source destination/receipt namespace digest, attempt/lease and a versioned producer contract. No callback is exposed to model/runtime tools. Unknown commit/rollback never emits proof. The full signed confirmation binds the assessment digest using the existing operator-decision reason field; explicit queue control role is mandatory (null/legacy refused). No new auth mode or recovery ledger. Public fixture execution review must configure the existing control_role so newly queued work snapshots that authority.

## Implemented role and producer contract refinement

The initial proposal above required a non-null queue cancellation role. Actual semantic queues deliberately permit explicit null. The implemented contract instead requires the failed attempt's nonempty, host-snapshotted existing `operator_identity.apply_roles`, plus the queue control role if present. Null alone grants nothing. Signed-key configuration is the existing documented JSON configuration before disabled drafting and separate execution review; no new auth mode or reviewed-binding rewrite. Its preservation through semantic configuration cloning is confirmed in source. Public fixture verification remains required.

The authoritative adapter event is `synapsor.postgres.source_db.rollback.v1`, only after acknowledged rollback, never unknown COMMIT/ROLLBACK. The host stores `writeback_source_rollback` with the canonical failed receipt in one existing transaction. Exact job hash covers every atomic member. Source lookup rejects filtered/RLS receipt tables and binds the original endpoint/namespace without recording credentials. Initial scope requires one claim and terminal attempt, no outstanding admissions or intents. Prior W2 remains ineligible.

Read-only reviewer challenges on altered repeat and unchecked CAS were reproduced and corrected: repeat binds original digest/source/reason; UPDATE must affect exactly one item. Native PostgreSQL tests observe two handles waiting on the real schema advisory lock, a concurrent restarted worker, one closure event, failed-save rollback and lost-acknowledgement replay.
