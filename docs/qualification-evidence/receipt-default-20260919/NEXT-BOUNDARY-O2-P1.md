# Read-only preparation: worker handoff and blocked-work reporting

Prepared after the primary M6 handoff on product `8ce338988da92ea37eb6711153965a7ce873440a`; under ten minutes of source/evidence inspection, within the separately declared 30-minute ceiling. No worker/status/recovery command was invoked, no live queue opened, no product edit or recovery implementation performed. This is a proposed next boundary, not a fresh reproduction or acceptance result.

Historical evidence: `/home/sandesh-tiwari/Desktop/Synapsor Tutorials/software-model-free-20260915/TICKET-BLOCKED-PROPOSALS.md` and the current CODEX-WORKLIST.md O2/P1 entries. Preserve their original observations; the source below qualifies what remains current.

## Current launch contract

`verified-action-review.ts:710` still prints `worker run --supervised --yes --config <exact Action config>` after separately reviewed execution enable. That line does not enumerate trusted-context references. Current `cli-help.ts:1548` already distinguishes the Action config from the primary Read config, supervised from legacy mode, and says reviewed writer credentials and trusted identity must be available. It also says enabled execution is not a running worker and approval is not completion. Do not report those explanations as wholly absent.

`worker-runtime.ts:41–64,655–797` requires the reviewed config, enabled supervised execution, valid policy, exact applicable authority/digest, canonical store binding and an appropriate worker identity. Identity comes from `--worker-id`, then `SYNAPSOR_RUNNER_ID`, otherwise the unique reviewed policy identity. Ambiguous or mismatching policy identities are already refused before claim. Current execution config and binding are refreshed before enqueue/claim; no hot switch on changed bindings is promised. This is already implemented behavior, not a new preflight proposal.

Business credentials: use the reviewed source read connection reference and the exact selected `write_url_env`. In this owned M6 fixture those names are `DATABASE_URL` and `SYNAPSOR_WRITE_RELEASE_SEAL_CANDIDATE_77988288`; never print their values or substitute an administrator connection. Source_db additionally requires the reviewed receipt infrastructure and permissions. Separate receipt selection, current verification and exact execution authorization remain necessary; M6 deliberately did not grant the latter.

Trusted business context is distinct from the worker label and operator decision identity. `operator-authority.ts:6–24` resolves reviewed `tenant_id_env` / `principal_env`, with defaults `SYNAPSOR_TENANT_ID` / `SYNAPSOR_PRINCIPAL`; named contexts must match, and other providers require their supported session instead of an environment override. Missing values produce TRUSTED_BINDING_MISSING. A future handoff must derive names from the actual reviewed configuration, not always hardcode these defaults.

A relevant current improvement: `workerCommand(run)` already wraps `withWorkerLocalTestRuntime`, which loads the reviewed default project local-test identity when the Action project root is present. `local-test-runtime-identity.ts:248–363` validates project/contract, containment, file ownership/private mode and conflicting inherited environment, then restores the prior environment on exit. Therefore the historical claim “the printed command always fails unless two variables are exported” is not established on current code. A valid default local identity may satisfy the prerequisite. Named client profiles do not automatically prove a worker selection; this inspected worker wrapper passes only projectRoot, not a profile reference. No new identity mode or worker launcher selection was designed here.

## Current reporting and recovery limits

`worker-runtime.ts:85–125` already has **summary.blocked in JSON**, and JSON includes raw queue status/attempts plus applicable recovery/authority assessment. The human Queue line still omits the blocked bucket and prints `attempt=n/max` even for BLOCKED. Both paths say worker health is unknown: queue state is not liveness. The missing JSON data model alleged in older wording is not current.

`finishWorkerFailure` at :914 and `isRetryableWritebackCode` at :1018 retain the narrow supervised retry set: DATABASE_UNAVAILABLE, TEMPORARILY_UNAVAILABLE, TRANSACTION_FAILED, IDEMPOTENCY_RECEIPT_IN_PROGRESS. Non-retryable supervised failures become blocked; unresolved outcomes require reconciliation. No recovery text for TRUSTED_BINDING_MISSING or SEMANTIC_AUTHORITY_STALE is established by the current switch. Blindly retrying stale work is not a valid reporting fix.

Existing supported operations, with their limits:

- `worker status --json` / human status inspect queues; `worker dead-letter show <id>` can inspect a specific item and retained receipts/events, while dead-letter list filters that state.
- `worker cancel <id> --yes --config <exact config>` only accepts queued/retry_wait, before lease. It resolves operator identity and required role, enforces retained cancellation-role authority, and requires verified identity in production. `worker-cancellation-authority.ts` already protects retired-digest production cancellation without a role snapshot. This does not establish a route out of blocked.
- `worker dead-letter requeue/discard` require a verified signed_key or jwt_oidc decision and only accept dead_letter. Requeue refuses when a durable receipt proves the effect completed. Neither works for blocked.
- Signed-key controls use `--identity` / `SYNAPSOR_OPERATOR_ID` and `--identity-key` / `SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH`; JWT uses its configured token source (default name SYNAPSOR_OPERATOR_TOKEN). Development identity/roles are not a verified signing identity. No credentials were read or provisioned here.
- Pause/resume/drain and exact-digest capability controls preserve queued records; they are not blocked-item recovery. Existing changed-rule diagnostics already identify unstarted stale authority and guide eligible queued cancellation; do not redo that work as a missing feature.

The inspected cancel/requeue/discard paths do not exit blocked. A supported remedy for the historical blocked cases remains **not established** here. No universal no-remedy claim is inferred from this bounded source read.

## Proposed next assignment boundary

First, complete the worker handoff from actual reviewed configuration: exact Action config, writer/reference and trusted-context prerequisites, supported local identity behavior, worker identity, current execution applicability, and accurate status/receipt completion criteria. Pair this with human/JSON consistency for blocked counts and terminal attempt language. Keep disclosures to names/status, never values, and preserve existing guards.

Separately design supported recovery transitions with explicit state, lease/dispatch, receipt/outcome, current-authority and operator-identity requirements before implementing any. Do not assume queue resume or new environment values can revive blocked work. No requeue/cancel/re-derivation, new identity setup, worker preflight change or compensation is authorized by this note.

Approval ceilings count approvals, including committed approvals whose execution later blocks. They remain consumed until the existing window expires. Status work does not authorize changing this metric or refunding slots; the older ticket's suggestion to count completions/refund is not adopted.
