# Separate decision: failed replay incorrectly described as human review

Observed once on frozen tree `fb6d6d923eb842b5bd2f17decb4b625a4b682b483d3a47aa510f96f8af6710a5`, after the legitimate R1 stale refusal, signed no-effect closure and separate fresh request. This is the model-visible reporting/M3 area explicitly excluded from this assignment. No product change or further replay sampling was made to repair it.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/blocked-closure-4b22b46-20260920/operational/r1`.

Exact reproduction is the preserved `old-reference-replay-plan.json`: unchanged tool name and arguments from the first normally issued reference/request, sent through the generated installed MCP launcher in a new process. Provenance and strict result are in `old-reference-replay-provenance.json` and `old-reference-replay-result.json`. Capture: `mcp-old-reference-replay/results.json`, SHA256 `991944f298ef745e9724e790e53144d62a3b556ee9bce77bc7f835566b7c48a2`.

Actual response: `request_disposition: already_recorded`, `status: attention_required`, `proposal.status: failed`, `authorization.approval: approved`, but `execution: human_review` and proposal text “pending human review because an automatic-approval limit did not pass.” That last claim is false for this request: its original automatic approval remains and no new limit refusal occurred during replay.

The lifecycle result is corroborated independently: one failed old proposal, one distinct approved new proposal; all proposal, approval, queue, job, receipt, event and subject-reference records unchanged by replay. No new work or redirected reference was created. The old failed receipt stays byte-identical, and the old item remains discarded at attempt1 after the later worker executes only the fresh request.

The presentation branch at `packages/mcp-server/src/semantic-actions.ts:672-679` selects this text for a non-approved/non-applied state whose recorded approval path was automatic-eligible. This file was unchanged by the closure repair. This is a source trace, not a separately executed pre-repair reproduction. Operator `worker status` correctly reports discarded, completed attempt1 and automatic_retry_scheduled:false.

A future bounded reporting repair should preserve the old-request mapping and actual approval/failure history. This task does not authorize changing the lifecycle, quota evaluation, model authority, compensation or retry semantics to address the wording.
