# Frozen known-case deployment handoff

Both reviewed deployments passed; checkpoint1 is blocked by native discovery-schema compatibility. Do not resume runtime or edit on the assumption this is repaired. No product change, new package, unseen case or new qualification is authorized by this handoff.

Candidate: installed tree `e81826e022472e8dfa342505418c2a1a1d8442c7a6a0cdb953f5b3075b1d3065`,7569entries; product `d450f4c77057d58f393019e090cdc051a827481d`; frozen source `6e87cd2996b1aca3058e5f4086bb743d745e434d`. `BASELINE-IDENTITY.json`, `PRESERVATION.json` and the prior `receipt-review-20260920/FINAL-ARTIFACT.json` retain the exact manifest/archive/lock/entrypoint identities. Reports and measurement helpers in this delivery are separate from those unchanged product bytes.

Raw root:
`/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920`

Independent root:
`/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/known-case-deployment-independent-20260920`

Read `FINAL-REPORT.md`, `MAIN-RUNTIME-BLOCKER.json`, `NATIVE-TOOL-SKIP-EVIDENCE.json`, `INDEPENDENT-RESULT.json` and `FINAL-SCORECARD.json`. Independent report SHA `7a61ba8334ee2b9734a158547522a96db19c6b762f816681bd886bb3c396fa58`; original evidence index30/30entries rehashed unchanged. The additive verifier-round supplement is separately indexed rather than rewriting its original index.

## Short decisive trace

1. `raw/main-A/authoring-meter/runtime-protocol-initial.jsonl`: real Runner initialize/tools-list returns4tools, exact schemas retained.
2. `raw/main-A/runtime-initial/client-output.jsonl`: native init exposes2tools; `proxy-events.jsonl` records the2-versus4 local refusal before reservation/forward. Original no-request capture is retained, not filled in after the fact.
3. `NATIVE-TOOL-SKIP-EVIDENCE.json`: original native cache log explicitly says root-anyOf caused both describe tools to be skipped. Native log SHA `4f01b542e91b701cf686a61ef5782da0dfdc41eb8b09d1a7f1f1049b997d196c`.
4. Independent `fixture-KC-B/runtime-local-diagnostic/{RESULT.json,launch.json,events.jsonl,client-output.jsonl,DIRECT-MCP-CATALOG.json}`: generated configuration directly, no observer, no forward; real catalog4/native envelope2. That folder's generated config and exact native launch are recorded. The underlying provider API restriction was not separately tested.
5. Main `RUNTIME-NONMUTATION.json` and independent `FINAL-COMPARISON.json`: all logical tables and full source equal deployed checkpoint,0requests/receipts/effects.

## Inputs and exact commands already executed

`CONTINUATION-STARTS.json` binds new read-only continuation copies of accepted completed BUSINESS review. A38/B196fullrows. Preserve logical paths `/var/tmp/synapsor-new-stageb-20260920-{A,B}/project`; never rewrite bindings. `prepare-owned-a.py` / `prepare-owned-b.py` show the tested whole-archive/full-ACL restore, exact original source hash, newly generated private passwords, owned PostgreSQL17 image and effective-store preflight. Use new owned destinations only; neither stopped archive is an invitation to run a historical queue.

Example of the actual main public commands (substitute no authority/JSON):

```bash
python3 docs/qualification-evidence/known-case-deployment-20260920/launch-public.py \
  '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/main-A/LAUNCH-PLAN.json' \
  start --project-root . --cli
python3 docs/qualification-evidence/known-case-deployment-20260920/launch-public.py \
  '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/main-A/LAUNCH-PLAN.json' \
  action review --project-root .
python3 docs/qualification-evidence/known-case-deployment-20260920/launch-public.py \
  '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/main-A/WORKER-LAUNCH-PLAN.json' \
  worker check --supervised --config synapsor.actions.runner.json --capability release.clear_assessment
node docs/qualification-evidence/known-case-deployment-20260920/runtime-client.mjs \
  '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/known-case-deployment-7be82c7-20260920/main-A/RUNTIME-PLAN.json'
```

These commands are historical reproduction identities, not instructions to rerun in preserved paths. The first3 exited0; the last stopped exit1 with no upstream/business call. Exact100x30operator frames/choices and timestamps are in `MAIN-OPERATION-EXITS.json` and raw/main-A/operator-captures. `apply-a-generated-writer.py` records the exact public-generated SQL application and separate LOGIN provisioning; it changes no RLS/business facts. Worker context came from the separately reviewed local identity, private per-process environment; runtime model had reader DSN only and no operator/provider/writer/identity values.

A complete untouched deployed start is raw/deployed-before-first-request/A; B's is independent/fixture-KC-B/deployed-before-first-request. Final states are raw/owned-final-states/main-A and independent/owned-final-state-KC-B. Full source/roles/project/home/logs were saved before stopping both labelled containers. Credentials are private and excluded from Git; dumps retain ACLs and role dumps omit passwords. Fresh credential recipes are in the restore/admin helpers. Intermediate and final-state archives have distinct labels/manifests.

## Accounting and limits

`COMMON-PLAN.md` and `PLAN-AGREEMENT.json` were fixed before operations. All allocations are STOPPED. `FINAL-BUDGET.json` snapshots actual counters without changing the historical ledger. One neutral real runtime call,$0.03305 native estimate; A1authoring/$0.008688,B1/$0.0118325; combined$0.0535705. Case-runtime/model business calls0,workers0,effects0. Read-only setup/probe/handshake operations are separately labelled. B had2public writer-verification rounds and2reported rolled-back receipt probe results; internal SQL/probe count was not instrumented.

The first neutral preflight's local reservation failure and inaccurate handler-count summary remain in raw/prerequisites with the additive `HARNESS-CORRECTION-1.json`. Runtime-controller preparation and private sentinel distinctions are described in the report. Local capture/budget/named-prefix/stdio-counter checks all passed with0provider calls; these are harness checks, not new product or qualification gates.

No pending human review, runtime eligibility/privacy/replay effect, ordinary-language numeric edit, same-client publication, add/remove, source-transaction concurrency or final runtime restart is qualified by this task. Historical Stage A remains artifact-specific; original Stage B and failed NEW-SB remain ATTEMPTED / NOT PASSED.
