# Synapsor for Cursor

Turn one application data change into a disabled, reviewable Synapsor Safe
Action. The plugin adds the proposal-only Runner MCP server, the
`/synapsor-protect` command, and thin Cursor guidance over Runner's canonical
host-neutral authoring instructions.

## Boundary

The Cursor agent can inspect project structure, draft a TypeScript action, and
run deterministic validation. It cannot activate the action, approve or apply a
proposal, commit or revert source data, read credentials, or establish trusted
tenant/principal authority. Those operations remain outside MCP in the secured
Runner Workbench and operator surfaces.

The plugin contains no database URL, token, trusted identity, approval identity,
or production endpoint. Cursor interpolates `${workspaceFolder}` for the Runner
config and local ledger paths, including project paths with spaces.

## Local installation

Cursor's official local-plugin mechanism loads directories from
`~/.cursor/plugins/local`. During development, link this plugin directory there:

```bash
mkdir -p "$HOME/.cursor/plugins/local"
ln -s "$(pwd)/plugins/cursor/synapsor" "$HOME/.cursor/plugins/local/synapsor"
```

Restart Cursor or run **Developer: Reload Window**, install at **workspace**
scope, and invoke `/synapsor-protect` in Agent. Provide staging credentials and
trusted scope through your own environment; never add their values to plugin or
project configuration.

For a copied installation, copy this complete directory instead of the symlink.
To uninstall a local development copy, remove only
`~/.cursor/plugins/local/synapsor`. Marketplace installs are removed from
Cursor's Customize page. Neither path edits unrelated project MCP servers.

## Verify the model-facing boundary

After the reviewed action is explicitly activated in Workbench, reload Cursor
and run:

```bash
npx -y -p @synapsor/runner@1.6.1 synapsor-runner mcp status cursor --project --check-launch
```

The output lists the exact semantic read/proposal tools. It must not list raw
SQL, approval, apply, activation, commit, or revert tools. Run Runner's MCP audit
against other project servers as well: Synapsor cannot govern a separate server
that still gives the model direct database-write authority.

## Marketplace status

This 1.6.1 plugin is prepared for local validation and Cursor Marketplace
review. It is not listed or published until Synapsor explicitly completes the
owner submission step.
