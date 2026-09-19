# Next repair decision: saved edit intent and verification metadata

Artifact `23c6ea7b3f128da6d0022efdb2b1ba70650794f1ec42b71086729282dde26fd7`; source checkpoint `e0210e0`; product/test `097c446`. No frozen installation repair attempted.

Root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/public-operation-3eb09c4-20260919`.

1. **Interrupted edit recovery did not implement the retained request.** `public/m4-final-action/terminal-1.log` records the recommended entry, consent, request and valid planning, followed by a harness refusal before the draft request payload was sent. `terminal-2.log` records `start --project-root . --cli` → Resume the interrupted job. It skipped the intended drafting operation, narrated that the old two-check rule remained, and offered a separately declined activation. `state-after/` proves the requested three-check condition is absent. Recovery did not activate anything. This is an observed recovery failure, not proof that an uninterrupted recommended-entry edit always fails.

2. **Verification metadata changed beyond the requested numeric edit.** `public/m4-final-w/terminal-1.log` records start → More options → Manual Boundary editor → W, same exact request. `terminal-2.log` shows its disabled replacement after restart. `semantic-diff-attempt1.json` preserves the failed strict comparison; `semantic-diff-actual.json` and `final-results.json` give exact original/new program paths. Both copies flip candidate-state model visibility false→true and slot-id visibility true→false; only W changes count 2→3. All executable effect/approval/timing/private collection structures otherwise match. The flag reconstruction in `apps/runner/src/action-rule-draft.ts:689` is a trace to investigate, not a complete cause or proof of runtime disclosure. It predates this entry repair. Do not waive these differences without a precise contract decision.

Complete original, before, after and reopened records are retained. Active Read/Action/execution pointers, source_db receipt selection, writer configuration, all business history and source rows are unchanged. No worker, source write, authority publication or receipt provisioning occurred. Saved project archives and database dumps are in `saved-state/`.

The initial privacy-guard harness error is separate: its original denylist contained the publicly reviewed enum `consumed`. It was corrected only for that enum; actual W input13–15 confirms it is the sole old denylist match. The original blocked payload was not captured. Do not present an inferred exact match as captured evidence. Both the reservation and recovery call are counted.

Terra's separate three-response read lane also remains incomplete (`public/runtime-primary/last-protocol-status.json`): discovery, rejected detail+limit, then valid detail. No row read, no fourth response, no mutation. Grok completed the same task. This is a bounded model-behavior observation; not evidence that every client or longer episode fails.

No product changes beyond the named repair were made after the frozen candidate. A separate bounded decision is required before changing recovery or recompilation behavior.
