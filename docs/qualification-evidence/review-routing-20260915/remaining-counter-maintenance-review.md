# Remaining primary A blocker: counter-maintenance review classification

**A remains BLOCKED.** The installed ordinary-language recheck reached the real coverage reviewer, but BUSINESS review did not complete. Its CLI exit was 0; that is not a workflow pass. No restart/recheck was attempted after this substantive blocker, and no favorable alternate response was selected. B's independent success does not replace A's result.

Candidate: `9faa87dd7e9f22a8ed8e2e8fe41317b6ea47d131465ec1bccac6017b98230de8`; product/tests `cc149a5fb2edac8545963350f8081423d77a3668`; frozen source `01b6c62af836ec580c86730632274a28faa2d9c8`. Primary openai/gpt-5.6-terra, low reasoning, store false, returned service tier default. This is a known-case PostgreSQL business source with SQLite control state, not a PostgreSQL control-store test.

## Actual path and evidence

The public command was `start --project-root . --cli`, through the recorded isolated installed launcher. From **Resume the interrupted job**, the exact stored request was:

> Recheck the current saved rules against the attached policy and existing decisions without changing the rules or authority.

The first actual transport returned `runner__plan_boundary_job` with `status=planned`, `operation=review_rules`, `read_mode=reuse`, `action_mode=none`. The operator identified only this old saved request as review-only. The second transport called `runner__review_policy_coverage`. There were zero new counting questions, no missing-attachment request, no transport failure, no timeout and no coverage correction turn. The operation ran from 02:31:37.121Z to 02:33:02.668Z on 2026-09-15; this elapsed time includes operator navigation.

The current source is v1, `sha256:2491df8d3397e186e260447ee6487ac008a5134c86f22d256aebc67b6452c5f7`. Its saved effect requirement says a successful ratification changes result state plus the maintained conflict counter. Actual provider input includes the exact current effect evidence:

```json
{
  "status": "owner_confirmed_operating_prerequisite",
  "resource": "tournament_ops.results",
  "field": "version",
  "maintenance": "all_writers_increment",
  "proof_digest": "sha256:a64444d8c11ed349977baf58b0b194936114c3898e802aeeac70e802a9803bdc",
  "read_boundary_digest": "sha256:6c6196b167fe621caf480cd2b2a4449ef083315cebaf044cc5bcb1660985efd3",
  "external_writers_verified": false,
  "production_integration_verified": false
}
```

The raw record also carries its generation-lock and role-posture fingerprints. The current host explanation distinguishes a confirmed operating prerequisite from independent verification of external writers; it says formal independent enforcement remains pending **if the policy requires it**. Missing counter attestation is therefore not the observed cause.

The submitted and persisted line-5 passage says:

> The maintained conflict counter is compiled as a private version increment, and the source owner has confirmed the operating prerequisite that all writers increment it; however, external-writer and production-integration verification remain false.

It uses `disposition=needs_decision`, `responsibility=deployment`, `issue_kind=missing_configuration`, topic **Conflict-counter maintenance**, and points to `/runner_evidence/actions/league.result_ratification/effect` plus `/runner_evidence/runtime_contract/source_counter_maintenance`. Its requested next step is to verify every production writer before relying on the control. It has no typed `deployment_prerequisite`.

`isDeferredPolicyDeployment` in `apps/runner/src/authoring-policy-source.ts` only defers the three named exact setup prerequisites. `policyReadinessItems` in `apps/runner/src/authoring-review-readiness.ts` consequently classifies this passage as a deployment item that **blocksReview=true**. The read-only corroboration in `installed-primary-results.json` finds exactly this one blocking item, matching the installed terminal result. Other deployment, assigned client selection and readback items remain nonblocking but unverified.

This is an observed review/readiness classification inconsistency concerning an attested operating contract versus independent production verification. The evidence does not establish missing context, a new counting ambiguity, runtime counter failure or worker failure. It does not justify setting the two verification flags true, broadly deferring all deployment claims, changing policy or forcing this passage to implemented. The next repair decision should establish the correct treatment of that specific source requirement and its current attestation, retaining genuine independent-verification obligations where required.

## Preserved state and reproduction

`installed-primary-results.json` records full sanitized input/output hashes, exact owner evidence, planner output, persisted readiness and pending request. `recovery-tournament-assisted-primary-review-stopped-oracle.json` compares every ledger table. All contents remain unchanged: six proposals, four approvals, four queue entries and two writeback receipts, including existing history. Source readback still contains the matching eight events and 96 results. Read/Action candidates, program, authority and execution configuration are unchanged. SQLite physical file bytes and review/resume bookkeeping may differ; whole-ledger byte identity is not claimed.

The pending review and the exact legacy pending edit both remain because BUSINESS review did not complete. No completed review history record was fabricated. Raw files and the whole-project stopped checkpoint are under:

```text
/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/review-routing-475c5c5-20260915/runs/recovery-tournament-assisted/
  meter/input-0001.json, output-0001.txt
  meter/input-0002.json, output-0002.txt
  logs/primary-review.typescript
  checkpoints/primary-start/
  checkpoints/primary-review-stopped/
```

Reproduce only in a new whole-project restore with its matching source dump and the recorded logical-path/effective-store preflight. Do not run the stopped project in place or execute its queue. `clean-starts.json` identifies an untouched starting copy for Claude's predeclared independent lane. The saved exact response can also be inspected without another model call; `summarize-public-results.mts` is a read-only corroboration, not a second installed trial.

No product or frozen-installation change follows this finding. The primary failure remains even if the independent secondary behaves differently. Historical Stage A remains artifact-specific; original Stage B remains NOT PASSED.
