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

export type BindingSource = "session" | "environment" | "cloud_session" | "static_dev" | "http_claim";
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
  evidence?: EvidenceRequirementSpec;
  max_rows?: number;
  proposal?: ProposalActionSpec;
  aggregate?: AggregateReadSpec;
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
  rules?: JsonRecord[];
  limits?: ApprovalPolicyLimitSpec[];
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
