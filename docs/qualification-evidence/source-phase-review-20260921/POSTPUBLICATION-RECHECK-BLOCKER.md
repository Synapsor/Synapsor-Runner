# A: explicit Review cannot find the newly published Action

**BLOCKED, preserved for a separate decision. No repair or revalidation was attempted.** This is a new final-path finding on tree `7b15c368564c356bd9437646901c8fed79d806f253a4c7f1874adc5f20a7a45d`, source `ef685f20b830f0c9a611cf11ad8441b153b29a61`.

After successful saved BUSINESS review, restarted explicit Review, exact five-day publication, separate receipt/writer/execution renewal and one verified effect, the operator exited and used `start --project-root . --cli` → Review attached rules and unresolved decisions. The actual error was:

> POLICY_REVIEW_CANDIDATE_UNAVAILABLE: This job has no saved Action candidate matching the selected Read revision. Revalidate its existing draft before review; no replacement was inferred.

The path stopped before any new provider transport. Choosing Save and continue later exited zero; that exit is **not** a successful review. No new draft, owner answer, receipt-mode change, reactivation or attempted recovery was used.

## Exact evidence

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/source-phase-review-e288ac2-20260921/main-A-final`.

- `operator-captures/terminal-009.log` and `exit-009.json`: start 17:34:11.481467Z, end 17:35:28.440109Z; exit0 after preserved refusal.
- `state-readbacks/{before-native-publication,final-stopped}-control.json`: the Action draft pointer formerly `policy:6136e62ff8d68da57c915fca78668a22e10fee3a501ff2e60e9316e0eda5309d` is now null; the Action active pointer is `policy:38224d09795925014a8efb375cfe93baef232bbf8d09fa40bc3f6f83d934e11e`.
- `PUBLICATION-FINAL-READBACK.json`: complete saved authority exactly equals published authority; digest `sha256:a26bae477f409339e9c284d7e2d6d51f102f20e9e3bf95ae5e26dcb8165accc8`. No inference from a display summary.
- `state-readbacks/final-stopped-{source,control,summary}.json`: full final state. Receipt/effect proof stays in `EFFECT-RECEIPT-READBACK.json` and `canonical-new-receipt.json`.
- `../owned-final-states/main-A-final/` and `../final-operational-seals/main-A/`: complete saved final state, matching source dump/schema/ACL and protected whole-project/HOME/captures. These are **final states**, not untouched starts.

## Read-only trace, not another implementation assignment

At the frozen source, `apps/runner/src/boundary-commands.ts:10632–10647`, `reviewSavedBoundaryPolicy` selects from `listActionRuleAuthorityDrafts`, filtered for the selected Read revision, then throws when there is no candidate and `resume.action` exists. `apps/runner/src/action-rule-authority.ts:434–457` returns stored drafts; it does not include the active authority. The selected pointer is null after publication, while `resume.action` remains. This explains the observed branch without an assumption that the five-day publication or receipt failed.

No supported recovery from this exact postpublication state was exercised. The error's revalidation suggestion is not evidence that revalidation is sufficient or appropriate here. Preserve this state for a separately scoped review-resume decision.

A's earlier BUSINESS completion/reuse and exact effect remain established; its required postpublication authoring recheck does not. B's separate native false-threshold statement is documented in the independent report, not attributed to this code path. Original Stage B remains ATTEMPTED / NOT PASSED.
