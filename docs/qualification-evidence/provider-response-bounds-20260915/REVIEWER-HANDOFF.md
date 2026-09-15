# Provider response bounds — verifier handoff

Status: READY for independent rerun. Product/tests `fbbb52b823314973e8097d07da4f05ddd936cbec`; baseline 1ae76e5. Frozen source `29000841a0a27c50ef436ccf1de76fd98ecf4772`. Full installed tree `072ab87a11ecde0ec1e0a0928bfc6ba036fede08b6e75cfc073b1de263c631ef` (7569 entries). Full suite 6440 passed / 463 skipped, exit 0; types and ten offline checks exit 0.

## Reproduce the bounded controls

Use a separate checkout/copy at the recorded product revision with the existing installed workspace dependencies. Keep HOME and /var/tmp private, NO_COLOR=1, umask 0077 and provider/unrelated credentials absent. The exact sandboxed command/environment manifests are in each `*-exit.json`; `run-local.py` records source hashes before and after. To use that helper independently, copy it and its plan to a new owned evidence directory and change owned_root; its exclusive output creation deliberately refuses to overwrite these attempts.

```bash
corepack pnpm exec vitest run apps/runner/src/provider-response-bounds.test.ts apps/runner/src/openrouter.test.ts apps/runner/src/model-ask.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=20000 --hookTimeout=20000
corepack pnpm typecheck
```

The primary regression is synthetic real local HTTP/SSE followed by real request encoding: 512 KiB of opaque continuation retained exactly and never emitted as UI events or ordinary result history. The first 5-test source is `before-bounds.test.ts.txt`; its baseline run was exit 1 at 1ae76e5. These are not recovered private Grok envelopes. `focused-bounds-attempt1.test.ts.txt` plus its log preserves the two wrong new error-code expectations; `harness-correction.md` explains the test-only correction.

## Independent public rerun

Use the final frozen `installed/node_modules/@synapsor/runner/dist/cli.js` on a new whole-project copy of the reviewer's established clean starting checkpoint, with its matching source state and effective-store preflight. Do not run the historical failure copy or patch this installation. Existing consent, configured provider/key handling and reviewed local fixtures remain required. The launcher command is:

```bash
node "/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/provider-response-bounds-1ae76e5-20260915/frozen/installed/node_modules/@synapsor/runner/dist/cli.js" start --project-root /ABSOLUTE/NEW/OWNED/JOB --cli --timeout 300
```

Keep predeclared OpenRouter x-ai/grok-4.6 and the existing request/navigation route. No new memory-size setting is needed or provided. Preserve every response/failure and authority/source differences. A full model-assisted review remains the independent lane: this task performs zero paid provider calls and does not assert cross-vendor completion from local transport tests.

The reviewer already established that the previous timeout candidate completes non-OpenAI planning. The outstanding question is completion of the coverage/review journey. Privacy-ineligible provider refusal and incomplete-call refusal remain expected; no fallback/privacy relaxation or partial-call acceptance is authorized by this repair.

## Evidence index

- `IMPLEMENTATION-NOTE.md`: cap choices, request-envelope interaction and retained tool budgets.
- `bounds-inventory.json`: every named bound and use; no old inline literals remain.
- `VERIFICATION-NOTE.md`: before/after threshold tests, exact control semantics and independent-trace classification.
- `before-bounds*`, `after-initial*`, `focused-bounds*`, `focused-final*`: retained failures and focused passes.
- `stable-full*`, `types*`, `offline-package-plan-attempt1.json` and per-command logs: distinct exits and unchanged-source evidence.
- `product-revision.json`, `product-source-archive.json`, `installed-candidate.json`: product/test, source checkpoint, complete manifest/lock/dependency/entrypoint identities.
- `installed-smoke-result.json`: actual installed help commands and constant inspection only, explicitly not a paid model journey.
- `external-evidence-baseline.json`, `prior-artifact-verification-before.json`, `preservation-after.json`: preservation. The independent G2 report was legitimately appended before this task; the new baseline does not rewrite an older manifest.

No prompt, business authority, selector, counter, receipt, worker or adapter integration change. Historical Stage A remains artifact-specific and original Stage B remains NOT PASSED. The separate receipt-review and TRUSTED_BINDING_MISSING findings are unchanged.

Verify the sealed installation without changing it:

```bash
node "/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/provider-response-bounds-1ae76e5-20260915/frozen/freeze-repair.mjs" --verify
```

`installed-smoke-attempt1-result.json` preserves the initial inspector failure after the three successful help commands. The corrected inspector reads the actual esbuild assignment form; it does not rerun those commands or patch the artifact. See FINAL-REPORT.md and installed-candidate.json for the complete manifest, archive, lock and package hashes.
