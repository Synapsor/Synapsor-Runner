# Runner 1.6.2 Packaging Hotfix Progress

## Incident

`@synapsor/runner@1.6.1` was published on 2026-07-23 through `npm publish`.
The source package used the pnpm workspace dependency
`@synapsor/spec: "workspace:^"`, and npm copied that value into the registry
manifest instead of converting it to a public semver range.

A clean public install therefore failed before Runner started:

```text
npm error EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:^
```

The same clean-cache control test succeeded against Runner 1.6.0. Registry
inspection confirmed:

```text
@synapsor/runner@1.6.0 -> @synapsor/spec: ^1.5.0
@synapsor/runner@1.6.1 -> @synapsor/spec: workspace:^
```

Runner 1.6.1 cannot be republished because npm versions are immutable.

## Hotfix

Branch:

```text
fix/runner-1.6.2-publish-manifest
```

Runner is prepared at 1.6.2. Spec and DSL remain 1.5.0.

The hotfix:

- keeps the source dependency explicit as
  `@synapsor/spec: "workspace:^1.5.0"` so monorepo development tests the local
  Spec;
- requires `corepack pnpm publish` through a `prepublishOnly` guard;
- rejects `npm publish` before packing;
- rejects unexpected local dependency protocols or paths;
- checks that pnpm transforms the packed dependency to
  `@synapsor/spec: "^1.5.0"`;
- installs the Runner tarball by itself in a clean npm project and exercises
  the packaged CLI;
- aligns the release smoke gate with `pnpm publish --dry-run`;
- updates Runner/Cursor version surfaces, changelog, release notes, and the
  standalone technical deep dive.

No Runner runtime, Spec, DSL, Cloud, C++, or website behavior changed.

## Verification

- `corepack pnpm install --frozen-lockfile`: pass.
- `corepack pnpm build`: pass.
- `corepack pnpm test`: pass, 47 files and 728 tests.
- `corepack pnpm verify:packed-runner`: pass.
  - source workspace dependency accepted only for pnpm;
  - npm publisher rejected;
  - packed dependency is `@synapsor/spec@^1.5.0`;
  - tarball clean-installs by itself;
  - packaged CLI verification passes.
- actual `npm publish --dry-run --access public`: rejected by the intended
  fail-closed guard.
- actual
  `corepack pnpm publish --dry-run --access public --no-git-checks`: pass,
  Runner 1.6.2, 292 files.
- `corepack pnpm test:smoke`: pass.
  - 391-test release battery;
  - MCP client configuration verification;
  - disposable Docker first-run proof;
  - public/local/packed/own-database checks;
  - license/content and diff checks.

## Owner Commands

Deprecate the immutable broken version:

```bash
npm deprecate @synapsor/runner@1.6.1 \
  "Broken install: workspace dependency leaked into the published manifest. Use 1.6.2 or 1.6.0."
```

After this hotfix is merged to `main`, publish only Runner:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner/apps/runner
corepack pnpm publish --access public
npm dist-tag add @synapsor/runner@1.6.2 next
```

Do not use `npm publish`. The release guard intentionally rejects it.
Do not republish Spec or DSL.

Verify from the registry and a clean npx install:

```bash
npm view @synapsor/runner@1.6.1 deprecated
npm view @synapsor/runner@1.6.2 version repository.url readmeFilename bin license
npm view @synapsor/runner@1.6.2 dependencies.@synapsor/spec
npm dist-tag ls @synapsor/runner
npx -y -p @synapsor/runner@1.6.2 synapsor-runner --version
npx -y -p @synapsor/runner@1.6.2 synapsor-runner audit --example dangerous-db-mcp
npx -y -p @synapsor/runner@1.6.2 synapsor-runner try --prove --yes --no-open
```

Expected:

```text
dependencies.@synapsor/spec = ^1.5.0
latest = 1.6.2
next = 1.6.2
synapsor-runner --version = 1.6.2
```
