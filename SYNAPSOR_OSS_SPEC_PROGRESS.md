# Synapsor OSS Spec Progress

## Current Goal

Complete the C++/Cloud -> `@synapsor/spec` -> OSS Runner round-trip before
publishing.

The active gap is no longer package scaffolding. It is proving this path:

```text
C++/Cloud internal model
  -> exported @synapsor/spec JSON
  -> @synapsor/spec validation
  -> @synapsor/runner load
  -> expected semantic MCP tools
  -> no raw execute_sql-style tools
```

Do not publish packages as part of this goal.

## Architecture Decisions

- `@synapsor/spec` is the canonical portable contract.
- Runner config remains runtime wiring and must not become the canonical
  contract.
- SQL-like DSL remains an authoring layer that compiles to `@synapsor/spec`.
- C++/Cloud remains proprietary but imports, normalizes, and exports the
  overlapping `@synapsor/spec` 0.1 subset.
- Cloud-only fields use `x-cloud-*`; runner-only fields use `x-runner-*`;
  experiments use `x-experimental-*`.

## Completed In Previous Goal

- Added `@synapsor/spec`.
- Added `@synapsor/dsl`.
- Updated runner to load canonical contract files through `contracts`.
- Preserved embedded legacy runner config support.
- Added runner CLI support for contract validate/normalize/bundle, DSL
  compile/validate, and Cloud push dry-run.
- Added migration and conformance docs.
- Verified baseline OSS tests and package pack dry-runs.

## Completed In This Goal

Main C++ repo now has:

- explicit C++ export DTOs/API in `SynapsorContractSpec`;
- deterministic export fixtures under
  `tests/fixtures/synapsor_contract_exports/`;
- C++ export tests for read, proposal, workflow, kept-out fields,
  policy references, Cloud extensions, and trusted-argument rejection;
- cross-repo verifier:
  `/home/sandesh-tiwari/Desktop/C++/Synapsor/scripts/verify_contract_roundtrip.sh`.
- verifier bundle check for a C++ exported workflow contract.

OSS repo updates:

- `docs/conformance.md` now documents C++ export fixture alignment.
- `packages/spec/README.md` now mentions the C++ export snapshots and
  round-trip verifier.
- `README.md` now shows how to load an existing canonical
  `synapsor.contract.json` from DSL, Cloud, or the C++ exporter.
- `contract bundle` now leaves `SYNAPSOR_DATABASE_READ_URL=` empty in
  `.env.example` instead of generating a URL-shaped password placeholder.
- `@synapsor/runner` is bumped to `0.1.2` because `0.1.1` already exists on
  npm and failed the registry check during dry-run.

## Verification Run So Far

Main C++/Cloud repo:

- `cmake --build build --target synapsor_tests -j 8`
- `./build/synapsor_tests --gtest_filter='SynapsorContractSpec.*'`
- `cmake --build build --target synapsor_tests -j 8 && ./build/synapsor_tests`
- `./scripts/verify_contract_roundtrip.sh`
- `git diff --check`

The verifier validated C++ export fixtures through `@synapsor/spec`, loaded
them with the runner, checked expected semantic tools, blocked raw/approval/
commit tool surfaces, inspected model-facing metadata for kept-out field leaks
and trusted-scope argument leaks, and invoked exported tools with mocked scoped
reads to verify kept-out fields do not appear in tool results or evidence
resources.
It also bundled the exported workflow contract and checked the bundle includes
the expected files without database URLs, write credentials, tokens, customer
rows, or URL-shaped placeholders.

OSS runner repo:

- `corepack pnpm build`
- `corepack pnpm test`
- `corepack pnpm --filter @synapsor/spec test`
- `corepack pnpm --filter @synapsor/dsl test`
- `corepack pnpm --filter @synapsor/runner test`
- CLI smokes for valid spec validation, invalid spec rejection, DSL
  validate/compile, runner contract validate, `cloud push --dry-run`, and
  `demo --quick --no-interactive`.
- Publish dry-runs:
  - `npm publish --access public --tag next --dry-run` in `packages/spec`
  - `npm publish --access public --tag next --dry-run` in `packages/dsl`
  - `npm publish --access public --tag next --dry-run` in `apps/runner`
- `git diff --check`
- changed-path scan for live RDS/API/private-key-style secrets.

## Remaining Checklist

- Review final `git status` in both repos before commit/push.
- Commit/push only when the user asks.
- Publish only when the user explicitly approves.

## Current Blocker

None.

## Exact Next Command Or File To Inspect

```bash
cd /home/sandesh-tiwari/Desktop/C++/Synapsor && git status --short --branch
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner && git status --short --branch
```
