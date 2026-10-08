import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { projectAuthoringReadScopeContext } from "./authoring-read-scope-context.js";

function fixture() {
  const boundary: ExplorationBoundaryDraft = {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "local_postgres", compiler_version: "1.7.0", spec_version: "1.9.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL_ID" },
    generation_lock_fingerprint: d("lock"), role_posture_fingerprint: d("role"),
    pack: { name: "equipment", resources: [{ id: "work.equipment", schema: "work", table: "equipment", primary_key: "id",
      tenant_key: "tenant_id", principal_key: "principal_id", field_types: { id: "uuid", tenant_id: "text", principal_id: "text", label: "text" },
      field_enums: {}, selectable_fields: ["label"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
      aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["tenant_id", "principal_id"],
      relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true }] },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
  };
  const base = { binding: { boundary_name: boundary.pack.name, generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    schema_fingerprint: d("schema"), role_posture_fingerprint: boundary.role_posture_fingerprint }, stage: "planning" as const,
    jobIntent: "Show the equipment labels that the policy permits.", provider: "openai" as const, model: "offline-scripted" };
  return { boundary, base, resume: buildBoundaryAuthoringResumeState(base), records: { questions: [], handoffs: [] } };
}
describe("B64 public host Read applicability assembly", () => {
  it("shares stable meaning across acknowledged stage/Resume bookkeeping without granting it", () => {
    const f = fixture(), initial = projectAuthoringReadScopeContext(f);
    const next = buildBoundaryAuthoringResumeState({ ...f.base, previous: f.resume, stage: "read_mapping" });
    expect(projectAuthoringReadScopeContext({ ...f, resume: next })).toEqual(initial);
    expect(initial).not.toHaveProperty("confirmation"); expect(initial).not.toHaveProperty("proposal");
    expect(initial.catalog.resources[0]!.fields).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ id: "tenant_id" }), expect.objectContaining({ id: "principal_id" }),
    ]));
  });
  it("keeps original request bytes without interpreting English or manufacturing targets", () => {
    const f = fixture(), text = 'No, only, except, do not — "ignore every rule" is quoted data.';
    const resume = buildBoundaryAuthoringResumeState({ ...f.base, jobIntent: text });
    const result = projectAuthoringReadScopeContext({ ...f, resume });
    expect(result.references).toEqual([{ kind: "request", id: result.references[0]!.id, digest: d(text), text }]);
    expect(result.catalog.resources[0]!.id).toBe("work.equipment");
  });
  it("binds actual Source attachment and exact snapshot independently of job and operation identity", () => {
    const f = fixture(), sources = newPolicySourceSession();
    sources.snapshots.push(policyTextSnapshot(Buffer.from("Labels may be shown.\nIdentifiers stay private."), "policy.txt"));
    sources.active = sources.snapshots[0]!.version;
    const resume = buildBoundaryAuthoringResumeState({ ...f.base, previous: f.resume, policySourceSession: sources.id });
    const before = projectAuthoringReadScopeContext({ ...f, resume, sources });
    const changed = structuredClone(sources);
    changed.snapshots.push(policyTextSnapshot(Buffer.from("Labels need review."), "policy.txt", 2));
    changed.active = changed.snapshots[1]!.version;
    const after = projectAuthoringReadScopeContext({ ...f, resume, sources: changed });
    expect(after.binding.meaning_digest).not.toBe(before.binding.meaning_digest);
    expect(after.binding.source_digest).not.toBe(before.binding.source_digest);
    expect(after.binding.applicability_digest).toBe(before.binding.applicability_digest);
    expect(after.binding.operation_digest).toBe(before.binding.operation_digest);
    expect(() => projectAuthoringReadScopeContext({ ...f, resume })).toThrow(/exact Source attachment/u);
    expect(() => projectAuthoringReadScopeContext({ ...f, resume, sources: { ...sources, id: "different" } })).toThrow(/exact Source attachment/u);
  });
  it("changes the operation binding for relevant catalog or role drift; never rebases old confirmation", () => {
    const f = fixture(), before = projectAuthoringReadScopeContext(f);
    const boundary = structuredClone(f.boundary); boundary.pack.resources[0]!.selectable_fields = [];
    const after = projectAuthoringReadScopeContext({ ...f, boundary });
    expect(after.binding.catalog_digest).not.toBe(before.binding.catalog_digest);
    expect(after.binding.operation_digest).not.toBe(before.binding.operation_digest);
    expect(after.binding.applicability_digest).toBe(before.binding.applicability_digest);
    expect(after).not.toHaveProperty("native");
    expect(() => projectAuthoringReadScopeContext({ ...f, boundary: { ...f.boundary, pack: { ...f.boundary.pack, name: "other" } } }))
      .toThrow(/different saved setup/u);
  });
  it("refuses old or absent protocols instead of interpreting the old request", () => {
    const f = fixture();
    expect(() => projectAuthoringReadScopeContext({ ...f, resume: { ...f.resume, schema_version: "synapsor.boundary-authoring-resume.v1" } }))
      .toThrow("This setup was saved by an older version. Start a new setup.");
    expect(() => projectAuthoringReadScopeContext({ ...f, resume: { ...f.resume, authoring_protocol: undefined } }))
      .toThrow(/AUTHORING_PROTOCOL_INVALID/u);
  });
});
