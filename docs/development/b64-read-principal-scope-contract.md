# Proposed typed Read subject scope

Historical proposal below; the current ownership and evidence checkpoints at the end supersede its pending status. The former English `jobRequestsPrincipalIsolation` controls both principal review and mapping-root presentation. Its deletion must not make unreviewed roots generally available. No new store, identity source, DB capability or automatic migration is proposed.

## Smallest canonical addition

Each requirement carries `subjects`, a finite array keyed by exact `root_resource`:

```ts
type ReadSubjectProposal =
  | { root_resource: string; mode: "trusted_principal" }
  | { root_resource: string; mode: "reviewed_resource"; scope_reference: string }
  | { root_resource: string; mode: "unresolved"; question: string };
```

For every included root there must be exactly one subject entry. Duplicate/conflicting entries and entries for another root refuse. An unresolved requirement with no resolved root may have an empty array; an exclusion-only requirement creates no positive subject grant. Missing `subjects` is invalid protocol shape; a known included root lacking its entry is unresolved and cannot reach confirmation. There is no default to unrestricted, tenant-only, or trusted-principal scope. `no_read_requested` stays explicit with no requirements. Provider schema and canonical codec must agree.

`trusted_principal` expresses requested applicability, not established isolation. It may start the existing structural principal review. `reviewed_resource` retains one exact host-published reviewed scope; it does not mean unrestricted and cannot name an arbitrary field/value/predicate. Its reference resolves to the current protected configuration and may itself be principal-scoped. The human sees that actual configuration. Missing/stale references stay pending/stale. Models never supply tenant/principal values, SQL, backend settings, a new predicate, or a boolean saying a review succeeded.

The new subject content participates in the existing requirement binding, record digest and scope delta. No second accepted-meaning index is added. This is a canonical shape change: explicitly version/refuse earlier unsupported B64 records through Main's existing native protocol gate; do not silently default an old missing subject or upgrade old confirmation. Main decides the exact development protocol/version pin before implementation.

## Protected context and compiler ports

Extend the existing host catalog projection with a bounded structural inventory, assembled from acknowledged current resource reviews:

```ts
type ReadSubjectContext = {
  roots: readonly {
    root_resource: string;
    reviewed_scope?: { reference: string; digest: Digest; principal_bound: boolean };
    principal_review_available: boolean;
  }[];
};
```

These are host facts, not provider input authority. `principal_review_available` only offers the existing review path; it cannot make an analyzed plan compatible. The projection digest enters the existing catalog/operation binding and is rechecked around waits and protected saves. The host-only source of `reviewed_scope.digest` is the exact structural tenant/principal/derived-path/RLS configuration and acknowledged review revision. Credentials and actual subject values never enter this inventory.

Use the actual `ReadWorkloadAnalysis.candidate` and current structural records when checking a completed scope: each compiled included root must preserve the referenced current configuration; a `trusted_principal` requirement needs the existing `hasReviewedPrincipalScope`/reviewed path checks and the ordinary compiler's trusted-context predicates. A merely suggested principal candidate is insufficient. Missing analysis, missing reviewed predicate, unsupported path or unresolved subject remains pending; changed acknowledged scope is stale/delta. Related resources still undergo the existing independent tenant/principal/path checks. A model WHERE filter never substitutes for trusted scope.

Replace the two English gates by typed dispatch: Main's existing principal review handler receives the exact roots whose `trusted_principal` requirement lacks a reviewed implementation. Mapping-root eligibility then comes from explicit subject proposals plus current structural review state, retaining relationship-only restrictions. `reviewed_resource` uses only its exact current host reference. An unresolved root does not become a mapping root by omission. Raw answers and model remapping follow the existing missing-answer path, with no answer-as-approval.

## Ownership and readback

- Read owner: `read-structured-scope.ts` codec/provider projection/digest/delta; existing producer adapters; `read-current-evidence.ts` protected projection; finite compiler assessment. No new store.
- Main: `authoring-read-scope-context.ts` structural inventory from actual native records; boundary principal-review dispatch and catalog root selection; native version/currentness ports. Boundary remains wiring only.
- Existing `operatorQuestionReadback`/shared Read presenter: per included root show “Only records belonging to the signed-in person” or “Keep the currently reviewed scope: <host summary>”, plus exact identity in details. Unresolved subject explicitly stays pending. Show before/after scope when changed, then the same default-No grouped confirmation covering scope and analyzed plans. Disabled save and activation remain distinct.

## Fixture impact and proofs

Every positive typed Read fixture must explicitly declare subjects; shared fixture builders can centralize the declarations but must not derive them from the returned draft or fill missing subjects automatically. Initial estimate: the shared context/prepared-native fixture, scope codec fixture, planning fixture, two workload builders, revision fixture, raw-host/native question fixture and Main public harness (roughly 8–12 builders plus direct negative payloads). Exact count follows schema agreement/static inventory; the existing218 open producer rows are still separately tracked. Prior B64 records without this field become explicit unsupported fixtures, not fabricated upgrades.

R2 pre-seal: missing/duplicate/other-root subject; principal candidate without review; tenant-only resource offered as principal-safe; current-scope reference copied to another root; changed principal/derived/RLS binding before/after wait; WHERE-only impersonation; omitted/replaced subject after initial proposal; related resource with independently invalid scope; intentional current tenant-level scope accurately shown and separately confirmed; no-Read has no invented subject; provider/canonical parity and unchanged native allowance/currentness/default-No.

Implementation checkpoint (unaccepted): canonical Read pinv2; required typed subjects; exact host `subject_scopes` catalog inventory retained in the existing native record as `subject_bindings`; cross-requirement conflict refusal; actual candidate scope digest/kind checks; no principal-to-tenant fallback. `subject-scope-before.log` preserves2FAIL before; `subject-scope-compiler-after.log`12PASS with actual compiler. Existing positive v1 fixtures now need explicit subjects and acknowledged inventory; types reports those fixture migrations plus the four pre-existing Main wiring errors. No native/public acceptance or automatic record migration claimed.

Configuration binding tightened: `readSubjectConfigurationDigest(resource, boundary)` requires the actual source and trusted-context configuration as its second argument. `subject-scope-context-after.log`:13PASS; changed trusted principal environment binding remains pending, while an unrelated presentation label does not change applicability. Main owns genuine native structural-review inventory; a separate helper owns ordinary structural-review/native fixture preparation. Unit declared host inputs are not claimed as protected-save proof.

Native inventory projector WIP: `projectReadSubjectContext({context, sourceDigest})` consumes a coherent `loadBoundaryReviewContext` result and exact current typed structural confirmations, with dependency-specific acknowledgment digests. It never reads final activation or grouped business-policy consent. Missing structural acknowledgments yield an empty inventory: the model may still propose typed scope from technical catalog facts, but it remains pending for actual structural review. Supported acquisition uses existing protected resource mapping/prepare+commit and ordinary Boundary review `--confirm --output <owned-file>` (or the existing individual decision route), followed by ordinary mapping/grouped review; no synthetic confirmation. The helper’s first real preparation correctly refused empty generated resources until explicit structural mappings are recorded. Fresh public onboarding through this sequence remains NOT PROVEN. Config digests also include organization and shared-reference scope without exposing their values.

Model-visible inventory repair: mapping now includes exact supplied subject scopes; planning/revision already include their full host catalog. All three carry the same requested-versus-established guidance and canonical principal/tenant/global descriptions. Actual outgoing-request responder derives its reply only from transmitted references/catalog (`subject-scope-wire-before.log` fails on absent inventory; `subject-scope-wire-after.log`14PASS, one request). RLS remains an explicit support gap: the existing decision owner classifies database-enforced principal wording as `resource_other`, so the projector cannot truthfully find an acknowledged typed `principal_scope`; no English fallback or invented confirmation was added.

Native projector correction: actual verified read-only posture has no `database_role` decision. Requiring a nonexistent acknowledgement blocked legitimate scope inventory; require it only when the native decision owner emits it, while always binding schema/role fingerprints. First `subject-projector-native.log`5PASS/2FAIL is preserved; `subject-projector-native-after.log`7PASS proves genuine reviewed-but-inactive records, missing/stale acknowledgments pending, coherent binding, exact Source drift and retained subject identity after an ordinary label edit. Historical helper prep without `--output` activated the fixture and is NOT preactivation evidence; ff0664a1 corrects that fixture through the existing export branch, explicitly reporting Authority active:no. No full public onboarding or RLS support claim.

RLS native ownership repair (DEV, awaiting independent variant): `boundary-principal-review.ts` now derives the exact principal decision from actual candidate resource/trusted context. Both `auto-boundary` presentation and `boundary-review-domain` use that descriptor; direct/derived/none IDs, presentation and input-digest payloads remain unchanged. RLS now has a real principal_scope decision binding its actual session settings, source, role fingerprint and trusted principal origin. Existing native pending inputs with the prior generic decision are not migrated or silently confirmed: ordinary currentness/re-review applies. No new record/store and no principal-prefix interpretation. Actual ordinary RLS override→disabled review before `subject-rls-native-before.log`1PASS/1FAIL; unchanged after + normal projector + auto-boundary104 gives `subject-rls-affected-after.log`115PASS. R1 finite independent variant required before integration.

### Current native dispatch and ownership (Main, 2026-10-08)

`createNativeReadScope.context` reloads the actual structural review and projects its exact acknowledged subject references at each awaited producer/currentness boundary. Planning, Read mapping and Read revision await this port; a held native mutation permit is forwarded, never replaced with a nested lease. The original public trace caught a missing permit; c7aaa085 fixes that binding and independent public controls pass (8 scoped cases, Replace excluded).

`principalRequirement` resolves exact typed Read subjects against current request/Source/catalog/operation bindings. Missing, stale or unrelated roots stay unresolved. A principal request can trigger the existing structural review; a reviewed tenant scope is not reinterpreted from words such as “my own” in prose. This projection does not grant Action authority. Action-only roots without typed requirements remain pending until the Action owner supplies its own typed subject contract.

`authoring-principal-scope-host.ts` owns structural candidate presentation, exact selection, and calling the existing preview/commit writers; its requirement reader is refreshed before saving. `boundary-commands.ts` only binds protected native records, actor and ports. The old jobRequestsPrincipalIsolation English reader and its catalog-root filtering are deleted; no replacement lexical rules exist. This extraction reduces the file to 19,702 lines (from 20,204 before extraction).

Evidence level: actual native structural preparation/projection/typed principal-vs-tenant/staleness checks plus existing principal interpreter controls: 3 PASS. Full types currently reports 14 legacy typed-fixture migration errors, no product errors. Public verification on this final dispatch pin remains required; the earlier eight public passes apply only to 604dc679+c7aaa085. No full/installed/freeze claim.

### Current integrated checkpoint: typed public replacement and manual boundary

The exact public projection now includes the selected native question and its immutable stored analysis, checked against the saved analysis digest and the same Resume revision. Public Replace consumes the original producer budget; it never treats completed assistance history as an active dispatch. `authoring-read-prompt-binding` selects the unique unretired native correction for the actual waiting handoff. The existing meaning host protected-saves cancellation reopening or a blank-answer successor before the B48 wait; old blank testimony remains immutable.

Independent R1 evidence: `81ffbf99` six public cases PASS (ordinary replacement, cancellation, cancel/blank reentry, competing native save, original Read positive); checkpoint `fe874956`. Replacement-specific separate-process reopen at `476cdb3b` made zero requests. This is not activation, source effects, installed acceptance or a full-suite verdict. No-Read planning-origin replacement remains open.

| Requirement | Existing record / owner | Effects and binding | Entry / protected save / evidence |
| --- | --- | --- | --- |
| Current Read scope | Read.v2 question + stored analysis / native scope adapter | Current structural inventory and exact saved analysis; no inferred meaning | planning/mapping/Review/Resume; existing Resume CAS; scoped native + public proofs |
| Raw correction | replacement_answer + owner handoff / Read meaning host | Exact declined review, actual raw answer, immutable predecessor; no new allowance | Replace/cancel/blank Resume; protected native question save before wait; six public cases |
| Correction mapping | saved assistance history / existing Read producer | Stable actual invocation binding, cumulative calls, actual completed operation | ordinary mapping owner, checkpoint host, Source/Resume acknowledgement; eight independent producer controls |
| Manual exact plans | operator_exact_plan workload + compiler / manual selection owner | OPEN: shared principal port currently incorrectly requires model Resume | supported no-model cards flow fails; original full-flow assertions retained; no fabricated model/consent workaround |

Manual repair must use actual typed plan selection and current reviewed structural scope, never the job's words or `source.kind` alone. Show the exact scopes to the operator, bind selection through compiler/currentness and the existing exact Read review/save, preserve default-No and separate activation. Remove English ranking and automatically inferred Action-support plans; explicit plan choices may replace those suggestions. Whether the existing selected-plan/current-review records suffice is under independent contract review; no new record or product bypass has been implemented. A new business subject requirement cannot be invented from metadata.
