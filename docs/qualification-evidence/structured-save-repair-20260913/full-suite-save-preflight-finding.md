# Named structured-preflight regression found by the full suite

Completed stable-full on 1c4c22a: actual test exit1, 6132 passed/2 failed/461 skipped; 295 files passed/1 failed/21 skipped, 1187.55 seconds. The run-local wrapper returned0 after recording the child exit1; the test result is failure, not wrapper success.

Exact existing tests in apps/runner/src/cli.test.ts: runner cli > returns one JSON failure for invalid start structured input without legacy fallback; same for onboard. Expected the fresh root to contain only invalid-draft.json after submitting `{}`. Actual root also contains .synapsor. Both calls still return the expected single JSON validation failure; no source/policy assertion is weakened.

The new structuredExecutionContext preflight is entered through withProjectRuntimeAdmission before parseStructuredDraftInput. That gate necessarily creates .synapsor/runtime-admission.sqlite, even for invalid JSON structure on an uninitialized root. This is a named-path regression in 1c4c22a, not an environment timeout or the prior migration defect. Gate acquisition is not filesystem-read-only, although it grants no authority.

Keep the running full suite on unchanged source. After its actual completion, the bounded correction is to validate the bounded local draft input before acquiring runtime coordination; the valid draft still performs full existing context preflight and final save checks. Preserve these unchanged CLI assertions and use their failing-before result as the regression. No gate/parser/identity relaxation or removal of established lock files. Preserve this full attempt and its eventual exit; focused reruns must not turn it into a full-suite pass.

Correction after completion: bounded draft-file read and structural parse now precede runtime admission. Existing assertions unchanged. A maximum of one additional final full run is explicitly recorded as a budget amendment for this named repair iteration; the first attempt and all elapsed/count budgets remain. No additional full-run loop is authorized by this plan.
