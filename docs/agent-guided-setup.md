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

The product path has one entry point. A developer with a database URL should
not have to run separate inspect, config, Read, Action, and MCP setup wizards:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL --cli
```

Runner performs metadata-only inspection, starts one model-guided job
conversation, keeps all generated authority disabled until exact operator
permissions, and prints the MCP install command when the selected Read and
Action surfaces are usable. Manual controls remain available from the same
screen.

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

From the intended project directory, run the preferred CLI:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL --cli
```

For a fresh interactive project, Runner performs metadata-only inspection,
creates disabled review artifacts, validates the generated project, initializes
the local ledger, and starts one Boundary conversation. The human chooses a
configured OpenAI, Anthropic, or loopback model, or selects the no-model path.
Workbench remains an optional preview rather than the primary route.

For an existing guided project, the same command resumes it. Resume and Try do
not rescan the database, rewrite files, or change a digest. To inspect the live
schema and role posture again, use `start --from-env DATABASE_URL --rescan`.
That flag is universal: it works for single-organization and multi-tenant
projects. It preserves unchanged reviewed decisions, invalidates only inputs
affected by real schema or role-posture drift, and prints an itemized diff. The
result remains a disabled update that requires human review and activation. On
this Start path, `--force` uses the same guarded reconciliation; prefer
`--rescan` for clarity.

Runner accepts one ordinary-language job of up to 2,000 characters. It derives
separate, shorter representative Read questions rather than treating the whole
job as one Explore question. If authoring pauses, the same command offers to
resume the exact job, concise Read intent, accepted business answers, provider,
and disabled drafts. It does not ask the human to restate them.

Report:

```text
Runner created or resumed a disabled local boundary. No source rows were read
and the database was not changed.
Next: choose the drafting path and review the exact model-metadata permission.
```

The coding agent may explain the permission, but the human decides whether the
named structural metadata may go to the named provider. `View exact Runner
details` is a visible choice inside confirmations; `/details` is available at
conversation prompts. Neither path calls the model or changes authority.

Then stop for any human decision about:

- fields kept out and fields still uncertain;
- exact row identity;
- trusted tenant and principal scope;
- aggregate-safe dimensions and measures;
- database-role and RLS posture;
- the exact Read or Action authority being activated.

Principal-column names are candidates, not proof. The human may confirm their
business meaning only from application identity design or reviewed RLS policy.
Concrete tenant and principal values are never needed while authoring reusable
Boundaries. Do not click, type, or call an authority confirmation for the user.

### 3. Review Read And Action Separately

One job may produce two disabled artifacts:

- the Read Boundary controls `app.describe_data` and `app.explore_data`;
- the Action Boundary controls proposal-only business outcomes through
  `app.describe_actions` and `app.request_change`.

The model may propose both, but cannot activate either. Runner presents the
complete Read permission and the complete Action permission separately. Action
activation also requires its exact Read dependency to be active. Approval and
apply remain later, independent authorities.

For a rule-derived action, verify that the agent supplies only an outcome and
opaque subject references. Runner privately loads facts and derives the exact
one-row effect. The model must not supply a patch, raw key, tenant, principal,
approval mode, or executor. See the [Action Rule Engine](action-rule-engine.md).

After the human finishes the exact reviews, the coding agent may verify the
surface:

```bash
synapsor-runner tools list \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Expected after Read-only activation:

```text
app.describe_data
app.explore_data
```

Expected after the dependent Action Boundary is also active:

```text
app.describe_data
app.explore_data
app.describe_actions
app.request_change
```

The two namespaces remain independently activatable. There is no new MCP tool
for every query or business outcome.

### 4. Verify The Active Read Surface

The coding agent may list reviewed tools without inventing scope arguments:

```bash
synapsor-runner tools list --config ./synapsor.runner.json
```

Terminal Ask or the Explore playground can exercise a reviewed Read Boundary.
Do not invent tenant or principal arguments. At runtime, trusted scope comes
from the reviewed environment/session binding outside model input.

Report after a successful bounded read:

```text
Your reviewed Read Boundary is working.
The result used only reviewed fields and trusted scope.
Source database changed: no.
Next: connect the same Read surface and, if activated, its separate Action
surface to your MCP client.
```

### 5. Present MCP Setup

Runner prints ready-to-copy configurations for:

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
synapsor-runner mcp install claude-code \
  --project --authoring --project-root . --dry-run
```

Use `cursor` or `vscode` instead when that is the selected client. Show the
dry-run result first. Installation remains a human choice. Local stdio uses one
`synapsor` entry with four fixed tools. Read and Action authority are independently
reviewed; sharing a transport does not activate either one.

## Guided Write Action

After the first safe read, the preferred terminal control plane can generate
one bounded write action; the preview Workbench exposes the same domain flow:

```text
synapsor> /actions
```

Or launch it directly:

```bash
synapsor-runner action review --project-root .
```

Schema structure supplies candidates only. The human decides business intent,
allowed fields, values or transitions, trusted scope, version guard, reviewer,
limits, optional bounded policy approval, execution posture, receipt mode, and
compensation. A bounded operator/model suggestion may reorder candidates but
cannot skip any decision or activate authority. See the [Safe Action Human
Control Plane](safe-action-control-plane.md).

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
