# Independent review and secondary-model handoff

This handoff is being prepared while stable verification runs. Final artifact identity, primary results and closure hashes will be added before delivery. No secondary run was performed here. Start with `FINAL-REPORT.md`, `SCORECARD.json`, `clean-starts.json` and the final installation manifest; do not infer completion from a prepared harness.

## What to compare

- Baseline `475c5c5ec7d5b5572b066665ddad3ff818117567`; initial routing product `557277d11bba380159febc1dcb88b83b20775a8a`, tests `11ba4805251f39be9df3aeea62d81433ed340071`; final acknowledgement correction and tests `cc149a5fb2edac8545963350f8081423d77a3668`.
- `IMPLEMENTATION-NOTE.md` explains the shared coverage handler, exact pending-review representation, reconciliation and unchanged guards. `prompt-change.json` contains the only added routing guidance and its captured basis.
- `exact-routing-captures-index.json` resolves full original inputs/replies. The normal regression fixture retains full requests and unmodified submitted function-call blocks; encrypted transport reasoning stays in the private raw original, not the Git fixture.
- `before-routing.log` demonstrates A's reuse/reuse plan without coverage and B's redundant text question. The exact responses are also processed by the real planner parser in normal CLI composed regressions; candidate metadata in those tests is synthetic and separately labelled.
- `development-result.json` is development evidence only. Final A/B records must name the same new complete installed tree.

## Reproduce local gates

From `/home/sandesh-tiwari/Desktop/C++/synapsor-runner`, use the recorded environment in `run-local.py`: private writable `/var/tmp`, isolated HOME, umask 0077, NO_COLOR=1, no provider or unrelated credentials. Use a new owned evidence/environment name for any independent rerun; original logs and directories use exclusive creation and must not be overwritten. The full suite already belongs to this assignment's completed run; secondary verification need not repeat a heavy suite.

```sh
corepack pnpm exec vitest run --maxWorkers=2 --minWorkers=1 --testTimeout=30000 --hookTimeout=120000
corepack pnpm typecheck
corepack pnpm exec vitest run apps/runner/src/authoring-counting-domain.test.ts apps/runner/src/authoring-counting-freshness.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --hookTimeout=120000
corepack pnpm exec vitest run apps/runner/src/control-policy-authority-codec.test.ts --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --hookTimeout=120000
```

The last two commands receive only the owned PostgreSQL CONTROL-store URL through `--pg` in the wrapper. No URL is required for ordinary tests. `offline-package-plan-attempt1.json` lists all ten exact offline commands and exits; package checks use a disposable offline npm cache plus the local Spec. A PostgreSQL business fixture with SQLite control state is not the same gate.

## Clean primary-independent starting states

The private `clean-starts/` tree contains A and B copied before the primary trial and marked read-only. It has full projects, matching source dumps, row readbacks and both-direction project manifests. `clean-starts.json` records their hashes; `clean-starts/MANIFEST.json` additionally records every entry's mode/hash. Each has 8 events and 96 results. B has v2 digest `sha256:43b32189678511fe66cfa821c92c029270c134152cc2f4d34dc5efbf2aeb69aa`, old v1 coverage, and no current-source counting decision. A has settled applicable evidence and its erroneous pending ordinary recheck. A's absence of `counting_decisions` records does not mean its existing positive basis is unknown: source/accepted supporting evidence can establish it.

Never run these saved projects in place. In your own owned harness copy, retain `case_sources`' prior run metadata and set each `checkpoint_root` to the corresponding clean-start directory. Set a new `owned_root` and your own finite budgets, leaving `frozen_root` at the verified final candidate. `prepare-known-run.mjs` supports that input override and checks every project file and matching source dump before creating a new network-isolated PostgreSQL fixture. When using a physically read-only handoff checkpoint, it restores owner-only writable permissions on the new project copy (directories 0700, files 0600 with any original owner execute bit); original bytes, identity values and the checkpoint remain unchanged. It creates only the saved role prerequisites and restores exact dump ACLs. It does not modify Runner bindings or grant new authority. The previous metadata supplies the original logical project/socket locators; whole-directory bind mounts map those to the new owned fixture. All writable application launches must pass `storage-preflight.mjs` first.

Helpers live alongside this report and rely on the repository's existing `scripts/qualification-sandbox.mjs` and recorded private provider observer. A copied harness under a new `docs/qualification-evidence/` directory keeps those relative imports valid. Keep private connections, source rows, audit keys and concrete identity files outside Git and authoring input. The installation remains read-only; no activation, worker or source effect is needed.

The primary public launcher uses the existing configured OpenAI credential without logging its value, and the nonmutating provider observer counts every actual transport. Its primary adapter/model/settings are openai/gpt-5.6-terra, low reasoning, store false. Preserve the same preflight, input privacy scanner, complete captures and timeout/call ceilings in the independent lane. Do not reuse the primary B project's newly accepted decisions.

## Public paths

Use a real terminal, logging its complete session, with the immutable installed CLI through the owned launcher:

```sh
node docs/qualification-evidence/review-routing-20260915/run-public-known.mjs recovery-tournament-assisted start --project-root . --cli
node docs/qualification-evidence/review-routing-20260915/run-public-known.mjs counting-wording-control start --project-root . --cli
```

A: select **Resume the interrupted job**. Its saved ordinary request is already the exact recheck; no new policy sentence is needed. If the old pending edit requires confirmation, identify that exact saved request as review-only. Require completed BUSINESS review, zero new counting questions and no phantom pending edit. Exit and restart, then select **Review attached rules and unresolved decisions** to observe current validated reuse or an actual new reviewer call.

B: select **Review attached rules and unresolved decisions** for the current saved v2 source. Identify the old request as review-only when required; do not attach or paste the text again. The unresolved current-source allowances have two separate business choices (tenant and boundary). The policy says only automatic ratification; choose the matching displayed behavior, then explicitly confirm each. The choices do not establish the numeric maximum, window or any other claim. Require current-source persisted BUSINESS review and preserve all unresolved deployment/readback/client duties. Exit/restart and explicitly recheck, with no repeated applicable counting question.

For each quiescent step, use `snapshot-known-run.mjs`, `review-oracle.mjs` and `project-difference.py`. They preserve whole project/dump state and compare every ledger table and source row; they do not grant application attestations. A physical SQLite hash may change without table contents changing. Require exact business/configuration preservation and retain any management/review delta explicitly.

The user's primary ceiling is 25 actual authoring transports across A/B, including errors/corrections, with six reserved for recheck and 75 minutes from first final invocation. This primary budget is not reset for the secondary; Claude's separate predeclaration governs its own lane. Stop a substantive failure and preserve it rather than selecting favorable responses.

## Secondary availability already settled

Claude's predeclaration is `/home/sandesh-tiwari/Desktop/Synapsor Tutorials/positive-counting-review-20260914/SECONDARY-MODEL-PREDECLARATION.md`. It selected openai/gpt-5.6-sol before trial, with fixed fallbacks gpt-5.6-luna, gpt-5.5, gpt-5.4. Use supported operator model configuration and any required source/metadata transfer review for the changed destination. We have not run that model, changed the adapter, searched for credentials, or labelled a self-review independent. Cross-provider comparison remains blocked on the already-recorded missing credential. A same-adapter pass establishes neither generality nor all-model support.

Historical Stage A remains artifact-specific. Original Stage B remains **NOT PASSED**. This review-only handoff does not cover software slot acquisition, signed headless counters, TRUSTED_BINDING_MISSING, new domains or runtime execution.
