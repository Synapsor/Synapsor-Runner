# Attempt classification

Historical logs and results are retained under their original labels.

- `before`: new test setup assertion incorrectly searched the full compiled metadata catalog for the unrelated field. That catalog legitimately contains the field; corrected the assertion to check the actual rule, verification binding and effect. Not a product result.
- `before-corrected-fixture`: nested read-only overlay was missing its root mount and could not find `corepack`. Environment failure; no test ran.
- `before-warning`: corrected test, original boundary-command implementation mounted read-only from baseline. Two product failures: neither confirmation named the dependent outcomes. This is the failing-before evidence.
- `focused-after`: warning assertions passed. Two subsequent new test assertions assumed list order and an empty array where the existing API returns an absent optional property; corrected those assertions without changing product code.
- `focused-routes`: three cancellation/review paths passed. Two added runtime checks lacked trusted test context and stopped at TRUSTED_CONTEXT_MISSING. Supplied the normal supported synthetic static-development context in the test; identity enforcement was unchanged.
- `routes-and-ui`: eight passed; the new Workbench test pointed at `.synapsor` instead of the generated boundary directory returned by fixture creation. Corrected to that returned directory. No product change.
- `focused-complete`: 13 passed, exit 0; name filters leave unrelated tests skipped.
- `types-early`: exit 0 before the later Workbench test addition.
- `affected-suite`: 445 passed, exit 0, in five discovered files. The command also contained the nonexistent `instant-cli-boundary.test.ts` filename, which Vitest did not discover. This is not Quick Start coverage. The actual `guided-start.test.ts` and `control-policy-authority-codec.test.ts` are run separately under `quick-start-authority`.
- `types`: exit 1 on the new Workbench test's `current.authoring` property; the existing binding is `current.bundle.mutation_bindings.authoring`. Test-only correction and final checks are recorded separately; the prior passing product is unchanged.

- `quick-start-authority`: 292 passed / 175 opt-in PostgreSQL cases skipped, exit 0. Includes all 45 guided-start tests. Combined with the five-file run: 737 distinct passing tests on identical product code; this is not a complete monorepo-suite claim.
- `final-focused`: after the test-only binding correction, all six composed activation cases passed, exit 0. Other cases filtered out by name are not additional backend skips.
- `final-types`: exit 0 after the same test-only correction.
