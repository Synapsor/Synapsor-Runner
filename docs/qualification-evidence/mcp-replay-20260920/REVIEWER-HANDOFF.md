# Independent M3/replay handoff — PREPARATION CHECKPOINT

This checkpoint is not permission to use the old artifact as the new candidate. `ARTIFACT.json` and `sealed-starts/manifest.json` will identify the new completed package and untouched R1/T1 starts after gates and public setup finish. Public sequence is NOT RUN yet. Tester owns independent component/transport probes and one T1 episode; main owns stable full-suite/package/backend window. Do not run a competing heavy suite.

Product/tests: 36a5e0e3034127f842a2053048a13ca9e05639a1 on canonical branch. `IMPLEMENTATION-NOTE.md` contains the stored-state mapping, cause, compatibility and read-consistency decisions. `BEFORE-AFTER.json` links the exact immutable independent original response and readonly diagnostic outputs. `DEVELOPMENT-GATES.json` retains failed development attempts distinctly from completed stable gates. `PLAN.json` records raw paths and finite budgets.

The client projection reads original proposal, applicable approvals, queue, receipts/events and the existing control-only rollback assessment. It re-reads those same sets; incompatible or changed observations yield unavailable details. It is not an atomic snapshot. No source read or closure is performed by projection. Approval kind no longer depends on current proposal state, worker continuation label or today's allowance. Historical effect is true/false/null; replay invocation has a distinct no-new-source-effect statement. The original failed receipt and later successful receipt remain separate. Text serializes the same safe object. `ok` denotes successful return of status, not an applied business effect.

Inspect change scope using:

```sh
git diff ae96fb0b2556cb2b9465adfc796fee76389f2eb9 36a5e0e3034127f842a2053048a13ca9e05639a1 -- apps/runner/src packages/mcp-server/src packages/proposal-store/src packages/postgres/src
```

Only two MCP product files and a narrow Runner presentation-wrapper condition changed, plus relevant tests. No proposal-store or PostgreSQL engine change. Stored business state has no migration. Synthetic matrix fixtures are explicitly labelled; the captured-state regression is diagnostic, not a fresh public reference/access test. All provider counts are zero.

Use `BOOTSTRAP.md` and the prepared public scripts for restoration or supported from-empty setup. Never use final-state archives as untouched starts; never rewrite reviewed locator/identity digests or reference lifetime. Create an owned local cluster and new credentials, preserving the exact reviewed role posture. Restore the entire project at its recorded logical path using read-only-root bwrap. The separate archived synthetic signing key is private, not client input. The new installation is immutable and may be whole-directory bind-mounted at its original path.

T1 should have all504 unchanged source rows, no proposal/approval/queue/job/receipt/intent history, actual source_db receipt infrastructure, a narrow nonadministrator writer, signed recovery operator, separately reviewed Read/Action/execution and a current generated four-tool local client. Perform own-context Read and worker check before requests. Main waits for actual independent restoration confirmation before consuming R1 and retains its container until restoration prerequisites are established.

Independent final limits: one90-minute episode, at most12 request_change calls including replays/refusals, four finite workers, one intended Runner business effect, one fixture-owner candidate-version increment and a finite predeclared closure/inspection set, zero provider calls. Stop substantive product failure; preserve harness errors separately. Recheck ordinary TTL/access; do not forge an old reference. Compare every logical control table, config and all source/receipt rows around each replay; report SQLite byte-only changes separately.

Prior independent narrow recovery acceptance remains attached to fb6d6d923eb842b5bd2f17decb4b625a4b682b483d3a47aa510f96f8af6710a5. Its separate MCP wording FAIL remains historical. Current candidate recovery preservation and replay acceptance need their own evidence. No universal recovery, multi-host, production or Stage B claim follows. Original Stage B is ATTEMPTED / NOT PASSED; M4 gaps and broader M3 private-reason disclosure are separate. `NEXT-QUALIFICATION-DECISION.md` is a proposal for a later bounded decision, not a new qualification run.
