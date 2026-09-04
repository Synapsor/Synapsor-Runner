import type {
  ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import type { ActionRuleScalarExpressionV1, ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import { describe, expect, it } from "vitest";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import {
  ACTION_RULE_MODEL_DRAFT_VERSION,
  actionRuleModelDraftFromAuthority,
  actionRuleDraftDiagnostics,
  compileActionRuleModelDraft,
  hasExactActionRowPath,
  type ActionRuleModelDraftV1,
} from "./action-rule-draft.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readDigest = `sha256:${"b".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 8,
  comparison: "exact",
  enum: ["active", "paused"],
};

describe("model-authored Action Rule draft compilation", () => {
  it("permits only uniquely proven related-row targets", () => {
    const built = relatedBuiltCatalog();
    const root = draft().verification.resources[0]!;
    const link = built.catalog.relationships[0]!;
    const related = { binding: "policy", resource: link.to_resource, source: { kind: "relationship" as const, from_binding: root.binding,
      relationship: link.name, direction: "forward" as const }, fields: [] };
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(true);
    link.target_unique = false;
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(false);
    link.target_unique = true;
    link.cardinality = "one_to_many";
    expect(hasExactActionRowPath(related, [root, related], built.catalog)).toBe(false);
  });
  it("resolves trusted mechanics from reviewed metadata and compiles one semantic outcome", () => {
    const result = compileActionRuleModelDraft({
      draft: draft(),
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    expect(result.verification_boundary.resources[0]).toMatchObject({
      binding: "account",
      primary_key: "account_id",
      version_field: "version",
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
      lock: "for_update",
    });
    expect(result.verification_boundary.resources[0]!.fields.map((field) => field.name))
      .toEqual(["account_id", "principal_id", "risk_hold", "status", "tenant_id", "version"]);
    expect(result.effect_envelope).toMatchObject({
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      conflict_key: "version",
      version_advance: { column: "version", strategy: "integer_increment" },
      allowed_fields: [{ name: "status", type: statusType, values: ["paused"] }],
      writeback: { mode: "none", supervised_worker: "disabled" },
    });
    expect(result.loaded.registry.rules).toHaveLength(1);
    expect(result.loaded.registry.rules[0]).toMatchObject({
      read_boundary_name: "billing_read",
      read_boundary_digest: readDigest,
      compiled: { outcome: "billing.pause_account" },
    });
    expect(result.loaded.registry.approval_classes[0]).toMatchObject({
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
    });
  });

  it("canonically fills the only one-row subject target for an UPDATE", () => {
    const attempted = draft();
    delete attempted.effect.target_binding;

    const result = compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    expect(result.draft.effect.target_binding).toBe("account");
    expect(result.effect_envelope.target_binding).toBe("account");
    expect(attempted.effect.target_binding).toBeUndefined();
  });

  it("adds both reviewed relationship keys without asking the model to name join columns", () => {
    const attempted = draft();
    attempted.verification.resources.push({
      binding: "policy",
      resource: "billing.account_policies",
      source: {
        kind: "relationship",
        from_binding: "account",
        relationship: "accounts_policy_fk",
        direction: "forward",
      },
      fields: ["allow_pause"],
    });
    attempted.require = {
      kind: "all",
      expressions: [
        attempted.require,
        {
          kind: "compare",
          operator: "eq",
          left: { kind: "field", binding: "policy", field: "allow_pause" },
          right: { kind: "literal", value: true, value_type: { kind: "boolean" } },
        },
      ],
    };

    const result = compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: relatedBuiltCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    const account = result.verification_boundary.resources.find((resource) => resource.binding === "account")!;
    const policy = result.verification_boundary.resources.find((resource) => resource.binding === "policy")!;
    expect(attempted.verification.resources[0]!.fields).not.toContain("policy_id");
    expect(attempted.verification.resources[1]!.fields).not.toContain("policy_id");
    expect(account.fields.map((field) => field.name)).toContain("policy_id");
    expect(policy.fields.map((field) => field.name)).toContain("policy_id");
  });

  it("reconstructs a model-safe edit baseline without trusted scope or lock mechanics", () => {
    const original = draft();
    const compiled = compileActionRuleModelDraft({
      draft: original,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });

    const reconstructed = actionRuleModelDraftFromAuthority({
      authority: compiled.loaded.authority,
      outcome: original.outcome,
      review: compiled.review,
    });

    const recompiled = compileActionRuleModelDraft({
      draft: reconstructed,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      activatedAt: "2026-09-03T01:00:00.000Z",
    });
    expect(recompiled.loaded.authority.digest).toBe(compiled.loaded.authority.digest);
    expect(reconstructed.outcome).toBe(original.outcome);
    expect(reconstructed.effect).toEqual(expect.objectContaining({
      operation: original.effect.operation,
      target_resource: original.effect.target_resource,
      target_binding: original.effect.target_binding,
    }));
    expect(JSON.stringify(reconstructed)).not.toContain("tenant_id");
    expect(JSON.stringify(reconstructed)).not.toContain("principal_id");
    expect(JSON.stringify(reconstructed)).not.toContain("generation_lock_fingerprint");
    expect(JSON.stringify(reconstructed)).not.toContain("for_update");
  });

  it("refuses a model attempt to write a trusted guard field", () => {
    const attempted = draft();
    attempted.effect.allowed_fields = [{ name: "tenant_id" }];
    attempted.effect.set = {
      tenant_id: { kind: "trusted", binding: "tenant" },
    };
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/tenant_id is not a reviewed writable Action Rule field/u);
  });

  it("returns machine-readable compiler diagnostics for bounded model repair", () => {
    const attempted = draft();
    attempted.require = {
      kind: "compare",
      operator: "gt",
      left: { kind: "field", binding: "account", field: "status" },
      right: literal("active"),
    };
    let diagnostics: ReturnType<typeof actionRuleDraftDiagnostics> = [];
    try {
      compileActionRuleModelDraft({
        draft: attempted,
        builtCatalog: builtCatalog(),
        readBoundary: boundary(),
        readBoundaryDigest: readDigest,
      });
    } catch (error) {
      diagnostics = actionRuleDraftDiagnostics(error);
    }
    expect(diagnostics).toEqual([expect.objectContaining({
      code: "ACTION_RULE_TYPE_MISMATCH",
      repair: "model",
      path: "rule.require",
    })]);
  });

  it("reports an exact bounded diagnostic before canonical hashing sees undefined model data", () => {
    const attempted = draft();
    attempted.derive = {
      invalid: {
        kind: "literal",
        value: undefined,
        value_type: stringId,
      } as unknown as ActionRuleScalarExpressionV1,
    };
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/rule\.derive\.invalid\.value must not contain an undefined value/u);
  });

  it("rejects a model name that the portable compiler cannot treat as a qualified outcome", () => {
    const attempted = draft();
    attempted.name = "pause-account";
    expect(() => compileActionRuleModelDraft({
      draft: attempted,
      builtCatalog: builtCatalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).toThrow(/dot-qualified fixed name/u);
  });
});

function draft(): ActionRuleModelDraftV1 {
  return {
    schema_version: ACTION_RULE_MODEL_DRAFT_VERSION,
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    verification: {
      name: "billing.pause_account_verification",
      resources: [{
        binding: "account",
        resource: "billing.accounts",
        source: { kind: "subject_ref" },
        fields: ["status", "risk_hold"],
      }],
    },
    effect: {
      name: "billing.pause_account_effect",
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      allowed_fields: [{ name: "status", values: ["paused"] }],
      set: { status: literal("paused") },
      writeback: "proposal_only",
    },
    require: {
      kind: "all",
      expressions: [
        { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "status" }, right: literal("active") },
        { kind: "compare", operator: "eq", left: { kind: "field", binding: "account", field: "risk_hold" }, right: { kind: "literal", value: false, value_type: { kind: "boolean" } } },
      ],
    },
    derive: {},
    approval: {
      class_name: "billing.human_pause",
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: [],
    },
    ttl_seconds: 300,
    review: {
      when: "The account is active and has no risk hold.",
      then: "Propose setting the account status to paused.",
      refused: ["The account is already paused.", "A risk hold exists."],
      human_review: "Every eligible proposal requires one billing reviewer.",
      examples: [
        { kind: "eligible", scenario: "Active account without a hold", result: "Propose paused" },
        { kind: "ineligible", scenario: "Risk hold is present", result: "Refuse" },
      ],
    },
  };
}

function literal(value: "active" | "paused"): ActionRuleScalarExpressionV1 {
  return { kind: "literal", value, value_type: structuredClone(statusType) };
}

function builtCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.accounts",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "accounts",
      primary_key: "account_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "account_id", type: stringId, nullable: false },
        { name: "tenant_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: statusType, nullable: false },
        { name: "risk_hold", type: { kind: "boolean" }, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  return {
    catalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres",
      engine: "postgres",
      read_boundary_name: "billing_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "billing.accounts",
        primary_key: "account_id",
        tenant_scope: "direct",
        tenant_key: "tenant_id",
        principal_scope: "direct",
        principal_key: "principal_id",
        version_candidates: ["version"],
        selected_version_field: "version",
        operations: { update: true, insert: false },
        fields: catalog.resources[0]!.fields.map((field) => ({
          ...field,
          role: ["account_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : field.name === "risk_hold"
              ? "runner_verification_only" as const
              : "model_visible" as const,
          writable: field.name === "status" || field.name === "risk_hold",
          ...(field.type.kind === "string" && field.type.enum ? { enum_source: "schema" as const } : {}),
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: [],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function relatedBuiltCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const built = builtCatalog();
  const accountCatalog = built.catalog.resources[0]!;
  const accountAuthoring = built.authoring.resources[0]!;
  accountCatalog.fields.push({ name: "policy_id", type: stringId, nullable: false });
  accountAuthoring.fields.push({
    name: "policy_id",
    type: stringId,
    nullable: false,
    role: "guard",
    writable: false,
  });
  const policyCatalog: ActionRuleCatalogV1["resources"][number] = {
    name: "billing.account_policies",
    source: "local_postgres",
    engine: "postgres",
    schema: "billing",
    table: "account_policies",
    primary_key: "policy_id",
    tenant_key: "tenant_id",
    principal_scope_key: "principal_id",
    version_field: "version",
    fields: [
      { name: "policy_id", type: stringId, nullable: false },
      { name: "tenant_id", type: stringId, nullable: false },
      { name: "principal_id", type: stringId, nullable: false },
      { name: "allow_pause", type: { kind: "boolean" }, nullable: false },
      { name: "version", type: { kind: "integer" }, nullable: false },
    ],
  };
  built.catalog.resources.push(policyCatalog);
  built.catalog.relationships.push({
    name: "accounts_policy_fk",
    from_resource: "billing.accounts",
    to_resource: "billing.account_policies",
    local_field: "policy_id",
    target_field: "policy_id",
    cardinality: "many_to_one",
    nullable: false,
    target_unique: true,
  });
  built.authoring.resources.push({
    name: policyCatalog.name,
    primary_key: policyCatalog.primary_key,
    tenant_scope: "direct",
    tenant_key: policyCatalog.tenant_key,
    principal_scope: "direct",
    principal_key: policyCatalog.principal_scope_key,
    version_candidates: ["version"],
    selected_version_field: "version",
    operations: { update: false, insert: false },
    fields: policyCatalog.fields.map((field) => ({
      ...field,
      role: field.name === "allow_pause" ? "runner_verification_only" as const : "guard" as const,
      writable: false,
    })),
  });
  built.authoring.relationships.push(structuredClone(built.catalog.relationships[0]!));
  return built;
}

function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "production",
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    pack: {
      name: "billing_read",
      resources: [{
        id: "billing.accounts",
        schema: "billing",
        table: "accounts",
        primary_key: "account_id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {},
        field_enums: {},
        selectable_fields: ["status"],
        filterable_fields: {},
        sortable_fields: [],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: [],
        time_bucket_fields: {},
        kept_out_fields: ["risk_hold"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 50,
      max_groups: 50,
      max_top_n: 25,
      max_measures: 3,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 500,
      max_response_bytes: 65_536,
      statement_timeout_ms: 3_000,
      max_complexity: 24,
      max_queries_per_session: 1_000,
      max_extracted_cells_per_session: 4_000,
      max_differencing_queries: 16,
      rate_limit_per_minute: 120,
    },
    unresolved_decisions: [],
  };
}
