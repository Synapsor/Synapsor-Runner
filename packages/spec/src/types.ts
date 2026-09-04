export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type ExtensionValue = JsonValue;
export type ExtensionFields = Record<`x-cloud-${string}` | `x-experimental-${string}` | `x-runner-${string}`, ExtensionValue>;

export type SynapsorContract = ExtensionFields & {
  spec_version: "0.1";
  kind: "SynapsorContract";
  metadata?: ContractMetadata;
  resources?: ResourceSpec[];
  contexts: AgentContextSpec[];
  capabilities: CapabilitySpec[];
  workflows?: WorkflowSpec[];
  policies?: PolicySpec[];
  evidence?: EvidenceSpec[];
  proposals?: ProposalSpec[];
  receipts?: ReceiptSpec[];
  replay?: ReplaySpec[];
  external_actions?: ExternalActionSpec[];
  verification_boundaries?: RuleVerificationBoundarySpecV1[];
  derived_effect_envelopes?: DerivedEffectEnvelopeSpecV1[];
  action_rules?: ActionRuleSpecV1[];
};

export type ContractMetadata = ExtensionFields & {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
};

export type SourceEngine = "postgres" | "mysql" | "synapsor";
export type ResourceSpec = ExtensionFields & {
  name: string;
  engine: SourceEngine;
  schema: string;
  table: string;
  type?: "table" | "view" | "external_source";
  primary_key: string;
  tenant_key?: string;
  conflict_key?: string;
  single_tenant_dev?: boolean;
};

export type BindingSource =
  | "session"
  | "environment"
  | "cloud_session"
  | "static_dev"
  | "http_claim"
  | "reviewed_organization";
export type ContextBindingSpec = ExtensionFields & {
  name: string;
  source: BindingSource;
  key: string;
  required?: boolean;
};

export type AgentContextSpec = ExtensionFields & {
  name: string;
  description?: string;
  bindings: ContextBindingSpec[];
  tenant_binding?: string;
  principal_binding?: string;
};

export type CapabilityKind = "read" | "aggregate_read" | "proposal" | "external_action" | "answer_with_evidence";
export type ScalarArgumentSpec = ExtensionFields & {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
  max_length?: number;
  minimum?: number;
  maximum?: number;
  enum?: JsonScalar[];
};

export type ObjectArrayArgumentSpec = ExtensionFields & {
  type: "object_array";
  description?: string;
  required?: boolean;
  max_items: number;
  fields: Record<string, ScalarArgumentSpec>;
};

export type ArgumentSpec = ScalarArgumentSpec | ObjectArrayArgumentSpec;

export type CapabilitySubjectSpec = ExtensionFields & {
  resource?: string;
  schema?: string;
  table?: string;
  primary_key?: string;
  tenant_key?: string;
  /** Row owner/assignee column bound to the context's required trusted principal binding. */
  principal_scope_key?: string;
  conflict_key?: string;
  single_tenant_dev?: boolean;
};

export type EvidenceRequirementSpec = ExtensionFields & {
  required: boolean;
  sources?: string[];
  query_audit?: boolean;
  handle_prefix?: string;
};

export type PatchBindingSpec = ExtensionFields & {
  fixed?: JsonScalar;
  from_arg?: string;
  from_item?: string;
};

/**
 * Portable scalar types supported by the reviewed Action Rule evaluator.
 * Financial values are integer minor units; JavaScript floating-point money
 * is deliberately outside this authority language.
 */
export type ActionRuleScalarTypeSpecV1 = ExtensionFields & (
  | { kind: "boolean" }
  | { kind: "integer"; unit?: string }
  | { kind: "money_minor"; currency: string }
  | { kind: "string"; max_length: number; enum?: string[]; comparison: "exact" }
  | { kind: "date" }
  | { kind: "timestamp" }
);

export type ActionRuleScalarExpressionV1 = ExtensionFields & (
  | { kind: "input"; name: string }
  | {
    kind: "literal";
    value: JsonScalar;
    value_type: ActionRuleScalarTypeSpecV1;
  }
  | {
    kind: "trusted";
    binding: "tenant" | "organization" | "principal" | "transaction_time";
  }
  | {
    kind: "field";
    binding: string;
    field: string;
  }
  | {
    kind: "derived";
    name: string;
  }
  | {
    kind: "aggregate";
    operation: "count" | "sum" | "min" | "max";
    binding: string;
    field?: string;
  }
  | {
    kind: "math";
    operation: "add" | "subtract" | "min" | "max";
    inputs: ActionRuleScalarExpressionV1[];
  }
  | {
    kind: "scale";
    operation: "multiply" | "divide";
    input: ActionRuleScalarExpressionV1;
    constant: number;
    rounding: "floor" | "ceiling" | "half_even";
  }
  | {
    kind: "clamp";
    input: ActionRuleScalarExpressionV1;
    minimum: ActionRuleScalarExpressionV1;
    maximum: ActionRuleScalarExpressionV1;
  }
  | {
    kind: "add_duration";
    timestamp: ActionRuleScalarExpressionV1;
    seconds: number;
  }
);

export type ActionRuleBooleanExpressionV1 = ExtensionFields & (
  | {
    kind: "all" | "any";
    expressions: ActionRuleBooleanExpressionV1[];
  }
  | {
    kind: "not";
    expression: ActionRuleBooleanExpressionV1;
  }
  | {
    kind: "compare";
    operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
    left: ActionRuleScalarExpressionV1;
    right: ActionRuleScalarExpressionV1;
  }
  | {
    kind: "null_check";
    operator: "is_null" | "is_not_null";
    value: ActionRuleScalarExpressionV1;
  }
  | {
    kind: "in";
    value: ActionRuleScalarExpressionV1;
    values: ActionRuleScalarExpressionV1[];
  }
  | {
    kind: "exists";
    binding: string;
    where: ActionRuleBooleanExpressionV1;
  }
);

export type RuleVerificationFieldSpecV1 = ExtensionFields & {
  name: string;
  type: ActionRuleScalarTypeSpecV1;
  nullable?: boolean;
  model_visible?: boolean;
};

export type RuleVerificationScopeSpecV1 = ExtensionFields & (
  | {
    mode: "columns";
    tenant_field: string;
    principal_field?: string;
  }
  | {
    mode: "inherited";
    from_binding: string;
  }
  | {
    mode: "single_organization";
    organization_id: string;
    principal_field?: string;
  }
);

export type RuleVerificationBindingSourceSpecV1 = ExtensionFields & (
  | { kind: "subject_ref" }
  | {
    kind: "relationship";
    from_binding: string;
    relationship: string;
    local_field: string;
    target_field: string;
    direction: "forward" | "inverse";
  }
);

export type RuleVerificationResourceSpecV1 = ExtensionFields & {
  binding: string;
  resource: string;
  source: RuleVerificationBindingSourceSpecV1;
  primary_key: string;
  version_field?: string;
  fields: RuleVerificationFieldSpecV1[];
  scope: RuleVerificationScopeSpecV1;
  cardinality: "one" | "many";
  max_rows: number;
  overflow: "ineligible" | "unsupported";
  deterministic_order?: Array<{ field: string; direction: "asc" | "desc" }>;
  lock: "for_update";
};

export type RuleVerificationBoundarySpecV1 = ExtensionFields & {
  schema_version: "synapsor.verification-boundary.v1";
  name: string;
  source: string;
  context: string;
  generation_lock_fingerprint: `sha256:${string}`;
  resources: RuleVerificationResourceSpecV1[];
  lock_order: string[];
  transaction: {
    isolation: "read_committed" | "repeatable_read" | "serializable";
    timezone: "UTC";
  };
};

export type DerivedEffectFieldSpecV1 = ExtensionFields & {
  name: string;
  type: ActionRuleScalarTypeSpecV1;
  minimum?: number;
  maximum?: number;
  values?: JsonScalar[];
};

export type DerivedEffectEnvelopeSpecV1 = ExtensionFields & {
  schema_version: "synapsor.derived-effect-envelope.v1";
  name: string;
  source: string;
  operation: "update" | "insert";
  target_resource: string;
  target_binding?: string;
  primary_key: string;
  tenant_key?: string;
  organization_scope?: ProtectedReadOrganizationScopeSpec;
  principal_scope_key?: string;
  conflict_key?: string;
  max_rows: 1;
  allowed_fields: DerivedEffectFieldSpecV1[];
  version_advance?: {
    column: string;
    strategy: "integer_increment";
  };
  deduplication?: {
    components: Array<{
      column: string;
      source: "proposal_id" | "trusted_tenant" | "derived" | "fixed";
      derived?: string;
      fixed?: JsonScalar;
    }>;
  };
  approval_classes: string[];
  writeback: {
    mode: "none" | "direct_sql";
    supervised_worker: "disabled" | "allowed";
  };
};

export type ActionRuleSubjectSpecV1 = ExtensionFields & {
  binding: string;
  resource: string;
  input: "opaque_subject_ref";
};

export type ActionRuleInputSpecV1 = {
  name: string;
  description: string;
  type: ActionRuleScalarTypeSpecV1;
  minimum?: number;
  maximum?: number;
};

export type ActionRuleSpecV1 = ExtensionFields & {
  schema_version: "synapsor.action-rule.v1";
  name: string;
  outcome: string;
  context: string;
  source: string;
  verification_boundary_ref: string;
  effect_envelope_ref: string;
  subjects: ActionRuleSubjectSpecV1[];
  inputs?: ActionRuleInputSpecV1[];
  require: ActionRuleBooleanExpressionV1;
  derive: Record<string, ActionRuleScalarExpressionV1>;
  effect: {
    operation: "update" | "insert";
    target_resource: string;
    target_binding?: string;
    set: Record<string, ActionRuleScalarExpressionV1>;
  };
  approval_class: string;
  ttl_seconds: number;
};

export type ProposalOperationKind = "update" | "insert" | "delete";
export type DeduplicationComponentSpec = ExtensionFields & {
  column: string;
  source: "proposal_id" | "trusted_tenant" | "fixed" | "item_field";
  fixed?: JsonScalar;
  item_field?: string;
};
export type FixedPredicateTermSpec = ExtensionFields & {
  column: string;
  operator: "eq";
  value: JsonScalar;
};
export type AggregateBoundSpec = ExtensionFields & {
  column: string;
  measure: "before" | "after" | "absolute_delta";
  maximum: number;
};
export type SetOperationSpec = ExtensionFields & {
  all: FixedPredicateTermSpec[];
};
export type BatchInsertSpec = ExtensionFields & {
  items_from_arg: string;
};
export type ProposalOperationSpec = ExtensionFields & {
  kind: ProposalOperationKind;
  cardinality?: "single" | "set";
  selection?: SetOperationSpec;
  max_rows?: number;
  aggregate_bounds?: AggregateBoundSpec[];
  batch?: BatchInsertSpec;
  deduplication?: {
    components: DeduplicationComponentSpec[];
  };
  version_advance?: {
    column: string;
    strategy: "integer_increment" | "database_generated";
  };
};

export type ProposalActionSpec = ExtensionFields & {
  action: string;
  /**
   * A reviewed assertion that the complete source belongs to one organization.
   * This supplies trusted proposal/accounting identity without inventing a
   * physical tenant column. Executable writeback requires separate authority.
   */
  organization_scope?: ProtectedReadOrganizationScopeSpec;
  /** Omitted by legacy contracts and interpreted as guarded single-row UPDATE. */
  operation?: ProposalOperationSpec;
  allowed_fields: string[];
  patch: Record<string, PatchBindingSpec>;
  numeric_bounds?: Record<string, { minimum?: number; maximum?: number }>;
  transition_guards?: Record<string, { from_column?: string; allowed: Record<string, string[]> }>;
  reversibility?: {
    mode: "reviewed_inverse";
  };
  conflict_guard?: { column?: string; weak_guard_ack?: boolean };
  approval?: {
    mode?: "human" | "operator" | "policy";
    required_role?: string;
    required_approvals?: number;
    policy?: string;
  };
  execution?: {
    supervised_worker: "allowed";
  };
  writeback?: {
    mode: "direct_sql" | "app_handler" | "cloud_worker" | "none";
    executor?: string;
    idempotency_key?: string;
  };
};

export type AggregateReadSpec = ExtensionFields & {
  function: "count" | "sum" | "avg";
  /** COUNT only: rows uses COUNT(*); non_null counts the fixed column. */
  count_mode?: "rows" | "non_null";
  column?: string;
  selection?: SetOperationSpec;
  minimum_group_size: number;
};

export type ProtectedReadValueSpec = ExtensionFields & (
  | { fixed: JsonScalar }
  | { from_arg: string }
);

export type ProtectedReadPredicateSpec = ExtensionFields & (
  | {
    field: string;
    relationship?: string;
    operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
    value: ProtectedReadValueSpec;
  }
  | {
    field: string;
    relationship?: string;
    operator: "in";
    values: JsonScalar[];
  }
);

export type ProtectedReadRelationshipSpec = ExtensionFields & {
  name: string;
  schema: string;
  table: string;
  primary_key: string;
  tenant_key?: string;
  principal_scope_key?: string;
  local_key: string;
  target_key: string;
  cardinality: "many_to_one";
  max_fan_out: 1;
};

export type ProtectedReadRelationshipLinkSpec = ExtensionFields & {
  schema: string;
  table: string;
  primary_key: string;
  tenant_key?: string;
  principal_scope_key?: string;
  local_key: string;
  target_key: string;
  cardinality: "many_to_one";
  max_fan_out: 1;
  unmatched_rows: "exclude" | "keep_null";
};

export type ProtectedReadRelationshipPathSpec = ExtensionFields & {
  name: string;
  links: ProtectedReadRelationshipLinkSpec[];
};

export type ProtectedReadBaseMeasureSpec = ExtensionFields & {
  function: "count" | "count_distinct" | "sum" | "avg";
  field?: string;
  relationship?: string;
};

export type ProtectedReadPostAggregateOperation =
  | "running_total"
  | "rank"
  | "lag_absolute_change"
  | "lag_percentage_change"
  | "moving_average"
  | "share_of_released_total";

export type ProtectedReadDerivedMeasureSpec = ExtensionFields & (
  | {
    shape: "ratio" | "percentage" | "per_unit_average";
    numerator: ProtectedReadBaseMeasureSpec;
    denominator: ProtectedReadBaseMeasureSpec;
    null_policy: "null_on_zero_or_null_denominator";
  }
  | {
    shape: ProtectedReadPostAggregateOperation;
    base_measure: ProtectedReadBaseMeasureSpec;
    direction?: "asc" | "desc";
    window_size?: number;
  }
);

export type ProtectedReadMeasureSpec = ExtensionFields & {
  name: string;
  function:
    | "count"
    | "count_distinct"
    | "sum"
    | "avg"
    | "stddev_samp"
    | "stddev_pop"
    | "var_samp"
    | "var_pop"
    | "null_count"
    | "non_null_count"
    | "completion_rate"
    | "reviewed_derived";
  field?: string;
  relationship?: string;
  derived?: ProtectedReadDerivedMeasureSpec;
};

export type ProtectedReadDimensionSpec = ExtensionFields & {
  name: string;
  field: string;
  relationship?: string;
  numeric_band?: {
    edges: number[];
    bucket_labels: string[];
  };
};

export type ProtectedReadTimeBucketSpec = ExtensionFields & {
  name: string;
  field: string;
  bucket: "hour" | "day" | "week" | "month" | "quarter" | "year" | "day_of_week";
  relationship?: string;
};

export type ProtectedReadTimeWindowSpec = ExtensionFields & {
  field: string;
  relationship?: string;
  /** Frozen UTC ISO instant captured when the reviewed Explore analysis ran. */
  start: string;
  /** Exclusive frozen UTC ISO instant captured when the reviewed Explore analysis ran. */
  end: string;
};

export type ProtectedReadAggregateSpec = ExtensionFields & {
  counted_entity: "subject";
  measures: ProtectedReadMeasureSpec[];
  dimensions?: ProtectedReadDimensionSpec[];
  time_bucket?: ProtectedReadTimeBucketSpec;
  comparison?: {
    field: string;
    relationship?: string;
    ranges: Array<{
      start: ProtectedReadValueSpec;
      end: ProtectedReadValueSpec;
    }>;
  };
  order_by?: (
    | { kind: "measure"; measure: string; direction: "asc" | "desc" }
    | { kind: "comparison_change"; measure: string; change: "absolute" | "percentage"; direction: "asc" | "desc" }
    | { kind: "time_bucket"; direction: "asc" | "desc" }
  );
  top_n: number;
  minimum_group_size: number;
};

export type ProtectedReadLimitsSpec = ExtensionFields & {
  max_rows: number;
  max_groups: number;
  max_ranked_groups?: number;
  max_response_cells: number;
  max_response_bytes: number;
  statement_timeout_ms: number;
  max_queries_per_session: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  rate_limit_per_minute: number;
};

export type ProtectedReadOrganizationScopeSpec = ExtensionFields & {
  mode: "single_organization";
  organization_id: string;
  acknowledgement: "all_rows_belong_to_one_organization";
};

/**
 * A digest-bound named read produced by Protect This Query.
 *
 * This is a frozen authority shape, not an ad hoc query AST: identifiers,
 * relationships, operators, ordering, privacy limits, and result bounds are
 * fixed by the reviewed contract. Only explicit `from_arg` value positions can
 * vary at runtime, and those arguments retain the capability's normal type and
 * bound validation.
 */
export type ProtectedReadSpec = ExtensionFields & {
  version: "1";
  mode: "rows" | "aggregate";
  boundary_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  organization_scope?: ProtectedReadOrganizationScopeSpec;
  predicates?: ProtectedReadPredicateSpec[];
  /**
   * Legacy one-hop form. It remains canonical when present so existing
   * protected contracts retain their exact normalized bytes and digest.
   */
  relationship?: ProtectedReadRelationshipSpec;
  /**
   * Additive reviewed bounded-path form. Every path and link is fixed by
   * human-reviewed authority; runtime plans may reference names only.
   */
  relationships?: ProtectedReadRelationshipPathSpec[];
  /**
   * A fixed half-open time predicate. Protect freezes resolved relative windows
   * here; it never turns them into dynamic model arguments.
   */
  time_window?: ProtectedReadTimeWindowSpec;
  row_order_by?: Array<{
    field: string;
    direction: "asc" | "desc";
  }>;
  aggregate?: ProtectedReadAggregateSpec;
  limits: ProtectedReadLimitsSpec;
};

export type CapabilitySpec = ExtensionFields & {
  name: string;
  description?: string;
  returns_hint?: string;
  kind: CapabilityKind;
  context: string;
  source?: string;
  subject: CapabilitySubjectSpec;
  args: Record<string, ArgumentSpec>;
  lookup?: { id_from_arg: string };
  visible_fields: string[];
  kept_out_fields?: string[];
  model_withheld_fields?: string[];
  evidence?: EvidenceRequirementSpec;
  max_rows?: number;
  proposal?: ProposalActionSpec;
  aggregate?: AggregateReadSpec;
  protected_read?: ProtectedReadSpec;
};

export type WorkflowSpec = ExtensionFields & {
  name: string;
  description?: string;
  context: string;
  allowed_capabilities: string[];
  required_evidence?: boolean;
  approval?: { required?: boolean; role?: string };
  settlement?: { mode: "manual" | "auto_if_green" | "block"; policy?: string };
  replay?: { checkpoint: "none" | "every_step" | "proposal_only" };
};

export type PolicySpec = ExtensionFields & {
  name: string;
  kind: "approval" | "settlement" | "scope" | "custom";
  mode?: "green" | "yellow" | "red" | "manual" | "block";
  rules?: ApprovalPolicyRuleSpec[];
  limits?: ApprovalPolicyLimitSpec[];
};

export type ApprovalPolicyRuleSpec = ExtensionFields & {
  /** Defaults to patch. before reads only the immutable pre-change snapshot. */
  source?: "patch" | "before";
  field: string;
  /** Legacy integer ceilings use max without operator/value. */
  max?: number;
  operator?: "lte" | "gte" | "eq" | "in" | "max_length";
  value?: JsonScalar;
  values?: JsonScalar[];
};

export type ApprovalPolicyLimitSpec = ExtensionFields & {
  kind: "count" | "total";
  max: number;
  period: "day";
  field?: string;
  scope?: "tenant_policy" | "tenant_policy_object";
};

export type EvidenceSpec = ExtensionFields & {
  handle: string;
  capability?: string;
  query_fingerprint?: string;
  items?: JsonRecord[];
};

export type ProposalSpec = ExtensionFields & {
  id: string;
  capability: string;
  subject: { type?: string; id: string; tenant_id?: string };
  status: "pending" | "approved" | "rejected" | "canceled" | "applied" | "conflict" | "failed";
  diff?: { before?: JsonRecord; patch?: JsonRecord; after?: JsonRecord };
  evidence_handle?: string;
};

export type ReceiptSpec = ExtensionFields & {
  id: string;
  proposal_id: string;
  status: "applied" | "already_applied" | "conflict" | "failed" | "canceled";
  idempotency_key?: string;
  source_database_mutated: boolean;
  rows_affected?: number;
};

export type ReplaySpec = ExtensionFields & {
  id: string;
  proposal_id?: string;
  run_id?: string;
  events: JsonRecord[];
};

export type ExternalActionSpec = ExtensionFields & {
  id: string;
  action: string;
  handler?: string;
  idempotency_key?: string;
  receipt?: string;
};

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};
