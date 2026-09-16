# Manual RUNNER ONLY

The two manual access-save builders omit `private_model_fields`, although the existing model revision default supplies it. The shared mutation already removes analysis grants when this subset of withheld fields is supplied. Use that existing behavior only for newly changed manual tiers. No active boundary, old disabled revision or `preserve_reviewed` request is migrated. Separate review/activation remains required.

Scoped Explore already withholds value equality for selected fields with no analytical grants; verify the real manual save feeds that predicate. Keep private Action row loading, trusted scope and relationship proofs intact.

Inspect the separate protected named-read projection before changing it: its fixed reviewed contract currently distinguishes raw withholding, not the model revision `none`/`preserve_reviewed` choice. Preserve existing reviewed comparison semantics and record the routing evidence.

## Reproduction and compatibility

Both manual request routes failed the new composed test before the fix: `security_hold = true` accepted, filter/sort/group retained, equal cells linked. Supplying `private_model_fields` fixes both, with no change to the shared validator or projector. Tests use real disabled persistence and explicit activation in disposable fixtures; active file bytes and active policy objects are checked unchanged before activation. An already raw-withheld status field retains its grants.

The first post-fix attempt only mismatched the existing refusal text; corrected to the exact diagnostic. An added preserve_reviewed control initially assumed preservation of a presence grant; current unchanged model/raw-withhold preparation already omits presence. The control now asserts its exact existing filter/sort/group behavior, with that limitation explicit. Original attempt logs remain. No preserve_reviewed implementation change was made.

Picker/help wording now distinguishes newly staged private manual decisions from existing or explicit raw-withheld analysis. The separate named-read assessment is in PROTECTED-READ-ASSESSMENT.md.

The wider nine-file attempt completed exit1: 713 passed, three obsolete manual/raw-withhold equivalence assertions failed, plus one default 5-second identity-fixture timeout. Changed only those three assertions to the intended new manual behavior, including exact candidate comparison against the unchanged raw-withhold flag path. Identity implementation/test unchanged: all13 cases pass in isolation at the original5-second limit (editorial4214ms, longest4605ms). This demonstrates sensitivity to the outer test limit, not a product coordination diagnosis. The two failed files are rerun with the already recorded repository verification setting `--testTimeout=20000` (prior authoring-correction focused-cli02/stable-full03), without altering any product timeouts or explicit per-test concurrency bounds. Other seven files remain passed on identical product code.
