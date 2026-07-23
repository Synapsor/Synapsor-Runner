# Cursor plugin

The Synapsor Cursor plugin is an official-format Cursor plugin under
`plugins/cursor/synapsor`. It packages the project-scoped Runner MCP server,
`/synapsor-protect`, and thin Cursor wrappers over Runner's canonical Safe Action
instructions.

Current implementation evidence was checked against Cursor's public plugin,
plugin-reference, MCP, and deeplink documentation on 2026-07-20:

- <https://cursor.com/docs/plugins>
- <https://cursor.com/docs/reference/plugins>
- <https://cursor.com/docs/mcp>
- <https://cursor.com/docs/reference/deeplinks>

The locally installed Cursor version used for validation is recorded in
`development/runner-1.6.0-progress.md`. Protocol/static validation is not a
claim that Cursor Marketplace review has completed.

## What the plugin installs

- one production stdio MCP server pinned to `@synapsor/runner@1.6.1`;
- one `/synapsor-protect` agent command;
- one discoverable Safe Action skill;
- one file-scoped rule for `synapsor/actions/**/*.ts`;
- no hooks, automatic shell execution, credentials, or activation path.

The MCP entry uses Cursor's documented `${workspaceFolder}` interpolation for
`synapsor.runner.json` and `.synapsor/local.db`. It exposes only `mcp serve`.
Approval, apply, activation, commit, and revert remain outside MCP.

Auto Boundary authoring uses a separate CLI-managed project entry rather than
the production plugin entry:

```bash
synapsor-runner mcp install cursor \
  --project \
  --authoring \
  --project-root . \
  --yes
```

That temporary local stdio entry is accepted only after exact boundary
activation and advertises exactly `app.describe_data` and `app.explore_data`.
After Protect activation, reinstall the normal project config; production then
advertises only named reviewed capabilities. The plugin never makes Scoped
Explore available to production, shared HTTP, remote, or non-loopback serving.

## Build and verify

```bash
corepack pnpm build:cursor-plugin
corepack pnpm verify:cursor-plugin
```

The verifier checks the manifest and component formats, version pin, project
paths, secret-free package contents, command authority boundary, deterministic
package inventory, disposable local install/reinstall/removal, preservation of
unrelated Cursor configuration, and paths containing spaces.

## Marketplace listing copy

**Name:** Synapsor

**Short description:** Turn one real application data change into a disabled,
reviewable MCP action without giving the Cursor agent SQL or commit authority.

**Security summary:** The plugin contains no database credentials or trusted
identity. Cursor can draft and validate disabled actions. Only a human using the
secured localhost Workbench can activate a reviewed digest; approval and apply
remain outside the model-facing MCP surface.

Required listing media:

- committed Synapsor logo from `assets/logo.svg`;
- screenshot of `/synapsor-protect` producing a disabled draft;
- screenshot of the Workbench exact-effect review and digest confirmation;
- 20-to-40-second GIF showing proposal, unchanged source, external approval,
  guarded receipt, idempotent retry, and stale conflict.

## Submission checklist

- [ ] Runner 1.6.1 package and plugin version agree.
- [ ] `corepack pnpm verify:cursor-plugin` passes from a clean checkout.
- [ ] Plugin is manually loaded in current stable Cursor at workspace scope.
- [ ] `/synapsor-protect` drafts and validates without activation.
- [ ] Exact Cursor `tools/list` contains only reviewed semantic tools.
- [ ] Another direct-write MCP server triggers Runner's bypass warning.
- [ ] Logo and listing media contain no secrets, local paths, or customer data.
- [ ] Privacy/security copy matches the OSS security boundary.
- [ ] Public repository and release links resolve.
- [ ] Owner submits the repository at <https://cursor.com/marketplace/publish>.

The final submission remains an explicit owner action. Do not claim that local
installation or static validation equals Marketplace approval.
