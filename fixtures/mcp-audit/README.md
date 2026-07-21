# MCP audit fixtures

These deterministic fixtures exercise the public `synapsor-runner audit`
contract without a database, account, telemetry, or business-tool call.

- `dangerous-tools-list.json` contains raw SQL and model-callable commit
  authority.
- `reviewed-proposal-tools-list.json` contains a semantic read and an exact
  proposal boundary.
- `cursor-bypass-config.json` proves that a reviewed Synapsor server does not
  govern a second model-visible server that still exposes `execute_sql`.

Static config auditing never launches either command in the Cursor fixture.
Live inspection requires one exact `--live-server` name and explicit `--yes`.
