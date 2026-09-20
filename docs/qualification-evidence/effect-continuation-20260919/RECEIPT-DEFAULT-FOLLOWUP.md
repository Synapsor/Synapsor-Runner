# Installed receipt continuation: blank Enter cancels the promised default

**FAILED on the unchanged final candidate.** This is an operator input/default integration defect, not loss of saved receipt intent, an execution bypass, or a receipt-engine failure. No repair was applied to the frozen installation.

Candidate: `7b99cc6fdc37db2ee6d357932d1f04fe714be323893a21c4fe768df6e3f96244`; source `b563c88efa34c52e98b3aec74a6e078cfe7d608b`; product/tests `4b4f362aa06cfb0e42005a1f853bc2cc6e408e09`.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/effect-continuation-f83209f-20260919`.

Reproduction, with no provider, worker or business request:

1. Restore `post-publication-controls/published-before-setup.tgz` as a whole directory at the bound logical path, using the isolated preflight/launcher. This is the genuine state after the one recorded public Action publication. Never execute its historical queues.
2. `action review --project-root .` → Verified Action Boundary → Review supervised execution for `release.seal_candidate`.
3. The receipt picker correctly defaults to Source database and displays the exact prior relation/writer reference, marked stale.
4. Choose Source database. The writer prompt says `Enter keeps SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288`.
5. Press blank Enter. Actual: return to the Action menu without schema/table review or saving a renewed selection. Expected: retain that displayed writer reference and continue. Stored selection stays stale; no current execution authorization is created.

Exact failure: `public/decline/terminal-1.log`, `exit-1.json`, `t3-stale-intent-default100x30.txt`, `inspection-blank-return.json`, and `state-blank-return/`. `state-fork/` is the before oracle. Those original attempts remain unchanged.

Trace: `semantic-receipt-setup.ts` calls `session.promptText` with the default only in context text, then interprets `undefined` as cancellation. `boundarySessionForActionPrompter` in `action-tui.ts` forwards context but no default value. Its actual `text` implementation returns `value || options.defaultValue`; empty input therefore becomes `undefined`. A mocked session returning an empty string did not establish the public adapter behavior. Schema and table prompts use the same contract; their blank behavior was not separately executed and is not claimed independently reproduced.

The separate prepared deployment continuation explicitly typed the same three displayed values through the normal operator prompts. It passed renewal, real verification, separate execution authorization and restart. The decline copy subsequently used explicit values and declined execution; the missing-infrastructure copy retained Source database and failed writer verification. These results do not repair or waive the failed blank-default route. This was human/operator entry of displayed configuration references, not a model call, payload replacement or changed business policy.

Next bounded decision: correct the public text/default contract with a real adapter regression that distinguishes blank Enter from Escape; then recheck this narrow installed continuation on a new artifact. Do not change current authority, receipt engines, history or default-decline execution semantics. This handoff does not authorize a worker or business request.
