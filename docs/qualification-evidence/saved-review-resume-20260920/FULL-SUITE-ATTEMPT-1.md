# First stable suite: failed, preserved

Actual exit 1 on source digest `59f5e52572282a3df1419a5ee05ebfe9c63e880f2af43ae18efe609536db5e48`, commit `5cc6c5d3999f906a995d7028a6ec8e086bfba3ce`. 6,787 passed, 478 skipped, three failed; 326 passed files, 21 skipped files, one failed file. Duration 1,534.37 seconds. Raw complete log and actual exit record remain `gates/stable-full.log` and `gates/stable-full-exit.json` under the assignment raw root. Source was unchanged during the run.

Exact failures in `apps/runner/src/source-counter-host.test.ts`, suite `existing compiled counter host review before policy coverage`:

- `retains exact authority and durable confirmation semantics (decline)`
- `retains exact authority and durable confirmation semantics (save_failed)`
- `retains exact authority and durable confirmation semantics (save_noop)`

All first rejected at line 190: expected one `SOURCE COUNTER REVIEW PENDING` detail heading, received zero. The shared preparation catch had renamed this established heading even for real declined/failed source-counter review. The test's preceding unchanged-authority, saved-confirmation and zero-provider checks passed up to that assertion; the aborted test had not yet established its restart leg. This is a presentation regression introduced by this repair, not an environment failure or evidence of changed authority behavior.

Narrow correction: track whether fresh reader inspection completed and source-counter review started. Preserve the existing counter-specific detail heading for that stage; use the new source-prerequisite heading only for reader-inspection failure. The actual sanitized reason still appears in the first visible paused-review notice. No validator, save predicate, provider prompt, counter commitment or business state changes. Existing heading assertions stay intact; additional assertions require the visible notice plus the real pending/checkpoint error. The later passing focused/full results are separate runs and do not overwrite this failure.

The original stable deadline remains 07:40:54 UTC; no budget reset. No frozen candidate or final paid lane existed when the failures were found. Re-run current-source focused tests, types, selected backend gates, ten offline checks and a separate full stable suite after the correction. No further development-provider sampling is needed for a detail-heading regression.
