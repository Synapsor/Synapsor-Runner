import type {
  ActionRuleBooleanExpressionV1,
  ActionRuleScalarTypeSpecV1,
  ActionRuleSpecV1,
  DerivedEffectEnvelopeSpecV1,
  JsonScalar,
  RuleVerificationBoundarySpecV1,
} from "@synapsor/spec";
import type { ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";

export const ACTION_RULE_COMPILER_VERSION = "synapsor.action-rule-compiler.v1" as const;
export const ACTION_RULE_CATALOG_VERSION = "synapsor.action-rule-catalog.v1" as const;
export const COMPILED_ACTION_RULE_VERSION = "synapsor.compiled-action-rule.v1" as const;
export const ACTION_RULE_REGISTRY_VERSION = "synapsor.action-rule-registry.v1" as const;
export const ACTION_RULE_APPROVAL_CLASS_VERSION = "synapsor.action-rule-approval-class.v1" as const;

export type ActionRuleCatalogFieldV1 = {
  name: string;
  type: ActionRuleScalarTypeSpecV1;
  nullable: boolean;
};

export type ActionRuleCatalogResourceV1 = {
  name: string;
  source: string;
  engine: "postgres" | "mysql";
  schema: string;
  table: string;
  primary_key: string;
  tenant_key?: string;
  principal_scope_key?: string;
  version_field?: string;
  storage_engine?: string;
  collation?: string;
  fields: ActionRuleCatalogFieldV1[];
};

export type ActionRuleCatalogRelationshipV1 = {
  name: string;
  from_resource: string;
  to_resource: string;
  local_field: string;
  target_field: string;
  cardinality: "one_to_one" | "many_to_one" | "one_to_many";
  nullable: boolean;
  target_unique: boolean;
};

export type ActionRuleCatalogV1 = {
  schema_version: typeof ACTION_RULE_CATALOG_VERSION;
  generation_lock_fingerprint: `sha256:${string}`;
  resources: ActionRuleCatalogResourceV1[];
  relationships: ActionRuleCatalogRelationshipV1[];
};

export type CompiledRuleBindingV1 = {
  binding: string;
  resource: ActionRuleCatalogResourceV1;
  verification: RuleVerificationBoundarySpecV1["resources"][number];
  relationship?: ActionRuleCatalogRelationshipV1;
};

export type CompiledActionRuleV1 = {
  schema_version: typeof COMPILED_ACTION_RULE_VERSION;
  compiler_version: typeof ACTION_RULE_COMPILER_VERSION;
  name: string;
  outcome: string;
  context: string;
  source: string;
  rule_digest: `sha256:${string}`;
  verification_boundary_digest: `sha256:${string}`;
  effect_envelope_digest: `sha256:${string}`;
  compiled_plan_digest: `sha256:${string}`;
  schema_lock_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  rule: ActionRuleSpecV1;
  verification_boundary: RuleVerificationBoundarySpecV1;
  effect_envelope: DerivedEffectEnvelopeSpecV1;
  target_resource: ActionRuleCatalogResourceV1;
  bindings: CompiledRuleBindingV1[];
  derivation_order: string[];
  derived_types: Record<string, ActionRuleScalarTypeSpecV1>;
  effect_field_types: Record<string, ActionRuleScalarTypeSpecV1>;
  approval_class: string;
  ttl_seconds: number;
  uses: 1;
};

export type ActionRuleFactRowV1 = Record<string, JsonScalar>;

export type ActionRuleFactSetV1 = {
  bindings: Record<string, { rows: ActionRuleFactRowV1[] }>;
  trusted: ({
    tenant: string;
    organization_scope?: never;
  } | {
    tenant?: never;
    organization_scope: { mode: "single_organization"; organization_id: string };
  }) & {
    principal?: string;
    transaction_time: string;
  };
  subject_provenance_digest: `sha256:${string}`;
};

export type EvaluateActionRuleInputV1 = {
  compiled: CompiledActionRuleV1;
  facts: ActionRuleFactSetV1;
  proposal_id: string;
  inputs?: Record<string, unknown>;
};

export type ActionRuleDependencyV1 = {
  binding: string;
  resource: string;
  primary_key: { column: string; value: JsonScalar };
  version?: { column: string; value: JsonScalar };
  row_digest: `sha256:${string}`;
};

export type DerivedActionEffectV1 = {
  operation: "single_row_update" | "single_row_insert";
  source: string;
  resource: string;
  schema: string;
  table: string;
  primary_key: { column: string; value?: JsonScalar };
  tenant_guard?: { column: string; value: JsonScalar };
  organization_scope?: { mode: "single_organization"; organization_id: string };
  principal_scope?: { column: string; value: JsonScalar };
  expected_version?: { column: string; value: JsonScalar };
  version_advance?: { column: string; strategy: "integer_increment" };
  allowed_columns: string[];
  set: Record<string, JsonScalar>;
  deduplication?: {
    components: Array<{ column: string; source: "proposal_id" | "trusted_tenant" | "derived" | "fixed"; value: JsonScalar }>;
  };
  effect_digest: `sha256:${string}`;
};

export type ActionRuleEvaluationV1 =
  | {
    result: "eligible";
    derived: Record<string, JsonScalar>;
    effect: DerivedActionEffectV1;
    dependencies: ActionRuleDependencyV1[];
    verified_facts_digest: `sha256:${string}`;
    dependency_set_digest: `sha256:${string}`;
  }
  | {
    result: "ineligible";
    safe_code: "ACTION_RULE_NOT_ELIGIBLE";
    dependencies: ActionRuleDependencyV1[];
    verified_facts_digest: `sha256:${string}`;
    dependency_set_digest: `sha256:${string}`;
  }
  | {
    result: "unknown";
    safe_code: string;
    reason: string;
    dependencies: ActionRuleDependencyV1[];
    verified_facts_digest: `sha256:${string}`;
    dependency_set_digest: `sha256:${string}`;
  };

export type ActionRuleApprovalPredicateEvaluationV1 =
  | { result: "match" }
  | { result: "no_match" }
  | { result: "unknown"; safe_code: string; reason: string };

export type ActivatedActionRuleV1 = {
  read_boundary_name: string;
  read_boundary_digest: `sha256:${string}`;
  action_boundary_name: string;
  action_boundary_digest: `sha256:${string}`;
  approval_policy_digest: `sha256:${string}`;
  compiled: CompiledActionRuleV1;
  activated_at: string;
};

export type ActionRuleApprovalClassSourceV1 = {
  name: string;
  mode: "human" | "policy";
  rules: Array<{
    outcome: string;
    auto_approve_when?: ActionRuleBooleanExpressionV1;
  }>;
  required_role: string;
  required_approvals: number;
  shared_limits: ActionBoundarySharedLimitV1[];
};

export type ActivatedActionRuleApprovalBindingV1 = {
  outcome: string;
  action_rule_digest: `sha256:${string}`;
  compiled_plan_digest: `sha256:${string}`;
  effect_envelope_digest: `sha256:${string}`;
  auto_approve_when?: ActionRuleBooleanExpressionV1;
};

export type ActivatedActionRuleApprovalClassV1 = {
  schema_version: typeof ACTION_RULE_APPROVAL_CLASS_VERSION;
  name: string;
  mode: "human" | "policy";
  rules: ActivatedActionRuleApprovalBindingV1[];
  required_role: string;
  required_approvals: number;
  shared_limits: ActionBoundarySharedLimitV1[];
  digest: `sha256:${string}`;
};

export type RuntimeActionRuleRegistryV1 = {
  schema_version: typeof ACTION_RULE_REGISTRY_VERSION;
  name: string;
  digest: `sha256:${string}`;
  rules: ActivatedActionRuleV1[];
  approval_classes: ActivatedActionRuleApprovalClassV1[];
};
