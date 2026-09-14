
### Checkpoint: explicit-context and transcript causes reproduced

All four exact PostgreSQL review cases failed before product changes (pg-four-before, exit 1). Both savedActionReadReviewState and readSavedActionJobReview dropped supplied env. The real-PG negative controls exposed the former as well; after threading the same explicit env through both, pg-four-after03 passes all four without changing unavailable authority. after01 is a test expectation typo (wrong missing-env code); after02 preserves the additional ambient-value failure. No fallback was introduced.

The reconstructed full acknowledged checkpoint plus exact generated response fails baseline 218dd24 and saves/reopens on current code (captured-composed-result.json). All three historical trigger texts fail the same original literal guard before 6671302; two already pass current baseline, quota prose is the remaining recurrence. The refused historical candidate itself never reached disk; reconstruction provenance is explicit.

Focused-after01: 189 pass, 1 opt-in skip, exit 0; development source changed in an unrelated test during this run, so this is not stable-source evidence. Failed-save host regression fails before restoring the last acknowledged transcript; combined post-fix checks are running. Selector capture proves model submission 0003 omitted filters and later 0010 added them. Existing normalization does not add omitted filters. No provider calls or frozen candidate changes yet.

Next: finish canonical-selector and pause/restart tests, stable full/types/live/offline gates, then freeze one complete candidate and run the two original recoveries plus one recovered runtime/edit and focused software preservation.
