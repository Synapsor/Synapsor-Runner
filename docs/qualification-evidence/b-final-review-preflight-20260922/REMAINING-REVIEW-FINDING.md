# Published B Review: invalid response and correction stop

The funded public Review did not complete. The unchanged installed product correctly selected active15, received one complete response, refused invalid coverage and retained the pending Review. This is a completion failure with safe refusal, not an observed authorization or receipt failure. No repair is made in this assignment.

## Exact evidence

Tester root: `/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/independent-phase-review-20260922/case-b-final-review-20260922-attempt1`.

- `authoring-meter/TESTER-B-FINAL-REVIEW-1-request.json`: SHA-256 `50cb96f14e84b773c4aa0198c4b463259a60fa103f57ccda12bfb07a4572101f`.
- `authoring-meter/TESTER-B-FINAL-REVIEW-1-response.txt`: saved permitted SSE capture SHA-256 `814e047baf65a4cf56b170673223fe74e5c7442d832bfccbd4e59d273c1eada2`. The meter separately records the received body's pre-redaction hash `8227780c82a6104812048c0a86e4d4ee4c1f081e4be7ec3bed5575dfcf08ef3d`; these are different serialization/disclosure contracts, not evidence of file mutation. Opaque private continuation remains withheld. The capture layer never rewrites the response delivered to Runner.
- `captures/terminal-001.log`, `captures/input-events-001.jsonl`, `records/ACTIVE15-REVIEW-RESULT-001.json` preserve the public menu, separately confirmed new bounded episode and refusal.
- Complete before/after snapshots: `private/LOGICAL-SNAPSHOT-BEFORE-REVIEW-002.json` (`364f02a52f36dd79c76874f2191493e8c78487eef77790445cd7b71879b51a1b`) and `private/LOGICAL-SNAPSHOT-AFTER-REVIEW-001.json` (`8aea0e1ae87c2b867635f43e839454bbd6571ba52e4ccc8d3ddc423e183944ad`). These contain private records; do not publish them or mount the evidence root into an authoring process.

Main trace root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/b-final-review-preflight-8d70613-20260922`. Read `REVIEW-FAILURE-TRACE-002.json`, `COUNTING-SUPPORT-WIRE-001.json`, `REUSE-CONTEXT-COMPARISON-002.json` and `MAIN-FULL-STATE-COMPARISON-001.json`. The first trace is retained; version 002 checks the complete existing receipt-proof predicate.

## What failed and what reached the provider

| Response component | Exact finding | Actual evidence and consequence |
|---|---|---|
| `/passages/18/counter_requirements/0` | `COUNTING_SUPPORT_MISMATCH` | The canonical selector is correct, but the optional counter citation names operator message 2. The current wire context supports the requirement through an exact typed `OPERATOR-COUNTING-REVIEW`, not that message. |
| `/passages/19/counter_requirements/0` | `COUNTING_SUPPORT_MISMATCH` | The other counter has its own exact typed review/configuration/path binding; the same extra message citation is unbound here too. No alternative preferred message ID is established. |
| `/passages/21` | `RECEIPT_READ_EXCLUSION_UNESTABLISHED` | Current host exclusion evidence exists. The implemented passage combines receipt Read exclusion, receipt configuration and the business effect, violating the deliberately narrow proof shape. |

Both supplied current/required counter selectors are `energy_ops.finalize_settlement_cycle`. The outgoing context contains established source association and the two accepted counter reviews. The existing diagnostic permits omitting an unbound **optional** citation while retaining the claim and authentic host/source proof. It does not authorize changing selectors, deleting a claim or inventing another owner answer (`authoring-counting-requirements.ts:159–164`).

Passage 21 has these three paths:

```text
/runner_evidence/actions/energy_ops.finalize_settlement_cycle/effect
/runner_evidence/runtime_contract/receipt_configuration
/runner_evidence/runtime_contract/receipt_read_exclusion
```

Main checked every `currentReceiptReadExclusion` condition against the exact request: host origin/scope, excluded flag, current configuration and digest, selected Read and graph digests, generation lock, source/mode and destination bindings. They pass. `authoring-obligation-review.ts:122–127` additionally requires exactly the isolated receipt-exclusion path and no unrelated claim fields. That confinement fails. The shipped prompt already requires isolation; its presence does not make the submitted mixed passage valid. This result does **not** demonstrate absent receipt infrastructure, stale exclusion proof or a privacy leak.

The host produces all three findings. The two counting findings are structural; `RECEIPT_READ_EXCLUSION_UNESTABLISHED` is classified non-structural by `authoring-coverage-feedback.ts:135–138`, encompassing missing/stale evidence and mixed shape under one code. `authoring-policy-coverage.ts:841` continues correction only when every finding is structural. Therefore no correction request was sent. Do not say the model ignored a counting-specific correction: there is only the initial request/response on the wire. No favorable replacement was constructed or tested.

The independent tester classifies this as correct safety refusal of an invalid provider report, with no demonstrated host product defect. A separate decision may consider bounded correction-classification work that distinguishes a malformed use of **present, current** narrow evidence from unavailable evidence, while keeping confinement and full replacement validation. This assignment neither changes that classification nor establishes that a hypothetical correction would pass all remaining validation. It is not permission to mark every receipt error retryable or to weaken the proof.

## Reuse and persistence

The context recomputed from the exact wire draft plus preserved source/messages/clarifications/interpretations equals the new persisted episode context `sha256:d3cdd78c9d1e9a66710ca6a6adf1f1c3930328922d23d26022acdac7a15f22e4`. Prior coverage context was `sha256:e802feed2f4c267cb884cc7fe4866c6ea7851bfa0c300535aadaf77a75562557`; its draft digest also differs. Thus the exact-context reuse condition at `authoring-prepared-policy-review.ts:93–100` was not satisfied. The exclusive changed draft dependency is not established; this is not a demonstrated cache defect or a claim that all published jobs need another call.

All 42 application-store tables, all five source tables (196 business rows plus two receipts), and configuration membership are unchanged. The sole JSON difference is the append of `/coverage_episodes/10` to the saved policy-source session. Prior episodes and every other field remain equal. Invalid coverage acquired no ownership/readiness and changed no authority, proposal, approval, queue, job or receipt. Restart/recheck was not run after this substantive failure.

The episode used one OpenRouter `openai/gpt-5.6-terra` transport, HTTP 200 with complete capture, costing $0.166652. Key access and the whole episode were funded. Funding is not this failure's cause. No new business request, worker, publication or effect occurred.
