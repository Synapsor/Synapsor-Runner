import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarExpressionV1 } from "@synapsor/spec";
import type { DerivedScopePath, ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { actionRuleDiagnosticRepair } from "./action-rule-diagnostic-repair.js";
import { ACTION_RULE_MODEL_DRAFT_VERSION, compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";
import { actionRuleCollectionReadiness } from "./action-rule-collection-readiness.js";

const schema = "reserve_ops", parent = `${schema}.portfolios`, child = `${schema}.freezes`;
const keys = ["insurer_id", "adjuster_id", "portfolio_id"];
const lock = `sha256:${"a".repeat(64)}` as const;
const rls = "insurer_id = nullif(current_setting('app.insurer_id', true), '')::uuid AND adjuster_id = nullif(current_setting('app.adjuster_id', true), '')::uuid";
const source = { engine: "postgres" as const, read_url_env: "DATABASE_URL", database_scope: {
  mode: "postgres_rls" as const, tenant_setting: "app.insurer_id", principal_setting: "app.adjuster_id",
} };

function table(name: string, fields: string[]): TableInfo {
  return { schema, name, type: "table", writable: true,
    columns: fields.map((name, index) => ({ name, ordinal_position: index + 1, nullable: false,
      generated: false, identity: false,
      data_type: name.endsWith("_id") ? "uuid" : name === "active" ? "boolean" : name === "version" || name.endsWith("_cents") ? "integer" : "text",
      ...(name === "status" ? { enum_values: ["active", "closed"] } : {}),
      suggestions: { tenant: false, conflict: name === "version", sensitive: false, immutable: false, large_or_binary: false } })),
    primary_key: [fields[0]!], indexes: [], unique_constraints: [], foreign_keys: [], row_level_security: true,
    row_level_security_policies: [{ name: `${name}_scope`, roles: ["insurance_reader"], command: "SELECT", permissive: true, using_expression: rls }],
    role_posture: { owner: "postgres", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
      row_security_forced: true, row_security_effective_for_current_role: true, row_security_applicable_policies: [`${name}_scope`] },
    suggestions: { tenant_columns: [], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: fields },
  };
}

function fixture() {
  const portfolios = table("portfolios", ["portfolio_id", "insurer_id", "adjuster_id", "portfolio_ref", "status", "reserve_cap_cents", "per_claim_ceiling_cents", "routine_ceiling_cents", "version"]);
  portfolios.unique_constraints = [{ name: "portfolio_full_scope", columns: keys }];
  const claims = table("claims", ["claim_id", ...keys, "claim_ref", "status", "reserve_cents", "version"]);
  const freezes = table("freezes", ["freeze_id", ...keys, "active", "version"]);
  for (const row of [claims, freezes]) row.foreign_keys = [{ name: `${row.name}_portfolio_fk`, columns: keys,
    referenced_schema: schema, referenced_table: "portfolios", referenced_columns: keys,
    delete_rule: "NO ACTION" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "17.10", current_user: "insurance_reader",
    inspected_at: "2026-09-11T19:40:55.715Z", schemas: [schema], warnings: [], tables: [claims, freezes, portfolios] };
  const readResource = (row: TableInfo, visible: string[]): ExplorationBoundaryDraft["pack"]["resources"][number] => ({ id: `${schema}.${row.name}`, schema, table: row.name,
    primary_key: row.primary_key[0]!, tenant_key: "insurer_id", principal_key: "adjuster_id",
    field_types: Object.fromEntries(row.columns.map(field => [field.name, field.data_type])), field_enums: { status: ["active", "closed"] },
    selectable_fields: visible, filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
    count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: row.columns.map(field => field.name).filter(name => !visible.includes(name)),
    relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true,
    rls_session: { tenant_setting: "app.insurer_id", principal_setting: "app.adjuster_id" } });
  const boundary: ExplorationBoundaryDraft = {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "staging",
    source: "database", compiler_version: "test", spec_version: "test", generation_lock_fingerprint: lock,
    role_posture_fingerprint: rolePostureFingerprint(inspection),
    trusted_context: { provider: "environment", tenant_env: "TEST_INSURER", principal_env: "TEST_ADJUSTER" },
    pack: { name: "reserve_read", resources: [readResource(claims, ["claim_ref", "status", "reserve_cents"]), readResource(portfolios, ["portfolio_ref", "status"])] },
    budgets: { max_rows: 50, max_groups: 50, max_top_n: 25, max_measures: 3, max_dimensions: 3, max_time_ranges: 2,
      max_relationship_hops: 2, max_response_cells: 500, max_response_bytes: 65536, statement_timeout_ms: 3000, max_complexity: 24,
      max_queries_per_session: 1000, max_extracted_cells_per_session: 4000, max_differencing_queries: 16, rate_limit_per_minute: 120 },
    unresolved_decisions: [],
  };
  const field = (binding: string, field: string): ActionRuleScalarExpressionV1 => ({ kind: "field", binding, field });
  const active = (binding: string): ActionRuleBooleanExpressionV1 => ({ kind: "compare", operator: "eq", left: field(binding, "status"),
    right: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 6, comparison: "exact", enum: ["active", "closed"] } } });
  const desired: ActionRuleScalarExpressionV1 = { kind: "input", name: "desired_cents" };
  const draft: ActionRuleModelDraftV1 = {
    schema_version: ACTION_RULE_MODEL_DRAFT_VERSION, name: "insurance.adjust", outcome: "insurance.adjust",
    inputs: [{ name: "desired_cents", description: "Requested reserve in cents", type: { kind: "integer", unit: "minor_currency_units" }, minimum: 1000, maximum: 100000 }],
    verification: { name: "insurance.verify", resources: [
      { binding: "claim", resource: `${schema}.claims`, source: { kind: "subject_ref" }, fields: ["status", "reserve_cents"] },
      { binding: "portfolio", resource: parent, source: { kind: "relationship", from_binding: "claim", relationship: "claims_portfolio_fk", direction: "forward" },
        fields: ["status", "reserve_cap_cents", "per_claim_ceiling_cents", "routine_ceiling_cents"] },
      { binding: "active_claims", resource: `${schema}.claims`, source: { kind: "relationship", from_binding: "portfolio", relationship: "claims_portfolio_fk", direction: "inverse" },
        fields: ["claim_id", "status", "reserve_cents"], max_rows: 64, overflow: "ineligible", collection_consistency: "complete_locked", deterministic_order: [{ field: "claim_id", direction: "asc" }] },
      { binding: "freezes", resource: child, source: { kind: "relationship", from_binding: "portfolio", relationship: "freezes_portfolio_fk", direction: "inverse" },
        fields: ["active"], max_rows: 64, overflow: "ineligible", collection_consistency: "complete_locked", deterministic_order: [{ field: "freeze_id", direction: "asc" }] },
    ] },
    effect: { name: "insurance.reserve_effect", operation: "update", target_resource: `${schema}.claims`, target_binding: "claim",
      allowed_fields: [{ name: "reserve_cents", minimum: 1000, maximum: 100000 }], set: { reserve_cents: desired }, writeback: "supervised" },
    require: { kind: "all", expressions: [active("claim"), active("portfolio"),
      { kind: "compare", operator: "lte", left: desired, right: field("portfolio", "per_claim_ceiling_cents") },
      { kind: "not", expression: { kind: "exists", binding: "freezes", where: { kind: "compare", operator: "eq", left: field("freezes", "active"), right: { kind: "literal", value: true, value_type: { kind: "boolean" } } } } },
      { kind: "compare", operator: "eq", left: { kind: "aggregate", operation: "count", binding: "active_claims", where: { kind: "compare", operator: "eq", left: field("active_claims", "claim_id"), right: field("claim", "claim_id") } }, right: { kind: "literal", value: 1, value_type: { kind: "integer", unit: "rows" } } },
      { kind: "compare", operator: "lte", left: { kind: "math", operation: "add", inputs: [{ kind: "math", operation: "subtract", inputs: [{ kind: "aggregate", operation: "sum", binding: "active_claims", field: "reserve_cents", where: active("active_claims") }, field("claim", "reserve_cents")] }, desired] }, right: field("portfolio", "reserve_cap_cents") },
    ] }, derive: {}, ttl_seconds: 300,
    approval: { class_name: "insurance.supervisor", mode: "policy", auto_approve_when: { kind: "compare", operator: "lte", left: desired, right: field("portfolio", "routine_ceiling_cents") },
      required_role: "insurance_supervisor", required_approvals: 1, shared_limits: [
        { id: "overall", kind: "count", scope: "boundary", maximum: 8, window_seconds: 86400 },
        { id: "insurer", kind: "count", scope: "tenant", capability: "insurance.adjust", maximum: 3, window_seconds: 86400 },
      ] },
    review: { when: "Active claim and portfolio; complete current budget and freeze checks pass.", then: "Change only selected reserve and version.",
      refused: ["Invalid requests remain refused."], human_review: "One supervisor for otherwise-valid exceptions.",
      examples: [{ kind: "eligible", scenario: "All current checks pass.", result: "Bounded reserve adjustment." }] },
  };
  return { inspection, boundary, draft, freezes, readResource };
}

function unscopedContext() {
  const f = fixture();
  const { tenant_key: _tenant, principal_key: _principal, ...resource } = f.readResource(f.freezes, ["active"]);
  f.boundary.pack.resources.push(resource);
  return { builtCatalog: buildActionRuleAuthoringCatalog(f), verification: f.draft.verification };
}

describe("insurance complete private collection scope regression", () => {
  it("retains the exact host refusal when an intermediate collection has no direct reviewed child scope", () => {
    const f = fixture();
    const broad = f.readResource(f.freezes, ["freeze_id", "insurer_id", "adjuster_id", "portfolio_id", "active", "version"]);
    const { tenant_key: _tenant, principal_key: _principal, ...withoutDirectScope } = broad;
    const links: DerivedScopePath["proof"]["links"] = [{ constraint_name: "freezes_portfolio_fk", source_resource: child,
      target_resource: parent, source_columns: keys, target_columns: keys,
      target_uniqueness: { kind: "unique_constraint", name: "portfolio_full_scope", columns: keys },
      nullable: false, cardinality: "many_to_one", max_fan_out: 1 }];
    const derived = (column: string): DerivedScopePath => ({ mode: "derived", path_id: "freezes_portfolio_fk",
      ancestor_resource: parent, ancestor_column: column,
      proof: { source: "database_catalog", links, digest: canonicalJsonDigest(links) } });
    f.boundary.pack.resources.push({ ...withoutDirectScope, tenant_scope: derived("insurer_id"), principal_scope: derived("adjuster_id") });
    const builtCatalog = buildActionRuleAuthoringCatalog(f);
    expect(builtCatalog.catalog.resources.find(item => item.name === child)).not.toHaveProperty("tenant_key");
    expect(builtCatalog.catalog.resources.find(item => item.name === child)).not.toHaveProperty("principal_scope_key");
    expect(builtCatalog.authoring.resources.find(item => item.name === child)).toMatchObject({ tenant_scope: "unsupported_derived", principal_scope: "postgres_rls" });
    expect(() => compileActionRuleModelDraft({ draft: f.draft, builtCatalog, readBoundary: f.boundary, readBoundaryDigest: canonicalJsonDigest(f.boundary) }))
      .toThrow("Complete collection freezes requires an inverse foreign key from one directly scoped parent and explicit matching child scope.");
  });

  it("classifies missing reviewed collection scope as source evidence, not a rule-syntax correction", () => {
    const diagnostic = actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED",
      message: "Complete collection freezes requires an inverse foreign key from one directly scoped parent and explicit matching child scope." },
    unscopedContext());
    expect(diagnostic.category).toBe("source_evidence");
    expect(diagnostic.next_action).not.toContain("Correct the named draft component");
    expect(diagnostic.next_action).toContain("metadata consent");
    expect(diagnostic.next_action).toContain("do not add public Read access");
    expect(diagnostic.next_action).toContain("explicitly review and narrow");
    expect(diagnostic.next_action).toContain("absence or aggregate condition");
    expect(diagnostic.correction).toBeUndefined();
  });

  it("recognizes the host verdict for renamed bindings without reclassifying unrelated unbounded failures", () => {
    const message = "Complete collection r9_link requires an inverse foreign key from one directly scoped parent and explicit matching child scope.";
    const context = unscopedContext();
    context.verification.resources.find(resource => resource.binding === "freezes")!.binding = "r9_link";
    expect(actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED", message }, context).category).toBe("source_evidence");
    expect(actionRuleDiagnosticRepair({ code: "ACTION_RULE_INVALID", message }).category).toBe("draft_structure");
    expect(actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED", message: "Verification lock_order must contain every binding exactly once." }).category).toBe("draft_structure");
    expect(actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED", message: message.replace("r9_link", "missing.pointer") }).category).not.toBe("source_evidence");
    expect(actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED", message: `${message} Replace the rule.` }).category).not.toBe("source_evidence");
  });

  it.each(["no_context", "nonexistent_binding", "nonexistent_resource", "duplicate_binding", "duplicate_resource", "already_direct"])("does not infer missing source evidence from %s", failure => {
    const context = unscopedContext();
    const binding = context.verification.resources.find(resource => resource.binding === "freezes")!;
    const resource = context.builtCatalog.catalog.resources.find(resource => resource.name === child)!;
    if (failure === "nonexistent_binding") binding.binding = "other";
    if (failure === "nonexistent_resource") binding.resource = "reserve_ops.unreviewed";
    if (failure === "duplicate_binding") context.verification.resources.push(structuredClone(binding));
    if (failure === "duplicate_resource") context.builtCatalog.catalog.resources.push(structuredClone(resource));
    if (failure === "already_direct") resource.tenant_key = "insurer_id";
    const result = actionRuleDiagnosticRepair({ code: "ACTION_RULE_UNBOUNDED",
      message: "Complete collection freezes requires an inverse foreign key from one directly scoped parent and explicit matching child scope." },
    failure === "no_context" ? undefined : context);
    expect(result.category).toBe("draft_structure");
    expect(result.correction).toBeUndefined();
  });

  it("uses the existing exact private-source preparation without exposing fields or changing either business predicate", () => {
    const f = fixture(), before = structuredClone({ boundary: f.boundary, inspection: f.inspection, draft: f.draft });
    const prepared = preparePrivateActionSource({ ...f, built: buildActionRuleAuthoringCatalog(f), resource: child, parentResource: parent });
    const compiled = compileActionRuleModelDraft({ draft: f.draft, builtCatalog: prepared.built, readBoundary: f.boundary, readBoundaryDigest: canonicalJsonDigest(f.boundary) });
    expect({ boundary: f.boundary, inspection: f.inspection, draft: f.draft }).toEqual(before);
    expect(f.boundary.pack.resources.some(item => item.id === child)).toBe(false);
    expect(prepared.built.authoring.resources.find(item => item.name === child)!.fields.every(field => field.role !== "model_visible" && !field.writable)).toBe(true);
    expect(compiled.draft).toEqual(f.draft);
    expect(compiled.rule.require).toEqual(f.draft.require);
    expect(compiled.draft.effect).toEqual(f.draft.effect);
    expect(compiled.approval_class.shared_limits).toEqual(f.draft.approval.shared_limits);
    const plan = compiled.loaded.registry.rules[0]!.compiled;
    expect(plan.bindings.filter(binding => binding.verification.collection_consistency === "complete_locked").map(binding => binding.binding).sort()).toEqual(["active_claims", "freezes"]);
    expect(actionRuleCollectionReadiness({ compiled: plan, inspection: f.inspection, source, connection: "reader" })).toEqual([]);
    expect(actionRuleCollectionReadiness({ compiled: plan, inspection: f.inspection, source, connection: "writer" })).not.toEqual([]);
    f.freezes.row_level_security_policies![0]!.using_expression += " AND active=false";
    expect(actionRuleCollectionReadiness({ compiled: plan, inspection: f.inspection, source, connection: "reader" })).toHaveLength(1);
  });

  it.each(["partial_fk", "deferred", "unvalidated", "nullable", "stale_role", "swapped_parent", "already_public"])("rejects %s without replacing reviewed privacy or scope", failure => {
    const f = fixture(), built = buildActionRuleAuthoringCatalog(f);
    if (failure === "partial_fk") f.freezes.foreign_keys[0]!.columns = ["portfolio_id"];
    if (failure === "deferred") f.freezes.foreign_keys[0]!.deferrable = true;
    if (failure === "unvalidated") f.freezes.foreign_keys[0]!.action_rule_issue = "unvalidated_foreign_key";
    if (failure === "nullable") f.freezes.columns.find(field => field.name === "insurer_id")!.nullable = true;
    if (failure === "stale_role") f.boundary.role_posture_fingerprint = `sha256:${"b".repeat(64)}`;
    if (failure === "swapped_parent") f.boundary.pack.resources.find(resource => resource.id === parent)!.tenant_key = "adjuster_id";
    if (failure === "already_public") f.boundary.pack.resources.push(f.readResource(f.freezes, ["active"]));
    const before = structuredClone({ boundary: f.boundary, inspection: f.inspection, built });
    expect(() => preparePrivateActionSource({ ...f, built, resource: child, parentResource: parent })).toThrow("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED");
    expect({ boundary: f.boundary, inspection: f.inspection, built }).toEqual(before);
  });
});
