# Bounded receipt-review chain (implementation checkpoint)

Scope: existing prepared coverage parser, receipt assessors, diagnostic collector,
producer correction and coordinated save/reuse. No runtime/authority change.
Rows below describe distinct proof obligations, not interchangeable receipts.

| Branch / prerequisites | Current rejection or result | Required disposition / remaining checks | Planned regression |
|---|---|---|---|
| Envelope and exact pointer resolution | Schema/reference error before assessment | Existing bounded structural feedback; dependent claims unevaluated | Both full captures; malformed/private/broad/duplicate roots |
| Counter support in same report | COUNTING_SUPPORT_MISMATCH | Retain explicit-citation refusal; optional omission only with independent authentic positive basis | Both full captures on actual wire; no-source-support negative |
| Explicit source receipt requirement cannot be established | Configuration mixture conflates missing requirement with shape | Typed requirement-unestablished, nonstructural; no mode inferred from configuration | Ambiguous/negated/missing requirement |
| Current mode conflicts with source | OBLIGATION_RECEIPT_MODE_MISMATCH, generic feedback | Typed conflict, nonstructural; no downgrade or forced deferral | Both modes, conflicting active/disabled selection |
| Missing/stale/foreign configuration or binding | Configuration mismatch or no obligation association | Explicit unavailable evidence, nonstructural; legitimate pending report remains pending | Source/Read/Action/destination/selection changes |
| Implemented configuration claim mixes effect/overview | OBLIGATION_CONFIGURATION_COMPONENT_MIXED before observation guard; generic feedback | Only current exact applicable selection plus supported unique component roots justifies isolation correction; whole reply invalid | Exact 35 passages; supported pairs/triple, reordered/renamed; unsupported companions |
| Isolated current configuration statement | Existing host pending receipt-setup component | Retain accepted narrow configuration-to-duty contract; no execution/receipt/readback proof | Full derived positive save/reload/recheck |
| Implemented selected-Read exclusion | Typed exclusion proof unavailable / unsupported shape / current proof mixed | Preserve previous repair and separate residual validation | Exact earlier full reply; duplicate/foreign/stale/extra claims |
| Broad Read plus receipt overview | Typed overbroad reference with current exact exclusion proof | Preserve precise alternative only when applicable; no guessed pointer | Prior source-phase controls |
| Implemented receipt/readback observation | Typed observation-unestablished | Evidence-backed capability isolation may be structural; pure observation/no proof nonstructural | Pure observation; capability+overview; duplicate/unsupported mixture |
| Pending receipt setup/configuration | Exact source mode, supported phase, selection checked; undefined means no deferral | Retain existing pending/revalidation behavior; typed actual mode conflict; no new positive waiver | Current/disabled runner_ledger/source_db; unsupported setup |
| Readback duty shape/host phase mismatch | Early parser prose error | Explicit typed readback-unestablished; no fabricated observation or format-only claim | Wrong phase, receipt-as-readback, extra roots |
| Execution setup malformed or unsupported | Existing deployment shape checks then evidence check | Structural separation only for recognized shape feedback; unsupported phase remains explicit nonstructural | Extra paths, unsupported setup/currentness |
| Saved obligation differs from current recomputation | OBLIGATION_EVIDENCE_STALE | Explicit typed stale/nonstructural; no retry for fresh opinion | Reload drift and save currentness |
| Full replacement source coverage/registered duties/residual claims | Full parse/readiness checks after component validation | Every original source line and duty still required; no patch merge or partial ownership | Removed headings/conditions/duties; false scalar/privacy; later failure |
| Persistence/reuse | Existing source/subject/configuration/decision CAS | No stale completion; provider outside coordination, no lock redesign | Failed/competing saves, cancellation, restart/reuse |
| Unknown/unrelated exception | Conservative generic finding | Remains nonstructural; no global whitelist | Plain strings/model eligibility flags/internal error |

Implementation note: retain the positive proof requirements and full-report validation. Route the named early returns through those requirements; formerly bypassed role/broad claims now refuse. Add a small
host-only typed configuration assessment/error with exhaustive safe mappings.
Assess evidence separately from the invalid grouping so the early shape refusal
can carry a justified disposition without moving or skipping its guard. Reuse
the prepared selected configuration and existing exact candidate checks. Unique
known roots and valid companions are necessary, never sufficient on their own.
Keep current typed exclusion/observation machinery; close demonstrated gaps in
its eligibility shape checks and known early receipt-specific diagnostics.

Local derived replies are explicitly not historical provider replies. Both
original replies must still fail. Full positive completion must be demonstrated
before any stable cycle or paid attempt. Tester challenge is required before
freeze. No inference from natural-language success wording is introduced.


Implemented mapping: `CoverageReceiptConfigurationError` carries one of seven
host assessment reasons. A `satisfies Record<Reason, ...>` map exhaustively
specifies code, safe reason, structural flag and repair. Receipt readback/setup
and stale saved obligation have a separate small typed reason union within the
same existing feedback module. Exclusion/context/observation typed errors remain
in place. Plain strings and unknown errors gain no structural privilege.

Implemented-selection check remains separate from representation: explicit
source mode; existing current selection/candidate assessment; current source,
unique mode/destination binding and applicable supplied Read proof; full context
revalidation still happens at save/reuse. Capability companions agree with their
actual Action target/resource/binding/operation and direct-SQL supported path.
Configuration+overview is the already accepted narrow selection contract, with
its separate pending duty; configuration+effect and the observed triple reject
with supported correction. Duplicates/children/foreign roots/observations do not.
Disabled reviewed intent can support its existing pending configuration duty;
it is not promoted into an implemented active configuration.

Evidence: `baseline-replay-01` before product edits; new
`receipt-correction-chain.test.ts`70tests; prior capture `evidence-aware-correction`
42tests; prior runner_ledger/disabled source_db `receipt-review-association`43tests;
source-phase, obligation readiness, scoped disclosure and source evidence
controls. Focused02 and03 passed; final aggregate will include all latest bytes.
The real local HTTP/SSE round trip runs both encoders, persists only a fully
validated replacement with current explicit unverified client ownership, then
reloads and rechecks with validated reuse. Raw local wire is under main raw
`local-wire-final-source/`; outputs are labelled DERIVED, never historical/live model
success. No endpoint beyond loopback is invoked.


Final pre-freeze routing additions (independent findings002/003): implemented
configuration comparisons cannot opt out using a different/omitted responsibility,
a scalar-only child, or a broad ancestor of the already established source
receipt requirement. They strictly refuse with typed responsibility_mismatch or
reference_overbroad, nonstructural. This uses the existing bounded explicit
receiptRequirement assessor, not an added prose detector. General claims on
other source lines and unknown/unrelated exceptions retain their existing
contracts; no arbitrary prose interpretation/generalization is claimed.
Pending exact deployment configuration remains supported as before. Old pure
configuration+receipt overview remains the narrow selection contract, never a
receipt observation. Root+child/duplicates remain unsupported mixtures.

Full suite had NOT started when these findings appeared. Earlier types02 and
backend01 remain successful historical results on their recorded bytes. Source
was not edited while they ran. The same08:11:17Z gate/freeze deadline is retained,
not reset; final gates rerun on final source. Focused06 now385passed1skipped.
