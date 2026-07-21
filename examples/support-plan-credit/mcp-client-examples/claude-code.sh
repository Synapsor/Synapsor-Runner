#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Credentials and trusted scope are inherited
# from the shell that starts Claude Code; they are not written to .mcp.json.
claude mcp add-json --scope project synapsor "$(cat <<'JSON'
{
  "type": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "-p",
    "@synapsor/runner",
    "synapsor-runner",
    "mcp",
    "serve",
    "--config",
    "./examples/support-plan-credit/synapsor.runner.json",
    "--store",
    "./tmp/support-plan-credit/local.db"
  ]
}
JSON
)"

claude mcp get synapsor

cat <<'PROMPT'
List the Synapsor MCP tools. Confirm there is no SQL, approval, apply, commit,
activation, or revert tool. Then call support.propose_plan_credit with
customer_id CUS-3001, credit_cents 2500, and reason "SLA outage ticket
SUP-481". Show the exact proposal effect and confirm source_database_changed is
false. Stop for human review outside Claude Code.
PROMPT
