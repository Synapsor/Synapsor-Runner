# Manual RUNNER ONLY repair

Canonical baseline: `75a65f8123d7be1e4212205179066b6378d2090a` on `codex/tui-safe-action-control-plane`. Product/tests/docs commit: `10769818ce1879f35f227193360606e3bdabd786`. Evidence delivery commit is recorded in the external tracker and delivery.json after push.

## Behavior

Both manual access request builders now set `private_model_fields` for fields moved to RUNNER ONLY, in addition to `withhold_from_model_fields`. This reuses the existing shared restriction; it removes model filters, sorting, grouping and other analysis grants while retaining private host access, scope and relationship proofs. Saving stages a disabled revision. Active authority remains unchanged until normal explicit review/activation. Existing untouched raw-withheld fields and the model's explicit `preserve_reviewed` mode are not migrated.

No runtime validator, projection algorithm, accounting, Action, receipt, identity or permission mechanism was changed. Picker, sign-off and onboarding explanations now describe the manual default and distinguish explicit raw withholding.

## Before and after

The composed regressions execute `boundary review --access` with the real mutation/persistence components, through both direct column save and pending-column/enum save. Synthetic `security_hold` begins with filter/sort/group grants. Before the repair both cases accepted `security_hold = true` after activation and linked equal values across cells. The original failures and patches are retained.

After the repair, the same filter is refused by the real Explore validator: `security_hold is not reviewed for filter operator eq.` Selecting the field remains valid; true/true/false/null return four distinct response-local placeholders, a second response shares none, and the local raw result is untouched. Tests also assert no model analysis remains, unrelated reviewed grants and scope/relationships persist, and the active file bytes plus loaded active policy remain identical until separate explicit activation. This is composed local implementation evidence, not a new installed Stage A campaign or live database qualification.

One interim assertion used the wrong refusal wording. A later compatibility assertion expected presence to survive the pre-existing model `preserve_reviewed` preparation; that unchanged path already omits presence. The final control preserves and asserts its actual filter/sort/group behavior. Those failed test attempts remain recorded; no `preserve_reviewed` product change was made.

## Protected named reads

`protected-read-runtime.ts:tokenFor` still preserves equal-value tokens in the separate named-read surface. Its authority has no private-analysis intent field. A blanket change would alter existing reviewed comparison behavior. The probe and routing trace are in [PROTECTED-READ-ASSESSMENT.md](PROTECTED-READ-ASSESSMENT.md).

The legacy Protect export does not carry the source field's no-analysis distinction. Exported named reads therefore do **not** gain the new manual Explore unlinkability guarantee. Carrying an explicit reviewed distinction into that contract is a separate remaining decision; this patch does not conceal or claim to fix that export limitation.

## Verification

| Check | Recorded result |
| --- | --- |
| Before product fix, both new manual routes | 2 failed, exit1 (expected reproduction) |
| Final focused manual/enum/picker controls | 4 passed, exit0; filtered skips411 |
| Initial full nine-file affected run | 713 passed / 4 failed, exit1; preserved |
| Unchanged identity recheck at original5s | 13 passed, exit0; filtered skips302 |
| Corrected semantic controls | 5 passed, exit0; filtered skips410 |
| Final complete CLI + picker files | 415 passed, exit0; no skips |
| Other seven full affected files | 302 passed on identical product code, in initial combined run |
| Typecheck | exit0 |
| Trusted-core dependency gate | exit0 |
| Offline local runner/package smoke | exit0 |
| Separate named token probe | exit0, characterizes equality; not a private-mode pass |
| Earlier frozen artifact preservation | exit0; full7,569-entry hash unchanged |

Thus all717 distinct affected tests have a passing final file result. This is **not** a green whole-repository suite or a green initial combined invocation. The three outdated manual assertions were corrected; the unrelated5s timeout passed unchanged in isolation. Its precise timing cause is not established. Final two-file execution uses the previously recorded20s outer test profile; explicit test/product timing was not changed. The whole repository suite, live PostgreSQL gates and a fresh installed campaign were not run for this small operator-path change.

 Exact commands, exits, timestamps, full-log locations and source patches are recorded by `verify.py` and `*-result.json`. Each verification used a network-isolated environment, cleared credentials, private HOME/tmp/var/tmp, NO_COLOR and umask 0077. No provider calls, external database connections or customer fixtures were used. The normal offline package smoke exercises only its disposable synthetic local store.

Changed file and rebuilt local package entrypoint SHA-256 values: [tested-files.json](tested-files.json). This is a local offline package check, not a new immutable installed candidate. The earlier frozen tree `4cdd9cd65389a57de238c07775ca9bb22d824bccf9cf9dd8a1e1adb9e2b44284` independently reverified all 7,569 entries unchanged. Original stopped queues and saved jobs were not opened. Historical Stage A and Stage B verdicts are unchanged.
