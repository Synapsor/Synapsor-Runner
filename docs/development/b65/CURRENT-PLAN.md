# B65 — business-invariant concurrency

T0: **2026-10-08T16:56:15Z**. End: **2026-10-12T16:56:15Z** (96 hours). Integration/acceptance/closeout reserved from **2026-10-11T16:56:15Z**. B64 and demo clocks are unchanged. Owner source: `/home/sandesh-tiwari/.codex/attachments/096c9fda-02d1-4375-9317-f1662aae6522/Pasted text.txt`, plus seven native-matrix additions in this chat.

Main coordinates; runtime/compiler implementer reuses `Luna Independent Tester` task `01a112d4-bd54-7441-b272-5932b16e4971`; independent native tester/reviewer reuses `Luna Independent Tester Replacement` task `01a117fd-4600-76a3-baf7-e404eb16d0d3`. These are temporary B65 roles in separate worktrees/branches/resources; historical Luna jobs/holds/receipts and frozen candidates stay untouched. Existing B64 Action owner provides only the small typed authoring-contract interface. Initial native baseline is Main **2887df78**; pin every actual run.

Both tasks received the complete authorization and matrix additions. First steps: inspect current owners/callers, preseal the matrix and deterministic barriers, unsafe SQL fixture control, then real public proposal/executor races on disposable PG followed by supported MySQL. No product patches in the baseline native matrix; report gaps. Supported-contract repair requires the authorized failing-before/independent review cadence, never altered fixtures or frozen patches. The isolated experimental derived `InvariantProtectionPlan` is non-deployable unless its existing source/scope authority suffices; no new capability/lock service/store/provider budget.

| Native group | Required observation | State |
| --- | --- | --- |
| Hard sum <=50, independent requests30/40 | Both public proposals coexist; one applies, other stale/invalid; exact receipts/effects; both winning orders | NOT RUN |
| Operation/dependency coverage | UPDATE/UPDATE, INSERT/INSERT, UPDATE/INSERT; independent instances; empty/nonempty; update/delete/membership/moves/limit changes; human/automatic approval | NOT RUN |
| Absence invariant | Distinct concurrent rows under explicit none-may-exist rule; at most one applies | NOT RUN |
| Authority revision | Stricter current authority activated after approval governs execution, with clear reason | NOT RUN |
| Competing workers / duplicate delivery | Same approved proposal, one business effect, consistent receipts | NOT RUN |
| Stale lease worker | Takeover completes; resumed expired worker cannot make obsolete/second effect | NOT RUN |
| Unknown COMMIT race | Waiting loser sees committed winner; winner enters B61 reconciliation, never replay | NOT RUN |
| Time boundary | Reviewed period/window semantics remain explicit and correct across approval/execution boundary | NOT RUN |
| PG and MySQL contention | Forced deadlock/lock timeout ends whole business transaction; typed contention outcome | NOT RUN |
| Scope/visibility/writer assumptions | RLS/constraints/isolation negatives; participating vs bypass external writer; complete relevant population | NOT RUN |
| Complete route / isolation | Four tools + genuine approval/worker/effect/receipt; separate from source/component proofs | NOT RUN |

Use independent connections/processes, deterministic barriers and observed waits, never sleeps alone or a harness mutex. Do not require both readers behind a correctly exclusive lock to reach the same barrier. Same-request dedupe and both-refused outcomes cannot prove the positive invariant race. No injected approved states; inability to coexist is a preparation limitation. Multi-step agent workflows (C) are characterization only. Exact canonical invariant-instance guard ignores agent/session/policy-version differences; this is not cross-tenant permission or global writer enforcement.

Resource envelope: isolated HOME/TMP/cwd/DB/ports, plain8GiB free floor, max2heavy jobs/8workers aggregate, B64 priority; coordinate heavy slots with Main. No paid/provider calls; Luna remains CLOSED. Commit/push all safe source/fixtures/WIP/evidence to private backup only. No rootconfig, credentials, ledgers or destructive cleanup.

## Controlling owner clarification

For a declared hard limit, Runner derives the post-change condition from the actual reviewed effect AST: applicable total plus this effect's contribution must not exceed the declared limit; a limit change is checked against current usage. The B64 business contract supplies only limit, scope and population, never a model/operator-authored trusted post-state formula. Pre-state-only eligibility must not be presented as hard-limit enforcement. Audit existing Luna and scripted rules for one-agent overshoot and report exact cases; do not edit those rules without an owner decision. Native duplicate-delivery or expired-worker second/obsolete effects are supported-contract violations, repairable under section5 with failing-before and independent challenge, never a lease-only workaround. These clarify existing B65 scope; clocks, paid closure and frozen artifacts are unchanged.

Capability packet APPROVED by Owner: the existing typed Action constraint may carry an explicitly reviewed hard-invariant designation bound to condition AST, complete scoped population, finite participating effect inventory, time semantics, external-writer boundary and current activated authority. The compiler derives enforceability or refuses using inspected Source evidence; Runner still derives post-state contribution/limit-update checks itself. No new tool/store/lock service/customer table or broader grant. DEV-only pending independent acceptance, not demo/release authorization. Report-only historical rule audit remains unchanged.
