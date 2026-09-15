# Timeout repair handoff

This is implementer-owned local evidence, not a cross-vendor qualification or independent acceptance. The prior cross-vendor report remains NOT ESTABLISHED; incomplete-response refusal and privacy filtering remain correct. The separate receipt-review blocker is unchanged.

## Reproduction and repair

Read IMPLEMENTATION-NOTE.md, before-handoff.log/exit.json, after-handoff.log/exit.json, focused-timeout.log/exit.json and combined.log/exit.json. Both normal Start/onboard handoffs failed before with requested300/observed120 seconds on the planner AND its built-in correction. After, the same assertions cover300/default120/600/1 on successive starts of the saved metadata. Metadata inspection occurs once. These are actual public command-function handoffs into the real planner with injected synthetic inspection/provider transport; they are not external model calls.

The new transport-scope tests also reach actual coverage/narration configurations for all four adapters, stop with a deliberate cancellation at transport, and prove concurrent/nested scope cleanup and unchanged Ask defaults. They do not claim completed policy reviews. All12 former hardcoded configurations read the per-invocation scope. No timeout value enters model messages, authority, saved policies or credential state.

The report's diagnosis needed one correction: --timeout WAS parsed and validated; it was forwarded only to post-activation Ask. Authoring now receives it. Default120 remains. Whole seconds1..600 reuse existing strict validation; transport retains its clamp. Re-supply the flag at each restart. Each bounded correction gets a separate deadline;600 may mean up to1200 seconds for two attempts, plus separately requested calls. No session deadline or success guarantee is implied.

## Operator route for your next owned trial

Use the NEW installation identified in installed-candidate.json, not either old package. In a whole-project owned restoration using the existing effective-store/logical-path preflight:

```bash
"/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-timeout-6a9ed0b-20260915/frozen/installed/node_modules/.bin/synapsor-runner" start --project-root . --cli --timeout 300
```

The same option works on onboard db --cli. Retain your declared provider/model/order, metadata consent and budget; longer requests need not succeed. No credentials or source rows belong in authoring messages. Selecting an OpenRouter catalog model does not establish an eligible endpoint: the picker explains parameter support, denied data collection and disabled fallback before current/listed/exact selection. This is selection-time guidance, not an endpoint eligibility preflight/filter. Do not report it as proof that the previously unavailable Qwen model now runs.

Both clean starting checkpoints and existing fixture/isolation instructions remain at the previous review-contract-20260915 handoff; they were not modified. Keep A's matched planner route distinct from B's explicitly chosen Review route. This repair adds no authoring calls or case decisions.

## Exact local checks

Every executed command and exit is in *-exit.json and offline-package-plan-attempt1.json. No full suite or live PostgreSQL gate is repeated in this narrow transport/selection change; prior green results belong to45ce2a9d only. The new installed smoke covers public help and invalid-value refusal before source inspection/save; successful overridden transport is composed-test evidence. No database, worker, effect, receipt or model campaign ran.

Recompute the complete installed artifact using its frozen/freeze-repair.mjs --verify and installed-artifact-manifest.json. It records all file hashes/modes/symlink targets, node, Spec, dependencies, lock and entrypoints. Product/test/frozen-source/report identities are separate. See FINAL-REPORT.md for completed results and exact final tree hash.
