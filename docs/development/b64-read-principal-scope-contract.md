# Proposed typed Read subject scope

Design only, awaiting Main/R2 pre-seal. The existing English `jobRequestsPrincipalIsolation` controls both principal review and mapping-root presentation. Its deletion must not make unreviewed roots generally available. No new store, identity source, DB capability or automatic migration is proposed.

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
