import { nativeAuthoringRefusal } from "./test-fixtures/native-authoring-refusal.js";
import type { AskProviderDependencies } from "./model-ask.js";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarExpressionV1 } from "@synapsor/spec";
import type { DerivedScopePath, ExplorationBoundaryDraft } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { ACTION_RULE_MODEL_DRAFT_VERSION, compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { actionRuleAuthoringCheckpoint, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { generateModelActionRuleDraft, type ModelActionRuleDraftInput } from "./action-rule-model.js";
import { reviewPrivateActionSourceForModel } from "./action-rule-source-consent.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { actionRuleCollectionReadiness } from "./action-rule-collection-readiness.js";
import { checkpointPrivateSourcePrerequisites } from "./action-rule-checkpoint-prerequisite.js";

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
  for (const row of [claims, freezes]) row.foreign_keys = [{ name: `${row.name}_insurer_id_adjuster_id_portfolio_id_fkey`, columns: keys,
    referenced_schema: schema, referenced_table: "portfolios", referenced_columns: keys,
    delete_rule: "NO ACTION" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "17.10", current_user: "insurance_reader",
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
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
      { binding: "portfolio", resource: parent, source: { kind: "relationship", from_binding: "claim", relationship: "claims_insurer_id_adjuster_id_portfolio_id_fkey", direction: "forward" },
        fields: ["status", "reserve_cap_cents", "per_claim_ceiling_cents", "routine_ceiling_cents"] },
      { binding: "active_claims", resource: `${schema}.claims`, source: { kind: "relationship", from_binding: "portfolio", relationship: "claims_insurer_id_adjuster_id_portfolio_id_fkey", direction: "inverse" },
        fields: ["claim_id", "status", "reserve_cents"], max_rows: 64, overflow: "ineligible", collection_consistency: "complete_locked", deterministic_order: [{ field: "claim_id", direction: "asc" }] },
      { binding: "freezes", resource: child, source: { kind: "relationship", from_binding: "portfolio", relationship: "freezes_insurer_id_adjuster_id_portfolio_id_fkey", direction: "inverse" },
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
        { id: "overall", kind: "count", scope: "capability", capability: "insurance.adjust", maximum: 8, window_seconds: 86400 },
        { id: "insurer", kind: "count", scope: "tenant", capability: "insurance.adjust", maximum: 3, window_seconds: 86400 },
      ] },
    review: { when: "Active claim and portfolio; complete current budget and freeze checks pass.", then: "Change only selected reserve and version.",
      refused: ["Invalid requests remain refused."], human_review: "One supervisor for otherwise-valid exceptions.",
      examples: [{ kind: "eligible", scenario: "All current checks pass.", result: "Bounded reserve adjustment." }] },
  };
  return { inspection, boundary, draft, freezes, readResource };
}

function savedJob() {
  const f = fixture();
  const publicBoundary = structuredClone(f.boundary);
  const { tenant_key: _tenant, principal_key: _principal, ...broad } = f.readResource(f.freezes, f.freezes.columns.map(field => field.name));
  const links: DerivedScopePath["proof"]["links"] = [{ constraint_name: "freezes_insurer_id_adjuster_id_portfolio_id_fkey", source_resource: child,
    target_resource: parent, source_columns: keys, target_columns: keys,
    target_uniqueness: { kind: "unique_constraint", name: "portfolio_full_scope", columns: keys },
    nullable: false, cardinality: "many_to_one", max_fan_out: 1 }];
  const inherited = (column: string): DerivedScopePath => ({ mode: "derived", path_id: links[0]!.constraint_name,
    ancestor_resource: parent, ancestor_column: column, proof: { source: "database_catalog", links, digest: canonicalJsonDigest(links) } });
  publicBoundary.pack.resources.push({ ...broad, tenant_scope: inherited("insurer_id"), principal_scope: inherited("adjuster_id") });
  const publicCatalog = buildActionRuleAuthoringCatalog({ boundary: publicBoundary, inspection: f.inspection });
  const { schema_version: _schema, verification, effect, approval, ...rule } = f.draft;
  const checkpoint = actionRuleAuthoringCheckpoint({
    intent_digest: canonicalJsonDigest("Adjust the reserve under the complete saved policy."),
    context_digest: canonicalJsonDigest({ catalog: publicCatalog.catalog, read: canonicalJsonDigest(publicBoundary), baseline: null }),
    components: { verification: { ...verification }, effect: { ...effect }, rule, approval: { ...approval } },
    operator_messages: ["Keep the complete freeze guard, reserve aggregate, private ceilings and 8 overall/3 insurer limits unchanged."],
    reviewed_relationships: publicCatalog.catalog.relationships.map(link => link.name).sort(),
  });
  return { ...f, publicBoundary, publicCatalog, checkpoint };
}

function runInput(f = savedJob()) {
  let stored = structuredClone(f.checkpoint);
  const bodies: string[] = [];
  const responses = [
    { status: 200, body: { output: [{ type: "function_call", call_id: "validate", name: "runner__validate_action_draft", arguments: "{}" }] } },
    { status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: "The unchanged disabled draft validates." }] }] } },
  ];
  const requestJson = vi.fn<NonNullable<AskProviderDependencies["requestJson"]>>(async request => { bodies.push(JSON.stringify(request.body)); return responses.shift()!; });
  const chooseOption = vi.fn(async () => "allow" as string | undefined);
  const assertCurrent = vi.fn(async () => {});
  const sourceReviews: Parameters<NonNullable<ModelActionRuleDraftInput["reviewPrivateSource"]>>[0][] = [];
  const input: ModelActionRuleDraftInput = {
    intent: "Adjust the reserve under the complete saved policy.", operatorJob: "Adjust the reserve under the complete saved policy.",
    session: { provider: "openai", model: "test", apiKey: "test-key", dependencies: { requestJson } },
    builtCatalog: buildActionRuleAuthoringCatalog(f), readBoundary: f.boundary, readBoundaryDigest: canonicalJsonDigest(f.boundary),
    checkpoint: f.checkpoint, revalidateSavedComponents: true, egressAcknowledged: true,
    onCheckpoint: async checkpoint => { stored = structuredClone(checkpoint); },
    reviewPrivateSource: async request => {
      sourceReviews.push(structuredClone(request));
      return reviewPrivateActionSourceForModel({ request, inspection: f.inspection,
        session: { chooseOption } as unknown as BoundaryReviewInteractiveSession,
        modelLabel: "stubbed authoring transport", assertCurrent });
    },
    askClarification: async () => undefined,
  };
  return { input, requestJson, chooseOption, assertCurrent, sourceReviews, bodies, stored: () => stored, f };
}

function reviseCheckpoint(checkpoint: ActionRuleAuthoringCheckpoint, change: (value: ActionRuleAuthoringCheckpoint) => void) {
  const next = structuredClone(checkpoint);
  change(next);
  const { schema_version: _schema, digest: _digest, ...core } = next;
  return actionRuleAuthoringCheckpoint(core);
}

const pausedResponse = { status: 200, body: { output: [{ type: "function_call", call_id: "pending_question", name: "runner__submit_approval_policy_draft", arguments: JSON.stringify({ status: "clarification", question: "Keep the existing draft pending?" }) }] } };

describe("retained public-origin collection checkpoint prerequisites", () => {
  it("reviews a missing private collection before the stale guard, then validates the full unchanged insurance rule", async () => {
    const h = runInput(), before = structuredClone({ ...h.f, readResource: undefined });
    expect(h.f.checkpoint.reviewed_private_sources).toBeUndefined();
    expect(h.f.publicCatalog.catalog.resources.find(resource => resource.name === child)).not.toHaveProperty("tenant_key");
    expect(h.input.builtCatalog.catalog.relationships.map(link => link.name)).not.toContain("freezes_insurer_id_adjuster_id_portfolio_id_fkey");
    const result = await generateModelActionRuleDraft(h.input);
    expect(result).toMatchObject({ state: "ready", authority_granted: false, source_database_changed: false });
    expect(h.chooseOption).toHaveBeenCalledOnce();
    expect(h.sourceReviews[0]).not.toHaveProperty("previousReview");
    expect(h.stored().reviewed_private_sources).toHaveLength(1);
    expect(h.stored().components).toEqual(before.checkpoint.components);
    expect(h.stored().operator_messages).toEqual(before.checkpoint.operator_messages);
    expect(result.compiled.draft.require).toEqual(before.draft.require);
    expect(result.compiled.draft.approval).toEqual(before.draft.approval);
    expect(result.compiled.draft.effect).toEqual(before.draft.effect);
    expect({ ...h.f, readResource: undefined }).toEqual(before);
    expect(h.bodies[0]).toContain("needs_revalidation");
    const plan = result.compiled.loaded.registry.rules[0]!.compiled;
    expect(actionRuleCollectionReadiness({ compiled: plan, inspection: h.f.inspection, source, connection: "reader" })).toEqual([]);
    expect(result.compiled.verification_boundary.resources.find(resource => resource.resource === child)!.fields.every(field => !field.model_visible)).toBe(true);
  });

  it.each(["TEST_TRANSPORT_INTERRUPTED", "TEST_INTERRUPTED"])("retains the original unobserved %s schedule as a no-retry negative", async message => {
    const h = runInput();
    h.requestJson.mockImplementation(async () => { throw new Error(message); });
    await expect(generateModelActionRuleDraft(h.input)).rejects.toMatchObject({ code: "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION" });
    expect(h.requestJson).toHaveBeenCalledOnce();
    expect(h.stored().reviewed_private_sources).toHaveLength(1);
    expect(h.stored().components).toEqual(h.f.checkpoint.components);
    expect(h.stored().operator_messages).toEqual(h.f.checkpoint.operator_messages);
    // This component fixture has no saved-job transport host. Public restart
    // fencing is exercised with the actual resume host in the recovery suite.
  });

  it("keeps the strict stale guard when the host did not authorize retained-component revalidation", async () => {
    const h = runInput();
    h.input.revalidateSavedComponents = false;
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("ACTION_AUTHORING_CHECKPOINT_STALE");
    expect(h.chooseOption).not.toHaveBeenCalled();
    expect(h.requestJson).not.toHaveBeenCalled();
    expect(h.stored()).toEqual(h.f.checkpoint);
  });

  it.each(["pending", undefined])("decline or interruption before consent keeps the exact saved work pending (%s)", async selection => {
    const h = runInput();
    h.chooseOption.mockResolvedValue(selection);
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("ACTION_AUTHORING_CHECKPOINT_STALE");
    expect(h.chooseOption).toHaveBeenCalledOnce();
    expect(h.assertCurrent).toHaveBeenCalledOnce();
    expect(h.stored()).toEqual(h.f.checkpoint);
    expect(h.requestJson).not.toHaveBeenCalled();
  });

  it("persists fresh consent before a complete native refusal, then reuses consent and accepted business answers", async () => {
    const h = runInput();
    h.requestJson.mockImplementation(nativeAuthoringRefusal);
    await expect(generateModelActionRuleDraft(h.input)).rejects.toMatchObject({ code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    const retained = h.stored();
    expect(retained.reviewed_private_sources).toHaveLength(1);
    expect(retained.context_digest).toBe(h.f.checkpoint.context_digest);
    expect(retained.components).toEqual(h.f.checkpoint.components);
    expect(retained.operator_messages).toEqual(h.f.checkpoint.operator_messages);
    const resumed = runInput();
    resumed.input.checkpoint = retained;
    const result = await generateModelActionRuleDraft(resumed.input);
    expect(result.compiled.draft.require).toEqual(h.f.draft.require);
    expect(resumed.chooseOption).not.toHaveBeenCalled();
    expect(resumed.sourceReviews[0]?.previousReview).toEqual(retained.reviewed_private_sources![0]);
    expect(resumed.bodies[0]).toContain("needs_revalidation");
    expect(resumed.bodies[0]).toContain(h.f.checkpoint.operator_messages![0]);
  });

  it.each([false, true])("checkpoint save failure stops before model exchange (commit happened=%s)", async committed => {
    const h = runInput(), save = h.input.onCheckpoint!;
    h.input.onCheckpoint = async next => {
      if (committed) await save(next);
      throw new Error("TEST_CHECKPOINT_EACCES");
    };
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("TEST_CHECKPOINT_EACCES");
    expect(h.requestJson).not.toHaveBeenCalled();
    expect(h.stored().components).toEqual(h.f.checkpoint.components);
    if (!committed) expect(h.stored()).toEqual(h.f.checkpoint);
    const resumed = runInput();
    resumed.input.checkpoint = h.stored();
    expect((await generateModelActionRuleDraft(resumed.input)).state).toBe("ready");
    expect(resumed.chooseOption).toHaveBeenCalledTimes(committed ? 0 : 1);
  });

  it("retains reviewed counters, unrelated rules and unfinished work without granting any authority", async () => {
    const h = runInput();
    const counter = { resource: "reserve_ops.claims", field: "version", maintenance: "all_writers_increment" as const,
      proof_digest: canonicalJsonDigest("already host-reviewed exact counter") };
    h.input.checkpoint = reviseCheckpoint(h.f.checkpoint, next => { next.reviewed_version_fields = [counter]; });
    const counterReview = vi.fn(async (request: Parameters<NonNullable<ModelActionRuleDraftInput["reviewVersionField"]>>[0]) => {
      expect(request.previousReview).toEqual(counter);
      expect(request.context.builtCatalog.catalog.resources.some(resource => resource.name === child && resource.verification_only)).toBe(true);
      return { ...request.context, review: counter };
    });
    h.input.reviewVersionField = counterReview;
    const unrelated = structuredClone(h.f.draft);
    unrelated.name = unrelated.outcome = "insurance.other_adjustment";
    unrelated.approval.shared_limits = unrelated.approval.shared_limits.map(limit => ({ ...limit, capability: unrelated.outcome }));
    const active = { read: "unchanged-active-read", action: "unchanged-active-action", pending: ["other-unfinished-job"] };
    const before = structuredClone({ unrelated, active });
    h.input.preparedDrafts = [unrelated];
    const result = await generateModelActionRuleDraft(h.input);
    expect(result.compiled.rule.outcome).toBe(h.f.draft.outcome);
    expect(h.stored().reviewed_version_fields).toEqual([counter]);
    expect(h.stored().components).toEqual(h.f.checkpoint.components);
    expect({ unrelated, active }).toEqual(before);
    expect(counterReview).toHaveBeenCalledOnce();
  });

  it.each(["no_callback", "no_persistence", "no_egress", "unrelated_intent", "withdrawn_binding", "unknown_edge", "ambiguous_binding", "forward", "bounded_only", "effect_target", "still_public"])(
    "does not turn %s into private-source approval", async failure => {
      const h = runInput();
      if (failure === "no_callback") delete h.input.reviewPrivateSource;
      if (failure === "no_persistence") delete h.input.onCheckpoint;
      if (failure === "no_egress") h.input.egressAcknowledged = false;
      if (failure === "unrelated_intent") h.input.intent = "Withdraw this reserve adjustment entirely.";
      if (failure === "still_public") h.input.readBoundary = h.f.publicBoundary;
      if (["withdrawn_binding", "unknown_edge", "ambiguous_binding", "forward", "bounded_only", "effect_target"].includes(failure)) {
        h.input.checkpoint = reviseCheckpoint(h.f.checkpoint, next => {
          const verification = next.components.verification as unknown as ActionRuleModelDraftV1["verification"];
          const childBinding = verification.resources.find(resource => resource.resource === child)!;
          if (failure === "withdrawn_binding") verification.resources = verification.resources.filter(resource => resource.resource !== child);
          if (failure === "unknown_edge") next.reviewed_relationships!.push("never_reviewed_link");
          if (failure === "ambiguous_binding") verification.resources.push(structuredClone(childBinding));
          if (failure === "forward" && childBinding.source.kind === "relationship") childBinding.source.direction = "forward";
          if (failure === "bounded_only") delete childBinding.collection_consistency;
          if (failure === "effect_target") next.components.effect!.target_resource = child;
        });
      }
      await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("ACTION_AUTHORING_CHECKPOINT_STALE");
      expect(h.chooseOption).not.toHaveBeenCalled();
      expect(h.requestJson).not.toHaveBeenCalled();
      expect(h.stored()).toEqual(h.f.checkpoint);
    });

  it.each(["partial_fk", "deferrable_fk", "unvalidated_fk", "nullable_key", "extra_row_predicate", "broad_all", "unverified_role", "missing_setting", "wrong_parent_scope"])(
    "requires current exact source proof before consent (%s)", async drift => {
      const h = runInput(), f = h.f;
      if (drift === "partial_fk") f.freezes.foreign_keys[0]!.columns = ["portfolio_id"];
      if (drift === "deferrable_fk") f.freezes.foreign_keys[0]!.deferrable = true;
      if (drift === "unvalidated_fk") f.freezes.foreign_keys[0]!.action_rule_issue = "unvalidated_foreign_key";
      if (drift === "nullable_key") f.freezes.columns.find(field => field.name === "insurer_id")!.nullable = true;
      if (drift === "extra_row_predicate") f.freezes.row_level_security_policies![0]!.using_expression += " AND active = false";
      if (drift === "broad_all") f.freezes.row_level_security_policies!.push({ ...f.freezes.row_level_security_policies![0]!, name: "broader_all", command: "ALL", using_expression: "true" });
      if (drift === "unverified_role") f.inspection.role_posture!.verified = false;
      if (drift === "missing_setting") delete f.boundary.pack.resources.find(resource => resource.id === parent)!.rls_session;
      if (drift === "wrong_parent_scope") f.boundary.pack.resources.find(resource => resource.id === parent)!.principal_key = "insurer_id";
      f.boundary.role_posture_fingerprint = rolePostureFingerprint(f.inspection);
      h.input.builtCatalog = buildActionRuleAuthoringCatalog(f);
      h.input.readBoundaryDigest = canonicalJsonDigest(f.boundary);
      await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED");
      expect(h.chooseOption).not.toHaveBeenCalled();
      expect(h.requestJson).not.toHaveBeenCalled();
      expect(h.stored()).toEqual(f.checkpoint);
    });

  it("rechecks host freshness after exact consent and rejects concurrent Read or source changes", async () => {
    const h = runInput();
    h.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ACTION_RULE_REVISION_STALE: current Read or source changed"));
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("ACTION_RULE_REVISION_STALE");
    expect(h.chooseOption).toHaveBeenCalledOnce();
    expect(h.assertCurrent).toHaveBeenCalledTimes(2);
    expect(h.requestJson).not.toHaveBeenCalled();
    expect(h.stored()).toEqual(h.f.checkpoint);
  });

  it.each(["read_changed", "wrong_relationship", "wrong_parent", "not_private"])("does not persist an inconsistent private prerequisite result (%s)", async change => {
    const h = runInput(), review = h.input.reviewPrivateSource!;
    h.input.reviewPrivateSource = async request => {
      const prepared = (await review(request))!;
      if (change === "read_changed") prepared.readBoundary = { ...prepared.readBoundary, pack: { ...prepared.readBoundary.pack, name: "unapproved_public_read" } };
      if (change === "wrong_relationship") prepared.review.relationship = "unrelated_fk";
      if (change === "wrong_parent") prepared.review.parent_resource = "reserve_ops.other_parent";
      if (change === "not_private") delete prepared.builtCatalog.catalog.resources.find(resource => resource.name === child)!.verification_only;
      return prepared;
    };
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow(change === "read_changed" ? "PRIVATE_SOURCE_READ_CHANGED" : "ACTION_AUTHORING_CHECKPOINT_STALE");
    expect(h.stored()).toEqual(h.f.checkpoint);
    expect(h.requestJson).not.toHaveBeenCalled();
  });

  it("does not ignore a same-base checkpoint conflict or overwrite the competing edit", async () => {
    const h = runInput();
    const concurrent = reviseCheckpoint(h.f.checkpoint, next => { next.operator_messages!.push("Another accepted operator answer."); });
    let store = concurrent;
    h.input.onCheckpoint = async next => {
      if (store.digest !== h.f.checkpoint.digest) throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED");
      store = next;
    };
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(store).toEqual(concurrent);
    expect(h.requestJson).not.toHaveBeenCalled();
  });

  it("allows only the winning save when two authoring sessions review the same base concurrently", async () => {
    const first = runInput(), second = runInput();
    let store = structuredClone(first.f.checkpoint);
    const base = store.digest, releases: Array<() => void> = [];
    let bothEntered!: () => void;
    const entered = new Promise<void>(resolve => { bothEntered = resolve; });
    for (const h of [first, second]) {
      h.chooseOption.mockImplementation(async () => {
        await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) bothEntered(); });
        return "allow";
      });
      h.input.onCheckpoint = async next => {
        if (store.digest !== base) throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED");
        store = structuredClone(next);
      };
    }
    const runs = Promise.allSettled([generateModelActionRuleDraft(first.input), generateModelActionRuleDraft(second.input)]);
    await entered;
    releases.forEach(release => release());
    const results = await runs;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toContain("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(store.components).toEqual(first.f.checkpoint.components);
    expect(store.reviewed_private_sources).toHaveLength(1);
    expect([first.requestJson.mock.calls.length, second.requestJson.mock.calls.length].sort()).toEqual([0, 1]);
  });

  it("asks fresh consent for new metadata on resume, rather than reusing an old private proof", async () => {
    const first = runInput();
    first.requestJson.mockImplementation(nativeAuthoringRefusal);
    await expect(generateModelActionRuleDraft(first.input)).rejects.toMatchObject({ code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    const resumed = runInput();
    resumed.f.freezes.columns.push({ ...resumed.f.freezes.columns.find(field => field.name === "active")!, name: "additional_private_flag", ordinal_position: 7 });
    resumed.input.checkpoint = first.stored();
    expect((await generateModelActionRuleDraft(resumed.input)).state).toBe("ready");
    expect(resumed.chooseOption).toHaveBeenCalledOnce();
    expect(resumed.sourceReviews[0]?.previousReview).toEqual(first.stored().reviewed_private_sources![0]);
    expect(resumed.stored().reviewed_private_sources?.[0]?.proof_digest).not.toBe(first.stored().reviewed_private_sources![0]!.proof_digest);
    const [, , options] = resumed.chooseOption.mock.calls[0] as unknown as Parameters<NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>>;
    expect(options?.exactDetails?.lines.join("\n")).toContain("additional_private_flag");
    expect(JSON.stringify(options?.explanationContext)).not.toContain("additional_private_flag");
  });

  it.each([false, true])("renewed prerequisite consent is durable before complete native refusal or failed save (save fails=%s)", async saveFails => {
    const first = runInput();
    first.requestJson.mockImplementation(nativeAuthoringRefusal);
    await expect(generateModelActionRuleDraft(first.input)).rejects.toMatchObject({ code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    const resumed = runInput();
    resumed.f.freezes.columns.push({ ...resumed.f.freezes.columns.find(field => field.name === "active")!, name: "additional_private_flag", ordinal_position: 7 });
    resumed.input.checkpoint = first.stored();
    if (saveFails) resumed.input.onCheckpoint = async () => { throw new Error("TEST_RENEWAL_SAVE_FAILED"); };
    resumed.requestJson.mockImplementation(nativeAuthoringRefusal);
    if (saveFails) await expect(generateModelActionRuleDraft(resumed.input)).rejects.toThrow("TEST_RENEWAL_SAVE_FAILED");
    else await expect(generateModelActionRuleDraft(resumed.input)).rejects.toMatchObject({ code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    if (saveFails) expect(resumed.requestJson).not.toHaveBeenCalled();
    else {
      const next = runInput(resumed.f);
      next.input.checkpoint = resumed.stored();
      expect((await generateModelActionRuleDraft(next.input)).state).toBe("ready");
      expect(next.chooseOption).not.toHaveBeenCalled();
      expect(resumed.stored().components).toEqual(first.stored().components);
    }
  });

  it("does not allow stale fields to become a ready rule after private admission", async () => {
    const h = runInput();
    h.f.freezes.columns = h.f.freezes.columns.filter(field => field.name !== "active");
    h.requestJson.mockResolvedValueOnce({ status: 200, body: { output: [{ type: "function_call", call_id: "validate", name: "runner__validate_action_draft", arguments: "{}" }] } });
    h.requestJson.mockResolvedValue(pausedResponse);
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("CANCELLED");
    const exchanges = h.requestJson.mock.calls.map(([request]) => JSON.stringify(request.body)).join("\n");
    expect(exchanges).toContain("needs_repair");
    expect(exchanges).not.toContain('"status":"ready_for_review"');
    expect(h.stored().components.rule).toEqual(h.f.checkpoint.components.rule);
  });

  it("does not nominate an explicitly removed dependency from a leftover reviewed relationship name", () => {
    const h = runInput();
    const removed = reviseCheckpoint(h.f.checkpoint, next => { delete next.components.verification; });
    expect(checkpointPrivateSourcePrerequisites(removed, h.input)).toEqual([]);
    expect(removed.reviewed_relationships).toEqual(h.f.checkpoint.reviewed_relationships);
  });

  it.each([{ pendingIntents: [] }, { pendingIntents: ["Prepare only the unrelated retained outcome."] }])("does not resurrect an outcome absent from the current retained job (%j)", async ({ pendingIntents }) => {
    const h = runInput();
    h.input.pendingIntents = pendingIntents;
    await expect(generateModelActionRuleDraft(h.input)).rejects.toThrow("no longer the current retained job");
    expect(h.sourceReviews).toEqual([]);
    expect(h.chooseOption).not.toHaveBeenCalled();
    expect(h.requestJson).not.toHaveBeenCalled();
    expect(h.stored()).toEqual(h.f.checkpoint);
  });

  it("uses exact structure, not insurance or conventional identity names", async () => {
    const original = savedJob();
    const renamed = JSON.parse(JSON.stringify(original).replaceAll("reserve_ops", "service_ops")
      .replaceAll("insurer_id", "group_id").replaceAll("adjuster_id", "agent_id")
      .replaceAll("portfolio_id", "workset_id").replaceAll("portfolios", "worksets")
      .replaceAll("claims", "allocations").replaceAll("freezes", "locks")) as ReturnType<typeof savedJob>;
    renamed.readResource = original.readResource;
    renamed.boundary.role_posture_fingerprint = rolePostureFingerprint(renamed.inspection);
    renamed.publicBoundary.role_posture_fingerprint = renamed.boundary.role_posture_fingerprint;
    renamed.publicCatalog = buildActionRuleAuthoringCatalog({ boundary: renamed.publicBoundary, inspection: renamed.inspection });
    renamed.checkpoint = reviseCheckpoint(renamed.checkpoint, next => {
      next.context_digest = canonicalJsonDigest({ catalog: renamed.publicCatalog.catalog, read: canonicalJsonDigest(renamed.publicBoundary), baseline: null });
    });
    const h = runInput(renamed), result = await generateModelActionRuleDraft(h.input);
    expect(h.stored().reviewed_private_sources?.[0]).toMatchObject({ resource: "service_ops.locks", parent_resource: "service_ops.worksets",
      relationship: "locks_group_id_agent_id_workset_id_fkey" });
    expect(result.compiled.draft.require).toEqual(renamed.draft.require);
    expect(h.chooseOption).toHaveBeenCalledOnce();
    expect(h.input.readBoundary.pack.resources.map(resource => resource.id)).not.toContain("service_ops.locks");
  });
});
