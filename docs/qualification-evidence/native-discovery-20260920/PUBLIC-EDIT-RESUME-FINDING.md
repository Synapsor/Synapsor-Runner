# Case A: saved numeric edit immediately pauses on public resume

**FAIL for completion of the public resume journey; source-level cause NOT ESTABLISHED.** This is a newly observed downstream stopping point, not a counterexample to portable MCP discovery. No repair or alternate authoring attempt was made on the frozen candidate.

Candidate: `4b33cde27ebfe5b33c9b65e9fcc716b1f6a3a354a137c17848633167798e47d6`; product/tests `b81207e08b7300f6d892f02ce4c2b014dc1894cc`; source `f33d9fd8a2cebc09e24459ba6b6821d5372468dd`.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/native-discovery-3d02c0b-20260920/main-A`.

## Executed route and expectation

1. On the owned deployed Case A, public `action review --project-root .` → verified Action → describe a change → Draft a change. Confirm the existing provider's exact metadata step.
2. Submit the unchanged predeclared request: “Change only the maximum requested release window from seven days to five days. Keep every other eligibility rule, effect, privacy rule, approval class, outcome-specific rolling count selector/window/maximum, receipt choice, maintained-version rule and client duty unchanged. Preserve prior approval history and do not reauthorize old unstarted work.”
3. Inspect the exact disabled diff; explicitly allow saving. The draft is saved. Runner then says “Attached rules review paused,” with no coverage provider request or visible reason. Active authority remains unchanged. Exit normally.
4. Public `start --project-root . --cli` → **Resume the interrupted job** (recommended, authority-review checkpoint). Runner restores the source snapshot, reports the existing Read Boundary retained, immediately prints the same pause, and exits 0. No choice, actionable prerequisite, review result or provider request follows.

Expected: a current review/remaining-prerequisite step, or an actionable explanation permitting normal continuation of the saved job. Exit 0 and a retained draft alone do not complete the requested edit. The final no-progress rule stops this path. The separately offered explicit Review path was not sampled as a workaround.

## Durable result

`MAIN-EDIT-STOP-RESULT.json` and the executable read-only `analyze-final-snapshots.py` compare all 42 logical tables and all 38 source rows.

- Old active Action: `policy:a8e217a549235a1eb6501182850920613c2784524a46b62dc89704329b9cad38`.
- New disabled Action: `policy:6136e62ff8d68da57c915fca78668a22e10fee3a501ff2e60e9316e0eda5309d`.
- Compiled differences: exactly three 7→5 bounds (input, eligibility expression, effect allowed field), matching public summary text, derived digests and prepared-rule timestamp. The UI additionally showed the corresponding review-summary wording change; that is not a fifth compiled permission change.
- Approval classes, catalog, relationship/private verification, selectors and 2/8/86400 accounting remain equal. Every active pointer, including Read, Action, execution and receipt management, remains equal.
- Three proposals, three approvals (two automatic/one human), three queue records, two canonical receipts. The six-day request remains unstarted. No worker was run against it.
- Source unchanged across edit/save/resume. Between saved-edit and resumed snapshots only `control_policy_deployments` and `control_policy_events` changed. Earlier pre-edit→final differences also include the disabled revision/pointer and legitimate read evidence/audit/reference/budget bookkeeping. No whole-ledger byte-identity claim.
- Publication, renewed writer/execution review, post-publication handling, five-day success/six-day refusal under the replacement, and final client recheck: **NOT RUN**.

## Exact evidence and next repair decision

- `operator-captures/terminal-008.log`, `exit-008.json`: edit and exact save permission; 03:31:48–03:42:13 UTC, exit 0.
- `operator-captures/terminal-009.log`, `exit-009.json`: restart/Resume; 03:42:34–03:43:11 UTC, exit 0.
- `authoring-meter/KC-A-14` through `KC-A-20` request/reply captures: seven upstream calls (intro, planning, four component-authoring rounds, permission narration). No coverage call. These are not seven retries or seven business questions.
- `state-readbacks/{pre-edit,edit-save-observed,final-stopped}-{control,source,summary}.json`.
- Saved `.synapsor/boundary-authoring/resume.json`: stage `authority_review`, original edit retained, original reviewed version field retained. The precise failing internal prerequisite/return is not demonstrated by the UI. Read-only inspection of `ensurePolicyCoverage`/`reviewActiveActionRules` identifies possible early refusal paths, not a proven root cause.
- Matching final project/home, source dump, password-free roles, logs and runtime supplement: `../owned-final-states/main-A/complete-manifest.json`. **Final state, not a clean start.** It contains unstarted approved work: do not run a worker merely to inspect/reproduce review. Use a new whole-project/source copy, established logical bind and effective-store preflight; never edit locators or run this original in place.

Next decision: authorize a narrow saved-edit review/resume diagnosis and repair against this exact state. Keep the working discovery repair and prior successful effects. No business-rule redraft or additional final sampling is authorized by this closure.
