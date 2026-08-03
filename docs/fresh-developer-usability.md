# Fresh-Developer Usability Protocol

This is the owner-observation script for Runner 1.6.6. Give it to a
database-familiar developer who has not used Synapsor. Automated tests prove
the mechanics; this protocol checks whether the product is understandable.

Do not report a participant result unless that person actually completed the
session.

## Goal

Starting from an empty directory and a synthetic or disposable staging
database, the participant should reach:

```text
Connect -> Review -> Try -> Ask through a model repeatedly
                         |-> use an existing model-enabled MCP client
                         |-> optionally use the no-model exact-plan fallback
                         `-> optionally Protect -> Propose
```

They must do so without raw SQL, hand-authored config/DSL/JSON/DDL, an account,
Cloud, Cursor, a model key, or maintainer instruction.

Run the protocol twice:

- once with the owner operating the product without implementation coaching;
- once with a technically capable developer who has not worked on Runner
  internals.

Automation, a maintainer driving the browser, and screenshot inspection do not
substitute for either participant.

Measure product time separately from initial package download or local package
installation. Start the timer after the candidate version check succeeds.

For a released build:

```bash
npx -y @synapsor/runner --version
```

For an unpublished candidate, the facilitator must provide the exact packed
Spec, DSL, and Runner tarballs rather than silently testing whatever npm
currently labels `latest`. Runner's startup command needs the local Spec and
Runner tarballs; the DSL tarball is part of the same candidate set and is
verified separately:

```bash
export SYNAPSOR_SPEC_TARBALL=/absolute/path/to/synapsor-spec-1.8.0.tgz
export SYNAPSOR_DSL_TARBALL=/absolute/path/to/synapsor-dsl-1.8.0.tgz
export SYNAPSOR_RUNNER_TARBALL=/absolute/path/to/synapsor-runner-1.6.6.tgz
npm exec --yes \
  --package "$SYNAPSOR_SPEC_TARBALL" \
  --package "$SYNAPSOR_RUNNER_TARBALL" -- \
  synapsor-runner --version
```

The maintainer-validated candidate set uses tarballs produced by:

```bash
pnpm --dir packages/spec pack --pack-destination <directory>
pnpm --dir packages/dsl pack --pack-destination <directory>
pnpm --dir apps/runner pack --pack-destination <directory>
```

Record all three SHA-256 values with the participant result. A candidate is not
valid when only Runner is packed against a same-version public Spec or DSL
whose contents differ from the local source.

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
Set up Synapsor for this staging application. Reach one safe read, ask three
different bounded aggregate questions without another review, optionally
protect one selected analysis as a reusable tool, and create one safe write
proposal. Explain what the model can and cannot do as you go.
```

Do not explain Synapsor’s architecture first.

## Starting Command

For a released build, the participant should find and run:

```bash
npx -y @synapsor/runner start --from-env DATABASE_URL
```

For the unpublished candidate, give the participant the equivalent single
command after the version check:

```bash
npm exec --yes \
  --package "$SYNAPSOR_SPEC_TARBALL" \
  --package "$SYNAPSOR_RUNNER_TARBALL" -- \
  synapsor-runner start --from-env DATABASE_URL
```

No other shell command should be required through the first proposal. The
participant may use Workbench for all human review and Try steps.

The starting command is the one environment-selection action. The participant
must not be asked in Workbench, Ask, the shell, or MCP to select, sign, or
re-confirm that the database is development/staging or “not production.”
Workbench may show the local authoring profile as read-only status. Record any
second environment declaration as a usability failure.

## Observation Tasks

Record whether the participant can:

1. identify the database, inspected resources, and current authority state;
2. recognize that the local authoring profile came from the starting command
   without making a second environment declaration;
3. explain why no source row was read before activation;
4. find fields Runner kept out and unresolved high-risk exceptions;
5. confirm row identity, tenant scope, and principal scope;
6. activate only the displayed reviewed digest;
7. drive one real safe read and state which fields were visible;
8. explain that the result came from a named capability or temporary
   authoring-only Explore authority;
9. reach Workbench Ask or an existing model-enabled MCP client as the primary
   post-activation path and ask one unfamiliar PM-style aggregate without SQL
   or plan JSON;
10. understand a cohort-suppression or reviewed-boundary refusal;
11. recover from one intentionally blocked request using the displayed single
    next action;
12. continue with at least two different reviewed combinations without
    Protect, another review, or a named capability;
13. Protect one useful result without copying an opaque handle;
14. explain why the protected capability is still disabled;
15. activate that exact digest and confirm Explore can be disabled while the
    named capability remains;
16. choose **Add a safe action** and define one bounded single-row business
    proposal;
17. explain why schema structure did not grant business write authority;
18. call the action and confirm the source database is unchanged;
19. find the proposal, exact effect, required approval, receipt mode, and
    conflict guard;
20. explain who may activate, approve, and apply.

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
| First safe read on the eligible narrow lane | at most 60 seconds |
| First safe read when the narrow lane is correctly unavailable | at most 3 minutes through explicit review |
| First PM-style aggregate | at most 5 minutes |
| Three related refinements | at most 7 minutes, including one exact comparison and one changed reviewed dimension or filter |
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

Within five seconds of the first actionable screen, ask the participant to
point out the proposed question, visible and hidden data, trusted scope,
mutation posture, and the single next action. Within three minutes, they must
understand that they can ask another legal combination and identify how an
external agent connects without being forced to configure it.

The run fails if the participant asks what the screen means, encounters
contradictory state, needs implementation terminology explained, requires
engineer coaching, or abandons before first value. Record the exact wording and
screen instead of helping them past it and reporting a pass.

It also fails the intended model-first path when the safe-read completion sends
the participant into the exact-plan form by default, hides existing-client
setup, or makes the participant configure a second model despite already using
a supported MCP host.

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
Spec candidate tarball:
Spec SHA-256:
DSL candidate tarball:
DSL SHA-256:
Runner candidate tarball:
Runner SHA-256:
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
Questions asked:
Points of hesitation:
Interventions:
Four-part explanation:
Outcome: pass | fail
```

## Maintainer Evidence

The automated packed FitFlow run records deterministic timing and interaction
evidence in:

```text
development/runner-1.6.6-fitflow-results.json
```

That evidence does not substitute for a first-time participant. Until a real
session is recorded, report **owner observation pending**, not “developer
usability proven.”
