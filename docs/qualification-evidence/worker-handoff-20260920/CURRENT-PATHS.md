# Current paths before implementation

Baseline 63aa6648e49c7eb7b3e5d9589835ac5d21b99346. Prepared NEXT-BOUNDARY-O2-P1.md read first. M6 independent acceptance PASS verified against both supplied hashes; no transfer to this later candidate. Historical queues remain unexecuted.

| Question | Current evidence and limit |
|---|---|
| Generated command | verified-action-review.ts:710 emits `worker run --supervised --yes --config <shell-quoted Action config>` after exact execution enable. Prior actual installed effect-continuation deployment capture records this output. No outcome selector or derived prerequisite status/check-only command is supplied. Current help already distinguishes Action config/supervised mode and says credentials/context must be available. |
| Scope and writer inputs | workerCommand(run) → withWorkerLocalTestRuntime → reviewed default local identity where supported → workerRun/readRuntimeConfig. Identity loader rejects contract/file/env conflicts. Worker identity resolves argument, SYNAPSOR_RUNNER_ID, unique reviewed worker identity. Business context is separately resolved by resolveTrustedContext using semanticContextCapability at execution. Exact outcome writer is selected by resolveSemanticSupervisedWriterSource; no model-controlled identity or queue-derived global person. |
| Before versus after claim | Current worker validates execution configuration and worker label before opening its startup store; then writes worker.started/attention context, enqueues, runs backlog/expiry attention and posture checks, claims (attempt increments), calls guarded apply/create job, and semantic writeback later resolves trusted context. Thus adding a check after claim/backlog is insufficient. Existing live PostgreSQL test `preserves the exact missing-binding code in the worker queue instead of a generic execution error` reproduces TRUSTED_BINDING_MISSING, BLOCKED/attempt1 with unchanged source and no receipt. Raw postgres-before.log; programmatic reviewed fixture, not public onboarding. |
| Missing writer | The exact writer binding is already resolved and posture checked before claim where required; a failure may be swallowed as no eligible work after startup bookkeeping. It is not evidence that every absent writer burns an attempt. Shared check should accurately identify the local absence without replacing live posture/per-item checks. |
| Status | Current workerStatus computes summary.blocked from the full filtered list and exposes it in JSON. Human Queue omits blocked and every item prints attempt=n/max. dead-letter list delegates to filtered status, so no matching items says “Worker queue is empty.” Explicit item show inspects any existing id and still prints Attempts n/max. A seeded-state before capture is pending below; no claim of current pagination before implementing a bounded display. |
| Recovery | worker cancel only queued/retry_wait with exact operator/cancellation role, production verified identity; dead-letter requeue/discard only dead_letter and verified signed_key/jwt_oidc identity; requeue checks durable effect receipts. These inspected paths cannot exit blocked. Pauses/capability controls preserve queue truth. Unknown outcomes require reconciliation, not blind retry. No recovery transition is authorized here. |

Implementation boundary: one shared read-only launch assessment from current selected configuration/authority and the supported identity resolver, used by handoff and a real worker check command. Before startup ledger writes, reject applicable locally missing inputs; preserve original per-item checks and multi-outcome scope. Reporting projects existing durable fields, labels attempt history/scheduling, and preserves JSON fields while adding explicit semantics. No accounting/retry/lease/receipt redesign.

Status reproduction: `status04-before` exit 1 is the first product assertion:
JSON already reports one blocked item; human summary omits it, item says
`attempt=1/5`, and an empty dead-letter filter says the whole queue is empty.
The complete four-output capture is `status-before-capture.json` in the raw root.
All application tables remained unchanged. The three earlier status attempts
were synthetic config preparation errors (required source, context, capability),
not product failures; their logs are retained.
