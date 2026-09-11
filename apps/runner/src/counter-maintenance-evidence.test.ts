import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { actionRuleAuthoringCheckpoint, parseReviewedActionVersionFields, type ReviewedActionVersionField } from "./action-rule-authoring-checkpoint.js";
import { prepareActionVersionField } from "./action-rule-version-review.js";
import { rebuildActionCatalogAfterMetadataRefresh } from "./action-rule-read-revision.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { buildActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { policyTextSnapshot } from "./authoring-policy-source.js";

const outcome = "exchange.accept", resourceNames = ["allotment.assignments", "allotment.offers"];
const stringType = (values: string[]) => ({ kind: "string" as const, comparison: "exact" as const,
  max_length: Math.max(...values.map(value => value.length)), enum: values });
function fixture() {
  const table = (name: string): TableInfo => ({ schema: "allotment", name, type: "table", writable: true,
    columns: [["record_id", "uuid"], ["tenant_id", "uuid"], ["person_id", "uuid"], ["plot_code", "text"], ["status", "text"], ["v7", "integer"]]
      .map(([field, type], index) => ({ name: field!, data_type: type!, nullable: false, generated: false, identity: false, ordinal_position: index + 1,
        ...(field === "plot_code" ? { enum_values: ["P1", "P2"] } : field === "status" ? { enum_values: ["available", "consumed"] } : {}),
        suggestions: { tenant: field === "tenant_id", conflict: false, sensitive: false,
          immutable: ["record_id", "tenant_id", "person_id"].includes(field!), large_or_binary: false } })),
    primary_key: ["record_id"], unique_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["plot_code", "status"] },
  });
  const inspection: SchemaInspection = { engine: "postgres", server_version: "17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00Z", schemas: ["allotment"], tables: [table("assignments"), table("offers")], warnings: [] };
  const generated = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "allotment",
    project: { root: "/owned-counter-evidence", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const read = generated.exploration_boundary;
  read.pack = { name: "exchange_read", resources: inspection.tables.map(table => ({ id: `allotment.${table.name}`,
    schema: table.schema, table: table.name, primary_key: "record_id", tenant_key: "tenant_id", principal_key: "person_id",
    field_types: Object.fromEntries(table.columns.map(column => [column.name, column.data_type])),
    field_enums: { plot_code: ["P1", "P2"], status: ["available", "consumed"] },
    selectable_fields: ["plot_code", "status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
    count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["record_id", "tenant_id", "person_id", "v7"], relationships: [],
    minimum_cohort_size: 5, suppression_aware_totals: true })) };
  let context = { readBoundary: read, readBoundaryDigest: explorationBoundaryCandidateDigest(read),
    builtCatalog: buildActionRuleAuthoringCatalog({ boundary: read, inspection }) };
  const reviewedVersionFields: ReviewedActionVersionField[] = [];
  for (const resource of resourceNames) {
    const prepared = prepareActionVersionField({ context, inspection, generationLock: generated.lock, resource, field: "v7" });
    reviewedVersionFields.push(prepared.review); context = prepared;
  }
  const draft: ActionRuleModelDraftV1 = { schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
    verification: { name: "exchange.verification", resources: resourceNames.map((resource, index) => ({ binding: index ? "offer" : "assignment",
      resource, source: { kind: "subject_ref" }, fields: ["plot_code", "status"] })) },
    effect: { name: "exchange.effect", operation: "update", target_resource: resourceNames[0]!, target_binding: "assignment",
      allowed_fields: [{ name: "plot_code", values: ["P1", "P2"] }],
      set: { plot_code: { kind: "field", binding: "offer", field: "plot_code" } }, writeback: "supervised",
      atomic_updates: [{ operation: "update", target_resource: resourceNames[1]!, target_binding: "offer",
        allowed_fields: [{ name: "status", values: ["consumed"] }],
        set: { status: { kind: "literal", value: "consumed", value_type: stringType(["available", "consumed"]) } } }] },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "offer", field: "status" },
      right: { kind: "literal", value: "available", value_type: stringType(["available", "consumed"]) } }, derive: {},
    approval: { class_name: "exchange.review", mode: "human", required_role: "coordinator", required_approvals: 1, shared_limits: [] }, ttl_seconds: 300,
    review: { when: "The selected offer is available.", then: "Copy its plot and consume it atomically.", refused: ["Refuse consumed offers."],
      human_review: "One coordinator approves.", examples: [{ kind: "eligible", scenario: "Available offer", result: "Wait for approval" }] } };
  const compiled = compileActionRuleModelDraft({ draft, ...context });
  return { read, decisions: [], actions: [compiled], source: { inspection, generationLock: generated.lock }, reviewedVersionFields };
}
function evidence(input: ReturnType<typeof fixture>) {
  return policyCoverageDraft(input).runner_evidence.actions[outcome]!.effect;
}

describe("strict shared counter review parsing", () => {
  const review: ReviewedActionVersionField = { resource: "allotment.assignments", field: "v7", maintenance: "all_writers_increment",
    proof_digest: canonicalJsonDigest("fixture review") };
  it("clones exact records, retaining default checkpoint 16 and explicit host maximum 32", () => {
    const records = Array.from({ length: 32 }, (_, i) => ({ ...review, resource: `allotment.target_${i}` }));
    expect(() => parseReviewedActionVersionFields(records)).toThrow("CHECKPOINT_INVALID");
    const parsed = parseReviewedActionVersionFields(records, 32);
    expect(parsed).toEqual(records); parsed[0]!.field = "changed"; expect(records[0]!.field).toBe("v7");
    expect(() => parseReviewedActionVersionFields([...records, { ...review, resource: "allotment.extra" }], 32)).toThrow("CHECKPOINT_INVALID");
    const core = { intent_digest: canonicalJsonDigest("intent"), context_digest: canonicalJsonDigest("context"), components: {} };
    expect(actionRuleAuthoringCheckpoint({ ...core, reviewed_version_fields: records.slice(0, 16) }).reviewed_version_fields).toHaveLength(16);
    expect(() => actionRuleAuthoringCheckpoint({ ...core, reviewed_version_fields: records.slice(0, 17) })).toThrow("CHECKPOINT_INVALID");
    const input = fixture();
    input.reviewedVersionFields = [...input.reviewedVersionFields, ...records.slice(0, 30)];
    expect(evidence(input).source_counter_maintenance).not.toBeNull();
    input.reviewedVersionFields.push(records[30]!);
    expect(() => policyCoverageDraft(input)).toThrow("CHECKPOINT_INVALID");
  });
  it.each([null, {}, [null], [{ ...review, field: "table.v7" }], [{ ...review, maintenance: "unconfirmed" }],
    [{ ...review, proof_digest: "sha256:bad" }], [{ ...review, model_confirmed: true }], [review, review]])("rejects malformed or duplicate records (%j)", value => {
    expect(() => parseReviewedActionVersionFields(value)).toThrow("CHECKPOINT_INVALID");
    const input = fixture();
    Object.assign(input, { reviewedVersionFields: value });
    expect(() => policyCoverageDraft(input)).toThrow("CHECKPOINT_INVALID");
  });
});

describe("current host-reviewed source counter maintenance evidence", () => {
  it("annotates primary and atomic companion targets without claiming independent external enforcement", () => {
    const input = fixture(), before = structuredClone(input), result = policyCoverageDraft(input), effect = result.runner_evidence.actions[outcome]!.effect;
    const records = [effect.source_counter_maintenance, effect.atomic_updates![0]!.source_counter_maintenance];
    for (const [index, record] of records.entries()) expect(record).toMatchObject({ status: "owner_confirmed_operating_prerequisite",
      resource: resourceNames[index], field: "v7", maintenance: "all_writers_increment", proof_digest: input.reviewedVersionFields[index]!.proof_digest,
      generation_lock_fingerprint: input.read.generation_lock_fingerprint, read_boundary_digest: explorationBoundaryCandidateDigest(input.read),
      role_posture_fingerprint: input.read.role_posture_fingerprint, external_writers_verified: false, production_integration_verified: false });
    expect(result.runner_evidence.runtime_contract.source_counter_maintenance).toContain("not independent proof");
    expect(result.runner_evidence.runtime_contract.source_counter_maintenance).toContain("formal independent enforcement");
    expect(result.runner_evidence.runtime_contract.source_counter_maintenance).toContain("null");
    expect(effect.version_advance).toEqual({ column: "v7", strategy: "integer_increment" });
    expect(input).toEqual(before);
    expect(policyCoverageDraft(input)).toEqual(result);
    for (const resource of resourceNames) expect(result.runner_evidence.read_access[resource]!.fields.v7)
      .toMatchObject({ actual_values_returned: false, model_analysis: [] });
  });

  it.each(["absent", "empty", "wrong_proof", "wrong_field", "unrelated", "missing_source"])("does not infer confirmation from compiled advancement (%s)", mode => {
    const input = fixture();
    if (mode === "absent") delete (input as Partial<typeof input>).reviewedVersionFields;
    if (mode === "empty") input.reviewedVersionFields = [];
    if (mode === "wrong_proof") input.reviewedVersionFields = input.reviewedVersionFields.map(review => ({ ...review, proof_digest: canonicalJsonDigest("wrong") }));
    if (mode === "wrong_field") input.reviewedVersionFields = input.reviewedVersionFields.map(review => ({ ...review, field: "ordinary_count" }));
    if (mode === "unrelated") input.reviewedVersionFields = [{ ...input.reviewedVersionFields[0]!, resource: "unreviewed.other" }];
    if (mode === "missing_source") delete (input as Partial<typeof input>).source;
    const result = evidence(input);
    expect(result.source_counter_maintenance).toBeNull();
    expect(result.atomic_updates![0]!.source_counter_maintenance).toBeNull();
    expect(result.version_advance).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("unreviewed.other");
  });

  it("never borrows another target's confirmation or verification-only counter", () => {
    const input = fixture(); input.reviewedVersionFields.splice(1);
    expect(evidence(input).source_counter_maintenance).not.toBeNull();
    expect(evidence(input).atomic_updates![0]!.source_counter_maintenance).toBeNull();
    input.actions[0]!.loaded.authority.catalog.resources[0]!.verification_only = true;
    expect(evidence(input).source_counter_maintenance).toBeNull();
  });

  it("does not emit unrelated host records and accepts canonical catalog ordering without changing evidence", () => {
    const input = fixture(), before = policyCoverageDraft(input);
    input.reviewedVersionFields.push({ ...input.reviewedVersionFields[0]!, resource: "unreviewed.private_register" });
    for (const target of input.actions[0]!.loaded.authority.catalog.resources) target.fields.reverse();
    expect(policyCoverageDraft(input)).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("unreviewed.private_register");
  });

  it.each(["proof", "binding", "rule", "scope", "type", "missing_advance"])("rechecks each companion independently (%s)", mode => {
    const input = fixture(), action = input.actions[0]!, companion = action.effect_envelope.atomic_updates![0]!;
    if (mode === "proof") input.reviewedVersionFields[1]!.proof_digest = canonicalJsonDigest("wrong companion proof");
    if (mode === "binding") companion.target_binding = "assignment";
    if (mode === "rule") action.rule.atomic_updates![0]!.target_resource = resourceNames[0]!;
    if (mode === "scope") companion.principal_scope_key = "tenant_id";
    if (mode === "type") action.verification_boundary.resources[1]!.fields.find(field => field.name === "v7")!.nullable = true;
    if (mode === "missing_advance") companion.version_advance.column = "unreviewed_counter";
    expect(evidence(input).source_counter_maintenance).not.toBeNull();
    expect(evidence(input).atomic_updates![0]!.source_counter_maintenance).toBeNull();
  });

  it("revalidates an unchanged exact owner commitment after a coherent writer metadata rescan without unrelated egress", () => {
    const input = fixture(), previousLock = input.source.generationLock, reviews = structuredClone(input.reviewedVersionFields);
    input.source.inspection.tables[0]!.row_level_security_policies = [{ name: "reviewed_writer", command: "UPDATE", permissive: true,
      roles: ["writer"], using_expression: "tenant_id = current_setting('app.tenant')", check_expression: "tenant_id = current_setting('app.tenant')" }];
    input.source.inspection.tables.push({ ...structuredClone(input.source.inspection.tables[1]!), name: "unreviewed_private_register" });
    const refreshed = buildAutoBoundary({ inspection: input.source.inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "allotment",
      project: { root: "/owned-counter-evidence", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
    input.source.generationLock = refreshed.lock;
    input.read.generation_lock_fingerprint = refreshed.exploration_boundary.generation_lock_fingerprint;
    input.read.role_posture_fingerprint = refreshed.exploration_boundary.role_posture_fingerprint;
    const catalog = rebuildActionCatalogAfterMetadataRefresh({ catalog: input.actions[0]!.loaded.authority.catalog,
      previousLock, nextLock: refreshed.lock, nextBoundary: input.read, inspection: input.source.inspection });
    input.actions = [compileActionRuleModelDraft({ draft: input.actions[0]!.draft, readBoundary: input.read,
      readBoundaryDigest: explorationBoundaryCandidateDigest(input.read),
      builtCatalog: buildActionRuleAuthoringCatalog({ boundary: input.read, inspection: input.source.inspection, retainedCatalog: catalog }) })];
    const result = policyCoverageDraft(input), effect = result.runner_evidence.actions[outcome]!.effect;
    expect(input.read.generation_lock_fingerprint).not.toBe(canonicalJsonDigest(previousLock));
    for (const [index, record] of [effect.source_counter_maintenance, effect.atomic_updates![0]!.source_counter_maintenance].entries()) {
      expect(record).toMatchObject({ proof_digest: reviews[index]!.proof_digest, generation_lock_fingerprint: canonicalJsonDigest(refreshed.lock),
        external_writers_verified: false, production_integration_verified: false });
    }
    expect(input.reviewedVersionFields).toEqual(reviews);
    expect(JSON.stringify(result)).not.toContain("unreviewed_private_register");
  });

  it.each(["catalog_lock", "read_digest", "read_name", "verification_lock", "source", "engine", "table", "field_type", "scope", "duplicate", "binding", "version", "advance", "rule_target"])("does not transplant confirmation into changed compiled %s", mode => {
    const input = fixture(), action = input.actions[0]!, catalog = action.loaded.authority.catalog;
    const target = catalog.resources.find(resource => resource.name === resourceNames[0])!;
    const binding = action.verification_boundary.resources.find(resource => resource.binding === "assignment")!;
    if (mode === "catalog_lock") catalog.generation_lock_fingerprint = canonicalJsonDigest("stale");
    if (mode === "read_digest") action.loaded.authority.rules[0]!.read_boundary_digest = canonicalJsonDigest("stale");
    if (mode === "read_name") action.loaded.authority.rules[0]!.read_boundary_name = "other_read";
    if (mode === "verification_lock") action.verification_boundary.generation_lock_fingerprint = canonicalJsonDigest("stale");
    if (mode === "source") target.source = "other_source";
    if (mode === "engine") target.engine = "mysql";
    if (mode === "table") target.table = "other_table";
    if (mode === "field_type") binding.fields.find(field => field.name === "v7")!.type = { kind: "boolean" };
    if (mode === "scope") target.principal_scope_key = "tenant_id";
    if (mode === "duplicate") catalog.resources.push(structuredClone(target));
    if (mode === "binding") action.effect_envelope.target_binding = "offer";
    if (mode === "version") binding.version_field = "other_counter";
    if (mode === "advance") action.effect_envelope.version_advance!.column = "other_counter";
    if (mode === "rule_target") action.rule.effect.target_resource = resourceNames[1]!;
    expect(evidence(input).source_counter_maintenance).toBeNull();
  });

  it.each(["nullable", "generated", "type", "role", "lock", "read_role"])("never emits positive stale inspected %s evidence", mode => {
    const input = fixture(), counter = input.source.inspection.tables[0]!.columns.find(field => field.name === "v7")!;
    if (mode === "nullable") counter.nullable = true;
    if (mode === "generated") counter.generated = true;
    if (mode === "type") counter.data_type = "text";
    if (mode === "role") input.source.inspection.current_user = "another_reader";
    if (mode === "lock") input.source.generationLock.source_env = "ANOTHER_DATABASE_URL";
    if (mode === "read_role") input.read.role_posture_fingerprint = canonicalJsonDigest("another_role");
    if (mode === "role" || mode === "read_role") expect(evidence(input).source_counter_maintenance).toBeNull();
    else expect(() => policyCoverageDraft(input)).toThrow();
  });

  it("supports a saved full authority and exact coverage links while a wrong proof remains unconfirmed", () => {
    const input = fixture(), loaded = input.actions[0]!.loaded.authority;
    const authority = buildActionRuleAuthorityDraft({ name: loaded.name, action_boundary_name: loaded.action_boundary.name,
      catalog: loaded.catalog, rules: loaded.rules, approval_classes: loaded.approval_classes,
      reviews: [{ outcome, ...input.actions[0]!.review }] });
    const draft = policyCoverageDraft({ ...input, actions: [], authority });
    const pointer = `/runner_evidence/actions/${outcome}/effect/source_counter_maintenance`;
    const source = policyTextSnapshot(Buffer.from("The source owner accepts the operating obligation to increment every updated counter."), "contract.txt");
    const passage = { start: 1, end: 1, disposition: "implemented", interpretation: "The exact owner operating prerequisite is recorded, not external proof.",
      draft_paths: [pointer], evidence_checks: [{ path: `${pointer}/status`, equals: "owner_confirmed_operating_prerequisite" },
        { path: `${pointer}/external_writers_verified`, equals: false }] };
    expect(parsePolicyCoverage({ passages: [passage] }, source, draft, []).passages).toHaveLength(1);
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, evidence_checks: [{ path: `${pointer}/external_writers_verified`, equals: true }] }] }, source, draft, []))
      .toThrow("Mechanical evidence mismatch");
    input.reviewedVersionFields[0]!.proof_digest = canonicalJsonDigest("wrong");
    expect(() => parsePolicyCoverage({ passages: [passage] }, source, policyCoverageDraft(input), [])).toThrow("Draft pointer is not present");
  });
});
