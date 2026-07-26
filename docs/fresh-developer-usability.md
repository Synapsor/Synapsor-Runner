# Fresh-Developer Usability Protocol

This is the owner-observation script for Runner 1.6.4. Give it to a
database-familiar developer who has not used Synapsor. Automated tests prove
the mechanics; this protocol checks whether the product is understandable.

Do not report a participant result unless that person actually completed the
session.

## Goal

Starting from an empty directory and a synthetic or disposable staging
database, the participant should reach:

```text
Connect -> Review -> Try -> Explore -> Protect -> Propose
```

They must do so without raw SQL, hand-authored config/DSL/JSON/DDL, an account,
Cloud, Cursor, a model key, or maintainer instruction.

Measure product time separately from initial npm download. Start the timer
after this succeeds:

```bash
npx -y @synapsor/runner --version
```

## Setup

Provide:

- Node 22.13 or newer;
- the packaged synthetic FitFlow fixture or equivalent disposable staging
  Postgres;
- a SELECT-only, non-owner connection URL available for hidden paste or an
  explicitly approved project `.env` file;
- the README only;
- no existing Synapsor project files.

Never use production credentials or data. Record OS, Node version, package
cache state, database engine, and whether an external document was opened.

## Participant Prompt

Say only:

```text
Set up Synapsor for this staging application. Reach one safe read, ask one
bounded aggregate question you have not seen before, protect that analysis as
a reusable tool, and create one safe write proposal. Explain what the model can
and cannot do as you go.
```

Do not explain Synapsor’s architecture first.

## Starting Command

The participant should find and run:

```bash
npx -y @synapsor/runner start
```

No other shell command should be required through the first proposal. The
participant may use Workbench for all human review and Try steps.

## Observation Tasks

Record whether the participant can:

1. identify the database, inspected resources, and current authority state;
2. explain why no source row was read before activation;
3. find fields Runner kept out and unresolved high-risk exceptions;
4. confirm row identity, tenant scope, and principal scope;
5. activate only the displayed reviewed digest;
6. drive one real safe read and state which fields were visible;
7. explain that the result came from a named capability or temporary
   authoring-only Explore authority;
8. ask one unfamiliar PM-style aggregate without SQL or plan JSON;
9. understand a cohort-suppression or reviewed-boundary refusal;
10. recover from one intentionally blocked request using the displayed single
    next action;
11. Protect the useful result without copying an opaque handle;
12. explain why the protected capability is still disabled;
13. activate that exact digest and confirm Explore can be disabled while the
    named capability remains;
14. choose **Add a safe action** and define one bounded single-row business
    proposal;
15. explain why schema structure did not grant business write authority;
16. call the action and confirm the source database is unchanged;
17. find the proposal, exact effect, required approval, receipt mode, and
    conflict guard;
18. explain who may activate, approve, and apply.

Do not rescue the participant until they have been blocked for two minutes.
Record the exact screen, wording, or prerequisite that blocked them.

## Required Comprehension Check

Ask the participant to explain these four facts in their own words:

1. The model does not receive raw SQL.
2. Reads use reviewed fields and trusted tenant/principal scope.
3. Model-facing writes create proposals instead of committing.
4. The model cannot activate, approve, or apply.

Any incorrect answer is a usability failure even when the commands worked.

## Measurements

| Measure | Release target |
| --- | --- |
| First schema summary | at most 60 seconds |
| First safe read | at most 3 minutes |
| First PM-style aggregate | at most 5 minutes |
| First protected named capability | at most 8 minutes |
| First guided proposal | at most 10 minutes |
| Shell commands through first proposal | at most 3; golden target is 1 |
| Manual project-file edits | 0 |
| External documentation searches | 0 |
| Raw SQL or plan JSON composed | 0 |
| Opaque handles copied | 0 |
| Screens with multiple primary next actions | 0 |
| Unsafe authority exposed to a model | 0 |

Also record clicks, deliberate human security decisions, wrong turns,
maintainer interventions, and whether resuming the first command changed any
file or digest.

For a realistic 30–50-table schema, the first useful result must still complete
within five minutes through review by exception. A blind bulk-approval control
is an automatic failure.

## Safety Blockers

Stop and fail the release for any:

- cross-tenant or cross-principal result;
- kept-out-field exposure;
- source-row read before activation;
- source mutation before approval;
- automatic activation;
- raw SQL/SQL-string/model-generated identifier;
- model-visible activation, approval, apply, commit, setup, or revert;
- production or remote Scoped Explore tool;
- write-capable/owner/superuser/`BYPASSRLS` Explore credential;
- discarded review state after a recoverable failure.

## Recording Template

```text
Participant:
Date:
Environment:
Package cached: yes | no
Product timer start:
Schema summary:
First safe read:
First aggregate:
Protected capability:
First proposal:
Shell commands:
Workbench primary actions:
Human authority decisions:
Manual file edits:
External docs opened:
Blocked-request recovery:
Interventions:
Four-part explanation:
Outcome: pass | fail
```

## Maintainer Evidence

The automated packed FitFlow run records deterministic timing and interaction
evidence in:

```text
development/runner-1.6.4-fitflow-results.json
```

That evidence does not substitute for a first-time participant. Until a real
session is recorded, report **owner observation pending**, not “developer
usability proven.”
