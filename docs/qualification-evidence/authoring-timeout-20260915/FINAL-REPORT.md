# Authoring timeout and OpenRouter selection — final report

Completed local repair at 2026-09-15T15:30:19.925113+00:00. Implementer-owned evidence; cross-vendor generality remains NOT ESTABLISHED. No provider call or new contract-level model result was produced. Original Stage B remains NOT PASSED; historical Stage A and previous full-suite results remain artifact-specific.

## Change and traced cause

Product/tests `69d1f3f22a76b28779d3f96ef1428ae970c0eabb` follows clean baseline6a9ed0b on codex/tui-safe-action-control-plane. The existing --timeout flag WAS parsed and range-validated in Start, contrary to the report's parser diagnosis; it only reached the post-activation Ask handoff.12 authoring configurations independently chose120 seconds. Before-handoff.log records actual Start and onboard planner/correction requests at120000ms despite --timeout300.

A small AsyncLocalStorage scope now carries the operator invocation's deadline to all12 authoring configurations: planning, coverage, rule authoring, Read mapping/revision/prerequisites, principal scope, interviews, suggestions, parent policy and narration. Replacement of the session/model does not replace the invocation setting. Independent/nested invocations and failure cleanup are tested. No shared process environment, saved policy/identity or model-supplied timeout is introduced.

Use `start --project-root . --cli --timeout 300` or the corresponding `onboard db --cli --timeout 300`. Authoring still defaults to120 seconds for every provider; existing strict whole-number1..600 validation and transport clamp remain. Re-supply the flag on restart. Ask defaults remain30remote/120loopback when unspecified. The diagnostic names the actual control. Each initial/correction request has a separate deadline; a two-call600-second path can take1200 seconds plus other calls. Catalog discovery remains separately bounded. No external latency or success guarantee is established.

The OpenRouter chooser now distinguishes catalog candidates from serving eligibility and explains parameter support, denied data collection, disabled fallback and zero-endpoint refusal on listed/current/exact-ID paths. This is selection-time guidance, NOT an endpoint eligibility filter or successful preflight. In particular the Qwen endpoint remains unverified; nothing here makes it eligible. Runtime privacy restrictions and incomplete-response refusal are unchanged. No new endpoint API/service integration or authoring prompt change was made.

## Verification

| Check | Result |
| --- | --- |
| Before composed handoffs/chooser |5expected failures, exit1; actual120000 vs required300000 preserved |
| Same handoffs/chooser after |5pass,349name-filtered; exit0;300/default120/600/1 across restart; both initial and correction |
| Focused transport/scope/OpenRouter |30pass,189name-filtered; exit0 |
| Combined21files |1326pass,2opt-in skips; exit0; source unchanged |
| Types |exit0 |
| Ten offline gates |10/10exit0, network namespace isolated, installed dependencies/local Spec |
| Frozen installed smoke |10checks complete: Start detailed help, onboard summary help, eight invalid-value refusals; help exits0/refusals1; no source open or project files saved |
| Full suite / live PostgreSQL / real provider |NOT RUN in this narrow repair; prior6407pass/463skip result is not transferred |

The historical6407passed/463skipped full-suite result belongs only to the prior45ce2a9d artifact.

The two combined skips are explicitly opt-in live creation/day-two authoring (SYNAPSOR_LIVE_AUTHORING_PROVIDER) and live admission coverage (SYNAPSOR_LIVE_ADMISSION_COVERAGE). All other selected tests ran, including existing operation-contract and OpenRouter privacy/partial-response controls. Positive deadline propagation is composed-test evidence with synthetic metadata and injected provider transports, not an installed external model run. Coverage/narration transport probes deliberately cancel and do not claim completed review.

Installed harness attempts are preserved separately: attempt1 incorrectly expected invalid-input exit2 (actual established CLI exit1); attempt2 completed Start then incorrectly expected the detailed Start paragraph in the separate onboard help summary. Attempt3 corrected the measurement and finished ONLY the pending onboard checks, retaining completed Start results. No product assertion was weakened, no product behavior or frozen bytes changed. Detailed timeout guidance is in start --help and docs/openrouter.md; onboard's summary points to the same route without repeating it.

## Exact candidate and preservation

- Product/test: `69d1f3f22a76b28779d3f96ef1428ae970c0eabb`.
- Frozen source/evidence checkpoint: `6f8b0f3a31b1eaece01df00b6e058a25e7ccc848`.
- Complete installed tree: `5c5c5eeb0d8a42305d857d5bcc0841c12861dd9bf26798679b2107e2e5a28d35` (7569entries).
- Full manifest SHA256: `0a286a04cce016d9752faea2a865e59641a63dc62c712ab26ef8b03f2ff01ba5`.
- Archive SHA256: `6b50e4210940934e15d5c7d372421fdd7c79a6752c807daf6d18fdb21609dbbe`.
- Installed lock SHA256: `20a4cce6f39d209d78cb69e5c5a7271934a77787ff812dc19ab05d953b44ba90`.
- Installation: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-timeout-6a9ed0b-20260915/frozen/installed`.
- Full manifest/archive and node/tarball/dependency/Spec identities: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-timeout-6a9ed0b-20260915/frozen`.

The new installation is sealed without write bits before hashing and used through a read-only bind. All entrypoints match the tested bundle. The compiled bundle has one timeout scope and12configuration reads. The previous7569-entry45ce2a9d installation and four supplied report/log files were re-hashed unchanged.312 protected tracked files, including packages and selected accounting/publication/identity/review modules, exactly match baseline. Original stores/queues were never opened for this task. No owned database/worker was started; test and packaging processes completed. Existing reviewer processes were left untouched.

Environment: private writable /var/tmp and HOME, umask0077, NO_COLOR=1, no unrelated/provider credentials in tests, network-isolated offline packaging. All test/harness logs and disposable state retained under the owned root. Declared budgets90mdevelopment/80mverification/25mclosure were not reset; provider budget0 and full-suite budget0 were respected. Final elapsed time is recorded at delivery.

## Handoff and remaining scope

REVIEWER-HANDOFF.md contains exact operator instructions; *-exit.json and offline-package-plan-attempt1.json contain exact executed commands/exits. installed-candidate.json and installed-smoke-result.json distinguish package identity from executed checks. Both pre-repair failure and harness corrections remain available. The compact read-only reviewer-handoff directory under the owned root includes raw logs, source archive, candidate archive and complete manifest; its hash is recorded in delivery.json after creation.

Only private backup delivery is permitted. Final branch/commit/remote status is recorded in `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/authoring-timeout-6a9ed0b-20260915/delivery.json`. Claude can now run the declared cross-vendor lane on the NEW artifact with an explicit longer deadline; a timeout fix alone does not establish a contract result. The prior receipt-review issue remains at ../review-contract-20260915/remaining-receipt-review.md and was not reopened. STOP for review; no public release or deployment.

Raw test logs retain their original final blank lines. The delivery whitespace check excludes only raw .log files; no output bytes were trimmed to satisfy formatting.
