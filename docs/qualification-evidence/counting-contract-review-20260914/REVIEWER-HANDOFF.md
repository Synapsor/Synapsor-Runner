# Reviewer handoff — work in progress

The controlling brief is `assignment-plan.json`; baseline and ancestry are in `baseline.json` and `ancestry.json`. The original two-call public failure remains under the previous evidence root. This task does not qualify new cases or revise historical Stage A/Stage B verdicts.

Start with `SEMANTIC-ADJUDICATION.md`, `saved-call-trace.json` and `IMPLEMENTATION-NOTE.md`. The complete first input/response and corrected second response are indexed with hashes. The actual counting query remains byte-identical (`counting-query-unchanged.json`). The owner explicitly rejected adding filters; the retained absent filters implement the source outcome-specific requirement only in the established singleton current/history domain. Human approvals are excluded.

Current product: `bf156a0ba5834c1c832d967400c5f4e2274ea4fd`; implementation/tests and prompt change originated at `79b3fdba300c8f7c0166bf229555a97c70b9aa76`. The later commit moves types into existing records to remove an import cycle. Neither commit changes selectors or admission behavior.

Commands are recorded as exact argument arrays in every `*-exit.json`. Corresponding `.log` and `*-source.json` files retain complete outputs and source identities. Important gates:

- `combined-focused`: 303 passed, 4 opt-in skips, before the type-only dependency correction.
- `types-after-dependency-repair`, `dependency-repair`, `focused-after-dependency`: final source; types/dependency exit 0; 111 passed, 2 opt-in skips.
- `final-postgres02`: real PostgreSQL control-store plus SQLite accounting/publication/domain checks, 37 passed, exit 0.
- `final-review-postgres02`: the exact four PostgreSQL unavailable-Read recovery cases, 4 passed, exit 0; other cases were excluded by the recorded pattern.
- `stable-full`: interrupted after the dependency gate rejected introduced type cycles; inner status -15, not a completed suite result.
- `stable-full02`: completed exit 1; 6257 passed, 5 failed, 462 skipped. All five failures were a single exact-object expectation missing the new approval-kind evidence field, parameterized over five scopes.
- Test-only correction `113859e`: explicit expected `approval_kind: boundary_automatic`. `selector-expectation-final` 65 passed; `types-final` exit 0. `final-test-only-source-delta.json` establishes unchanged product/backend code.
- `stable-full03`: completed **exit 0, 6262 passed / 462 skipped**, source unchanged. Third launch was explicitly declared within the original 120-minute phase budget.
- `offline-first-failed-plan.json`: preserve the initial dependency failure. `offline-package-plan.json` records the corrected source gates and subsequent packaging checks separately.

The full-suite launch budget amendment is explicit in `assignment-plan.json`; no historical counter was reset. Provider development calls: zero. The prepared final public copy has 104 unchanged business rows (8 events and 96 results). `owned-domain-inspection02.log` is host integration evidence on a different copy, not an installed model review. The first host diagnostic's import-resolution error remains saved.

Do not rerun a harness against these preserved project directories. For a separate reproduction, use a new owned root and whole-directory restore from the indexed `stopped-review-conflict` checkpoint with its matching source dump/readback. Preserve its logical project/store bindings using `scripts/qualification-sandbox.mjs`; never rewrite them to relocate the project. The setup helper verifies the original input manifest, project manifest, database destination, container identity and complete source baseline. Use its fixture-only mode until a candidate is frozen.

Final public path: `start --project-root . --cli` → Resume the interrupted job. Keep the exact provider/model and saved metadata consent. The only applicable routing confirmation is that the old instruction was a generated repair; it is not a new business-policy override. Pause before deployment, save, restart, and explicitly recheck unchanged coverage. Keep source/readback duties unverified. No activation, worker, receipt or source effect is scheduled.

The final installation manifest, package result and public scorecard will be added after execution. Its complete tree, local Spec, lockfile, dependencies and entrypoints must be verified before and after the public run. Do not substitute the earlier installation or treat the version string as identity.

All ten offline checks completed exit0. Package source bytes match completed full03 (package-source-check.json). The six source checks precede only the test expectation change; product and their dependencies are unchanged. Next: freeze a complete installation from the committed checkpoint and perform the authorized public assisted review/restart/recheck.
