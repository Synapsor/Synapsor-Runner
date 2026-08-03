# Secure Text-to-SQL Without Giving The Model SQL

Synapsor does not put a security filter around arbitrary model-generated SQL.
It removes SQL from the model interface. The model composes a typed plan from
human-reviewed resources, fields, operations, relationships, and limits;
Runner validates that plan and compiles the parameterized database statement.

## Why A Valid Query Is Not Enough

Enterprise text-to-SQL failures are often plausible wrong answers rather than
syntax errors:

| Measurement | Reported result | What it means |
| --- | --- | --- |
| [BEAVER](https://arxiv.org/abs/2409.02038), 9,128 question-SQL pairs across 812 tables | A published [ReFoRCE](https://arxiv.org/abs/2502.00675) pipeline reports about 11% end-to-end execution accuracy | One measured system answered most questions incorrectly on this enterprise benchmark |
| [EntSQL](https://arxiv.org/abs/2606.03363), taxonomy of 982 observed failures | 536 wrong-filter failures, or 54.6% | The largest failure class can execute cleanly and return a convincing wrong number |

These measurements come from different evaluations. The 54.6% is a share of
observed failures, not an overall error rate, and the roughly 11% is not a
universal model score. Neither is a claim that Runner improves model accuracy.

## What Runner Changes

- Tenant and principal scope is injected by trusted runtime state, not authored
  by the model.
- The model can select only reviewed filters, measures, dimensions, time grains,
  and cardinality-proven relationship paths.
- Unknown or unreviewed identifiers are refused instead of becoming SQL.
- Result size, query cost, cohort suppression, and comparison budgets are
  enforced independently of model prose.
- The operator can inspect the typed request, normalized plan, runtime checks,
  and evidence for what actually executed.

## What Runner Does Not Change

A model can still choose the wrong legal grouping, measure, or business
definition. Runner makes the available menu reviewable and the execution
auditable; it does not make natural-language interpretation infallible. Keep
important definitions in reviewed views or named capabilities and inspect the
Runner-verified result separately from model prose.

```bash
npx -y @synapsor/runner start
```

Continue with [Bounded Aggregate Reads](aggregate-reads.md) and [Reviewed
Database Views](reviewed-database-views.md).
