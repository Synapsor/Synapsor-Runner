# New two-case Stage B — 20 September 2026

**NEW-SB-A: FAIL. NEW-SB-B: FAIL. New attempt: ATTEMPTED / NOT PASSED.** Both journeys stopped during authoring/review. Neither reached activation, a runtime business request, worker dispatch, receipt, edit, addition or removal. No product, prompt or package changes were made, and no replacement case was selected.

**Historical original Stage B: ATTEMPTED / NOT PASSED**, unchanged. Historical Stage A and narrow recovery/replay acceptances remain attached to their own artifacts and tested scopes.

## Identity and roles

| Identity | Value |
|---|---|
| Canonical baseline | `codex/tui-safe-action-control-plane`, `d3dbf16fed394082ef2e6e4b7d0bc63ad6929cba` |
| Product/tests | `36a5e0e3034127f842a2053048a13ca9e05639a1` |
| Frozen source/evidence | `5bb7e6bd82386a53f49a6525a004fca9d5cdd06d` |
| Installed tree | `9392b9364af45f2b15e8599b5382179e36a57404660b5de32fd58df0a6fa4bf7` |
| Installed manifest | `a1f335cc0be0838327d935c2c5399a86217593330361f22bd327f864acfd92a2` |
| Installed archive | `4417f2a41304947d373da4f648f0d31b34b5823f6ac69736482025f006fdb847` |
| Source archive | `133ccedaf689d812b8f7a400ce790459288da70d2afc9df611d5b608714577fe` |
| Lockfile | `2cc29c8bfb487a405b9127caf4bf3e57120b2955627bceddd2edf37347474b8f` |
| Dependencies inventory | `1222ade936611dd20890b66fbc2d453ba19a9d02928c1d19654bba80bc4f4ab7` |

Runner 1.8.0, local Spec 1.11.0, Node 22.22.2. Node binary SHA-256 `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90`. All 7,569 installed entries, including bytes, modes and symlink targets, verified before selection and after the trials. External packages and sealed case inputs also reverified unchanged. There was no new freeze/build.

Main Codex prepared the common envelope/meter and Case B inputs, then operated tester-authored Case A. The separate tester prepared Case A and personally operated Case B without reading its hidden oracle. It independently inspected main's stopped A capture afterward against its own oracle. This is two cross-authored trials, not two independent runs of each case, a real-human usability study or a model-family comparison. No implementation coaching occurred during either live episode; main's internal-source diagnostic began only after A was stopped and sealed.

The tester signed the prerequisite checkpoint before case selection (`SHARED-CHECKPOINT-SIGNOFF.md`, SHA-256 `aa54b93f298f770d94a2b52704e3ff22f26f8aee3ae7e3a5d98de1d14c125c3b`). The preserved v2 plan states the supported envelope, audit reconciliation, budgets and required rows. Both authors selected one paper/DDL candidate; neither screened a series of model interviews.

## Cases and provider contract

**A: wildlife rehabilitation release clearance**, 38 source rows in three tables. Scalar public assessment with two forward private related bindings; one versioned UPDATE; typed release-window input; automatic versus supervisor review; tenant/outcome rolling limits; declared Runner-ledger receipts. Its later phases reserved a numeric limit edit, a distinct postponement outcome and its removal. Source-only packet SHA-256 `fbd945187b170e9e53f352def02b072f16592ad460bb80a5227e11039e57ed2a`. Initial policy SHA-256 `d4e783115e819649c2be8fa5cfc7abe9d31f891c51eb0315b0a44a0c90388cd5`.

**B: cooperative microgrid metering settlement**, 196 rows in four tables. Two bounded private complete collections, filtered numeric SUM and absence of blocking notes, plus atomic cycle/register updates and required source_db receipts. This differs structurally from the earlier single checks-count/constant companion-update software case and from A. Later phases reserved an automatic-threshold edit, a distinct human-reviewed follow-up flag and removal. Operator/source packet SHA-256 `6508a3a46257dd8e78f4d8bf5526135f604d5c8c12ff4d61ec1cf90b3205f60f`; initial policy SHA-256 `809b76df7917a192accc5061b20e4cb0a363508b5cd7fe877727518f2147a55c`.

Both were fresh projects with no imported Runner business authority, approvals, receipts or writer setup. PostgreSQL 17 sources used inspected full-scope immediate FKs, FORCE RLS, restricted readers and privately generated local credentials; control topology was SQLite per job. Source-owner facts, later phase texts, contexts and scenario subjects were sealed before the first case call. Private expected results stayed outside authoring inputs. Case B's initial manifest omitted the separately archived selection note; an additive metadata seal bound it before the live run without changing inputs or rewriting the original manifest. A's concrete deployment contexts and full-row normalization recipe were supplied separately before live use; neither became authoring input.

Authoring was **OpenRouter / `openai/gpt-5.6-terra`**, same settings in both cases: 120-second timeout, normal operation-specific output budgets (coverage 12,000; Action 5,000), reasoning/temperature/top_p/parallel_tool_calls omitted, required parameters, no fallback and data-collection-denying routing. Exact settings are in `PROVIDER-PLAN-v2.json`. The preflighted runtime pair was native Claude Code 2.1.278 / Anthropic `claude-opus-5`, high effort/adaptive thinking, 4,096 output tokens and only the four runtime tools. **Neither case reached that runtime client.** Neutral runtime success is not case runtime evidence.

The user authorized a $10 available balance. Shared ceilings were $0.20 neutral and $4.90 per case, including authoring/runtime failures, enforced by one reservation ledger. Four neutral transports exhausted the shared preflight allowance at $0.066902. Case A used 15 transports, $0.2882805; B used 16, $0.221205. **Total reported cost: $0.5763875**; no unsettled case reservations. Native neutral cost is the client's reported estimate, not an independently reconciled account bill. The stopped allocation status prevents further case calls. There were zero case runtime-model transports, public MCP calls, request_change calls, workers or successful business-effect transactions.

## A: saved correct counter selectors, then invalid review

The main operator used installed `start`, explicitly reviewed metadata/policy transfer, supplied the sealed ordinary job and policy, selected Claude Code, answered the organization/person distinction using the owner sheet, and explicitly confirmed the maintained-counter contract. No concrete identity values or source rows entered authoring. The disabled Read and Action were saved; no activation or execution confirmation was given.

The supplied coverage context contained two exact `release.clear_assessment` history selectors, with maxima 2 and 8 and 86,400-second windows. The provider's complete response 15 instead submitted `current_capability:null` and `required_capability:null` for both counters, asserting singleton equivalence in passage 9. This assertion contradicted the actual context; it was not a new owner ambiguity or a changed source.

The exact first parser refusal was:

```
Counter evidence changed at /runner_evidence/actions/release.clear_assessment/automatic_limits/0/history_selector/capability; reconcile the current filter before proposing any repair.
```

`authoring-policy-coverage.ts` rejects that mismatch before accepting the passage. `coverageFinding()` does not classify this message specifically and returns `COVERAGE_VALIDATION_INCOMPLETE`, `structural:false`, at `/passages/9`. The normal bounded structural-correction loop consequently sent no second coverage request. The public screen said the rules check needed a retry, retained the draft and made activation unavailable. The operator kept Read disabled and exited 0; exit zero was not BUSINESS completion. No new review episode was launched to seek agreement.

After freezing the stopped state, a zero-provider, zero-store-open diagnostic fed the **unchanged full response and captured context** into the actual source parser. It reproduced the same refusal and identical feedback context `sha256:6aa70b39710836a64d4441f534d23c2783b7298b4865655a2b5f0431799de148`. `replay-a-coverage.mts` records the exact command. This is diagnostic source-module evidence, not another installed public run or a repaired response.

The tester independently confirmed that the disabled core Action preserves the initial policy and the mismatch refusal is correct. A separate submitted coverage passage identified missing public-label filtering; saved evidence confirms the label is returned and `filterable_fields` is empty. Runtime discovery was not exercised, so this does not establish a general inability to find a label by any permitted listing. Other coverage claims and duties were not accepted by a completed review. No false affirmative counting proof or ownership was persisted.

Logical state at stop: two draft pointers (Read and Action); only management entries active; zero business approvals, proposals, queue rows, effects, receipts or authority reviews. Management revisions/events legitimately changed (through epoch 8), so no whole-ledger byte identity is claimed. All 38 source rows were identical to the initial baseline, SHA-256 `51687e126e9b7b2860fe38c3678e6c54a965fd1518aec33cb2ca89d1bf75f7a4`.

## B: arithmetic authoring failed, compiler failure not established

The tester personally operated installed `start`, approved the exact structural/policy transfer and used the sealed job text. The model failed to produce the required register increment. Captured Runner findings included `ACTION_RULE_INVALID` at `rule.atomic_updates.0.set.credited_total.kind` and `rule.derive.new_credited_total.kind`: `kind add is unsupported`, followed by `kind arithmetic is unsupported`.

The provider-visible schema advertises `{kind:"math", operation:"add", inputs:[...]}`. The model instead used `kind:"add"` / `kind:"arithmetic"` with left/right operands and never submitted the advertised form. It eventually called this a compiler blocker. **The observed failure is the model-assisted authoring journey; a defect rejecting valid compiler input is NOT ESTABLISHED.** Repeated error records in later request histories are copies of earlier tool results, not additional distinct validation attempts.

The tester paused at the ordinary prompt after the product's bounded attempts, with no structured Action candidate and authority inactive. All 196 source rows matched baseline SHA-256 `3d350f3f75ea99b020e95264008f90a0a0ae286d659c36e3a46d0a59cc6fd9bc`. Main inspected the report and captured diagnostic/schema evidence; it did not independently repeat B's journey.

Tester report: `/home/sandesh-tiwari/Desktop/Synapsor Tutorials/test-1.8.0/stage-b-two-case-b-operator-20260920/REVIEW.md`, SHA-256 `e856137405f4dfa98b7daf90ded3d7b8b665d286d179078fa8c82a35f56e32e3`. Its additive clarification/A inspection has SHA-256 `7cc2b62a0df3e255d3e88044c14570118f44938540427fab2ef4f44fb87a9a77`; the original report remains unchanged.

## Required rows and measured friction

| Required observation | A | B |
|---|---|---|
| Candidate, sealed source, scope/reader preflight | PASS | PASS |
| Public onboarding, exact metadata/policy consent | PASS | PASS |
| Accurate complete disabled job and BUSINESS review | FAIL: invalid review; safe refusal | FAIL: no reviewable Action |
| Core saved Action policy comparison | PASS, stopped-state inspection only | NOT ESTABLISHED |
| Saved pause/reopen retaining completed review | NOT RUN after stop | NOT RUN after stop |
| Separate Read/Action/receipt/execution reviews and generated DBA handoff | NOT RUN | NOT RUN |
| Reviewed local runtime clients and own-context diagnostic | NOT RUN | NOT RUN |
| Actual model read/request and no premature effect | NOT RUN | NOT RUN |
| Exact effect, versions, receipts, full-row readback | NOT RUN | NOT RUN |
| Human approval and execution | NOT RUN | NOT RUN |
| Typed/eligibility/private/other-context negatives with positives | NOT RUN | NOT RUN |
| Replay before/after execution and process restart | NOT RUN | NOT RUN |
| Actual shared-limit / duplicate contention | NOT RUN | NOT RUN |
| Numeric edit, exact diff/publication/history/unstarted work | NOT RUN | NOT RUN |
| A uninterrupted edit / B acknowledged interruption-resume | NOT RUN | NOT RUN |
| Added outcome, receipt, removal and unstarted refusal | NOT RUN | NOT RUN |
| Final authoring recheck and separate runtime restart | NOT RUN | NOT RUN |
| Stopped-path source and authority preservation | PASS | PASS |

These mandatory unrun rows cannot inherit earlier Stage A or recovery successes. In particular, B's collection completeness, atomic companion effect and source_db receipt guarantee remain unverified in this case.

A's public process ran 17:40:35.470–17:53:27.798 UTC (772.328 seconds), with the saved Read draft at 17:46:14.437 and first disabled Action at 17:46:49.102. These are draft milestones, not usable Read/BUSINESS-ready times. Summed measured provider-transport duration was 98.192 seconds. B's allocation began 17:44:25.854; its successful public process ran 17:45:20.372–17:50:43.711 (323.339 seconds), provider duration 82.464 seconds. BUSINESS readiness, verified deployment, successful runtime read, receipt, edit/add/remove and final recheck times were never reached. Active operator/admin time is unknown; it cannot be inferred by subtracting provider time. No deployment DBA steps occurred.

Expected owner confirmations, consent and fixture provisioning are reported separately from engineering assistance. No live syntax coaching, payload replacement, manual-editor rescue or source/policy weakening occurred. A's post-stop source inspection did not resume the journey. B's inaccurate compiler explanation and A's generic refusal are observed UX friction, not evidence of changed source behavior. This result does not measure ordinary human usability or cross-model generality.

## Environment corrections, gates and preservation

Preselection measurement corrections are retained: ancestor-project resolution required a fresh `/var/tmp` logical root; exact neutral model/settings were verified after preserving the first mismatched probe; the runtime meter's alias validation was corrected using zero-provider probes. A/B source preparation waited for the final PostgreSQL server after initdb's temporary-server restart. B used exactly one **live** harness continuation: its first launcher exited before Runner/provider because a spaced `NODE_OPTIONS` import path was not a file URI. Only the qualification launcher was corrected; original clocks/counters and failed captures remained. This is separate from pre-live readiness preparation.

A's post-stop readback had two measurement-only refusals (owner password omitted, then a cleanup SELECT not forwarded through docker stdin). Both stopped before a query/cleanup, were recorded, and were corrected without repeating a public operation or seeking a new result. The successful complete source comparisons and dumps preceded cleanup.

Private HOME, writable task-owned `/var/tmp`, umask 0077, NO_COLOR, 100×30 PTY, whole-directory isolation and effective-store preflight were retained. Provider credentials were scoped to authoring; reader credentials only to the intended fixture; administrator credentials never entered model/client configuration. Capture redaction withheld private continuation without changing the wire payload. No source rows or concrete runtime identity values were supplied to authoring.

The previous unchanged-build gates were inspected, not rerun: full suite 6,671 passed / 476 skipped, exit 0; types exit 0; explicit PostgreSQL gate 48 passed, exit 0; ten applicable offline checks exit 0. Command/exit/log hashes are under `prerequisites/gates-inspected.json`. New local meter/redaction/transport tests used fake transports, plus the one read-only exact A parser replay, all exit 0. No competing heavy suite or build occurred.

Both stopped states, raw captures, logical records, source dumps and credential-free role/bootstrap material were saved before cleanup. Main removed only its label/ID-verified A container and B DDL-preparation container; tester separately removed its own source container. Original inputs and all frozen artifacts reverified unchanged. No historical queue was executed. No production, multi-host, clock-skew, universal recovery/exactly-once, target-intent assurance or production authentication claim follows.

## At most two next decisions

1. Decide a bounded repair of review correction handling for a submitted counter value contradicting the exact supplied evidence. Preserve the strict refusal; investigate truthful specific feedback and eligibility for the existing structural correction contract using A's unchanged capture.
2. Decide a bounded authoring-contract investigation for B's repeated unsupported arithmetic representations and inaccurate compiler diagnosis. Use the schema/reply/tool-result chain; do not assume the compiler lacks supported addition or widen the effect grammar.

No such repair or new qualification is authorized by this report. Both cases are now used cases. Stop for review; no new package, third case or unseen retry.
