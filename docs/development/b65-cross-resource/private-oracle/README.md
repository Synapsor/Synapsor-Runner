# Private reference-state pack

This directory and `../CASE-MANIFEST.json` are private test evidence. They are not model-visible instructions, a Runner implementation, a SQL parser, or a new native execution harness. `../fixtures/SCENARIOS.json` is complete synthetic Source preparation data plus the exact proposed effects. The independent Tester loads these into the existing isolated native harness and retains its established barriers, wait observations, privacy boundary and authority checks.

`../fixtures/OPERATOR-FACTS.json` separates declared business policy/effects from complete Source rows and expected results. It is a menu of test preparation facts, **not a payload to send wholesale**: only the actual operator-authorized job and properly consented/schema-bound facts belong in a real request. Cross-principal initial rows and private expected totals stay in the oracle lane.

Run the short pure controls from the repository root:

```sh
node --test docs/development/b65-cross-resource/private-oracle/reference-state.test.mjs
```

API:

- `fixture(id)` returns a fresh copy of the exact initial tables, atomic effects and business rule.
- `proposedState(id, operations)` computes the combined complete state directly from those initial rows and exact effects, including intentionally invalid states. It never imports Runner's post-state evaluator or consumes Runner output.
- `referenceSchedule(id, order)` computes ideal serial admissibility and whole atomic effects. It is a reference possibility, not an assertion that Runner must optimally accept stale proposals.
- `referenceCommittedState(id, committedOperationIds)` computes expected complete state from explicitly observed committed operation identities, rejecting duplicate/replayed or invariant-violating sequences. It does not infer commits from a success message or receipt absence.
- `compareCompleteSnapshot(id, committedOperationIds, observed)` compares every table/row/field with that independently computed state. Table/row ordering is ignored; missing tables, altered unaffected fields and duplicate identities are not ignored.

All monetary values are signed integer-cent strings. T10 uses exact rational cross multiplication; no floating-point rounding, SQL NULL behavior or fixed-width overflow is invented. The NULL/large-integer controls prove the oracle's arithmetic only. Native database precision/NULL/overflow policy remains a separately declared companion and may be unsupported.

The Tester must independently bind actual operation identities, complete snapshots, exact affected counts, proposals/statuses and source receipts. A known completed change needs its actual matching receipt; an uncertain COMMIT is not turned into refusal or spare capacity. Reuse the existing B61 receipt-scope reconciliation controls, retain holds, and never replay unknown/completed effects. These pure controls prove no transport, lock, database, recovery, public authority or product-support property.

Each native case/engine verdict remains unset until attempted, then exactly one of `ENFORCED`, `UNSUPPORTED_REFUSED`, `DEFECT`, `NOT_REACHED_HARNESS`. Unsupported capability must retain original intent and refuse designation/activation; never alter amounts, reduce scopes, hide a term or substitute human approval. Record public-route and native-component evidence separately. Both-refused is not a positive progress proof; conservative stale refusal is not post-state proof. PG and MySQL qualify separately.

The manifest includes all five sequential cases, T01–T10, independent-scope companions, UPDATE membership, whole atomic UPDATE statement order and all six T09 orders. Remaining selected companions are explicitly marked pending native predeclaration/evidence linkage. No completed prior B65/B66/B61 evidence should be rerun merely to fill this pack.

If the native fixture adds technical columns, triggers/defaults or additional unchanged tables, declare the full initial rows and exact expected source-side effects before the run. `applyExactEffects(initial, effects)` can compute that complete reference state without reading Runner output. Do not remove version/identity/unaffected fields from observed snapshots merely to fit the compact synthetic tables. An unknown trigger/default effect is a missing fixture contract, not permission to ignore it. The manifest's SQL-native companion rows remain pending until the Tester records these exact choices.
