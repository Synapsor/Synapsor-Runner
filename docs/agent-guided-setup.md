# Agent-Guided Synapsor Setup

This guide lets Claude Code, Codex, Cursor, or another coding agent help a
developer set up Synapsor Runner without taking over a human security decision.
It uses the same local-first flow a developer runs directly. No Synapsor
account, Cloud login, model API key, global installation, or database
replication is required.

## Copyable Prompt

```text
Set up Synapsor Runner for this project.

Use DATABASE_URL from my environment. Run the setup yourself and explain each
step briefly. Stop only when I must review the data boundary or make another
human-authority decision. Never ask me to paste credentials into chat, and
never activate, approve, or apply anything for me.

Finish by driving one safe tool, showing what the agent can and cannot access,
and giving me the MCP configuration for my client.
```

## Rules For The Coding Agent

The coding agent may inspect project files, check tool availability, run the
documented CLI, explain failures, and resume completed work.

The coding agent must not:

- ask the user to paste a database URL, password, token, or private key into
  chat;
- print or persist the value of `DATABASE_URL` or another credential;
- choose a tenant or principal boundary;
- decide that a sensitive or uncertain field is safe to expose;
- activate an exploration boundary or named capability;
- approve, reject, apply, reconcile, or revert a proposal;
- run writeback setup with `--apply`;
- weaken a failed role, RLS, schema-lock, profile, or transport check;
- replace an existing generated project or use `--force` without a human
  choosing the destructive path;
- fetch or execute setup code other than the documented npm package command.

The model-facing MCP surface never contains activation, approval, or apply
tools. A coding agent operating the terminal must preserve the same separation.

## Guided Procedure

### 1. Verify Local Prerequisites

Run:

```bash
node --version
test -n "${DATABASE_URL:-}"
npx -y @synapsor/runner --version
```

Do not run `echo "$DATABASE_URL"` or otherwise reveal its value. Runner
requires Node 22.13 or newer.

Report one sentence:

```text
Node, the Runner package, and an exported DATABASE_URL are available.
Next: inspect metadata and open the local boundary review.
```

If `DATABASE_URL` is absent, stop and say:

```text
DATABASE_URL is not exported in this shell. Export it locally, without pasting
it into chat, then ask me to continue.
```

### 2. Start Or Resume The Guided Project

From the intended project directory, run:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL
```

For a fresh interactive project, Runner performs metadata-only inspection,
creates disabled review artifacts, validates the generated project, initializes
the local ledger, and starts the secured loopback Workbench. It prints one
local URL if a browser cannot be opened.

For an existing guided project, the same command resumes it. Resume and Try do
not rescan the database, rewrite files, or change a digest. To inspect the live
schema and role posture again, use `start --from-env DATABASE_URL --rescan`.
That flag is universal: it works for single-organization and multi-tenant
projects and produces a disabled update that still requires human review and
activation. Do not add `--force` unless the operator also intends its separate
overwrite/reset behavior.

Report:

```text
Runner created or resumed a disabled local boundary. No source rows were read
and the database was not changed.
Next: review the security exceptions in Workbench.
```

Then stop. The human must review:

- fields kept out and fields still uncertain;
- exact row identity;
- trusted tenant and principal scope;
- aggregate-safe dimensions and measures;
- database-role and RLS posture;
- the exact digest being activated.

Do not click or call activation endpoints for the user.

### 3. Continue After Human Activation

After the user confirms that Workbench shows an active reviewed boundary,
continue in the same Workbench session. The built-in Explore form performs the
first bounded read and PM-style aggregate without SQL or plan JSON.

The coding agent may verify the active local surface without copying an opaque
handle:

```bash
npx -y @synapsor/runner try call --list --format json
```

If no named capability is active yet, that is expected: a temporary local
Scoped Explore boundary is not a production named tool. Ask the user to run the
suggested aggregate in Workbench and select **Protect this analysis**.

Protect creates public DSL, canonical JSON, tests, and a disabled named
capability. Stop again for exact-digest human activation. Do not activate it
for the user.

### 4. Verify The First Named Tool

After the human activates a protected named capability, run:

```bash
npx -y @synapsor/runner try call --list --format json
```

Use the tool name returned by that command. For a tool with generated sample
input, run:

```bash
npx -y @synapsor/runner try call <tool-name> --sample --json
```

Do not invent tenant or principal arguments. Trusted scope comes from the
reviewed environment/session binding outside model input.

Report:

```text
Your first safe named tool is working.
The result used only reviewed fields and trusted scope.
Source database changed: no.
Next: connect the same reviewed tool surface to your MCP client.
```

### 5. Present MCP Setup

Workbench displays ready-to-copy configurations for:

- Cursor project MCP;
- Claude Code project MCP and Claude-compatible local stdio MCP;
- VS Code project MCP;
- Codex;
- generic stdio MCP.

All hosts launch the same reviewed Runner project. None receives a broader
authority surface.

For a terminal-rendered generic configuration, run:

```bash
synapsor-runner mcp config --absolute-paths
```

Do not write into a client configuration without explicit user consent.
Cursor, Claude Code, and VS Code have consent-gated project installers:

```bash
synapsor-runner mcp install claude-code --project --dry-run
```

Use `cursor` or `vscode` instead when that is the selected client. Show the
dry-run result first. Installation remains a human choice.

## Guided Write Action

After the first safe read, Workbench can generate one bounded write action.
Schema structure supplies candidates only. The human decides business intent,
allowed fields, values or transitions, trusted scope, version guard, reviewer,
limits, optional bounded policy approval, receipt mode, and compensation.

The generated action starts disabled. Its first model-facing call creates an
exact proposal and must say:

```text
Proposal created.
Source database changed: no.
The model cannot approve or apply this proposal.
```

Stop at action activation, proposal approval, writeback setup, apply, and
revert. Those are human or trusted-operator decisions outside MCP.

Manual apply is the default. An operator may separately configure
digest-bound supervised execution for eligible production actions. In that
mode, the response must disclose that reviewed policy may approve and a trusted
worker may later apply the proposal without a per-request click. The coding
agent still cannot enable, start, pause, configure, or control that worker. See
[Operator-Supervised Automatic Apply](supervised-automatic-apply.md).

## Recovery

Use the one next action Runner prints. Preserve the current project and review
state.

| Failure | Required response |
| --- | --- |
| Connection failed | Confirm the local environment variable and network path without printing the credential, then rerun `start`. |
| Privileged, writable, owner, `BYPASSRLS`, or unverifiable read role | Stop source-row exploration. Ask the user to supply a verifiably read-only role. |
| Tenant, principal, or row identity unresolved | Stop and direct the human to the highlighted Workbench exception. |
| Sensitive field blocked | Keep it out unless a human records a reasoned field decision. |
| Existing generated project | Run the same `start` command and choose Resume. Do not use `--force`. |
| Stale generation lock | Preserve active named capabilities; choose Rescan and review changes. |
| Workbench port unavailable | Use the single alternate loopback URL Runner prints or free the occupied local port. |
| Writeback prerequisites missing | Keep the proposal unchanged. Use `writeback setup` for a preview only and stop for human review. |

## What The Developer Should Understand

At the end, ask the developer to explain these four facts:

1. The model never receives raw SQL authority.
2. Reads are limited to reviewed fields under trusted tenant and principal
   scope.
3. Model-facing writes create proposals rather than committing changes.
4. The model cannot activate authority, approve proposals, or apply writes.

If any answer is unclear, reopen the Workbench Overview. Do not expand authority
to make onboarding appear successful.
