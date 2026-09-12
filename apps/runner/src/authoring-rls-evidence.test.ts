import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { buildActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { policyTextSnapshot } from "./authoring-policy-source.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";

const resource = "opaque.r8", outcome = "record.finish";
function fixture() {
  const table: TableInfo = { schema: "opaque", name: "r8", type: "table", writable: true, row_level_security: true,
    columns: [["k00", "uuid"], ["q2", "uuid"], ["q1", "uuid"], ["label", "text"], ["state", "text"], ["counter", "integer"]]
      .map(([name, type], index) => ({ name: name!, data_type: type!, nullable: false, generated: false, ordinal_position: index + 1,
        ...(name === "state" ? { enum_values: ["ready", "done"] } : {}),
        comment: name === "q1" ? "obsolete account label" : name === "q2" ? "obsolete person label" : "",
        suggestions: { tenant: false, conflict: name === "counter", sensitive: false, immutable: false, large_or_binary: false } })),
    primary_key: ["k00"], unique_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: ["q2"], conflict_columns: ["counter"], sensitive_columns: [], default_visible_columns: ["label", "state"] },
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
      row_security_forced: true, row_security_effective_for_current_role: true, row_security_applicable_policies: ["own"] },
    row_level_security_policies: [{ name: "own", command: "SELECT", permissive: true, roles: ["reader"],
      using_expression: "q2 = NULLIF(current_setting('app.group', true), '')::uuid AND q1 = NULLIF(current_setting('app.person', true), '')::uuid" }] };
  const inspection: SchemaInspection = { engine: "postgres", server_version: "16", current_user: "reader",
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    inspected_at: "2026-09-11T00:00:00Z", schemas: ["opaque"], tables: [table], warnings: [] };
  const generated = build(inspection), read = structuredClone(generated.exploration_boundary);
  read.pack = { name: "scoped_records", resources: [{ id: resource, schema: "opaque", table: "r8", primary_key: "k00", tenant_key: "q2",
    field_types: Object.fromEntries(table.columns.map(column => [column.name, column.data_type])), field_enums: { state: ["ready", "done"] },
    selectable_fields: ["label", "state"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
    aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["q1", "q2", "k00", "counter"],
    relationships: [], rls_session: { tenant_setting: "app.group", principal_setting: "app.person" }, minimum_cohort_size: 5,
    suppression_aware_totals: true }] };
  const f = { read, inspection, lock: generated.lock };
  return { ...f, compiled: compile(f) };
}
function build(inspection: SchemaInspection) {
  return buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "opaque",
    project: { root: "/fixture/rls-evidence", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}
function proposed(name = outcome): ActionRuleModelDraftV1 {
  const type = { kind: "string" as const, comparison: "exact" as const, max_length: 5, enum: ["ready", "done"] };
  return { schema_version: "synapsor.action-rule-model-draft.v1", name: `${name}.rule`, outcome: name,
    discovery: { title: "Finish selected record", summary: "Finish one ready record", aliases: ["finish record"] },
    verification: { name: `${name}.verification`, resources: [{ binding: "record", resource, source: { kind: "subject_ref" }, fields: ["k00", "state", "counter"] }] },
    effect: { name: `${name}.effect`, operation: "update", target_resource: resource, target_binding: "record",
      allowed_fields: [{ name: "state", values: ["done"] }], set: { state: { kind: "literal", value: "done", value_type: type } }, writeback: "supervised" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "record", field: "state" },
      right: { kind: "literal", value: "ready", value_type: type } }, derive: {},
    approval: { class_name: `${name}.approval`, mode: "human", required_role: "reviewer", required_approvals: 1, shared_limits: [] }, ttl_seconds: 300,
    review: { when: "The selected record is ready.", then: "Finish only that record.", refused: ["Refuse records already done."],
      human_review: "One reviewer must approve.", examples: [{ kind: "eligible", scenario: "Own ready record", result: "Wait for reviewer" }] } };
}
function compile(f: { read: ReturnType<typeof build>["exploration_boundary"]; inspection: SchemaInspection }, name = outcome) {
  return compileActionRuleModelDraft({ draft: proposed(name), builtCatalog: buildActionRuleAuthoringCatalog({ boundary: f.read, inspection: f.inspection }),
    readBoundary: f.read, readBoundaryDigest: explorationBoundaryCandidateDigest(f.read) });
}
function input(f = fixture()) { return { read: f.read, decisions: [], actions: [f.compiled], source: { inspection: f.inspection, generationLock: f.lock } }; }
function refresh(f: ReturnType<typeof fixture>) {
  const generated = build(f.inspection);
  f.lock = generated.lock;
  f.read.generation_lock_fingerprint = canonicalJsonDigest(f.lock);
  f.read.role_posture_fingerprint = generated.exploration_boundary.role_posture_fingerprint;
}

function privateFixture(origin: "private_review" | "retained_catalog" = "private_review") {
  const f = fixture(), parent = f.inspection.tables[0]!, child = structuredClone(parent);
  f.read.pack.resources[0]!.principal_key = "q1";
  parent.unique_constraints = [{ name: "parent_tuple", columns: ["q2", "q1", "k00"] }];
  child.name = "r9";
  child.columns.push({ ...structuredClone(child.columns[0]!), name: "parent_id", ordinal_position: 7 });
  child.foreign_keys = [{ name: "r9_r8_fk", columns: ["q2", "q1", "parent_id"], referenced_schema: "opaque",
    referenced_table: "r8", referenced_columns: ["q2", "q1", "k00"], delete_rule: "RESTRICT" }];
  f.inspection.tables.push(child);
  refresh(f);
  const built = buildActionRuleAuthoringCatalog({ boundary: f.read, inspection: f.inspection });
  const prepared = preparePrivateActionSource({ built, boundary: f.read, inspection: f.inspection,
    resource: "opaque.r9", parentResource: resource });
  let compiledCatalog = prepared.built;
  if (origin === "retained_catalog") {
    const broad = structuredClone(f.read), childRead = structuredClone(broad.pack.resources[0]!);
    childRead.id = "opaque.r9";
    childRead.table = "r9";
    childRead.field_types!.parent_id = "uuid";
    broad.pack.resources.push(childRead);
    const initial = buildActionRuleAuthoringCatalog({ boundary: broad, inspection: f.inspection });
    compiledCatalog = buildActionRuleAuthoringCatalog({ boundary: f.read, inspection: f.inspection, retainedCatalog: initial.catalog });
    expect(compiledCatalog.catalog.resources.find(entry => entry.name === "opaque.r9")!.verification_only).toBeUndefined();
  }
  const draft = proposed();
  draft.verification.resources.push({ binding: "private_rows", resource: "opaque.r9",
    source: { kind: "relationship", from_binding: "record", relationship: "r9_r8_fk", direction: "inverse" },
    fields: ["state"], max_rows: 64, overflow: "ineligible", collection_consistency: "complete_locked" });
  draft.require = { kind: "all", expressions: [draft.require, { kind: "not", expression: { kind: "exists", binding: "private_rows",
    where: { kind: "compare", operator: "eq", left: { kind: "field", binding: "private_rows", field: "state" },
      right: { kind: "literal", value: "ready", value_type: { kind: "string", comparison: "exact", max_length: 5, enum: ["ready", "done"] } } } } }] };
  f.compiled = compileActionRuleModelDraft({ draft, builtCatalog: compiledCatalog, readBoundary: f.read,
    readBoundaryDigest: explorationBoundaryCandidateDigest(f.read) });
  return f;
}

describe("digest-bound inspected RLS policy evidence", () => {
  it("carries current RLS evidence for privately used resources retained from the initial catalog", () => {
    const current = input(privateFixture("retained_catalog")), before = structuredClone(current);
    const draft = policyCoverageDraft(current);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.database_scope_proof).toMatchObject({
      resource: "opaque.r9", tenant: { field: "q2", setting: "app.group" }, principal: { field: "q1", setting: "app.person" } });
    expect(Object.keys(draft.runner_evidence.read_access)).toEqual([resource]);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.fields.state).toMatchObject({
      actual_values_returned: false, model_analysis: [], private_action_verification: true });
    expect(current).toEqual(before);
  });
  it("carries current private complete-collection scope into coverage without adding public access or asserting policy completeness", () => {
    const current = input(privateFixture()), before = structuredClone(current);
    const draft = policyCoverageDraft(current);
    const proof = draft.runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.database_scope_proof;
    expect(proof).toMatchObject({ resource: "opaque.r9", schema: "opaque", table: "r9", operation: "SELECT",
      tenant: { field: "q2", setting: "app.group" }, principal: { field: "q1", setting: "app.person" }, enforcement: "inspected_postgres_rls" });
    expect(Object.keys(draft.runner_evidence.read_access)).toEqual([resource]);
    expect(draft.runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.fields.state).toMatchObject({
      actual_values_returned: false, model_analysis: [], private_action_verification: true });
    expect(JSON.stringify(draft)).not.toMatch(/current_setting|using_expression/);
    expect(current).toEqual(before);
  });

  describe.each(["private_review", "retained_catalog"] as const)("compiled source origin: %s", origin => {
  it.each(["missing_relationship", "partial_pairs", "binding_pairs", "wrong_parent", "parent_scope", "wrong_source", "wrong_field", "wrong_scope", "missing_resource", "catalog_lock", "read_digest"])(
    "does not infer private scope for a changed compiled binding (%s)", change => {
      const current = input(privateFixture(origin)), action = current.actions[0]!, authority = action.loaded.authority;
      const child = authority.catalog.resources.find(entry => entry.name === "opaque.r9")!;
      const binding = action.verification_boundary.resources.find(entry => entry.binding === "private_rows")!;
      if (change === "missing_relationship") authority.catalog.relationships = [];
      if (change === "partial_pairs") authority.catalog.relationships[0]!.field_pairs!.pop();
      if (change === "binding_pairs" && binding.source.kind === "relationship") binding.source.field_pairs!.pop();
      if (change === "wrong_parent" && binding.source.kind === "relationship") binding.source.from_binding = "missing";
      if (change === "parent_scope") {
        const parent = action.verification_boundary.resources.find(entry => entry.binding === "record")!;
        if (parent.scope.mode === "columns") parent.scope.principal_field = "q2";
      }
      if (change === "wrong_source") child.source = "other";
      if (change === "wrong_field") child.fields.find(field => field.name === "state")!.nullable = true;
      if (change === "wrong_scope" && binding.scope.mode === "columns") binding.scope.principal_field = "q2";
      if (change === "missing_resource") authority.catalog.resources = authority.catalog.resources.filter(entry => entry.name !== child.name);
      if (change === "catalog_lock") authority.catalog.generation_lock_fingerprint = canonicalJsonDigest("other");
      if (change === "read_digest") authority.rules[0]!.read_boundary_digest = canonicalJsonDigest("old");
      expect(policyCoverageDraft(current).runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.database_scope_proof).toBeNull();
    });

  it.each(["extra_filter", "broader_policy", "missing_policy", "deferred_fk", "ambiguous_fk", "duplicate_fk", "changed_type", "nullable_key", "unvalidated_fk", "nonunique_tuple"])(
    "does not substitute FK presence for current complete private visibility (%s)", change => {
      const f = privateFixture(origin), child = f.inspection.tables[1]!;
      if (change === "extra_filter") child.row_level_security_policies![0]!.using_expression += " AND state = 'ready'";
      if (change === "broader_policy") child.row_level_security_policies!.push({ name: "all", command: "SELECT", permissive: true,
        roles: ["reader"], using_expression: "true" });
      if (change === "missing_policy") child.row_level_security_policies = [];
      if (change === "deferred_fk") child.foreign_keys[0]!.deferrable = true;
      if (change === "ambiguous_fk") child.foreign_keys.push({ ...structuredClone(child.foreign_keys[0]!), name: "other_fk" });
      if (change === "duplicate_fk") child.foreign_keys.push(structuredClone(child.foreign_keys[0]!));
      if (change === "changed_type") child.columns.find(column => column.name === "state")!.data_type = "boolean";
      if (change === "nullable_key") child.columns.find(column => column.name === "parent_id")!.nullable = true;
      if (change === "unvalidated_fk") child.foreign_keys[0]!.action_rule_issue = "unvalidated_foreign_key";
      if (change === "nonunique_tuple") f.inspection.tables[0]!.unique_constraints = [];
      expect(() => policyCoverageDraft(input(f))).toThrow("POLICY_RLS_EVIDENCE_STALE");
      refresh(f);
      // Updating a source lock alone is not revalidation of its retained private catalog.
      const action = f.compiled;
      action.loaded.authority.catalog.generation_lock_fingerprint = f.read.generation_lock_fingerprint;
      action.verification_boundary.generation_lock_fingerprint = f.read.generation_lock_fingerprint;
      action.loaded.authority.rules[0]!.read_boundary_digest = explorationBoundaryCandidateDigest(f.read);
      expect(policyCoverageDraft(input(f)).runner_evidence.actions[outcome]!.scoped_bindings.private_rows!.database_scope_proof).toBeNull();
    });
  });

  it("annotates RLS-only principal enforcement without projecting it or changing authority", () => {
    const current = input(), before = structuredClone(current), draft = policyCoverageDraft(current);
    const read = draft.runner_evidence.read_access[resource]!, action = draft.runner_evidence.actions[outcome]!.scoped_bindings.record!;
    expect(current.read.pack.resources[0]!.principal_key).toBeUndefined();
    expect(action.scope).toEqual({ mode: "columns", tenant_field: "q2" });
    expect(action.fields).not.toHaveProperty("q1");
    expect(read.trusted_principal_field).toBe("q1");
    expect(read.explicit_principal_column).toBeNull();
    expect(read.database_scope_proof).toMatchObject({ source: "local_postgres", schema: "opaque", table: "r8", operation: "SELECT",
      tenant: { field: "q2", setting: "app.group" }, principal: { field: "q1", setting: "app.person" }, enforcement: "inspected_postgres_rls" });
    expect(action.database_scope_proof).toEqual(read.database_scope_proof);
    expect(read.fields.q1).toMatchObject({ actual_values_returned: false, model_analysis: [], kept_out: true });
    expect(draft.runner_evidence.runtime_contract.read_eligibility).toMatchObject({ database_business_predicates_verified: false,
      configured_current_state_prerequisite: null, action_requirements_apply_to_reads: false });
    expect(draft.runner_evidence.runtime_contract.deployment_prerequisites.authenticated_identity.verified).toBe(false);
    expect(draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.verified).toBe(false);
    expect(JSON.stringify(draft)).not.toMatch(/current_setting|NULLIF|obsolete account|obsolete person|using_expression/);
    expect(current).toEqual(before);
  });

  it("covers both retained saved outcomes and leaves their complete compiled rules and privacy unchanged", () => {
    const f = fixture(), second = compile(f, "record.complete_alternative"), loaded = f.compiled.loaded.authority;
    const authority = buildActionRuleAuthorityDraft({ name: loaded.name, action_boundary_name: loaded.action_boundary.name,
      catalog: loaded.catalog, rules: [...loaded.rules, ...second.loaded.authority.rules],
      approval_classes: [...loaded.approval_classes, ...second.loaded.authority.approval_classes],
      reviews: [{ outcome, ...f.compiled.review }, { outcome: second.rule.outcome, ...second.review }] });
    const current = { ...input(f), actions: [], authority }, before = structuredClone(current), draft = policyCoverageDraft(current);
    for (const action of Object.values(draft.runner_evidence.actions)) expect(action.scoped_bindings.record!.database_scope_proof?.principal.field).toBe("q1");
    expect(draft.actions).toHaveLength(2);
    expect(current).toEqual(before);
  });

  it("offers exact mechanical coverage pointers without treating a session name as a business condition", () => {
    const draft = policyCoverageDraft(input()), policy = policyTextSnapshot(Buffer.from("Keep q2 account and q1 person record ownership separate."), "scope.txt");
    const path = `/runner_evidence/read_access/${resource}/database_scope_proof`;
    const passage = { start: 1, end: 1, disposition: "implemented", responsibility: "runner", interpretation: "The inspected RLS mapping proves these two record-scope identities.",
      draft_paths: [path, `/runner_evidence/actions/${outcome}/scoped_bindings/record/database_scope_proof`],
      evidence_checks: [{ path: `${path}/principal/field`, equals: "q1" }, { path: `${path}/tenant/field`, equals: "q2" },
        { path: `${path}/operation`, equals: "SELECT" }] };
    expect(parsePolicyCoverage({ passages: [passage] }, policy, draft, []).passages[0]!.disposition).toBe("implemented");
    expect(() => parsePolicyCoverage({ passages: [{ ...passage, evidence_checks: [{ path: `${path}/principal/field`, equals: "q2" }] }] }, policy, draft, [])).toThrow("Mechanical evidence mismatch");
  });

  it.each(["lock", "schema", "policy", "type", "role", "owner_membership", "read_role"])("rejects stale %s evidence", change => {
    const current = input();
    if (change === "lock") current.source.generationLock.source_env = "ANOTHER_DATABASE_URL";
    if (change === "schema") current.source.inspection.tables[0]!.name = "different";
    if (change === "policy") current.source.inspection.tables[0]!.row_level_security_policies![0]!.using_expression = "true";
    if (change === "type") current.source.inspection.tables[0]!.columns[2]!.data_type = "text";
    if (change === "role") current.source.inspection.current_user = "different_reader";
    if (change === "owner_membership") current.source.inspection.tables[0]!.role_posture!.current_role_can_assume_owner = true;
    if (change === "read_role") current.read.role_posture_fingerprint = canonicalJsonDigest("different");
    expect(() => policyCoverageDraft(current)).toThrow("POLICY_RLS_EVIDENCE_STALE");
  });

  it.each(["missing_policy", "broad_all", "extra_condition", "ineffective", "unverified_role"])("leaves freshly inspected but unproved %s scope unresolved", change => {
    const f = fixture(), table = f.inspection.tables[0]!;
    if (change === "missing_policy") table.row_level_security_policies = [];
    if (change === "broad_all") table.row_level_security_policies!.push({ name: "broad", command: "ALL", permissive: true, roles: ["reader"], using_expression: "true" });
    if (change === "extra_condition") table.row_level_security_policies![0]!.using_expression += " AND state = 'ready'";
    if (change === "ineffective") table.role_posture!.row_security_effective_for_current_role = false;
    if (change === "unverified_role") f.inspection.role_posture!.verified = false;
    refresh(f);
    const evidence = policyCoverageDraft(input(f)).runner_evidence;
    expect(evidence.read_access[resource]!.trusted_principal_field).toBeNull();
    expect(evidence.read_access[resource]!.database_scope_proof).toBeNull();
    expect(evidence.actions[outcome]!.scoped_bindings.record!.database_scope_proof).toBeNull();
  });

  it("does not manufacture inspected evidence when only the reviewed session settings are available", () => {
    const { source: _source, ...current } = input(), draft = policyCoverageDraft(current);
    expect(draft.runner_evidence.read_access[resource]!.principal_scope_configured).toBe(true);
    expect(draft.runner_evidence.read_access[resource]!.trusted_principal_field).toBeNull();
    expect(draft.runner_evidence.read_access[resource]!.database_scope_proof).toBeNull();
  });

  it.each(["source", "table", "engine", "catalog_lock", "read_digest", "read_name", "principal", "duplicate", "missing_field"])("does not transplant Read proof into a different Action %s", change => {
    const current = input(), authority = current.actions[0]!.loaded.authority, target = authority.catalog.resources[0]!;
    if (change === "source") target.source = "another_source";
    if (change === "table") target.table = "another_table";
    if (change === "engine") target.engine = "mysql";
    if (change === "catalog_lock") authority.catalog.generation_lock_fingerprint = canonicalJsonDigest("other lock");
    if (change === "read_digest") authority.rules[0]!.read_boundary_digest = canonicalJsonDigest("old read");
    if (change === "read_name") authority.rules[0]!.read_boundary_name = "another_read";
    if (change === "principal") target.principal_scope_key = "q2";
    if (change === "duplicate") authority.catalog.resources.push(structuredClone(target));
    if (change === "missing_field") target.fields = target.fields.filter(field => field.name !== "q1");
    const evidence = policyCoverageDraft(current).runner_evidence;
    expect(evidence.read_access[resource]!.database_scope_proof?.principal.field).toBe("q1");
    expect(evidence.actions[outcome]!.scoped_bindings.record!.database_scope_proof).toBeNull();
  });

  it("requires fresh binding after writer-only policy metadata changes, while retaining exact business rules", () => {
    const f = fixture(), previous = structuredClone(f.compiled.draft), oldEvidence = policyCoverageDraft(input(f));
    f.inspection.tables[0]!.row_level_security_policies!.push({ name: "writer_lock", command: "UPDATE", permissive: true,
      roles: ["dedicated_writer"], using_expression: "q2 = current_setting('app.group', true)::uuid AND q1 = current_setting('app.person', true)::uuid" });
    expect(() => policyCoverageDraft(input(f))).toThrow("POLICY_RLS_EVIDENCE_STALE");
    refresh(f);
    expect(policyCoverageDraft(input(f)).runner_evidence.actions[outcome]!.scoped_bindings.record!.database_scope_proof).toBeNull();
    f.compiled = compile(f);
    const fresh = policyCoverageDraft(input(f));
    expect(fresh.runner_evidence.actions[outcome]!.scoped_bindings.record!.database_scope_proof?.principal.field).toBe("q1");
    expect(f.compiled.draft).toEqual(previous);
    expect(canonicalJsonDigest(fresh)).not.toBe(canonicalJsonDigest(oldEvidence));
  });

  it("does not add an unrelated inspected table or private source to Read evidence", () => {
    const f = fixture(), unrelated = structuredClone(f.inspection.tables[0]!);
    unrelated.name = "unreviewed";
    f.inspection.tables.push(unrelated);
    refresh(f);
    f.compiled = compile(f);
    const evidence = policyCoverageDraft(input(f));
    expect(Object.keys(evidence.runner_evidence.read_access)).toEqual([resource]);
    expect(JSON.stringify(evidence)).not.toContain("opaque.unreviewed");
  });
});
