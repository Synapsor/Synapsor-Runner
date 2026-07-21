# Fresh-Developer Usability Protocol

Use this protocol with five developers who have not previously used Synapsor.
It is a launch gate, not an automated test. A maintainer may rehearse the
protocol, but must not report a participant result unless that person actually
completed the session.

## Goal

Measure whether a developer can connect an existing supported staging project,
draft one disabled Safe Action with a coding agent, receive an exact Data PR,
approve outside the agent, and find the guarded receipt without learning the
canonical JSON or SQL-like DSL first.

Measure product time separately from the initial package download. Start the
product timer only after `synapsor-runner --version` succeeds.

## Participant Setup

Provide each participant with:

- a fresh clone of their application or the support-plan-credit reference app;
- Node 22.13 or newer;
- a disposable Postgres staging database and least-privilege read/write roles;
- exported database URLs and trusted tenant/principal values;
- current stable Cursor, with no existing Synapsor configuration;
- the README only. Do not give verbal product-architecture instruction.

Never use production credentials or data. Record the OS, Node version, Cursor
version, package-install method, database engine, and whether the package was
already cached.

## Tasks

Ask the participant to complete these tasks without a maintainer taking control:

1. Run the four-second synthetic proof and identify whether the model can call
   `approve`, `apply`, `commit`, or raw SQL.
2. Connect the staging project and confirm the trusted organization scope.
3. Tell Cursor one business action to make safe and use the generated
   `/synapsor-protect` path or exact fallback prompt.
4. Find the disabled action file and explain why editing it does not activate a
   tool.
5. Open the Workbench effect preview and confirm the source row is unchanged.
6. Explicitly activate the reviewed digest through the operator-controlled UI.
7. Reconnect Cursor if instructed and create one proposal through the semantic
   tool.
8. Review the exact before/after Data PR, approve outside Cursor, and apply it.
9. Locate the receipt/replay record and explain what happens on retry.
10. Draft a second disabled action without changing the active tool surface.

Do not rescue a participant until they have been blocked for two minutes. Record
the exact screen, command, wording, or missing prerequisite that blocked them.

## Measurements

For each participant, record:

| Measure | Target |
| --- | --- |
| Installed CLI to first own-data Data PR | under 5 minutes |
| Installed CLI to first guarded receipt | under 8 minutes |
| Second disabled action draft after setup | under 2 minutes |
| Second action ready for explicit activation | under 5 minutes |
| Handwritten canonical JSON or DSL | none on the happy path |
| Extra CLI command after Cursor proposal call | none |
| Unsafe authority exposed to Cursor | none |

Also record every wrong turn, maintainer intervention, misunderstood trust
boundary, and request for a model-provider key or Synapsor account.

## Pass Criteria

The launch gate passes only when all five participants:

- complete the first Data PR without handwritten JSON or DSL;
- correctly identify that activation, approval, and apply are outside the
  model-facing MCP surface;
- observe unchanged source data before approval;
- produce one guarded receipt; and
- expose only the intended semantic read/proposal tools in Cursor.

At least four of five must meet every timing target. Any cross-tenant result,
hidden-field exposure, pre-approval mutation, automatic activation, raw SQL
tool, or model-visible commit authority is a release blocker regardless of
timing.

## Reporting Template

Record one row per real participant:

```text
Participant:
Date:
Environment:
Cold package download:
Product timer start:
First Data PR:
First receipt:
Second draft:
Second activation-ready action:
Interventions:
Tool surface observed:
Safety-boundary explanation:
Outcome: pass | fail
```

Until five real sessions are recorded, report this gate as **owner verification
pending**. Do not infer usability from unit tests, protocol tests, or a
maintainer-run demo.
