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

Expected successful output ends with:

```text
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
