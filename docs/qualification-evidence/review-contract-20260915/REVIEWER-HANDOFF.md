# Independent verifier handoff

Status: preparation in progress; final installation and delivery manifest are recorded at closure. This document is not an acceptance verdict. Read FINAL-REPORT.md, SCORECARD.json, IMPLEMENTATION-NOTE.md, development-results.json and remaining-receipt-review.md first. Claude owns final sol trials and independent controls, not another concurrent full suite.

## Identities and starting state

Canonical branch: `codex/tui-safe-action-control-plane`. The complete product/test commit is in product-revision.json. Original baseline9966b59, maintenancea49d612, operation65395f6 are separate from final evidence/freeze commits. Candidate identification must use the full installed-artifact-manifest.json and tree hash, including every file, mode and symlink target. Do not infer identity from version1.8.0, source commit alone or either historical package.

The two untouched clean starts have a 207-entry manifest SHA256 `a37fe3bdd53313a598889837b867a480750e2488ae258f758295dd8f94de0e9d`. See clean-starts.json for exact whole-project snapshots and matching source dumps. Each source contains8events+96results. A uses the saved recheck-requested v1 job. B uses wording-stopped v2, no accepted current-v2 counting decisions and only old-source coverage. Do not use the new development/final reviewed projects as clean starts.

A source: `sha256:2491df8d3397e186e260447ee6487ac008a5134c86f22d256aebc67b6452c5f7`.
B source: `sha256:43b32189678511fe66cfa821c92c029270c134152cc2f4d34dc5efbf2aeb69aa`.
Saved Read: `sha256:6c6196b167fe621caf480cd2b2a4449ef083315cebaf044cc5bcb1660985efd3`.
Saved Action: `sha256:3431e33b5c7ef594c67b545c33ae8285cbd919ff01c91bf35f5d72581ad2ea3e`.

Create a new owned harness/evidence root. Copy the recorded helpers/plan there, set only its owned output paths, point frozen_root at the unchanged candidate and case checkpoint_root at the appropriate immutable clean start. Preserve the original logical project/store paths with the existing whole-directory bind isolation. `prepare-known-run.mjs` restores the matching dump/role ACL prerequisites into a new task-owned PostgreSQL17 container with no network. It does not modify authority or business rows. Review the recorded helper before use; do not run it with this task's existing output root because it refuses overwrites. Do not hand-edit reviewed identity/store bindings to relocate a job.

## Public route and observations

Run `start --project-root . --cli` on the owned logical project through the installed harness. Choose **Choose a different drafting model**, **Change the model for openai**, `gpt-5.6-sol`, then use **CONTINUE SAVED JOB WITH SELECTED MODEL**. Allow only the displayed exact metadata/source transfer through the normal consent steps. Existing configured key handling stays private; neither credentials nor concrete runtime identity/source rows belong in authoring input or shared logs.

For A choose **Resume the interrupted job**. It uses the exact ordinary saved recheck: “Recheck the current saved rules against the attached policy and existing decisions without changing the rules or authority.” Observe the actual planner response before the shared coverage handler. If the existing legacy request prompt appears, confirm **This saved request was review-only**, because that is this exact request's recorded intent. No new counting answer should be required. A direct Review button is a separately labelled control, not proof of the ordinary-language route.

For B choose **Review attached rules and unresolved decisions** after model choice. This deliberately bypasses planning on both models. Confirm the legacy request's review-only intent. The complete already-attached v2 text must be present without a new upload. For each genuine unresolved allowance, choose **Only automatic Request result ratification approvals** and separately confirm the exact decision. This is an owner choice about the existing source, not new selector policy or a copied primary decision. Any first refusal and the single built-in correction remain in the record. Do not silently switch models or keep sampling after a substantive blocker.

Primary development B is blocked by the new receipt-review classification issue; sol development B completed after one counting-support correction. Preserve both results. Historical secondary B reached planning and was not matched to primary explicit Review; do not revive the withdrawn comparison. This handoff does not claim general provider/model compatibility.

After a completed BUSINESS review, save/exit, restart the same installed artifact and explicitly select Review. Verify the actual persisted coverage, current applicability, completed review history and activity `validated_reuse` versus a new provider call. A CLI exit0 or no-change draft is insufficient. Independent identity, execution/receipt setup and after-execution readback duties must remain honestly pending. No activation, worker, proposal, effect or permission change belongs to these public checks.

## Reproducible checks and evidence

Run deterministic checks using the exact committed commands in `*-exit.json`; run-local.py provides the recorded private HOME, umask0077, writable private /tmp and /var/tmp, NO_COLOR=1 and credential-free environment. Relevant files include boundary-job-operation-contract.test.ts, boundary-job-model.test.ts, boundary-cli.test.ts, counter-maintenance-review.test.ts and the unchanged positive-counting/mixed/domain/readiness tests. Captured baseline response stays invalid; the corrected minimal response in the deterministic continuation is labelled derived.

The single whole-suite command is `corepack pnpm exec vitest run --maxWorkers=2 --minWorkers=1 --testTimeout=30000 --hookTimeout=120000` through run-local.py. Types, the ten offline checks and explicit PostgreSQL control-store review/domain checks have separate exit records. Ordinary PostgreSQL skips are not live-backend passes. Installed PostgreSQL business-source/SQLite-control copies are distinct from those live PostgreSQL control-store tests.

The ten offline commands and their exact environment are in run-offline-checks.py and offline-package-plan-attempt1.json. The frozen archive includes the locally packed Spec, exact lockfile, installed dependencies, prompts and all five entrypoints. Recompute with `node <frozen-root>/freeze-repair.mjs --verify`, and independently walk both directions against the complete manifest. Never patch the installed tree in place.

Full provider envelopes/responses are private under each owned run's meter directory; sanitized hashes/settings/function names and corrections are indexed in development-results.json / installed-primary-results.json. Terminal logs prove actual navigation. Snapshot JSON, per-table read-only oracles, project differences and matching source dumps establish durable state. Original fixture/source/conversation and ledger history must survive; legitimate review bookkeeping and SQLite physical bytes need not be byte-identical.

At closure, reviewer-handoff contains committed source, candidate archives/manifests, exact captures, stopped owned fixture state, untouched clean starts and a separate read-only manifest. All evidence here is implementer-owned until independent review. Historical Stage A remains specific to its accepted artifact. Original Stage B is NOT PASSED; no new Stage B or runtime campaign starts from this handoff.
