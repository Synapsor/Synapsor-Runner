# P1 delayed-work contract — design for a later decision

This is a prospective design and test plan, not a change to dispatch, proof expiry, approval, closure or retry behavior. The [attempt3 assessment](P1-EXPIRY-DECISION.md) observed a semantic-authority proof expiring before the worker's transaction-time fact load. That proof, the subject reference, approval/mandate, business deadline and worker lease have separate purposes and lifetimes. Extending any one timestamp does not validate the others.

## Proposed opt-in new-job contract

If an operator later elects to support delayed dispatch, Runner could issue an **attributed new validation record** for an old, still-authorized queued request. The immutable original proposal, job, approval and proof would remain unchanged. The renewal would be opt-in, disabled by default, bounded by a total job age and a maximum number of validations. Migration and eligibility of preexisting jobs need an explicit decision; no old job gains this route automatically.

The validator would require the **same** subject, trusted scope, inputs, business action, exact derived effects and version guards as the approved request. It would reload current Action and Read authority, execution and receipt selection, trusted identity, all material private facts and complete collections, and compare their current dependencies and effect with the original. It must refuse publication/revocation, changed identity or source, missing evidence, changed dependency/version, changed effect or approval class, and any uncertain source outcome. Initial support should be conservative about changed versions or facts; this is not a material-drift redesign. A fresh source read cannot renew an expired human mandate.

The retained approval must be checked against its original scope, expiry and revocation rules. An already counted automatic admission must **not** take another allowance slot or receive a refund. A separately defined execution-time budget, if one exists, remains a separate check. Human approval is not invalid merely because time passed: its own reviewed scope, expiry and revocation terms decide. A new validation cannot broaden that mandate or silently change the amount or target.

Preparation and dispatch need a coordinated currentness boundary. Existing store admission/lease fencing and source-transaction checks must prevent competing workers, publication or revocation from slipping between validation and execution. The transaction must still reload facts, enforce versions and compare effects under the existing source locks. The product must not hold a source transaction while waiting for a person or model. A lost acknowledgement or uncertain commit goes to reconciliation, never an automatic re-execution. A new validation record must identify the original request, its current authority/configuration, checked facts and time, without copying a signature or editing `valid_until` in the old proof.

Queued-before-dispatch expiry, terminal blocked work and uncertain execution are separate states. Existing proven-no-effect closure is administrative discard, not renewal or retry. A cancelled or replaced queued request needs explicit lineage and duplicate blocking; an old expired item must remain visible with a truthful reason. The current product lacks a supported transition for every such case, so a later design must specify cancellation/replacement, current duplicate behavior, quota accounting and UI status before claiming delayed-work support.

| Future acceptance case | Required result under an explicitly enabled renewal policy |
| --- | --- |
| Only proof age changed; exact operation, facts, authority, versions, approval and receipt path remain current | New attributed validation of the same queued request can permit one guarded dispatch within its new bound; original proof and approval stay immutable. |
| Renewal disabled, total age or validation count exceeded | Refuse renewal and leave the original queued/blocked history visible. |
| Subject, trusted scope, private/complete-collection fact, version, effect or approval class changed | Refuse same-request renewal; a changed operation needs a new proposal and ordinary admission. |
| Action/Read/execution/receipt/identity withdrawn or changed | Refuse; no stale authority or credential substitution. |
| Human mandate expired/revoked or is outside its reviewed scope | Refuse; new fact validation cannot create a new human decision. |
| Original already applied, has conflicting receipt, or source outcome is unknown | Preserve idempotent applied result or require reconciliation; no second effect or assumed rollback. |
| Competing worker, publication, cancellation or acknowledgement loss | Fencing/currentness prevents double dispatch; unresolved outcomes stay uncertain rather than silently retried. |
| Historical blocked item with no role-bound rollback producer | Remains outside the existing authenticated closure contract, even if recovery roles are configured later. |

Future integration work also needs to decouple durable request acceptance/dispatch from generation of a customer-facing answer. An outage after admission does not revoke the stored approval. The current known-case attempt deliberately waits for completed native narration before dispatch; it does **not** qualify asynchronous completion or authorize dispatch from an incomplete turn.
