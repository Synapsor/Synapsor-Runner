# Runner 1.6.6 Human Usability Observations

This record covers the two human release gates required by
`docs/fresh-developer-usability.md`. Automated browser runs, screenshots, model
calls, and maintainer-driven tests do not count as participant observations.

## Failed Candidate

Candidate root:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-source-candidate
```

| Package | Artifact | SHA-256 |
| --- | --- | --- |
| `@synapsor/spec@1.7.0` | `spec/synapsor-spec-1.7.0.tgz` | `76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71` |
| `@synapsor/dsl@1.7.0` | `dsl/synapsor-dsl-1.7.0.tgz` | `4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e` |
| `@synapsor/runner@1.6.6` | `runner/synapsor-runner-1.6.6.tgz` | `9132a22c93d73c936315940ba69d7f959c07a06384af4d96a23218a85a0d81c8` |

`SHA256SUMS` at the candidate root must validate before each observation. If
any artifact changes, create a new candidate and do not combine observations
from different hashes.

## Superseded Quick-Start Candidate

The Quick Start selection repair was packed separately, then superseded after
the owner required model-first analytics. Preserve it for traceability; do not
use it for a new observation:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-quick-start-fix-candidate
```

| Package | Artifact | SHA-256 |
| --- | --- | --- |
| `@synapsor/spec@1.7.0` | `spec/synapsor-spec-1.7.0.tgz` | `76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71` |
| `@synapsor/dsl@1.7.0` | `dsl/synapsor-dsl-1.7.0.tgz` | `4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e` |
| `@synapsor/runner@1.6.6` | `runner/synapsor-runner-1.6.6.tgz` | `a766ad71adabd27de6555f68f5100d6f05282779c48167ac65c4cf1699d9e2fc` |
| `synapsor-runner@1.6.6` | `alias/synapsor-runner-1.6.6.tgz` | `e8643f2a579e1b42aa91aa5a9dcb59783b7e0857b0167d7a456e6f44f4103a64` |

`SHA256SUMS` validates all four files. The Spec, DSL, and alias are
byte-identical to the failed candidate; only the scoped Runner changed. The
replacement passed the complete 71-file/1,021-test root suite, packed Runner
and alias verification, and the principal-absent browser gate. Those automated
checks do not turn the failed owner observation into a pass.

## Superseded Model-First Candidate

This candidate is no longer eligible for owner or independent-developer
observations:

```text
/home/sandesh-tiwari/Desktop/C++/synapsor-release-candidates/runner-1.6.6-20260728-model-first-messaging-candidate
```

| Package | Artifact | SHA-256 |
| --- | --- | --- |
| `@synapsor/spec@1.7.0` | `spec/synapsor-spec-1.7.0.tgz` | `76e45614a3e61577fd39a7aafbf76f00cda00ff9120a76f8990bbaab515d4a71` |
| `@synapsor/dsl@1.7.0` | `dsl/synapsor-dsl-1.7.0.tgz` | `4732ada0573c45e7590d57721fb50d6d5352453f3252bec831ab8146da8ef54e` |
| `@synapsor/runner@1.6.6` | `runner/synapsor-runner-1.6.6.tgz` | `91e5b40586634479d78069991db4ff9da23eeb59eaf41bd12b77a2698459c6ca` |
| `synapsor-runner@1.6.6` | `alias/synapsor-runner-1.6.6.tgz` | `e8643f2a579e1b42aa91aa5a9dcb59783b7e0857b0167d7a456e6f44f4103a64` |

`SHA256SUMS` validates all four files. Model-powered Workbench Ask is now the
primary post-activation path; using an existing model-enabled MCP client is a
peer path; the no-model exact-plan composer is an optional fallback. Automated
evidence includes 71/71 test files and 1,021/1,021 tests, desktop/mobile browser
coverage, deterministic Workbench Ask, packed guided onboarding, packed Runner
and alias verification, and a clean exact-tarball install. This does not satisfy
either human gate. The owner subsequently found the authority-to-advertising
defect recorded below, so this candidate is superseded.

## Participant Prompt

Give each participant only this product task after facilitator setup:

```text
Set up Synapsor for this staging application. Reach one safe read, then use
Workbench Ask or an existing model-enabled MCP client to ask three different
bounded aggregate questions without another review. Optionally protect one
analysis as a reusable tool, and create one safe write proposal. Explain what
the model can and cannot do as you go.
```

Do not explain Runner internals or rescue the participant before two minutes.
Confusion, contradictory state, implementation terminology, or abandonment is
a failed observation and must be recorded verbatim.

## Owner Observation

Status: failed - current candidate retest required

The owner launched the exact Runner candidate in
`/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test` on 2026-07-28. The
first Quick Start viewport displayed the primary action
`This is my development database: activate this narrow read and run it` as
disabled. The owner could not reach first value and reported the blocker
without implementation coaching.

Authoritative inspection found:

- installed Runner: `@synapsor/runner@1.6.6`;
- Runner tarball SHA-256:
  `9132a22c93d73c936315940ba69d7f959c07a06384af4d96a23218a85a0d81c8`;
- Node: `v22.22.2`;
- `DATABASE_URL` and `SYNAPSOR_TENANT_ID` were set in the running process;
- `SYNAPSOR_PRINCIPAL` was absent;
- Quick Start selected `public.classes`, whose reviewed principal key is
  `trainer_id`;
- the same draft contained `public.check_ins`, a tenant-scoped analytical
  resource requiring no principal binding;
- the button was disabled solely because ranking gave principal-scoped
  resources a 40-point bonus before checking first-value ceremony.

This is a product defect, not missing operator work. The run fails DoD 14,
23-26, and 28-30 before first result. It cannot be converted into a pass after
the source fix; the owner must repeat against a newly packed and hashed
candidate.

```text
Participant: owner
Date: 2026-07-28
OS and Node version: Linux; Node v22.22.2
Package cache state:
Database engine and fixture: PostgreSQL; synthetic 40-resource FitFlow project
Product timer start:
First actionable viewport: Quick Start, with primary action disabled
First safe result: not reached
First aggregate: not reached
Three related refinements: not reached
Protected capability: not reached
First proposal: not reached
Shell commands:
Workbench primary actions: disabled narrow-read action; full-review alternative
Clicks:
Human authority decisions:
Manual project-file edits: none reported
External documentation opened: none reported
Blocked-request recovery: none offered that could run first value
Questions asked: why is the primary action disabled?
Points of hesitation: disabled first-value action
Maintainer interventions: none before failure report
Could identify question/visible-hidden data/scope/mutation/next action in 5s: no executable next action
Could identify another legal combination and external client path in 3m: not reached
Four-part authority explanation: not assessed
Outcome: fail
```

The owner then repeated the fresh-project journey in:

```text
/home/sandesh-tiwari/Desktop/C++/Synapsor-runner-test/project-model-first-20260728
```

The installed unpublished Runner tarball had SHA-256
`91e5b40586634479d78069991db4ff9da23eeb59eaf41bd12b77a2698459c6ca`.
The exact activated boundary contained only:

- resource `public.check_ins`;
- groupable field `outcome`;
- count-distinct field `id`;
- day, week, and month buckets on `checked_in_at`;
- no active relationship to members, locations, or regions.

Workbench Ask nevertheless advertised the placeholder question
`Which reviewed regions contributed most to the weekly change?`. That question
was impossible under the exact activated boundary. Asking either that question
or `How many members do we have?` caused every attempted data plan to be
refused, after which Workbench displayed only:

```text
Request refused safely
The provider returned no final answer.
```

This is a second owner-gate failure. It proves two product defects:

1. Ask starters and placeholders were not derived and validated against the
   exact activated boundary.
2. An all-refused provider tool loop discarded actionable refusal context and
   failed to explain what the reviewed boundary could answer.

The replacement must generate and validate every advertised question against
the exact active authority, preserve attempted-plan refusal codes, and return a
Runner-authored boundary explanation when the provider supplies no final prose.
Automation must include the exact authority-to-advertising seam. This failed
run cannot become a pass after the source repair; the owner must repeat it
against a newly packed and hashed candidate.

The same owner run also found that the first Quick Start screen did not make
the activation decision convincing or understandable. The owner clicked the
enabled green action without being confident what boundary it would activate.
Although the screen listed visible fields, hidden fields, scope, and limits, it
did not plainly communicate that the selected resource was the entire initial
boundary, what other inspected resources remained unavailable, or that a
developer could review and change table/column access before activation. The
alternative action was framed only as a path for shared or production-like
data, which incorrectly discouraged development users who wanted control.

The replacement first viewport must:

- name the exact selected data area/table and state that it is the whole
  initial active boundary;
- summarize visible fields, kept-out fields, trusted scope, limits, and one
  actually executable first question;
- say plainly that every other inspected resource and field remains blocked;
- expose a clear `Review or change access` path for choosing resources and
  fields before activation;
- preserve one fast primary action without forcing a full matrix review;
- separate the human activation meaning from the subsequent safe-read result
  in its copy, even when one gesture orchestrates both operations.

The owner also reconfirmed that model-first means the first default analytical
experience, not merely a model button shown after a no-model result. The
current Quick Start still activates and renders a deterministic composer result
before offering Workbench Ask. That ordering is a product defect. The primary
path must be review boundary, activate, then ask naturally through Workbench Ask
or an existing model-enabled MCP client. The deterministic exact-plan composer
and no-model read remain supported as an explicit `Use without a model`
alternative against the identical boundary.

The owner then ran the valid generated question
`How did check ins change by week across outcome?`. The model first described
the catalog, attempted two invalid bounded plans (`count` with a field and a
`top_n` above the reviewed limit), then executed the valid plan. Runner correctly
refused both invalid attempts, returned the valid weekly result, suppressed one
small cohort, and did not expose the suppressed label or value.

The authority behavior passed, but the presentation failed: Workbench displayed
the catalog lookup, both recovered refusals, a long model-generated duplicate of
the table, the final verified table, and internal caution text in one flat
transcript. For a turn that eventually succeeds, the primary answer must show a
concise model interpretation and the final verified Runner result. Metadata
lookups and safely recovered intermediate refusals must be summarized and
collapsed by default, while remaining inspectable. If no valid plan succeeds,
the refusals remain prominent. Provider instructions must ask for a concise
interpretation without repeating rows, tables, audit internals, generic safety
boilerplate, or an unsolicited follow-up menu.

The same review established one additional usability failure: the fresh local
guided route had already received the selected database URL and opened secured
loopback Workbench, but the interface still asked the owner to declare an
environment profile. For this route, the start command is the one
environment-selection action. Any later request in Workbench, Ask, the
interactive shell, or MCP to select, sign, or re-confirm "development",
"staging", or "not production" is a usability failure. The established local
authoring profile may be displayed as read-only status; it cannot be changed by
the browser, model, MCP request, provider response, or source data.

The implementation has removed that second declaration and the browser gate
now proves request-body profile overrides are refused. This repair does not turn
the failed owner observation into a pass. The owner must repeat the complete
journey against the next exact packed candidate.

## Current Candidate

Status: none

The model-first candidate is superseded. A replacement candidate may be named
only after the authority-derived starter and all-refused Ask repairs pass the
focused, browser, full-suite, and packed-artifact gates.

## Independent-Developer Observation

Status: pending

The participant must be technically capable and unfamiliar with Runner
internals. Use a new empty project and the current candidate hashes.

```text
Participant:
Date:
Relationship to project:
Prior Runner-internals work: none
OS and Node version:
Package cache state:
Database engine and fixture:
Surface used:
Product timer start:
First actionable viewport:
First safe result:
First aggregate:
Three related refinements:
Protected capability:
First proposal:
Shell commands:
Workbench primary actions:
Clicks:
Human authority decisions:
Manual project-file edits:
External documentation opened:
Blocked-request recovery:
Questions asked:
Points of hesitation:
Maintainer interventions:
Could identify question/visible-hidden data/scope/mutation/next action in 5s:
Could identify another legal combination and external client path in 3m:
Four-part authority explanation:
Outcome: pending
```

## Completion Rule

Do not change either status to `pass` from automation or inference. Both people
must complete their own observation against the exact candidate. Any candidate
change after a failed observation requires rerunning the affected observation
against the current hashes.
