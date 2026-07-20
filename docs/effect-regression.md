# Agent Effect Regression

Contract tests answer whether a reviewed capability boundary is still valid.
Effect regression answers a different question:

> Did a model, prompt, policy, capability, or application change alter the
> business effect the agent proposes?

Runner effect evaluation is provider-neutral and offline. Runner snapshots
existing replay evidence into a versioned fixture, then compares a result
exported by your agent harness. It does not invoke a model, query a source
database, approve a proposal, or apply a write.

## Create A Baseline

Start from an existing replay, proposal, or shadow-study case:

```bash
synapsor-runner effect fixture create \
  --from-replay replay_wrp_... \
  --request "Waive the late fee on invoice INV-3001" \
  --contract ./synapsor.contract.json \
  --capability-call billing.inspect_invoice \
  --capability-call billing.propose_late_fee_waiver \
  --store ./.synapsor/local.db \
  --out ./effects/late-fee.json
```

Use `--from-proposal wrp_...` or `--from-shadow-case shc_...` for the other
sources. The contract is required so Runner records its version and the
reviewed kept-out fields. Every `--capability-call` must exist in that
contract.

The fixture contains:

- the business request;
- trusted tenant and principal context from the stored proposal;
- bounded evidence and query-fingerprint snapshots already in the ledger;
- the permitted capability calls;
- expected target, business diff, policy result, conflict code, and outcome;
- the contract version and fields that must remain hidden;
- a digest that catches unreviewed fixture edits.

It contains no database URL, provider credential, or live source connection.
The secret and hidden-field checks fail closed while creating or loading it.

## Import A Provider-Neutral Result

Create a template:

```bash
synapsor-runner effect result init \
  --fixture ./effects/late-fee.json \
  --out ./effects/late-fee.result.json
```

Have your agent test harness populate this JSON after a propose-only run. The
format records:

- capability names and model-controlled arguments;
- trusted context supplied by the application outside those arguments;
- target, proposed diff, policy, conflict, and outcome category;
- fields observed by the harness;
- whether the harness made any new source read;
- whether the source database changed.

The adapter may use any model provider or application framework. Runner imports
the result; it does not require a proprietary LLM API.

The evaluation harness must disable apply/writeback. A result reporting a
source mutation always fails. A new source read also fails by default. Pass
`--allow-live-read` only when the test environment is explicitly disposable;
that flag never permits a write.

## Compare In CI

```bash
synapsor-runner effect run \
  --fixture ./effects/late-fee.json \
  --result ./effects/late-fee.result.json
```

`effect compare` is an alias. Both return a nonzero status when any reviewed
effect changes. Reports cover:

- capability calls and capability-surface expansion;
- trusted-context drift or model arguments selecting tenant/principal;
- target-object and business-diff changes;
- policy, conflict, outcome-category, and contract-version changes;
- kept-out field exposure;
- source mutation or an unapproved new read.

Use `--format json` or `--format junit` for CI:

```bash
synapsor-runner effect run \
  --dataset ./effects/dataset.json \
  --results-dir ./effects/results \
  --format junit \
  --out ./artifacts/effect-results.xml
```

Dataset fixture paths are relative and cannot escape the dataset directory.
Each result is named `<fixture_id>.result.json`.

## Accept An Intentional Change

Runner never updates a baseline during `run` or `compare`. After reviewing an
intentional business change, accept it explicitly:

```bash
synapsor-runner effect accept \
  --fixture ./effects/late-fee.json \
  --result ./effects/late-fee.result.json \
  --actor release-engineer@example.com \
  --reason "Reviewed billing policy v2" \
  --in-place \
  --yes
```

Use `--out ./effects/late-fee.v2.json` instead of `--in-place` to preserve the
old fixture. Acceptance appends actor, reason, timestamp, and before/after
baseline digests. It cannot waive:

- a mismatched fixture identity;
- source mutation;
- a new source read;
- trusted-context drift or model-controlled tenant/principal;
- hidden-field exposure.

Commit the accepted fixture and review it like application code.

## Boundaries

- This is not a general agent workflow engine.
- This does not execute a provider command or application code.
- This does not prove model quality outside the imported observations.
- This complements [`contract test`](contract-testing.md); a contract can
  conform while an agent's proposed business effect still regresses.
- Replay remains read-only. Creating an effect fixture does not replay or
  reapply the original write.

