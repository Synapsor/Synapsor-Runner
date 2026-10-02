# Batch 1: reviewed Read answers and exact dependencies

Status: integrated development draft, **not frozen or independently accepted**. The immutable discovery installation remains product `6acaed5e6fd97f9266de8577ab7322381bc4b557`. This work implements the owner-authorized batch after the independent Round 2 findings. It grants no runtime authority and runs no provider inference.

## Confirmed causes and intended behavior

| Cause | Change | Boundary retained |
|---|---|---|
| F1: an explicit field explanation in an answer received during the same call was unavailable until a later outer conversation save | Resolve exact field definitions from the current attributed answer as well as prior statements; accept the ordinary “field/column” wording | A resource answer does not define every field. Exact references, ambiguity, caller-input separation, currentness and conflicting meanings remain checked. |
| F8: “Show asset display name” manufactured a dependency on another resource's bare `name` field | Do not treat a nested display-name noun phrase as another bare-field imperative | Qualified references and actual positive instructions remain dependencies; omission and privacy checks are unchanged. |
| S08: blank input was an irreversible decline rather than a pending answer | Blank offers one explicit default-No local decline confirmation; No/cancel leaves the question pending | Explicit decline remains available. Escape/EOF do not consent or send. Legacy declined checkpoints retain their meaning. |
| Reviewed follow-up: a genuinely different question for an already answered target could only stop | Save the proposed response, then show the exact prior/new question and answer in a local default-No interpretation review | Model wording cannot itself replace an answer. Exact repeats remain refused; all received responses count against the existing four-response limit. |

The tester agreed these contracts before implementation in independent records1230/1232/1235. Those records are contract agreement, not acceptance of this implementation.

## Response history and restart

The original `clarified_targets` records remain append-only. A host-only reviewed edge binds predecessor/next response indices and full request/answer digests, exact target/category and current context. This preserves repeated identical text as distinct received events. Current meaning excludes superseded records; the model receives separately labelled historical responses rather than a silently rewritten history.

A proposed replacement is checkpointed before its confirmation and is not yet current meaning or a generic policy answer. No/Escape leaves it pending. Resume reopens that exact local review without requesting the answer or generation again. Yes is checked against current Source/context and compare-and-swap state before persistence. A failed save does not acknowledge acceptance. A confirmed decision saved before a process interruption resumes local consumption once through the existing path.

After successful Read mapping, the last assistance checkpoint is retained as inert provenance on the matching saved Read analysis. It is not an active continuation pointer, new approval or source of runtime authority. The existing pending-assistance field is cleared only after the accepted mapping persistence succeeds. No new recovery system is introduced.

## Verification so far

Failing-first evidence exists separately for same-call meaning/target parsing, blank/decline and reviewed follow-up. Evidence root: `authoring-dead-end-lab-20261002/batchfix1-264` under the private progress directory.

Before integration, 156 existing transitive caller test files ran on unchanged product source:146 passed,5 skipped,5 failed. A missing sandbox device bind and non-owner-only fixture umask caused subprocess/PTY/runtime-directory failures. The original failures remain preserved. Re-running only the five affected files with device access and umask0077 passed375 tests with227 retained skips. This is not represented as a second passing complete suite.

Integrated focused checks passed248 tests across existing Read/meaning/resume and new regressions. Twenty-one public boundary cases passed, including native prompt-adapter context, blank/cancel, reviewed replacement, restart, currentness/competing writes and persistence failures. Runner-only no-emit type checking passed. The complete existing CLI test file and five related Read/persistence files then passed563 tests across six files. Settled full/types/PostgreSQL/offline gates and independent installed acceptance remain required.

One new forged-model-witness test initially expected no operator question at all. Existing behavior ignored the extra witness keys but asked its legitimate first question. The tester agreed the corrected oracle before editing it: pending state, no minted host decision, no local confirmation and no follow-up generation. That original failure remains preserved; no product unknown-key policy or previous assertion was weakened. A separate type-only fixture mistake used an unsupported timezone and was corrected to a real mutable resource label for the unchanged currentness expectation.

This batch stays open to independently confirmed causes until2026-10-03T16:00Z (Sat09:00PDT), then settles and freezes once. Product edit cutoff2026-10-04T04:36:53Z; package deadline2026-10-05T04:36:53Z. Historical evidence, financial liabilities, counters and tester independence are unchanged. The tester's separate paid baseline failures are measurements, not automatic repair authority or positive lifecycle passes.
