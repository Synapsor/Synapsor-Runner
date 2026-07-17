# Review Contracts Before Serving Them

Runner uses the same DSL parser and canonical Spec validator for compilation,
editor diagnostics, explanation, and lint. These tools reduce authoring errors;
they do not replace a human review of database permissions, visible fields,
tenant binding, or business policy.

## Explain The Boundary

```bash
synapsor-runner contract explain ./contract.synapsor.sql --format markdown
synapsor-runner contract explain ./synapsor.contract.json --format json
```

The explanation lists trusted context bindings, model-facing arguments, fixed
targets and selections, visible and kept-out fields, evidence requirements,
proposal/writeback controls, approval, bounds, reversibility, and unresolved
runtime dependencies. It is derived from normalized canonical contract JSON.
It never reads environment values or prints database URLs, tokens, keys, or
evidence rows.

## Lint In CI

```bash
synapsor-runner contract lint ./contract.synapsor.sql --strict
synapsor-runner contract lint ./synapsor.contract.json \
  --config ./synapsor.runner.json --format sarif --out ./contract-lint.sarif
```

`--strict` is equivalent to `--fail-on warning`; the default fails on errors.
Lint rule IDs, ordering, severity, and source ranges are deterministic. Rules
cover objective review gaps such as missing descriptions/evidence, unbounded
strings, unresolved wiring, irreversible operations, and policy/writeback
contradictions. Lint does not claim to discover every sensitive column.

### Review Capability-Surface Fitness

Runner structurally limits capability **depth**: contracts cannot turn a model
argument into raw SQL or a free-form predicate, and trusted tenant/principal
scope is never model input. A separate review concern is capability **breadth**:
many individually narrow tools can accumulate until the total model-facing
surface is difficult to understand.

Use this fitness test during review:

> If a capability cannot be described as a named business operation an audit
> log would recognize, it probably should not be exposed yet.

`contract lint` reports these deterministic advisory warnings:

| Code | Review signal |
| --- | --- |
| `SURFACE_GENERIC_ARGUMENT` | An un-enumerated string argument is literally named `filter`, `query`, `where`, `predicate`, or `sql`. Runner still does not interpolate it into SQL. |
| `SURFACE_TARGET_DENSITY` | More than eight capabilities target the same normalized source and object. Eight is a review threshold, not a runtime limit. |
| `SURFACE_OPERATION_NAMING` | A capability name does not match the conservative named-business-operation heuristic. |
| `SURFACE_NEAR_DUPLICATE` | Two capabilities have the same target, kind, reviewed fields, targeting, write/approval shape, and identical or directionally loosened arguments. |

The default command exits successfully when these advisories are the only
findings. `--strict` (or `--fail-on warning`) deliberately lets a team turn all
warnings into a CI policy gate without changing canonical contract validity.
Text, JSON, and SARIF use the same stable finding set and deterministic order.

Passing these checks does not prove that a surface is safe or well designed.
Review which operations each agent actually needs; use narrower contracts or
Runner/client deployments instead of exposing every organization capability to
every model.

Expected successful output ends with:

```text
Surface: N model-facing capabilities across M targets; 0 target(s) above the advisory density threshold of 8
Summary: 0 error / 0 warning / N info
```

## Language Server

```bash
synapsor-runner language-server --stdio
```

The stdio LSP supports `.synapsor.sql` and legacy `.synapsor` documents. It
publishes parser/validator diagnostics and provides context-aware completion,
hover, and formatting. Configure a generic LSP client to launch the command
above with the workspace as its working directory. For VS Code, use any stdio
language-client extension that can associate both filename patterns with that
command. Generic SQL highlighting remains useful for `.synapsor.sql`; the LSP
adds Synapsor-specific semantics.

The server never suggests raw SQL, model-authored predicates, approval tools,
or clauses that are illegal for the current capability kind.
