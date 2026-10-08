import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { READ_SCOPE_PROTOCOL, parseReadScopeProposal } from "./read-structured-scope.js";

const proposal = () => ({ protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested", requirements: [{
  id: "names", intended_use: "Show names belonging to the signed-in person", references: ["job"], disposition: "include",
  targets: [{ root_resource: "work.items", resource: "work.items", operation: "resource" },
    { root_resource: "work.items", resource: "work.items", operation: "return", field: "name" }],
}] });

describe("B64 v2 typed subject scope", () => {
  it("pins the changed canonical contract explicitly", () => {
    expect(READ_SCOPE_PROTOCOL).toBe("synapsor.read-scope.v2");
  });
  it("never defaults a missing subject requirement to open scope", () => {
    expect(() => parseReadScopeProposal(proposal())).toThrow("READ_SCOPE_INVALID");
  });
});

import { Ajv } from "ajv";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import { resolveReadScopeProposal, assessReadScopeDraft, assertReadScopeProvenance, readSubjectConfigurationDigest,
  readSubjectScopeKind, readScopeProposalSchema, readScopeProposalCodec, readScopeDelta, type ReadSubjectProposal } from "./read-structured-scope.js";

function fixture(principal = true) {
  const request = "Show names belonging to the signed-in person.";
  const boundary: ExplorationBoundaryDraft = { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
    deployment_profile: "staging", source: "local_postgres", compiler_version: "1.8.0", spec_version: "1.11.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "TEST_TENANT", principal_env: "TEST_PERSON" },
    generation_lock_fingerprint: d("fixture lock"), role_posture_fingerprint: d("fixture roles"),
    pack: { name: "subject_fixture", resources: [{ id: "work.items", schema: "work", table: "items", primary_key: "id", tenant_key: "tenant_id",
      ...(principal ? { principal_key: "person_id" } : {}), field_types: { id: "uuid", tenant_id: "text", person_id: "text", name: "text" },
      field_enums: {}, selectable_fields: ["name"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
      aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["id", "tenant_id", "person_id"],
      relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true }] },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [] };
  const subject = { root_resource: "work.items", reference: "acknowledged-items-scope", source_digest: d(null), review_digest: d("actual fixture review revision"),
    configuration_digest: readSubjectConfigurationDigest(boundary.pack.resources[0]!), kind: readSubjectScopeKind(boundary.pack.resources[0]!) };
  const catalog = { resources: [{ id: "work.items", fields: [{ id: "name" }] }], relationships: [], subject_scopes: [subject] };
  const expectedBinding = { request_digest: d(request), source_digest: d(null), catalog_digest: d(catalog), meaning_digest: d(request),
    applicability_digest: d("owned fixture job"), operation_digest: d(boundary) };
  const references = [{ id: "job", kind: "request" as const, text: request, digest: d(request) }];
  const analysis = analyzeReadWorkloadSet({ generatedBoundary: boundary, workload: { schema_version: READ_WORKLOAD_SET_VERSION, name: "names",
    source: { kind: "model", provider: "openai", model: "fixture" }, allowed: [{ id: "names", description: "Show item names",
      plan: { kind: "rows", resource: "work.items", select: ["name"] } }], forbidden: [] } });
  const proposed = { ...proposal(), requirements: [{ ...proposal().requirements[0]!, subjects: [
    { root_resource: "work.items", mode: "trusted_principal" } as ReadSubjectProposal,
  ] }] };
  const resolve = (value: unknown = proposed) => resolveReadScopeProposal(value, { expectedBinding, references, catalog, analysis });
  return { boundary, subject, catalog, expectedBinding, references, analysis, proposed, resolve };
}

describe("B64 typed subjects against actual compiled scope", () => {
  it("requires current reviewed principal configuration in the actual analyzed candidate", () => {
    const f = fixture(); expect(f.analysis.status).toBe("ready");
    expect(assessReadScopeDraft(f.resolve(), f.analysis)).toMatchObject({ status: "compatible", authority_granted: false });
  });
  it.each(["missing_subject", "unresolved", "missing_review", "tenant_only"] as const)("keeps %s pending without widening access", mode => {
    const f = fixture(mode !== "tenant_only");
    if (mode === "missing_subject") f.proposed.requirements[0]!.subjects = [];
    if (mode === "unresolved") f.proposed.requirements[0]!.subjects = [{ root_resource: "work.items", mode: "unresolved", question: "Whose records?" }];
    if (mode === "missing_review") f.catalog.subject_scopes = [];
    expect(assessReadScopeDraft(f.resolve(), f.analysis)).toMatchObject({ status: "pending", unresolved: ["names"] });
  });
  it("rejects conflicting subject interpretations across requirements on the same root", () => {
    const f = fixture(); f.proposed.requirements.push({ ...f.proposed.requirements[0]!, id: "other-purpose", subjects: [
      { root_resource: "work.items", mode: "reviewed_resource", scope_reference: f.subject.reference },
    ] });
    expect(() => f.resolve()).toThrow("READ_SCOPE_SUBJECT_CONFLICT");
  });
  it("does not replace a reviewed root reference with another or a stale Source binding", () => {
    const f = fixture(); f.proposed.requirements[0]!.subjects = [{ root_resource: "work.items", mode: "reviewed_resource", scope_reference: "other-root" }];
    expect(() => f.resolve()).toThrow("READ_SCOPE_SUBJECT_INVALID");
    f.proposed.requirements[0]!.subjects = [{ root_resource: "work.items", mode: "trusted_principal" }];
    f.subject.source_digest = d("changed Source");
    expect(() => f.resolve()).toThrow("READ_SCOPE_SUBJECT_STALE");
  });
  it("makes intentional existing tenant scope reviewable without calling it principal isolation", () => {
    const f = fixture(false); f.proposed.requirements[0]!.subjects = [{ root_resource: "work.items", mode: "reviewed_resource", scope_reference: f.subject.reference }];
    const record = f.resolve(); expect(record.subject_bindings[0]?.kind).toBe("tenant");
    expect(assessReadScopeDraft(record, f.analysis).status).toBe("compatible");
    f.proposed.requirements[0]!.subjects = [{ root_resource: "work.items", mode: "trusted_principal" }];
    expect(readScopeDelta(record, f.resolve()).added).toHaveLength(1);
    expect(assessReadScopeDraft(f.resolve(), f.analysis).status).toBe("pending");
  });
  it("invalidates copied review acknowledgement or changed compiled predicates", () => {
    const f = fixture(), record = f.resolve();
    f.subject.review_digest = d("another acknowledged review");
    expect(() => assertReadScopeProvenance(record, f)).toThrow("READ_SCOPE_PROVENANCE_STALE");
    const changed = structuredClone(f.analysis); delete changed.candidate!.pack.resources[0]!.principal_key;
    expect(assessReadScopeDraft(record, changed).status).toBe("pending");
  });
  it("projects the same required subject shapes to the provider without accepting identity values", () => {
    const f = fixture(), accepts = new Ajv({ strict: false }).compile(readScopeProposalSchema);
    const extra = structuredClone(f.proposed) as unknown as { requirements: Array<{ subjects: unknown[] }> };
    extra.requirements[0]!.subjects[0] = { root_resource: "work.items", mode: "trusted_principal", principal: "model-selected" };
    for (const value of [f.proposed, proposal(), extra]) expect(accepts(value)).toBe(readScopeProposalCodec.safeParse(value).success);
    expect(accepts(extra)).toBe(false);
  });
});
