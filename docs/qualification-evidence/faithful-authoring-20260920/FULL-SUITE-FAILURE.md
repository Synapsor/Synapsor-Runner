# Stable full-suite failure — preserved

At product/tests `280093e19eb09578046fd7e29ce1b9b7aec17704`, the single stable full suite exited **1**. 322 files passed, 21 skipped, one failed; 6,699 tests passed, 476 skipped, one failed. Duration 1313.36 seconds. The source digest remained `7051bb39076a16e6c698a3c5b61023473afd1d80a61aa00e732807ccc5ea0099` before and after.

Failure: `apps/runner/src/manual-activation-terminal.test.ts > manual activation in a real terminal > 'oversized' at 48 columns keeps review and activation distinct`, line 42. Expected rendered screen to include `Inspect activation blocker`. Actual screen included `DRAFT - ACTIVATION BLOCKED`, `REVIEW PENDING`, `... 18 rows hidden ...`, and the resource footer, but not the expected command text. No activation or unsafe behavior is established by this assertion failure.

The test waits for `EDIT ACCESS` in streamed output and then awaits the current paint promise; that header may precede the complete terminal frame. This is a possible measurement race, not an established diagnosis. One unchanged isolated reproduction is planned. No assertion, wait or product code is altered for this unrelated test. A targeted pass cannot replace the failed whole-suite result.

Exact command, start/end, PID, exit and source inventory: main raw `gates/stable-full-exit.json`, `stable-full-source.json`, full `stable-full.log`. The ordinary suite's skipped PostgreSQL opt-ins are not live backend passes. This failure remains separately visible from A/B authoring results.

Unchanged isolated file run completed at 19:29:56 UTC, exit 0, all six cases passed including oversized at 48 columns. Source unchanged. This establishes non-reproduction in the isolated schedule, not a root cause or repair. The full suite remains FAIL; no further repeated sampling or unrelated terminal change is undertaken.
