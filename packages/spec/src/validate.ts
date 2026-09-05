import { SPEC_VERSION } from "./version.js";
import type { CapabilitySpec, JsonScalar, ProposalActionSpec, SynapsorContract, ValidationIssue, ValidationResult } from "./types.js";
import { SynapsorSpecValidationError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = new Set([
  "spec_version",
  "kind",
  "metadata",
  "resources",
  "contexts",
  "capabilities",
  "workflows",
  "policies",
  "evidence",
  "proposals",
  "receipts",
  "replay",
  "external_actions",
  "verification_boundaries",
  "derived_effect_envelopes",
  "action_rules",
]);
const METADATA_KEYS = new Set(["name", "description", "version", "tags"]);
const RESOURCE_KEYS = new Set(["name", "engine", "schema", "table", "type", "primary_key", "tenant_key", "conflict_key", "single_tenant_dev"]);
const CONTEXT_KEYS = new Set(["name", "description", "bindings", "tenant_binding", "principal_binding"]);
const BINDING_KEYS = new Set(["name", "source", "key", "required"]);
const CAPABILITY_KEYS = new Set(["name", "description", "returns_hint", "kind", "context", "source", "subject", "args", "lookup", "visible_fields", "kept_out_fields", "model_withheld_fields", "evidence", "max_rows", "proposal", "aggregate", "protected_read"]);
const SUBJECT_KEYS = new Set(["resource", "schema", "table", "primary_key", "tenant_key", "principal_scope_key", "conflict_key", "single_tenant_dev"]);
const ARG_KEYS = new Set(["type", "description", "required", "max_length", "minimum", "maximum", "enum", "max_items", "fields"]);
const LOOKUP_KEYS = new Set(["id_from_arg"]);
const EVIDENCE_KEYS = new Set(["required", "sources", "query_audit", "handle_prefix"]);
const PROPOSAL_KEYS = new Set(["action", "organization_scope", "operation", "allowed_fields", "patch", "numeric_bounds", "transition_guards", "reversibility", "conflict_guard", "approval", "execution", "writeback"]);
const OPERATION_KEYS = new Set(["kind", "cardinality", "selection", "max_rows", "aggregate_bounds", "batch", "deduplication", "version_advance"]);
const SELECTION_KEYS = new Set(["all"]);
const PREDICATE_TERM_KEYS = new Set(["column", "operator", "value"]);
const AGGREGATE_BOUND_KEYS = new Set(["column", "measure", "maximum"]);
const BATCH_KEYS = new Set(["items_from_arg"]);
const DEDUPLICATION_KEYS = new Set(["components"]);
const DEDUPLICATION_COMPONENT_KEYS = new Set(["column", "source", "fixed", "item_field"]);
const VERSION_ADVANCE_KEYS = new Set(["column", "strategy"]);
const PATCH_KEYS = new Set(["fixed", "from_arg", "from_item"]);
const SET_MAX_ROWS_HARD_CEILING = 100;
const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);
const TRANSITION_GUARD_KEYS = new Set(["from_column", "allowed"]);
const CONFLICT_GUARD_KEYS = new Set(["column", "weak_guard_ack"]);
const APPROVAL_KEYS = new Set(["mode", "required_role", "required_approvals", "policy"]);
const EXECUTION_KEYS = new Set(["supervised_worker"]);
const WRITEBACK_KEYS = new Set(["mode", "executor", "idempotency_key"]);
const REVERSIBILITY_KEYS = new Set(["mode"]);
const AGGREGATE_READ_KEYS = new Set(["function", "count_mode", "column", "selection", "minimum_group_size"]);
const PROTECTED_READ_KEYS = new Set([
  "version",
  "mode",
  "boundary_digest",
  "generation_lock_fingerprint",
  "organization_scope",
  "predicates",
  "relationship",
  "relationships",
  "time_window",
  "row_order_by",
  "aggregate",
  "limits",
]);
const PROTECTED_ORGANIZATION_SCOPE_KEYS = new Set([
  "mode",
  "organization_id",
  "acknowledgement",
]);
const PROTECTED_VALUE_KEYS = new Set(["fixed", "from_arg"]);
const PROTECTED_PREDICATE_KEYS = new Set(["field", "relationship", "operator", "value", "values"]);
const PROTECTED_RELATIONSHIP_KEYS = new Set([
  "name",
  "schema",
  "table",
  "primary_key",
  "tenant_key",
  "principal_scope_key",
  "local_key",
  "target_key",
  "cardinality",
  "max_fan_out",
]);
const PROTECTED_RELATIONSHIP_PATH_KEYS = new Set(["name", "links"]);
const PROTECTED_RELATIONSHIP_LINK_KEYS = new Set([
  "schema",
  "table",
  "primary_key",
  "tenant_key",
  "principal_scope_key",
  "local_key",
  "target_key",
  "cardinality",
  "max_fan_out",
  "unmatched_rows",
]);
const PROTECTED_ROW_ORDER_KEYS = new Set(["field", "direction"]);
const PROTECTED_AGGREGATE_KEYS = new Set([
  "counted_entity",
  "measures",
  "dimensions",
  "time_bucket",
  "comparison",
  "order_by",
  "top_n",
  "minimum_group_size",
]);
const PROTECTED_MEASURE_KEYS = new Set(["name", "function", "field", "relationship", "derived"]);
const PROTECTED_RATIO_DERIVED_MEASURE_KEYS = new Set(["shape", "numerator", "denominator", "null_policy"]);
const PROTECTED_POST_DERIVED_MEASURE_KEYS = new Set(["shape", "base_measure", "direction", "window_size"]);
const PROTECTED_DERIVED_OPERAND_KEYS = new Set(["function", "field", "relationship"]);
const PROTECTED_POST_AGGREGATE_SHAPES = new Set([
  "running_total",
  "rank",
  "lag_absolute_change",
  "lag_percentage_change",
  "moving_average",
  "share_of_released_total",
]);
const PROTECTED_SEQUENTIAL_AGGREGATE_SHAPES = new Set([
  "running_total",
  "lag_absolute_change",
  "lag_percentage_change",
  "moving_average",
]);
const PROTECTED_DIMENSION_KEYS = new Set(["name", "field", "relationship", "numeric_band"]);
const PROTECTED_NUMERIC_BAND_KEYS = new Set(["edges", "bucket_labels"]);
const PROTECTED_TIME_BUCKET_KEYS = new Set(["name", "field", "bucket", "relationship"]);
const PROTECTED_TIME_WINDOW_KEYS = new Set(["field", "relationship", "start", "end"]);
const PROTECTED_COMPARISON_KEYS = new Set(["field", "relationship", "ranges"]);
const PROTECTED_RANGE_KEYS = new Set(["start", "end"]);
const PROTECTED_AGGREGATE_ORDER_KEYS = new Set(["kind", "measure", "change", "direction"]);
const PROTECTED_LIMIT_KEYS = new Set([
  "max_rows",
  "max_groups",
  "max_ranked_groups",
  "max_response_cells",
  "max_response_bytes",
  "statement_timeout_ms",
  "max_queries_per_session",
  "max_extracted_cells_per_session",
  "max_differencing_queries",
  "rate_limit_per_minute",
]);
const WORKFLOW_KEYS = new Set(["name", "description", "context", "allowed_capabilities", "required_evidence", "approval", "settlement", "replay"]);
const POLICY_KEYS = new Set(["name", "kind", "mode", "rules", "limits"]);
const APPROVAL_POLICY_LIMIT_KEYS = new Set(["kind", "max", "period", "field", "scope"]);
const EVIDENCE_RECORD_KEYS = new Set(["handle", "capability", "query_fingerprint", "items"]);
const PROPOSAL_RECORD_KEYS = new Set(["id", "capability", "subject", "status", "diff", "evidence_handle"]);
const RECEIPT_KEYS = new Set(["id", "proposal_id", "status", "idempotency_key", "source_database_mutated", "rows_affected"]);
const REPLAY_KEYS = new Set(["id", "proposal_id", "run_id", "events"]);
const EXTERNAL_ACTION_KEYS = new Set(["id", "action", "handler", "idempotency_key", "receipt"]);
const VERIFICATION_BOUNDARY_KEYS = new Set(["schema_version", "name", "source", "context", "generation_lock_fingerprint", "resources", "lock_order", "transaction"]);
const VERIFICATION_RESOURCE_KEYS = new Set(["binding", "resource", "source", "primary_key", "version_field", "fields", "scope", "cardinality", "max_rows", "overflow", "deterministic_order", "lock"]);
const VERIFICATION_FIELD_KEYS = new Set(["name", "type", "nullable", "model_visible"]);
const VERIFICATION_SOURCE_KEYS = new Set(["kind", "from_binding", "relationship", "local_field", "target_field", "field_pairs", "direction"]);
const VERIFICATION_SCOPE_KEYS = new Set(["mode", "tenant_field", "principal_field", "from_binding", "organization_id"]);
const VERIFICATION_ORDER_KEYS = new Set(["field", "direction"]);
const VERIFICATION_TRANSACTION_KEYS = new Set(["isolation", "timezone"]);
const EFFECT_ENVELOPE_KEYS = new Set(["schema_version", "name", "source", "operation", "target_resource", "target_binding", "primary_key", "tenant_key", "organization_scope", "principal_scope_key", "conflict_key", "max_rows", "allowed_fields", "version_advance", "deduplication", "approval_classes", "writeback"]);
const EFFECT_FIELD_KEYS = new Set(["name", "type", "minimum", "maximum", "values"]);
const EFFECT_DEDUP_KEYS = new Set(["components"]);
const EFFECT_DEDUP_COMPONENT_KEYS = new Set(["column", "source", "derived", "fixed"]);
const EFFECT_VERSION_ADVANCE_KEYS = new Set(["column", "strategy"]);
const EFFECT_WRITEBACK_KEYS = new Set(["mode", "supervised_worker"]);
const ACTION_RULE_KEYS = new Set(["schema_version", "name", "outcome", "context", "source", "verification_boundary_ref", "effect_envelope_ref", "subjects", "inputs", "require", "derive", "effect", "approval_class", "ttl_seconds"]);
const ACTION_RULE_SUBJECT_KEYS = new Set(["binding", "resource", "input"]);
const ACTION_RULE_EFFECT_KEYS = new Set(["operation", "target_resource", "target_binding", "set"]);
const ACTION_RULE_SCALAR_TYPE_KEYS = new Set(["kind", "unit", "currency", "max_length", "enum", "comparison"]);
const ACTION_RULE_SCALAR_EXPR_KEYS = new Set(["kind", "value", "value_type", "binding", "field", "name", "operation", "inputs", "input", "constant", "rounding", "minimum", "maximum", "timestamp", "seconds"]);
const ACTION_RULE_BOOLEAN_EXPR_KEYS = new Set(["kind", "expressions", "expression", "operator", "left", "right", "value", "values", "binding", "where"]);
const ACTION_RULE_SCALAR_TYPE_VARIANT_KEYS = {
  boolean: new Set(["kind"]),
  integer: new Set(["kind", "unit"]),
  money_minor: new Set(["kind", "currency"]),
  string: new Set(["kind", "max_length", "enum", "comparison"]),
  date: new Set(["kind"]),
  timestamp: new Set(["kind"]),
} as const;
const ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS = {
  input: new Set(["kind", "name"]),
  literal: new Set(["kind", "value", "value_type"]),
  trusted: new Set(["kind", "binding"]),
  field: new Set(["kind", "binding", "field"]),
  derived: new Set(["kind", "name"]),
  aggregate: new Set(["kind", "operation", "binding", "field"]),
  math: new Set(["kind", "operation", "inputs"]),
  scale: new Set(["kind", "operation", "input", "constant", "rounding"]),
  clamp: new Set(["kind", "input", "minimum", "maximum"]),
  add_duration: new Set(["kind", "timestamp", "seconds"]),
} as const;
const ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS = {
  all: new Set(["kind", "expressions"]),
  any: new Set(["kind", "expressions"]),
  not: new Set(["kind", "expression"]),
  compare: new Set(["kind", "operator", "left", "right"]),
  null_check: new Set(["kind", "operator", "value"]),
  in: new Set(["kind", "value", "values"]),
  exists: new Set(["kind", "binding", "where"]),
} as const;

const TRUSTED_ARG_NAMES = new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "principalId",
  "schema",
  "table",
  "column",
  "columns",
  "database_url",
  "write_url",
  "read_url",
  "expected_version",
  "row_version",
]);

export function validateContract(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "CONTRACT_NOT_OBJECT", message: "Contract must be a JSON object." }],
      warnings,
    };
  }

  checkUnknownKeys(input, TOP_LEVEL_KEYS, "$", errors);
  if (input.spec_version !== SPEC_VERSION) {
    errors.push({ path: "$.spec_version", code: "UNSUPPORTED_SPEC_VERSION", message: `spec_version must be ${SPEC_VERSION}.` });
  }
  if (input.kind !== "SynapsorContract") {
    errors.push({ path: "$.kind", code: "INVALID_KIND", message: "kind must be SynapsorContract." });
  }
  validateMetadata(input.metadata, "$.metadata", errors);
  const resourceNames = validateResources(input.resources, errors, warnings);
  const contextNames = validateContexts(input.contexts, errors, warnings);
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  const policies = Array.isArray(input.policies) ? input.policies : [];
  const capabilityNames = validateCapabilities(input.capabilities, contextNames, resourceNames, errors, warnings);
  validatePrincipalScopes(input.capabilities, input.contexts, input.resources, errors);
  validateProtectedOrganizationContexts(input.capabilities, input.contexts, errors);
  validateWorkflows(input.workflows, contextNames, capabilityNames, errors);
  const policyByName = validatePolicies(input.policies, errors);
  validateCapabilityApprovalPolicies(capabilities, policies, policyByName, errors);
  validateEvidenceRecords(input.evidence, errors);
  validateProposalRecords(input.proposals, capabilityNames, errors);
  validateReceiptRecords(input.receipts, errors);
  validateReplay(input.replay, errors);
  validateExternalActions(input.external_actions, errors);
  validateActionRuleAuthority(input, resourceNames, contextNames, errors);
  scanForInlineSecrets(input, "$", errors);

  return { ok: errors.length === 0, errors, warnings };
}

export function assertValidContract(input: unknown): asserts input is SynapsorContract {
  const result = validateContract(input);
  if (!result.ok) throw new SynapsorSpecValidationError(result.errors);
}

function validateMetadata(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "METADATA_NOT_OBJECT", message: "metadata must be an object." });
    return;
  }
  checkUnknownKeys(value, METADATA_KEYS, path, errors);
  if (value.name !== undefined && !isNonEmptyString(value.name)) errors.push({ path: `${path}.name`, code: "INVALID_METADATA_NAME", message: "metadata.name must be a non-empty string." });
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => !isNonEmptyString(tag)))) {
    errors.push({ path: `${path}.tags`, code: "INVALID_METADATA_TAGS", message: "metadata.tags must be an array of non-empty strings." });
  }
}

function validateResources(value: unknown, errors: ValidationIssue[], warnings: ValidationIssue[]): Set<string> {
  const names = new Set<string>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.resources", code: "RESOURCES_NOT_ARRAY", message: "resources must be an array." });
    return names;
  }
  value.forEach((resource, index) => {
    const path = `$.resources[${index}]`;
    if (!isRecord(resource)) {
      errors.push({ path, code: "RESOURCE_NOT_OBJECT", message: "resource must be an object." });
      return;
    }
    checkUnknownKeys(resource, RESOURCE_KEYS, path, errors);
    if (!isQualifiedOrSafeName(resource.name)) errors.push({ path: `${path}.name`, code: "INVALID_RESOURCE_NAME", message: "resource name must be a safe identifier or qualified name." });
    else addUnique(names, resource.name, `${path}.name`, "DUPLICATE_RESOURCE_NAME", errors);
    if (!["postgres", "mysql", "synapsor"].includes(String(resource.engine))) errors.push({ path: `${path}.engine`, code: "INVALID_RESOURCE_ENGINE", message: "engine must be postgres, mysql, or synapsor." });
    for (const key of ["schema", "table", "primary_key"]) {
      if (!isSafeIdentifier(resource[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_RESOURCE_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
    }
    if (resource.tenant_key !== undefined && !isSafeIdentifier(resource.tenant_key)) errors.push({ path: `${path}.tenant_key`, code: "INVALID_TENANT_KEY", message: "tenant_key must be a fixed safe identifier." });
    if (!isSafeIdentifier(resource.tenant_key) && resource.single_tenant_dev !== true) {
      errors.push({ path: `${path}.tenant_key`, code: "TENANT_KEY_REQUIRED", message: "tenant_key is required unless single_tenant_dev is explicitly true." });
    }
    if (resource.single_tenant_dev === true) warnings.push({ path: `${path}.single_tenant_dev`, code: "SINGLE_TENANT_DEV", message: "single_tenant_dev is only for local demos and must not be used for shared tenant data." });
    if (resource.conflict_key !== undefined && !isSafeIdentifier(resource.conflict_key)) errors.push({ path: `${path}.conflict_key`, code: "INVALID_CONFLICT_KEY", message: "conflict_key must be a fixed safe identifier." });
  });
  return names;
}

function validateContexts(value: unknown, errors: ValidationIssue[], warnings: ValidationIssue[]): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.contexts", code: "CONTEXTS_REQUIRED", message: "At least one context is required." });
    return names;
  }
  value.forEach((context, index) => {
    const path = `$.contexts[${index}]`;
    if (!isRecord(context)) {
      errors.push({ path, code: "CONTEXT_NOT_OBJECT", message: "context must be an object." });
      return;
    }
    checkUnknownKeys(context, CONTEXT_KEYS, path, errors);
    if (!isQualifiedOrSafeName(context.name)) errors.push({ path: `${path}.name`, code: "INVALID_CONTEXT_NAME", message: "context name must be a safe identifier or qualified name." });
    else addUnique(names, context.name, `${path}.name`, "DUPLICATE_CONTEXT_NAME", errors);
    if (!Array.isArray(context.bindings) || context.bindings.length === 0) {
      errors.push({ path: `${path}.bindings`, code: "BINDINGS_REQUIRED", message: "context.bindings must contain trusted/session bindings." });
      return;
    }
    const bindingNames = new Set<string>();
    context.bindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path}.bindings[${bindingIndex}]`;
      if (!isRecord(binding)) {
        errors.push({ path: bindingPath, code: "BINDING_NOT_OBJECT", message: "binding must be an object." });
        return;
      }
      checkUnknownKeys(binding, BINDING_KEYS, bindingPath, errors);
      if (!isSafeIdentifier(binding.name)) errors.push({ path: `${bindingPath}.name`, code: "INVALID_BINDING_NAME", message: "binding name must be a safe identifier." });
      else addUnique(bindingNames, binding.name, `${bindingPath}.name`, "DUPLICATE_BINDING_NAME", errors);
      if (!["session", "environment", "cloud_session", "static_dev", "http_claim", "reviewed_organization"].includes(String(binding.source))) errors.push({ path: `${bindingPath}.source`, code: "INVALID_BINDING_SOURCE", message: "binding source must be session, environment, cloud_session, static_dev, http_claim, or reviewed_organization." });
      if (!isNonEmptyString(binding.key)) errors.push({ path: `${bindingPath}.key`, code: "INVALID_BINDING_KEY", message: "binding key must be a non-empty string." });
      if (binding.source === "static_dev") warnings.push({ path: `${bindingPath}.source`, code: "STATIC_DEV_BINDING", message: "static_dev bindings are for local demos only." });
    });
    for (const key of ["tenant_binding", "principal_binding"]) {
      if (context[key] !== undefined && (!isSafeIdentifier(context[key]) || !bindingNames.has(String(context[key])))) {
        errors.push({ path: `${path}.${key}`, code: "UNKNOWN_CONTEXT_BINDING", message: `${key} must reference a binding name.` });
      }
    }
  });
  return names;
}

function validateCapabilities(value: unknown, contextNames: Set<string>, resourceNames: Set<string>, errors: ValidationIssue[], warnings: ValidationIssue[]): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value)) {
    errors.push({ path: "$.capabilities", code: "CAPABILITIES_REQUIRED", message: "capabilities must be an array; an empty array represents zero authority." });
    return names;
  }
  value.forEach((capability, index) => {
    const path = `$.capabilities[${index}]`;
    if (!isRecord(capability)) {
      errors.push({ path, code: "CAPABILITY_NOT_OBJECT", message: "capability must be an object." });
      return;
    }
    checkUnknownKeys(capability, CAPABILITY_KEYS, path, errors);
    if (!isQualifiedName(capability.name)) errors.push({ path: `${path}.name`, code: "INVALID_CAPABILITY_NAME", message: "capability name must be namespace.name." });
    else addUnique(names, capability.name, `${path}.name`, "DUPLICATE_CAPABILITY_NAME", errors);
    if (capability.returns_hint !== undefined && !isNonEmptyString(capability.returns_hint)) errors.push({ path: `${path}.returns_hint`, code: "INVALID_RETURNS_HINT", message: "returns_hint must be a non-empty string." });
    if (!["read", "aggregate_read", "proposal", "external_action", "answer_with_evidence"].includes(String(capability.kind))) errors.push({ path: `${path}.kind`, code: "INVALID_CAPABILITY_KIND", message: "kind must be read, aggregate_read, proposal, external_action, or answer_with_evidence." });
    if (!isNonEmptyString(capability.context) || !contextNames.has(capability.context)) errors.push({ path: `${path}.context`, code: "UNKNOWN_CONTEXT", message: "capability.context must reference a declared context." });
    const proposalOrganizationScope = isRecord(capability.proposal)
      ? capability.proposal.organization_scope
      : undefined;
    const protectedOrganizationScope = isRecord(capability.protected_read)
      ? capability.protected_read.organization_scope
      : undefined;
    validateSubject(
      capability.subject,
      `${path}.subject`,
      resourceNames,
      errors,
      warnings,
      proposalOrganizationScope ?? protectedOrganizationScope,
    );
    const hasProtectedRead = capability.protected_read !== undefined;
    validateArgs(capability.args, `${path}.args`, errors, capability.kind === "aggregate_read" || hasProtectedRead);
    if (capability.lookup !== undefined) validateLookup(capability.lookup, `${path}.lookup`, capability.args, errors);
    validateFieldList(capability.visible_fields, `${path}.visible_fields`, "VISIBLE_FIELDS_REQUIRED", errors, capability.kind === "aggregate_read");
    if (capability.kept_out_fields !== undefined) validateFieldList(capability.kept_out_fields, `${path}.kept_out_fields`, "INVALID_KEPT_OUT_FIELDS", errors, true);
    if (capability.model_withheld_fields !== undefined) {
      validateFieldList(
        capability.model_withheld_fields,
        `${path}.model_withheld_fields`,
        "INVALID_MODEL_WITHHELD_FIELDS",
        errors,
        true,
      );
    }
    validateKeptOutExclusion(capability.visible_fields, capability.kept_out_fields, path, errors);
    validateModelWithheldExclusion(capability.kept_out_fields, capability.model_withheld_fields, path, errors);
    if (capability.evidence !== undefined) validateEvidenceRequirement(capability.evidence, `${path}.evidence`, errors);
    if (capability.max_rows !== undefined && !isPositiveInteger(capability.max_rows)) errors.push({ path: `${path}.max_rows`, code: "INVALID_MAX_ROWS", message: "max_rows must be a positive integer." });
    if (capability.kind === "proposal") {
      validateProposalAction(capability.proposal, capability.subject, `${path}.proposal`, errors);
      validateSetCapabilityArgs(capability, path, errors);
    }
    if (capability.kind !== "proposal" && capability.proposal !== undefined) errors.push({ path: `${path}.proposal`, code: "PROPOSAL_ONLY_FOR_PROPOSAL_KIND", message: "proposal is only valid for proposal capabilities." });
    if (hasProtectedRead) validateProtectedRead(capability, path, errors);
    if (capability.kind === "aggregate_read") {
      if (!hasProtectedRead) validateAggregateRead(capability, path, errors);
      else if (capability.aggregate !== undefined) errors.push({ path: `${path}.aggregate`, code: "LEGACY_AGGREGATE_WITH_PROTECTED_READ", message: "protected aggregate reads use protected_read.aggregate and must not also declare the legacy scalar aggregate field." });
    } else if (capability.aggregate !== undefined) {
      errors.push({ path: `${path}.aggregate`, code: "AGGREGATE_ONLY_FOR_AGGREGATE_READ", message: "aggregate is valid only for aggregate_read capabilities." });
    }
  });
  return names;
}

function validateSetCapabilityArgs(capability: JsonRecord, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(capability.proposal) || !isRecord(capability.proposal.operation) || capability.proposal.operation.cardinality !== "set") return;
  const operation = capability.proposal.operation;
  const args = isRecord(capability.args) ? capability.args : {};
  const patch = isRecord(capability.proposal.patch) ? capability.proposal.patch : {};
  const visible = new Set(Array.isArray(capability.visible_fields) ? capability.visible_fields.filter((field): field is string => typeof field === "string") : []);
  const requiredReadFields = [
    ...(Array.isArray(operation.aggregate_bounds) ? operation.aggregate_bounds.filter(isRecord).map((bound) => bound.column) : []),
    ...(isRecord(operation.selection) && Array.isArray(operation.selection.all) ? operation.selection.all.filter(isRecord).map((term) => term.column) : []),
    ...(isRecord(capability.proposal.conflict_guard) ? [capability.proposal.conflict_guard.column] : []),
  ].filter(isSafeIdentifier);
  for (const field of requiredReadFields) if (!visible.has(field)) errors.push({ path: `${path}.visible_fields`, code: "SET_REVIEW_FIELD_NOT_VISIBLE", message: `bounded set review requires visible field ${field}.` });
  if (operation.kind === "insert") {
    const itemsArg = isRecord(operation.batch) ? operation.batch.items_from_arg : undefined;
    const arg = isSafeIdentifier(itemsArg) ? args[itemsArg] : undefined;
    if (!isRecord(arg) || arg.type !== "object_array") {
      errors.push({ path: `${path}.proposal.operation.batch.items_from_arg`, code: "BATCH_ITEMS_ARG_NOT_OBJECT_ARRAY", message: "batch.items_from_arg must reference an object_array argument." });
      return;
    }
    if (Number(arg.max_items) > Number(operation.max_rows)) errors.push({ path: `${path}.args.${String(itemsArg)}.max_items`, code: "BATCH_ITEMS_EXCEED_MAX_ROWS", message: "object_array max_items must not exceed operation.max_rows." });
    const fields = isRecord(arg.fields) ? arg.fields : {};
    for (const [column, binding] of Object.entries(patch)) {
      if (!isRecord(binding) || !isSafeIdentifier(binding.from_item) || !Object.prototype.hasOwnProperty.call(fields, binding.from_item)) {
        errors.push({ path: `${path}.proposal.patch.${column}.from_item`, code: "UNKNOWN_BATCH_ITEM_FIELD", message: "batch INSERT patch fields must bind a declared item field." });
      }
    }
    const components = isRecord(operation.deduplication) && Array.isArray(operation.deduplication.components) ? operation.deduplication.components : [];
    const primaryKey = isRecord(capability.subject) ? capability.subject.primary_key : undefined;
    if (isSafeIdentifier(primaryKey) && !components.some((component) => isRecord(component) && component.source === "item_field" && component.column === primaryKey)) {
      errors.push({ path: `${path}.proposal.operation.deduplication.components`, code: "BATCH_PRIMARY_KEY_REQUIRED", message: `batch INSERT must derive primary key ${primaryKey} from a typed item field.` });
    }
    for (const [index, component] of components.entries()) {
      if (isRecord(component) && component.source === "item_field" && (!isSafeIdentifier(component.item_field) || !Object.prototype.hasOwnProperty.call(fields, component.item_field))) {
        errors.push({ path: `${path}.proposal.operation.deduplication.components[${index}].item_field`, code: "UNKNOWN_DEDUP_ITEM_FIELD", message: "item_field deduplication must reference a declared batch item field." });
      }
    }
  } else {
    for (const [column, binding] of Object.entries(patch)) if (isRecord(binding) && binding.from_item !== undefined) errors.push({ path: `${path}.proposal.patch.${column}.from_item`, code: "FROM_ITEM_BATCH_INSERT_ONLY", message: "from_item is valid only for batch INSERT." });
  }
}

function validateSubject(
  value: unknown,
  path: string,
  resourceNames: Set<string>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  organizationScope?: unknown,
): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "SUBJECT_REQUIRED", message: "subject must be an object." });
    return;
  }
  checkUnknownKeys(value, SUBJECT_KEYS, path, errors);
  if (value.resource !== undefined && (!isQualifiedOrSafeName(value.resource) || (resourceNames.size > 0 && !resourceNames.has(String(value.resource))))) {
    errors.push({ path: `${path}.resource`, code: "UNKNOWN_RESOURCE", message: "subject.resource must reference a declared resource." });
  }
  if (value.resource === undefined) {
    for (const key of ["schema", "table", "primary_key"]) {
      if (!isSafeIdentifier(value[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_SUBJECT_IDENTIFIER", message: `${key} must be provided as a fixed safe identifier when resource is omitted.` });
    }
    if (!isSafeIdentifier(value.tenant_key)
      && value.single_tenant_dev !== true
      && !validProtectedOrganizationScope(organizationScope)) {
      errors.push({ path: `${path}.tenant_key`, code: "TENANT_KEY_REQUIRED", message: "tenant_key is required unless single_tenant_dev is explicitly true or the capability freezes a reviewed single organization." });
    }
  }
  if (value.principal_scope_key !== undefined && !isSafeIdentifier(value.principal_scope_key)) {
    errors.push({ path: `${path}.principal_scope_key`, code: "INVALID_PRINCIPAL_SCOPE_KEY", message: "principal_scope_key must be a fixed safe identifier." });
  }
  if (value.principal_scope_key !== undefined
    && value.resource === undefined
    && !isSafeIdentifier(value.tenant_key)
    && !validProtectedOrganizationScope(organizationScope)) {
    errors.push({ path: `${path}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key requires either a reviewed tenant_key or a reviewed single-organization authority." });
  }
  if (value.principal_scope_key !== undefined && value.single_tenant_dev === true) {
    errors.push({ path: `${path}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key cannot be used with single_tenant_dev; declare a reviewed tenant_key." });
  }
  if (value.single_tenant_dev === true) warnings.push({ path: `${path}.single_tenant_dev`, code: "SINGLE_TENANT_DEV", message: "single_tenant_dev is only for local demos and must not be used for shared tenant data." });
}

function validatePrincipalScopes(capabilities: unknown, contexts: unknown, resources: unknown, errors: ValidationIssue[]): void {
  if (!Array.isArray(capabilities) || !Array.isArray(contexts)) return;
  const contextByName = new Map<string, JsonRecord>();
  const resourceByName = new Map<string, JsonRecord>();
  for (const context of contexts) {
    if (isRecord(context) && isNonEmptyString(context.name)) contextByName.set(context.name, context);
  }
  if (Array.isArray(resources)) {
    for (const resource of resources) {
      if (isRecord(resource) && isNonEmptyString(resource.name)) resourceByName.set(resource.name, resource);
    }
  }
  capabilities.forEach((capability, index) => {
    if (!isRecord(capability) || !isRecord(capability.subject)) return;
    const protectedRead = isRecord(capability.protected_read) ? capability.protected_read : undefined;
    const protectedRelationshipPrincipal = isRecord(protectedRead?.relationship)
      && protectedRead.relationship.principal_scope_key !== undefined;
    const protectedPathPrincipal = Array.isArray(protectedRead?.relationships)
      && protectedRead.relationships.some((relationship) => isRecord(relationship)
        && Array.isArray(relationship.links)
        && relationship.links.some((link) => isRecord(link)
          && link.principal_scope_key !== undefined));
    const rootPrincipal = capability.subject.principal_scope_key !== undefined;
    if (!rootPrincipal && !protectedRelationshipPrincipal && !protectedPathPrincipal) return;
    const path = `$.capabilities[${index}]`;
    const resource = typeof capability.subject.resource === "string" ? resourceByName.get(capability.subject.resource) : undefined;
    const tenantKey = capability.subject.tenant_key ?? resource?.tenant_key;
    const singleTenantDev = capability.subject.single_tenant_dev ?? resource?.single_tenant_dev;
    const organizationScoped = validProtectedOrganizationScope(
      isRecord(capability.proposal) && capability.proposal.organization_scope !== undefined
        ? capability.proposal.organization_scope
        : isRecord(capability.protected_read)
          ? capability.protected_read.organization_scope
          : undefined,
    );
    if (rootPrincipal && ((!isSafeIdentifier(tenantKey) && !organizationScoped) || singleTenantDev === true)) {
      errors.push({ path: `${path}.subject.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key requires a reviewed tenant_key or protected single-organization authority." });
    }
    const context = contextByName.get(String(capability.context));
    if (!context || !isSafeIdentifier(context.principal_binding)) {
      errors.push({ path: `${path}.context`, code: "PRINCIPAL_SCOPE_BINDING_REQUIRED", message: "principal-scoped capabilities require a context with principal_binding." });
      return;
    }
    const binding = Array.isArray(context.bindings)
      ? context.bindings.find((item) => isRecord(item) && item.name === context.principal_binding)
      : undefined;
    if (!isRecord(binding) || binding.required !== true) {
      errors.push({ path: `${path}.context`, code: "PRINCIPAL_SCOPE_BINDING_REQUIRED", message: "principal_binding must reference a required trusted context binding." });
    }
    if (rootPrincipal) {
      const scopeKey = capability.subject.principal_scope_key;
      if (isRecord(capability.args) && Object.prototype.hasOwnProperty.call(capability.args, String(scopeKey))) {
        errors.push({ path: `${path}.args.${String(scopeKey)}`, code: "MODEL_CONTROLLED_PRINCIPAL_SCOPE", message: "the reviewed principal scope column cannot also be a model-facing argument." });
      }
      if (isRecord(capability.proposal)) {
        if (Array.isArray(capability.proposal.allowed_fields) && capability.proposal.allowed_fields.includes(scopeKey)) {
          errors.push({ path: `${path}.proposal.allowed_fields`, code: "PRINCIPAL_SCOPE_WRITE_FORBIDDEN", message: "the reviewed principal scope column cannot be model-writeable." });
        }
        if (isRecord(capability.proposal.patch) && Object.prototype.hasOwnProperty.call(capability.proposal.patch, String(scopeKey))) {
          errors.push({ path: `${path}.proposal.patch.${String(scopeKey)}`, code: "PRINCIPAL_SCOPE_WRITE_FORBIDDEN", message: "the reviewed principal scope column is forced from trusted context and cannot be patched by the model." });
        }
      }
    }
  });
}

function validateProtectedOrganizationContexts(
  capabilities: unknown,
  contexts: unknown,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(capabilities) || !Array.isArray(contexts)) return;
  const contextByName = new Map<string, JsonRecord>();
  for (const context of contexts) {
    if (isRecord(context) && isNonEmptyString(context.name)) contextByName.set(context.name, context);
  }
  capabilities.forEach((capability, index) => {
    if (!isRecord(capability)) return;
    const protectedRead = isRecord(capability.protected_read) ? capability.protected_read : undefined;
    const proposal = isRecord(capability.proposal) ? capability.proposal : undefined;
    const rawOrganizationScope = proposal?.organization_scope ?? protectedRead?.organization_scope;
    const organizationScope = isRecord(rawOrganizationScope) ? rawOrganizationScope : undefined;
    const context = contextByName.get(String(capability.context));
    const tenantBindingName = context?.tenant_binding;
    const tenantBinding = Array.isArray(context?.bindings)
      ? context.bindings.find((binding) => isRecord(binding) && binding.name === tenantBindingName)
      : undefined;
    const path = `$.capabilities[${index}]`;
    if (organizationScope !== undefined) {
      if (!isRecord(tenantBinding)
        || tenantBinding.source !== "reviewed_organization"
        || tenantBinding.key !== organizationScope.organization_id
        || tenantBinding.required !== true) {
        errors.push({
          path: `${path}.context`,
          code: "PROTECTED_ORGANIZATION_BINDING_REQUIRED",
          message: "reviewed single-organization authority requires a matching required reviewed_organization tenant binding.",
        });
      }
    } else if (isRecord(tenantBinding) && tenantBinding.source === "reviewed_organization") {
      errors.push({
        path: `${path}.context`,
        code: "PROTECTED_ORGANIZATION_AUTHORITY_REQUIRED",
        message: "a reviewed_organization tenant binding is valid only for a read or proposal capability that freezes the same organization.",
      });
    }
  });
}

function validProtectedOrganizationScope(value: unknown): value is JsonRecord {
  return isRecord(value)
    && value.mode === "single_organization"
    && typeof value.organization_id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.organization_id)
    && value.acknowledgement === "all_rows_belong_to_one_organization";
}

function validateProtectedOrganizationScope(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_ORGANIZATION_SCOPE_NOT_OBJECT", message: "organization_scope must be a fixed reviewed authority object." });
    return false;
  }
  checkUnknownKeys(value, PROTECTED_ORGANIZATION_SCOPE_KEYS, path, errors);
  if (value.mode !== "single_organization") {
    errors.push({ path: `${path}.mode`, code: "INVALID_PROTECTED_ORGANIZATION_MODE", message: "organization_scope.mode must be single_organization." });
  }
  if (typeof value.organization_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.organization_id)) {
    errors.push({ path: `${path}.organization_id`, code: "INVALID_PROTECTED_ORGANIZATION_ID", message: "organization_id must contain 1-128 letters, numbers, dots, colons, underscores, or dashes." });
  }
  if (value.acknowledgement !== "all_rows_belong_to_one_organization") {
    errors.push({ path: `${path}.acknowledgement`, code: "PROTECTED_ORGANIZATION_ACKNOWLEDGEMENT_REQUIRED", message: "organization_scope must retain the reviewed all-rows-belong-to-one-organization acknowledgement." });
  }
  return validProtectedOrganizationScope(value);
}

function validateArgs(value: unknown, path: string, errors: ValidationIssue[], allowEmpty = false): void {
  if (!isRecord(value) || (!allowEmpty && Object.keys(value).length === 0)) {
    errors.push({ path, code: "ARGS_REQUIRED", message: "args must define at least one model-facing business argument." });
    return;
  }
  for (const [name, arg] of Object.entries(value)) {
    const argPath = `${path}.${name}`;
    if (!isSafeIdentifier(name)) errors.push({ path: argPath, code: "INVALID_ARG_NAME", message: "arg names must be safe identifiers." });
    if (TRUSTED_ARG_NAMES.has(name)) errors.push({ path: argPath, code: "MODEL_CONTROLLED_TRUST_ARG", message: "model-facing args cannot include trust scope, dynamic identifiers, or version authority." });
    if (!isRecord(arg)) {
      errors.push({ path: argPath, code: "ARG_NOT_OBJECT", message: "arg definition must be an object." });
      continue;
    }
    checkUnknownKeys(arg, ARG_KEYS, argPath, errors);
    if (!["string", "number", "boolean", "object_array"].includes(String(arg.type))) errors.push({ path: `${argPath}.type`, code: "INVALID_ARG_TYPE", message: "arg type must be string, number, boolean, or object_array." });
    if (arg.description !== undefined && !isNonEmptyString(arg.description)) errors.push({ path: `${argPath}.description`, code: "INVALID_ARG_DESCRIPTION", message: "arg description must be a non-empty string." });
    if (arg.type === "object_array") {
      if (!Number.isSafeInteger(arg.max_items) || Number(arg.max_items) < 1 || Number(arg.max_items) > SET_MAX_ROWS_HARD_CEILING) errors.push({ path: `${argPath}.max_items`, code: "INVALID_OBJECT_ARRAY_MAX_ITEMS", message: `object_array max_items must be 1 through ${SET_MAX_ROWS_HARD_CEILING}.` });
      if (!isRecord(arg.fields) || Object.keys(arg.fields).length === 0 || Object.keys(arg.fields).length > 64) {
        errors.push({ path: `${argPath}.fields`, code: "OBJECT_ARRAY_FIELDS_REQUIRED", message: "object_array fields must define 1 through 64 typed item fields." });
      } else {
        validateArgs(arg.fields, `${argPath}.fields`, errors);
        for (const [fieldName, field] of Object.entries(arg.fields)) {
          if (isRecord(field) && field.type === "object_array") errors.push({ path: `${argPath}.fields.${fieldName}`, code: "NESTED_OBJECT_ARRAY_FORBIDDEN", message: "object_array item fields must be scalar." });
        }
      }
      for (const key of ["max_length", "minimum", "maximum", "enum"]) if (arg[key] !== undefined) errors.push({ path: `${argPath}.${key}`, code: "OBJECT_ARRAY_SCALAR_OPTION_FORBIDDEN", message: `${key} is valid only on scalar arguments or item fields.` });
      continue;
    }
    if (arg.max_items !== undefined || arg.fields !== undefined) errors.push({ path: argPath, code: "OBJECT_ARRAY_OPTIONS_REQUIRE_OBJECT_ARRAY", message: "max_items and fields require type object_array." });
    if (arg.max_length !== undefined && (!Number.isInteger(arg.max_length) || Number(arg.max_length) <= 0)) errors.push({ path: `${argPath}.max_length`, code: "INVALID_MAX_LENGTH", message: "max_length must be a positive integer." });
    if ((arg.minimum !== undefined || arg.maximum !== undefined) && arg.type !== "number") errors.push({ path: argPath, code: "NUMERIC_BOUNDS_REQUIRE_NUMBER", message: "minimum/maximum can only be used with number args." });
    if (arg.minimum !== undefined && !isFiniteNumber(arg.minimum)) errors.push({ path: `${argPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    if (arg.maximum !== undefined && !isFiniteNumber(arg.maximum)) errors.push({ path: `${argPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    if (isFiniteNumber(arg.minimum) && isFiniteNumber(arg.maximum) && Number(arg.minimum) > Number(arg.maximum)) errors.push({ path: argPath, code: "INVALID_ARG_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    if (arg.enum !== undefined) {
      if (!Array.isArray(arg.enum) || arg.enum.length === 0 || arg.enum.length > 64) {
        errors.push({ path: `${argPath}.enum`, code: "INVALID_ARG_ENUM", message: "enum must contain 1 through 64 scalar values." });
      } else {
        const expectedType = arg.type;
        const keys = new Set<string>();
        arg.enum.forEach((item, enumIndex) => {
          if (item === null || typeof item !== expectedType) errors.push({ path: `${argPath}.enum[${enumIndex}]`, code: "ARG_ENUM_TYPE_MISMATCH", message: `enum values must match argument type ${String(expectedType)} and cannot be null.` });
          const key = `${typeof item}:${JSON.stringify(item)}`;
          if (keys.has(key)) errors.push({ path: `${argPath}.enum[${enumIndex}]`, code: "ARG_ENUM_DUPLICATE_VALUE", message: "enum values must be unique after canonicalization." });
          keys.add(key);
        });
      }
    }
  }
}

function validateProtectedRead(capability: JsonRecord, path: string, errors: ValidationIssue[]): void {
  const protectedRead = capability.protected_read;
  if (!isRecord(protectedRead)) {
    errors.push({ path: `${path}.protected_read`, code: "PROTECTED_READ_NOT_OBJECT", message: "protected_read must be a reviewed authority object." });
    return;
  }
  checkUnknownKeys(protectedRead, PROTECTED_READ_KEYS, `${path}.protected_read`, errors);
  if (capability.kind !== "read" && capability.kind !== "aggregate_read") {
    errors.push({ path: `${path}.protected_read`, code: "PROTECTED_READ_KIND_FORBIDDEN", message: "protected_read is valid only on read and aggregate_read capabilities." });
  }
  if (protectedRead.version !== "1") errors.push({ path: `${path}.protected_read.version`, code: "INVALID_PROTECTED_READ_VERSION", message: "protected_read.version must be 1." });
  if (protectedRead.mode !== "rows" && protectedRead.mode !== "aggregate") errors.push({ path: `${path}.protected_read.mode`, code: "INVALID_PROTECTED_READ_MODE", message: "protected_read.mode must be rows or aggregate." });
  if (protectedRead.mode === "rows" && capability.kind !== "read") errors.push({ path: `${path}.kind`, code: "PROTECTED_READ_KIND_MISMATCH", message: "protected rows require capability kind read." });
  if (protectedRead.mode === "aggregate" && capability.kind !== "aggregate_read") errors.push({ path: `${path}.kind`, code: "PROTECTED_READ_KIND_MISMATCH", message: "protected aggregates require capability kind aggregate_read." });
  for (const key of ["boundary_digest", "generation_lock_fingerprint"] as const) {
    if (!isSha256Digest(protectedRead[key])) errors.push({ path: `${path}.protected_read.${key}`, code: "INVALID_PROTECTED_READ_DIGEST", message: `${key} must be a canonical sha256 digest.` });
  }

  const organizationScoped = validateProtectedOrganizationScope(
    protectedRead.organization_scope,
    `${path}.protected_read.organization_scope`,
    errors,
  );
  const subject = isRecord(capability.subject) ? capability.subject : {};
  if (organizationScoped && isSafeIdentifier(subject.tenant_key)) {
    errors.push({
      path: `${path}.protected_read.organization_scope`,
      code: "PROTECTED_SCOPE_MODES_CONFLICT",
      message: "protected_read must freeze either tenant-key scope or one reviewed organization, never both.",
    });
  }
  if (!organizationScoped && !isSafeIdentifier(subject.tenant_key)) {
    errors.push({
      path: `${path}.subject.tenant_key`,
      code: "PROTECTED_TENANT_AUTHORITY_REQUIRED",
      message: "protected_read requires a reviewed tenant_key unless it freezes one reviewed organization.",
    });
  }

  const args = isRecord(capability.args) ? capability.args : {};
  const referencedArgs = new Set<string>();
  const keptOut = new Set(Array.isArray(capability.kept_out_fields) ? capability.kept_out_fields.filter((field): field is string => typeof field === "string") : []);
  const trustedScopeFields = new Set([subject.tenant_key, subject.principal_scope_key].filter((field): field is string => isSafeIdentifier(field)));
  const relationshipNames = new Set<string>();
  const legacyRelationshipName = validateProtectedRelationship(
    protectedRead.relationship,
    keptOut,
    trustedScopeFields,
    `${path}.protected_read.relationship`,
    organizationScoped,
    errors,
  );
  if (legacyRelationshipName) relationshipNames.add(legacyRelationshipName);
  if (protectedRead.relationship !== undefined && protectedRead.relationships !== undefined) {
    errors.push({
      path: `${path}.protected_read`,
      code: "PROTECTED_RELATIONSHIP_FORMS_CONFLICT",
      message: "protected_read must use either legacy relationship or reviewed relationships, not both.",
    });
  }
  validateProtectedRelationshipPaths(
    protectedRead.relationships,
    keptOut,
    trustedScopeFields,
    `${path}.protected_read.relationships`,
    relationshipNames,
    organizationScoped,
    errors,
  );

  if (protectedRead.time_window !== undefined) {
    const timeWindowPath = `${path}.protected_read.time_window`;
    if (!isRecord(protectedRead.time_window)) {
      errors.push({ path: timeWindowPath, code: "PROTECTED_TIME_WINDOW_NOT_OBJECT", message: "time_window must be a fixed reviewed UTC range." });
    } else {
      checkUnknownKeys(protectedRead.time_window, PROTECTED_TIME_WINDOW_KEYS, timeWindowPath, errors);
      validateProtectedFieldReference(
        protectedRead.time_window.field,
        protectedRead.time_window.relationship,
        relationshipNames,
        keptOut,
        trustedScopeFields,
        timeWindowPath,
        errors,
      );
      const start = protectedRead.time_window.start;
      const end = protectedRead.time_window.end;
      if (!isCanonicalUtcInstant(start) || !isCanonicalUtcInstant(end)
        || Date.parse(start) >= Date.parse(end)) {
        errors.push({
          path: timeWindowPath,
          code: "INVALID_PROTECTED_TIME_WINDOW",
          message: "time_window must freeze one canonical half-open UTC range with start < end; dynamic arguments are not allowed.",
        });
      }
    }
  }

  if (!isRecord(capability.evidence) || capability.evidence.required !== true || capability.evidence.query_audit !== true) {
    errors.push({
      path: `${path}.evidence`,
      code: "PROTECTED_READ_EVIDENCE_REQUIRED",
      message: "protected reads require evidence.required=true and query_audit=true.",
    });
  }

  if (protectedRead.predicates !== undefined) {
    if (!Array.isArray(protectedRead.predicates) || protectedRead.predicates.length > 8) {
      errors.push({ path: `${path}.protected_read.predicates`, code: "INVALID_PROTECTED_PREDICATES", message: "protected_read.predicates must contain at most 8 reviewed predicates." });
    } else {
      protectedRead.predicates.forEach((predicate, index) => {
        const predicatePath = `${path}.protected_read.predicates[${index}]`;
        if (!isRecord(predicate)) {
          errors.push({ path: predicatePath, code: "PROTECTED_PREDICATE_NOT_OBJECT", message: "protected predicate must be an object." });
          return;
        }
        checkUnknownKeys(predicate, PROTECTED_PREDICATE_KEYS, predicatePath, errors);
        validateProtectedFieldReference(predicate.field, predicate.relationship, relationshipNames, keptOut, trustedScopeFields, predicatePath, errors);
        if (!["eq", "neq", "lt", "lte", "gt", "gte", "in"].includes(String(predicate.operator))) {
          errors.push({ path: `${predicatePath}.operator`, code: "INVALID_PROTECTED_PREDICATE_OPERATOR", message: "protected predicate operator must be eq, neq, lt, lte, gt, gte, or in." });
        }
        if (predicate.operator === "in") {
          if (predicate.value !== undefined) errors.push({ path: `${predicatePath}.value`, code: "PROTECTED_IN_VALUE_FORBIDDEN", message: "in predicates use a fixed values list, not value." });
          if (!Array.isArray(predicate.values) || predicate.values.length < 1 || predicate.values.length > 20 || predicate.values.some((value) => !isJsonScalar(value))) {
            errors.push({ path: `${predicatePath}.values`, code: "INVALID_PROTECTED_IN_VALUES", message: "in predicates require 1 through 20 fixed scalar values." });
          }
        } else {
          if (predicate.values !== undefined) errors.push({ path: `${predicatePath}.values`, code: "PROTECTED_VALUES_IN_ONLY", message: "values is valid only for an in predicate." });
          validateProtectedValue(predicate.value, args, referencedArgs, `${predicatePath}.value`, errors);
        }
      });
    }
  }

  if (protectedRead.row_order_by !== undefined) {
    if (!Array.isArray(protectedRead.row_order_by) || protectedRead.row_order_by.length < 1 || protectedRead.row_order_by.length > 3) {
      errors.push({ path: `${path}.protected_read.row_order_by`, code: "INVALID_PROTECTED_ROW_ORDER", message: "row_order_by must contain 1 through 3 fixed sort fields." });
    } else {
      const visible = new Set(Array.isArray(capability.visible_fields) ? capability.visible_fields.filter((field): field is string => typeof field === "string") : []);
      protectedRead.row_order_by.forEach((order, index) => {
        const orderPath = `${path}.protected_read.row_order_by[${index}]`;
        if (!isRecord(order)) {
          errors.push({ path: orderPath, code: "PROTECTED_ROW_ORDER_NOT_OBJECT", message: "row order must be an object." });
          return;
        }
        checkUnknownKeys(order, PROTECTED_ROW_ORDER_KEYS, orderPath, errors);
        if (!isSafeIdentifier(order.field) || !visible.has(String(order.field)) || keptOut.has(String(order.field))) {
          errors.push({ path: `${orderPath}.field`, code: "PROTECTED_ROW_ORDER_FIELD_FORBIDDEN", message: "row order field must be a visible, non-kept-out subject field." });
        }
        if (order.direction !== "asc" && order.direction !== "desc") errors.push({ path: `${orderPath}.direction`, code: "INVALID_PROTECTED_ORDER_DIRECTION", message: "order direction must be asc or desc." });
      });
    }
  }

  validateProtectedReadLimits(protectedRead.limits, `${path}.protected_read.limits`, errors);

  if (protectedRead.mode === "rows") {
    if (protectedRead.aggregate !== undefined) errors.push({ path: `${path}.protected_read.aggregate`, code: "PROTECTED_AGGREGATE_ROWS_FORBIDDEN", message: "protected row reads must not declare aggregate." });
    if (capability.lookup !== undefined) errors.push({ path: `${path}.lookup`, code: "PROTECTED_LOOKUP_FORBIDDEN", message: "protected row reads use only their reviewed predicates and must not also declare legacy lookup." });
    if (!Array.isArray(capability.visible_fields) || capability.visible_fields.length === 0) errors.push({ path: `${path}.visible_fields`, code: "PROTECTED_ROW_VISIBLE_FIELDS_REQUIRED", message: "protected row reads require one or more visible fields." });
    const maxRows = isRecord(protectedRead.limits) ? protectedRead.limits.max_rows : undefined;
    if (!Number.isSafeInteger(capability.max_rows) || capability.max_rows !== maxRows) {
      errors.push({ path: `${path}.max_rows`, code: "PROTECTED_ROW_LIMIT_MISMATCH", message: "capability.max_rows must exactly match protected_read.limits.max_rows." });
    }
  } else if (protectedRead.mode === "aggregate") {
    if (capability.lookup !== undefined) errors.push({ path: `${path}.lookup`, code: "PROTECTED_AGGREGATE_LOOKUP_FORBIDDEN", message: "protected aggregate reads do not use legacy lookup." });
    if (Array.isArray(capability.visible_fields) && capability.visible_fields.length > 0) errors.push({ path: `${path}.visible_fields`, code: "PROTECTED_AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "protected aggregate reads return no source row fields." });
    if (protectedRead.row_order_by !== undefined) errors.push({ path: `${path}.protected_read.row_order_by`, code: "PROTECTED_AGGREGATE_ROW_ORDER_FORBIDDEN", message: "protected aggregates use aggregate.order_by." });
    validateProtectedAggregate(protectedRead.aggregate, {
      args,
      referencedArgs,
      relationshipNames,
      keptOut,
      trustedScopeFields,
      maxGroups: isRecord(protectedRead.limits) ? protectedRead.limits.max_groups : undefined,
      maxRankedGroups: isRecord(protectedRead.limits)
        ? protectedRead.limits.max_ranked_groups
        : undefined,
      path: `${path}.protected_read.aggregate`,
      errors,
    });
    if (protectedRead.time_window !== undefined
      && isRecord(protectedRead.aggregate)
      && protectedRead.aggregate.comparison !== undefined) {
      errors.push({
        path: `${path}.protected_read`,
        code: "PROTECTED_TIME_SELECTION_CONFLICT",
        message: "protected_read must use either one fixed time_window or an aggregate comparison, not both.",
      });
    }
  }

  for (const [name, arg] of Object.entries(args)) {
    if (isRecord(arg) && arg.type === "object_array") {
      errors.push({ path: `${path}.args.${name}`, code: "PROTECTED_READ_SCALAR_ARGS_ONLY", message: "protected reads accept only bounded scalar arguments." });
    }
    if (!referencedArgs.has(name)) {
      errors.push({ path: `${path}.args.${name}`, code: "PROTECTED_READ_UNUSED_ARG", message: "every protected-read argument must be selected by a human for one reviewed value position." });
    }
  }
}

function validateProtectedRelationship(
  value: unknown,
  keptOut: Set<string>,
  trustedScopeFields: Set<string>,
  path: string,
  organizationScoped: boolean,
  errors: ValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_RELATIONSHIP_NOT_OBJECT", message: "protected relationship must be an object." });
    return undefined;
  }
  checkUnknownKeys(value, PROTECTED_RELATIONSHIP_KEYS, path, errors);
  for (const key of ["name", "schema", "table", "primary_key", "local_key", "target_key"] as const) {
    if (!isSafeIdentifier(value[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
  }
  if (organizationScoped && value.tenant_key !== undefined) {
    errors.push({ path: `${path}.tenant_key`, code: "PROTECTED_SCOPE_MODES_CONFLICT", message: "single-organization protected relationships must not declare tenant_key." });
  } else if (!organizationScoped && !isSafeIdentifier(value.tenant_key)) {
    errors.push({ path: `${path}.tenant_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "tenant_key must be a fixed safe identifier for tenant-scoped protected relationships." });
  }
  if (value.principal_scope_key !== undefined && !isSafeIdentifier(value.principal_scope_key)) errors.push({ path: `${path}.principal_scope_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "principal_scope_key must be a fixed safe identifier." });
  if (value.cardinality !== "many_to_one" || value.max_fan_out !== 1) {
    errors.push({ path, code: "PROTECTED_RELATIONSHIP_CARDINALITY_FORBIDDEN", message: "the protected-read release permits only an explicitly reviewed many-to-one relationship with max_fan_out 1." });
  }
  if (isSafeIdentifier(value.local_key) && (keptOut.has(value.local_key) || trustedScopeFields.has(value.local_key))) {
    errors.push({
      path: `${path}.local_key`,
      code: "PROTECTED_RELATIONSHIP_LOCAL_KEY_FORBIDDEN",
      message: "the reviewed relationship cannot join through a kept-out or trusted-scope subject field.",
    });
  }
  return isSafeIdentifier(value.name) ? value.name : undefined;
}

function validateProtectedRelationshipPaths(
  value: unknown,
  keptOut: Set<string>,
  trustedScopeFields: Set<string>,
  path: string,
  relationshipNames: Set<string>,
  organizationScoped: boolean,
  errors: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    errors.push({
      path,
      code: "INVALID_PROTECTED_RELATIONSHIP_PATHS",
      message: "protected relationships must contain 1 through 3 reviewed paths.",
    });
    return;
  }
  value.forEach((candidate, pathIndex) => {
    const candidatePath = `${path}[${pathIndex}]`;
    if (!isRecord(candidate)) {
      errors.push({ path: candidatePath, code: "PROTECTED_RELATIONSHIP_PATH_NOT_OBJECT", message: "protected relationship path must be an object." });
      return;
    }
    checkUnknownKeys(candidate, PROTECTED_RELATIONSHIP_PATH_KEYS, candidatePath, errors);
    if (!isSafeIdentifier(candidate.name)) {
      errors.push({ path: `${candidatePath}.name`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "relationship path name must be a fixed safe identifier." });
    } else if (relationshipNames.has(candidate.name)) {
      errors.push({ path: `${candidatePath}.name`, code: "DUPLICATE_PROTECTED_RELATIONSHIP", message: "protected relationship names must be unique." });
    } else {
      relationshipNames.add(candidate.name);
    }
    if (!Array.isArray(candidate.links) || candidate.links.length < 1 || candidate.links.length > 3) {
      errors.push({ path: `${candidatePath}.links`, code: "INVALID_PROTECTED_RELATIONSHIP_LINKS", message: "a protected relationship path requires one through three reviewed many-to-one links." });
      return;
    }
    candidate.links.forEach((link, linkIndex) => {
      const linkPath = `${candidatePath}.links[${linkIndex}]`;
      if (!isRecord(link)) {
        errors.push({ path: linkPath, code: "PROTECTED_RELATIONSHIP_LINK_NOT_OBJECT", message: "protected relationship link must be an object." });
        return;
      }
      checkUnknownKeys(link, PROTECTED_RELATIONSHIP_LINK_KEYS, linkPath, errors);
      for (const key of ["schema", "table", "primary_key", "local_key", "target_key"] as const) {
        if (!isSafeIdentifier(link[key])) errors.push({ path: `${linkPath}.${key}`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
      }
      if (organizationScoped && link.tenant_key !== undefined) {
        errors.push({ path: `${linkPath}.tenant_key`, code: "PROTECTED_SCOPE_MODES_CONFLICT", message: "single-organization protected relationship links must not declare tenant_key." });
      } else if (!organizationScoped && !isSafeIdentifier(link.tenant_key)) {
        errors.push({ path: `${linkPath}.tenant_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "tenant_key must be a fixed safe identifier for tenant-scoped protected relationship links." });
      }
      if (link.principal_scope_key !== undefined && !isSafeIdentifier(link.principal_scope_key)) {
        errors.push({ path: `${linkPath}.principal_scope_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "principal_scope_key must be a fixed safe identifier." });
      }
      if (link.cardinality !== "many_to_one" || link.max_fan_out !== 1) {
        errors.push({ path: linkPath, code: "PROTECTED_RELATIONSHIP_CARDINALITY_FORBIDDEN", message: "every protected relationship link must be reviewed many-to-one with max_fan_out 1." });
      }
      if (link.unmatched_rows !== "exclude" && link.unmatched_rows !== "keep_null") {
        errors.push({ path: `${linkPath}.unmatched_rows`, code: "PROTECTED_RELATIONSHIP_NULL_SEMANTICS_REQUIRED", message: "every protected relationship link must freeze exclude or keep_null unmatched-row semantics." });
      }
      if (linkIndex === 0 && isSafeIdentifier(link.local_key)
        && (keptOut.has(link.local_key) || trustedScopeFields.has(link.local_key))) {
        errors.push({
          path: `${linkPath}.local_key`,
          code: "PROTECTED_RELATIONSHIP_LOCAL_KEY_FORBIDDEN",
          message: "the reviewed relationship cannot join through a kept-out or trusted-scope subject field.",
        });
      }
    });
  });
}

function validateProtectedAggregate(
  value: unknown,
  input: {
    args: JsonRecord;
    referencedArgs: Set<string>;
    relationshipNames: Set<string>;
    keptOut: Set<string>;
    trustedScopeFields: Set<string>;
    maxGroups: unknown;
    maxRankedGroups: unknown;
    path: string;
    errors: ValidationIssue[];
  },
): void {
  const { path, errors } = input;
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_AGGREGATE_REQUIRED", message: "protected aggregate mode requires a frozen aggregate definition." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_AGGREGATE_KEYS, path, errors);
  if (value.counted_entity !== "subject") errors.push({ path: `${path}.counted_entity`, code: "INVALID_PROTECTED_COUNTED_ENTITY", message: "the initial protected aggregate release counts the scoped subject entity." });
  const measureNames = new Set<string>();
  if (!Array.isArray(value.measures) || value.measures.length < 1 || value.measures.length > 4) {
    errors.push({ path: `${path}.measures`, code: "INVALID_PROTECTED_MEASURES", message: "protected aggregate requires 1 through 4 reviewed measures." });
  } else {
    value.measures.forEach((measure, index) => {
      const measurePath = `${path}.measures[${index}]`;
      if (!isRecord(measure)) {
        errors.push({ path: measurePath, code: "PROTECTED_MEASURE_NOT_OBJECT", message: "protected measure must be an object." });
        return;
      }
      checkUnknownKeys(measure, PROTECTED_MEASURE_KEYS, measurePath, errors);
      validateUniqueIdentifier(measure.name, measureNames, `${measurePath}.name`, "DUPLICATE_PROTECTED_MEASURE_NAME", errors);
      if (!["count", "count_distinct", "sum", "avg", "stddev_samp", "stddev_pop", "var_samp", "var_pop", "null_count", "non_null_count", "completion_rate", "reviewed_derived"].includes(String(measure.function))) errors.push({ path: `${measurePath}.function`, code: "INVALID_PROTECTED_MEASURE_FUNCTION", message: "measure function is not in the reviewed fixed aggregate allowlist." });
      if (measure.function === "reviewed_derived") {
        if (measure.field !== undefined || measure.relationship !== undefined) {
          errors.push({ path: measurePath, code: "PROTECTED_DERIVED_DIRECT_FIELD_FORBIDDEN", message: "a reviewed derived measure freezes its fields inside derived operands." });
        }
        validateProtectedDerivedMeasure(measure.derived, measurePath, input, value, errors);
      } else {
        if (measure.derived !== undefined) errors.push({ path: `${measurePath}.derived`, code: "PROTECTED_DERIVED_SHAPE_FORBIDDEN", message: "only reviewed_derived measures may declare a fixed derived shape." });
        validateProtectedRelationshipReference(measure.relationship, input.relationshipNames, `${measurePath}.relationship`, errors);
      }
      if (measure.function === "count") {
        if (measure.field !== undefined) errors.push({ path: `${measurePath}.field`, code: "PROTECTED_COUNT_FIELD_FORBIDDEN", message: "count measures count scoped subject rows and must not declare a field." });
        if (measure.relationship !== undefined) errors.push({ path: `${measurePath}.relationship`, code: "PROTECTED_COUNT_RELATIONSHIP_FORBIDDEN", message: "count measures count the scoped subject entity, not a joined relation." });
      } else if (measure.function !== "reviewed_derived") {
        validateProtectedFieldReference(measure.field, measure.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, measurePath, errors);
      }
    });
    if (value.measures.some((measure) => isRecord(measure)
      && ["stddev_samp", "stddev_pop", "var_samp", "var_pop", "reviewed_derived"].includes(String(measure.function)))
      && (!Number.isSafeInteger(value.minimum_group_size) || Number(value.minimum_group_size) < 5)) {
      errors.push({
        path: `${path}.minimum_group_size`,
        code: "PROTECTED_DISPERSION_COHORT_TOO_SMALL",
        message: "dispersion and reviewed derived measures require a minimum group size of at least 5 contributors.",
      });
    }
  }

  const dimensionNames = new Set<string>();
  if (value.dimensions !== undefined) {
    if (!Array.isArray(value.dimensions) || value.dimensions.length > 3) {
      errors.push({ path: `${path}.dimensions`, code: "INVALID_PROTECTED_DIMENSIONS", message: "protected aggregate permits at most 3 reviewed dimensions." });
    } else {
      value.dimensions.forEach((dimension, index) => {
        const dimensionPath = `${path}.dimensions[${index}]`;
        if (!isRecord(dimension)) {
          errors.push({ path: dimensionPath, code: "PROTECTED_DIMENSION_NOT_OBJECT", message: "protected dimension must be an object." });
          return;
        }
        checkUnknownKeys(dimension, PROTECTED_DIMENSION_KEYS, dimensionPath, errors);
        validateUniqueIdentifier(dimension.name, dimensionNames, `${dimensionPath}.name`, "DUPLICATE_PROTECTED_DIMENSION_NAME", errors);
        validateProtectedFieldReference(dimension.field, dimension.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, dimensionPath, errors);
        if (dimension.numeric_band !== undefined) {
          validateProtectedNumericBand(dimension.numeric_band, `${dimensionPath}.numeric_band`, errors);
        }
      });
    }
  }

  if (value.time_bucket !== undefined) {
    const bucketPath = `${path}.time_bucket`;
    if (!isRecord(value.time_bucket)) {
      errors.push({ path: bucketPath, code: "PROTECTED_TIME_BUCKET_NOT_OBJECT", message: "time_bucket must be an object." });
    } else {
      checkUnknownKeys(value.time_bucket, PROTECTED_TIME_BUCKET_KEYS, bucketPath, errors);
      if (!isSafeIdentifier(value.time_bucket.name)) errors.push({ path: `${bucketPath}.name`, code: "INVALID_PROTECTED_TIME_BUCKET_NAME", message: "time bucket name must be a safe identifier." });
      if (!["hour", "day", "week", "month", "quarter", "year", "day_of_week"].includes(String(value.time_bucket.bucket))) errors.push({ path: `${bucketPath}.bucket`, code: "INVALID_PROTECTED_TIME_BUCKET", message: "time bucket must be hour, day, week, month, quarter, year, or day_of_week." });
      validateProtectedFieldReference(value.time_bucket.field, value.time_bucket.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, bucketPath, errors);
    }
  }

  if (value.comparison !== undefined) {
    const comparisonPath = `${path}.comparison`;
    if (!isRecord(value.comparison)) {
      errors.push({ path: comparisonPath, code: "PROTECTED_COMPARISON_NOT_OBJECT", message: "comparison must be an object." });
    } else {
      checkUnknownKeys(value.comparison, PROTECTED_COMPARISON_KEYS, comparisonPath, errors);
      validateProtectedFieldReference(value.comparison.field, value.comparison.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, comparisonPath, errors);
      if (!Array.isArray(value.comparison.ranges) || value.comparison.ranges.length < 1 || value.comparison.ranges.length > 2) {
        errors.push({ path: `${comparisonPath}.ranges`, code: "INVALID_PROTECTED_COMPARISON_RANGES", message: "comparison requires one or two bounded time ranges." });
      } else {
        value.comparison.ranges.forEach((range, index) => {
          const rangePath = `${comparisonPath}.ranges[${index}]`;
          if (!isRecord(range)) {
            errors.push({ path: rangePath, code: "PROTECTED_COMPARISON_RANGE_NOT_OBJECT", message: "comparison range must be an object." });
            return;
          }
          checkUnknownKeys(range, PROTECTED_RANGE_KEYS, rangePath, errors);
          validateProtectedValue(range.start, input.args, input.referencedArgs, `${rangePath}.start`, errors);
          validateProtectedValue(range.end, input.args, input.referencedArgs, `${rangePath}.end`, errors);
        });
      }
    }
  }

  if (value.order_by !== undefined) {
    const orderPath = `${path}.order_by`;
    if (!isRecord(value.order_by)) {
      errors.push({ path: orderPath, code: "PROTECTED_AGGREGATE_ORDER_NOT_OBJECT", message: "aggregate order_by must be an object." });
    } else {
      checkUnknownKeys(value.order_by, PROTECTED_AGGREGATE_ORDER_KEYS, orderPath, errors);
      if (value.order_by.direction !== "asc" && value.order_by.direction !== "desc") errors.push({ path: `${orderPath}.direction`, code: "INVALID_PROTECTED_ORDER_DIRECTION", message: "order direction must be asc or desc." });
      if (value.order_by.kind === "measure") {
        if (!isSafeIdentifier(value.order_by.measure) || !measureNames.has(String(value.order_by.measure))) errors.push({ path: `${orderPath}.measure`, code: "UNKNOWN_PROTECTED_ORDER_MEASURE", message: "measure ordering must reference a reviewed measure name." });
        if (value.order_by.change !== undefined) errors.push({ path: `${orderPath}.change`, code: "PROTECTED_MEASURE_ORDER_CHANGE_FORBIDDEN", message: "measure ordering must not declare a comparison-change shape." });
      } else if (value.order_by.kind === "comparison_change") {
        if (!isSafeIdentifier(value.order_by.measure) || !measureNames.has(String(value.order_by.measure))) errors.push({ path: `${orderPath}.measure`, code: "UNKNOWN_PROTECTED_ORDER_MEASURE", message: "comparison-change ordering must reference a reviewed measure name." });
        if (value.order_by.change !== "absolute" && value.order_by.change !== "percentage") errors.push({ path: `${orderPath}.change`, code: "INVALID_PROTECTED_COMPARISON_CHANGE", message: "comparison-change ordering must use absolute or percentage change." });
        if (!isRecord(value.comparison)
          || !Array.isArray(value.comparison.ranges)
          || value.comparison.ranges.length !== 2) {
          errors.push({ path: orderPath, code: "PROTECTED_CHANGE_ORDER_REQUIRES_COMPARISON", message: "comparison-change ordering requires exactly two reviewed periods." });
        }
      } else if (value.order_by.kind === "time_bucket") {
        if (value.order_by.measure !== undefined) errors.push({ path: `${orderPath}.measure`, code: "PROTECTED_TIME_ORDER_MEASURE_FORBIDDEN", message: "time-bucket ordering must not declare a measure." });
        if (value.order_by.change !== undefined) errors.push({ path: `${orderPath}.change`, code: "PROTECTED_TIME_ORDER_CHANGE_FORBIDDEN", message: "time-bucket ordering must not declare a comparison-change shape." });
        if (!isRecord(value.time_bucket)) errors.push({ path: orderPath, code: "PROTECTED_TIME_ORDER_REQUIRES_BUCKET", message: "time-bucket ordering requires a reviewed time bucket." });
        if (isRecord(value.comparison)) errors.push({ path: orderPath, code: "PROTECTED_COMPARISON_TIME_ORDER_FORBIDDEN", message: "a two-period comparison cannot order by an absolute time bucket." });
      } else {
        errors.push({ path: `${orderPath}.kind`, code: "INVALID_PROTECTED_AGGREGATE_ORDER", message: "aggregate order kind must be measure, comparison_change, or time_bucket." });
      }
    }
  }
  const hasPostAggregateTransform = Array.isArray(value.measures)
    && value.measures.some((measure) => isRecord(measure)
      && measure.function === "reviewed_derived"
      && isRecord(measure.derived)
      && PROTECTED_POST_AGGREGATE_SHAPES.has(String(measure.derived.shape)));
  const ranked = hasPostAggregateTransform || (isRecord(value.order_by)
    && (value.order_by.kind === "measure" || value.order_by.kind === "comparison_change"));
  const maximumGroups = ranked && Number.isSafeInteger(input.maxRankedGroups)
    ? Number(input.maxRankedGroups)
    : input.maxGroups;
  if (!Number.isSafeInteger(value.top_n) || Number(value.top_n) < 1 || Number(value.top_n) > 100 || (Number.isSafeInteger(maximumGroups) && Number(value.top_n) > Number(maximumGroups))) {
    errors.push({ path: `${path}.top_n`, code: "INVALID_PROTECTED_TOP_N", message: "top_n must be positive, at most 100, and no greater than its reviewed group limit." });
  }
  if (!Number.isSafeInteger(value.minimum_group_size) || Number(value.minimum_group_size) < 1 || Number(value.minimum_group_size) > 1_000_000) {
    errors.push({ path: `${path}.minimum_group_size`, code: "INVALID_PROTECTED_MINIMUM_GROUP_SIZE", message: "minimum_group_size must be from 1 through 1000000." });
  }
}

function validateProtectedNumericBand(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_NUMERIC_BAND_NOT_OBJECT", message: "reviewed numeric band must be an object." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_NUMERIC_BAND_KEYS, path, errors);
  const edges = Array.isArray(value.edges) ? value.edges : [];
  if (edges.length < 1 || edges.length > 16
    || edges.some((edge) => typeof edge !== "number" || !Number.isFinite(edge))
    || edges.some((edge, index) => index > 0 && Number(edge) <= Number(edges[index - 1]))) {
    errors.push({ path: `${path}.edges`, code: "INVALID_PROTECTED_NUMERIC_BAND_EDGES", message: "reviewed numeric band requires 1 through 16 finite, strictly increasing edges." });
  }
  const labels = Array.isArray(value.bucket_labels) ? value.bucket_labels : [];
  if (labels.length !== edges.length + 1
    || labels.some((label) => typeof label !== "string" || !label.trim() || [...label].length > 64 || /[\u0000-\u001f\u007f]/.test(label))
    || new Set(labels).size !== labels.length
    || new TextEncoder().encode(JSON.stringify(labels)).byteLength > 2_048) {
    errors.push({ path: `${path}.bucket_labels`, code: "INVALID_PROTECTED_NUMERIC_BAND_LABELS", message: "reviewed numeric band requires one unique bounded label per bucket and at most 2048 UTF-8 bytes total." });
  }
}

function validateProtectedDerivedMeasure(
  value: unknown,
  measurePath: string,
  input: {
    relationshipNames: Set<string>;
    keptOut: Set<string>;
    trustedScopeFields: Set<string>;
  },
  aggregate: JsonRecord,
  errors: ValidationIssue[],
): void {
  const path = `${measurePath}.derived`;
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_DERIVED_REQUIRED", message: "reviewed_derived requires one fixed reviewed calculation." });
    return;
  }
  if (["ratio", "percentage", "per_unit_average"].includes(String(value.shape))) {
    checkUnknownKeys(value, PROTECTED_RATIO_DERIVED_MEASURE_KEYS, path, errors);
    if (value.null_policy !== "null_on_zero_or_null_denominator") {
      errors.push({ path: `${path}.null_policy`, code: "INVALID_PROTECTED_DERIVED_NULL_POLICY", message: "derived denominator behavior must be null_on_zero_or_null_denominator." });
    }
    const numerator = validateProtectedDerivedOperand(value.numerator, `${path}.numerator`, input, errors);
    const denominator = validateProtectedDerivedOperand(value.denominator, `${path}.denominator`, input, errors);
    if (numerator && denominator && numerator.relationship !== denominator.relationship) {
      errors.push({ path, code: "PROTECTED_DERIVED_RELATIONSHIP_MISMATCH", message: "derived operands must use the same reviewed relationship path." });
    }
    if (value.shape === "per_unit_average"
      && (numerator?.function !== "sum"
        || !["count", "count_distinct"].includes(denominator?.function ?? ""))) {
      errors.push({ path, code: "INVALID_PROTECTED_PER_UNIT_SHAPE", message: "per_unit_average requires SUM divided by COUNT or COUNT DISTINCT." });
    }
    return;
  }
  if (!PROTECTED_POST_AGGREGATE_SHAPES.has(String(value.shape))) {
    errors.push({
      path: `${path}.shape`,
      code: "INVALID_PROTECTED_DERIVED_SHAPE",
      message: "derived shape is not in the fixed reviewed calculation allowlist.",
    });
    return;
  }
  checkUnknownKeys(value, PROTECTED_POST_DERIVED_MEASURE_KEYS, path, errors);
  validateProtectedDerivedOperand(value.base_measure, `${path}.base_measure`, input, errors);
  if (value.shape === "rank") {
    if (value.direction !== "asc" && value.direction !== "desc") {
      errors.push({ path: `${path}.direction`, code: "PROTECTED_RANK_DIRECTION_REQUIRED", message: "rank requires a fixed asc or desc direction." });
    }
  } else if (value.direction !== undefined) {
    errors.push({ path: `${path}.direction`, code: "PROTECTED_TRANSFORM_DIRECTION_FORBIDDEN", message: "only rank may declare a direction." });
  }
  if (value.shape === "moving_average") {
    if (!Number.isSafeInteger(value.window_size) || Number(value.window_size) < 2 || Number(value.window_size) > 12) {
      errors.push({ path: `${path}.window_size`, code: "PROTECTED_MOVING_WINDOW_INVALID", message: "moving_average requires a fixed window_size from 2 through 12." });
    }
  } else if (value.window_size !== undefined) {
    errors.push({ path: `${path}.window_size`, code: "PROTECTED_TRANSFORM_WINDOW_FORBIDDEN", message: "only moving_average may declare a window_size." });
  }
  if (aggregate.comparison !== undefined) {
    errors.push({ path, code: "PROTECTED_TRANSFORM_COMPARISON_FORBIDDEN", message: "post-suppression calculations cannot be combined with a two-period comparison." });
  }
  if (PROTECTED_SEQUENTIAL_AGGREGATE_SHAPES.has(String(value.shape))) {
    if (!isRecord(aggregate.time_bucket)) {
      errors.push({ path, code: "PROTECTED_TRANSFORM_TIME_BUCKET_REQUIRED", message: `${String(value.shape)} requires one reviewed ordered time bucket.` });
    } else if (aggregate.time_bucket.bucket === "day_of_week") {
      errors.push({ path, code: "PROTECTED_TRANSFORM_TIME_BUCKET_UNORDERED", message: `${String(value.shape)} cannot use day_of_week because it is not a continuous calendar sequence.` });
    }
  } else {
    if (aggregate.time_bucket !== undefined) {
      errors.push({ path, code: "PROTECTED_TRANSFORM_TIME_BUCKET_FORBIDDEN", message: `${String(value.shape)} operates across released dimension groups and cannot use a time bucket.` });
    }
    if (!Array.isArray(aggregate.dimensions) || aggregate.dimensions.length === 0) {
      errors.push({ path, code: "PROTECTED_TRANSFORM_DIMENSION_REQUIRED", message: `${String(value.shape)} requires at least one reviewed dimension.` });
    }
  }
}

function validateProtectedDerivedOperand(
  value: unknown,
  path: string,
  input: {
    relationshipNames: Set<string>;
    keptOut: Set<string>;
    trustedScopeFields: Set<string>;
  },
  errors: ValidationIssue[],
): { function: string; relationship?: string } | undefined {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_DERIVED_OPERAND_REQUIRED", message: "a derived operand must be a fixed reviewed aggregate." });
    return undefined;
  }
  checkUnknownKeys(value, PROTECTED_DERIVED_OPERAND_KEYS, path, errors);
  if (!["count", "count_distinct", "sum", "avg"].includes(String(value.function))) {
    errors.push({ path: `${path}.function`, code: "INVALID_PROTECTED_DERIVED_OPERAND", message: "derived operands permit only count, count_distinct, sum, or avg." });
  }
  validateProtectedRelationshipReference(value.relationship, input.relationshipNames, `${path}.relationship`, errors);
  if (value.function === "count") {
    if (value.field !== undefined || value.relationship !== undefined) {
      errors.push({ path, code: "PROTECTED_DERIVED_COUNT_SHAPE_INVALID", message: "a derived COUNT operand counts scoped root rows and has no field or relationship." });
    }
  } else {
    validateProtectedFieldReference(value.field, value.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, path, errors);
  }
  return {
    function: String(value.function),
    ...(typeof value.relationship === "string" ? { relationship: value.relationship } : {}),
  };
}

function validateProtectedReadLimits(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_READ_LIMITS_REQUIRED", message: "protected_read requires immutable execution, response, extraction, and differencing limits." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_LIMIT_KEYS, path, errors);
  const ceilings: Record<string, number> = {
    max_rows: 100,
    max_groups: 500,
    max_ranked_groups: 10_000,
    max_response_cells: 10_000,
    max_response_bytes: 1_048_576,
    statement_timeout_ms: 30_000,
    max_queries_per_session: 1_000,
    max_extracted_cells_per_session: 100_000,
    max_differencing_queries: 100,
    rate_limit_per_minute: 120,
  };
  for (const [key, maximum] of Object.entries(ceilings)) {
    if (key === "max_ranked_groups" && value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > maximum) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_PROTECTED_READ_LIMIT", message: `${key} must be a positive integer no greater than ${maximum}.` });
    }
  }
  if (Number.isSafeInteger(value.max_ranked_groups)
    && Number.isSafeInteger(value.max_groups)
    && Number(value.max_ranked_groups) < Number(value.max_groups)) {
    errors.push({ path: `${path}.max_ranked_groups`, code: "INVALID_PROTECTED_RANKED_GROUP_LIMIT", message: "max_ranked_groups cannot be lower than max_groups." });
  }
}

function validateProtectedValue(value: unknown, args: JsonRecord, referencedArgs: Set<string>, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_VALUE_REQUIRED", message: "protected value must be exactly one fixed literal or one reviewed argument reference." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_VALUE_KEYS, path, errors);
  const hasFixed = Object.prototype.hasOwnProperty.call(value, "fixed");
  const hasArg = Object.prototype.hasOwnProperty.call(value, "from_arg");
  if (hasFixed === hasArg) {
    errors.push({ path, code: "PROTECTED_VALUE_EXACTLY_ONE_SOURCE", message: "protected value must declare exactly one of fixed or from_arg." });
    return;
  }
  if (hasFixed && !isJsonScalar(value.fixed)) errors.push({ path: `${path}.fixed`, code: "INVALID_PROTECTED_FIXED_VALUE", message: "fixed must be a JSON scalar." });
  if (hasArg) {
    const argument = isSafeIdentifier(value.from_arg) ? args[value.from_arg] : undefined;
    if (!isSafeIdentifier(value.from_arg) || !isRecord(argument) || argument.type === "object_array") {
      errors.push({ path: `${path}.from_arg`, code: "UNKNOWN_PROTECTED_VALUE_ARG", message: "from_arg must reference a declared scalar capability argument." });
    } else {
      referencedArgs.add(value.from_arg);
    }
  }
}

function validateProtectedFieldReference(
  field: unknown,
  relationship: unknown,
  relationshipNames: Set<string>,
  keptOut: Set<string>,
  trustedScopeFields: Set<string>,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!isSafeIdentifier(field)) {
    errors.push({ path: `${path}.field`, code: "INVALID_PROTECTED_FIELD", message: "protected field must be a fixed safe identifier." });
  } else if (relationship === undefined && (keptOut.has(field) || trustedScopeFields.has(field))) {
    errors.push({ path: `${path}.field`, code: "PROTECTED_FIELD_FORBIDDEN", message: "kept-out and trusted-scope fields cannot be selected, filtered, grouped, sorted, joined, aggregated, or counted distinctly." });
  }
  validateProtectedRelationshipReference(relationship, relationshipNames, `${path}.relationship`, errors);
}

function validateProtectedRelationshipReference(value: unknown, relationshipNames: Set<string>, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isSafeIdentifier(value) || !relationshipNames.has(value)) {
    errors.push({ path, code: "UNKNOWN_PROTECTED_RELATIONSHIP", message: "relationship must reference one of the capability's reviewed many-to-one paths." });
  }
}

function validateUniqueIdentifier(value: unknown, seen: Set<string>, path: string, code: string, errors: ValidationIssue[]): void {
  if (!isSafeIdentifier(value)) {
    errors.push({ path, code: "INVALID_PROTECTED_ALIAS", message: "reviewed aliases must be safe identifiers." });
    return;
  }
  if (seen.has(value)) errors.push({ path, code, message: `Duplicate reviewed alias: ${value}.` });
  seen.add(value);
}

function validateAggregateRead(capability: JsonRecord, path: string, errors: ValidationIssue[]): void {
  const aggregate = capability.aggregate;
  if (!isRecord(aggregate)) {
    errors.push({ path: `${path}.aggregate`, code: "AGGREGATE_READ_REQUIRED", message: "aggregate_read requires an aggregate definition." });
    return;
  }
  checkUnknownKeys(aggregate, AGGREGATE_READ_KEYS, `${path}.aggregate`, errors);
  const fn = String(aggregate.function);
  if (!["count", "sum", "avg"].includes(fn)) errors.push({ path: `${path}.aggregate.function`, code: "INVALID_AGGREGATE_FUNCTION", message: "aggregate function must be count, sum, or avg." });
  if (!Number.isSafeInteger(aggregate.minimum_group_size) || Number(aggregate.minimum_group_size) < 1 || Number(aggregate.minimum_group_size) > 1_000_000) {
    errors.push({ path: `${path}.aggregate.minimum_group_size`, code: "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", message: "aggregate reads require minimum_group_size from 1 through 1000000." });
  }
  if (fn === "count") {
    if (aggregate.count_mode !== "rows" && aggregate.count_mode !== "non_null") errors.push({ path: `${path}.aggregate.count_mode`, code: "COUNT_MODE_REQUIRED", message: "COUNT requires count_mode rows or non_null." });
    if (aggregate.count_mode === "rows" && aggregate.column !== undefined) errors.push({ path: `${path}.aggregate.column`, code: "COUNT_ROWS_COLUMN_FORBIDDEN", message: "COUNT rows must not declare a column." });
    if (aggregate.count_mode === "non_null" && !isSafeIdentifier(aggregate.column)) errors.push({ path: `${path}.aggregate.column`, code: "COUNT_COLUMN_REQUIRED", message: "COUNT non_null requires a fixed column." });
  } else {
    if (!isSafeIdentifier(aggregate.column)) errors.push({ path: `${path}.aggregate.column`, code: "AGGREGATE_NUMERIC_COLUMN_REQUIRED", message: "SUM/AVG require a fixed reviewed numeric column." });
    if (aggregate.count_mode !== undefined) errors.push({ path: `${path}.aggregate.count_mode`, code: "COUNT_MODE_COUNT_ONLY", message: "count_mode is valid only for COUNT." });
  }
  if (aggregate.selection !== undefined) validateFixedSelection(aggregate.selection, `${path}.aggregate.selection`, errors);
  if (isRecord(capability.args) && Object.keys(capability.args).length > 0) errors.push({ path: `${path}.args`, code: "AGGREGATE_MODEL_ARGS_FORBIDDEN", message: "the first aggregate-read release permits no model-controlled predicate arguments." });
  if (capability.lookup !== undefined) errors.push({ path: `${path}.lookup`, code: "AGGREGATE_LOOKUP_FORBIDDEN", message: "aggregate reads use only trusted scope and contract-fixed selection." });
  if (Array.isArray(capability.visible_fields) && capability.visible_fields.length > 0) errors.push({ path: `${path}.visible_fields`, code: "AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "aggregate reads return no source row fields." });
  if (!isRecord(capability.evidence) || capability.evidence.required !== true || capability.evidence.query_audit !== true) errors.push({ path: `${path}.evidence`, code: "AGGREGATE_EVIDENCE_REQUIRED", message: "aggregate reads require evidence and query audit." });
}

function validateFixedSelection(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "FIXED_SELECTION_REQUIRED", message: "selection must be a reviewed object." }); return; }
  checkUnknownKeys(value, SELECTION_KEYS, path, errors);
  if (!Array.isArray(value.all) || value.all.length < 1 || value.all.length > 8) { errors.push({ path: `${path}.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed equality terms." }); return; }
  value.all.forEach((term, index) => {
    const termPath = `${path}.all[${index}]`;
    if (!isRecord(term)) { errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." }); return; }
    checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column)) errors.push({ path: `${termPath}.column`, code: "INVALID_PREDICATE_COLUMN", message: "predicate column must be a fixed safe identifier." });
    if (term.operator !== "eq") errors.push({ path: `${termPath}.operator`, code: "INVALID_PREDICATE_OPERATOR", message: "only literal equality predicates are supported." });
    if (!("value" in term) || !isJsonScalar(term.value)) errors.push({ path: `${termPath}.value`, code: "FIXED_PREDICATE_VALUE_REQUIRED", message: "predicate value must be a contract literal." });
  });
}

function validateLookup(value: unknown, path: string, args: unknown, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "LOOKUP_NOT_OBJECT", message: "lookup must be an object." });
    return;
  }
  checkUnknownKeys(value, LOOKUP_KEYS, path, errors);
  if (!isSafeIdentifier(value.id_from_arg) || !isRecord(args) || !Object.prototype.hasOwnProperty.call(args, String(value.id_from_arg))) {
    errors.push({ path: `${path}.id_from_arg`, code: "UNKNOWN_LOOKUP_ARG", message: "lookup.id_from_arg must reference a model-facing arg." });
  }
}

function validateEvidenceRequirement(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "EVIDENCE_NOT_OBJECT", message: "evidence must be an object." });
    return;
  }
  checkUnknownKeys(value, EVIDENCE_KEYS, path, errors);
  if (typeof value.required !== "boolean") errors.push({ path: `${path}.required`, code: "INVALID_EVIDENCE_REQUIRED", message: "evidence.required must be boolean." });
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some((source) => !isNonEmptyString(source)))) errors.push({ path: `${path}.sources`, code: "INVALID_EVIDENCE_SOURCES", message: "evidence.sources must be non-empty strings." });
}

function validateProposalAction(value: unknown, subject: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROPOSAL_REQUIRED", message: "proposal capabilities must define proposal action semantics." });
    return;
  }
  checkUnknownKeys(value, PROPOSAL_KEYS, path, errors);
  if (!isQualifiedOrSafeName(value.action)) errors.push({ path: `${path}.action`, code: "INVALID_PROPOSAL_ACTION", message: "proposal.action must be a safe action name." });
  const organizationScoped = validateProtectedOrganizationScope(
    value.organization_scope,
    `${path}.organization_scope`,
    errors,
  );
  if (organizationScoped && isRecord(subject)) {
    if (isSafeIdentifier(subject.tenant_key)) {
      errors.push({
        path: `${path}.organization_scope`,
        code: "PROPOSAL_SCOPE_MODES_CONFLICT",
        message: "a proposal must use either a reviewed tenant column or one reviewed organization, never both.",
      });
    }
    if (subject.single_tenant_dev === true) {
      errors.push({
        path: `${path}.organization_scope`,
        code: "PROPOSAL_SCOPE_MODES_CONFLICT",
        message: "reviewed single-organization authority cannot be combined with single_tenant_dev.",
      });
    }
  }
  const operation = validateProposalOperation(value.operation, subject, value.patch, value.conflict_guard, `${path}.operation`, errors);
  const deleteOperation = operation === "delete";
  validateFieldList(value.allowed_fields, `${path}.allowed_fields`, "ALLOWED_FIELDS_REQUIRED", errors, deleteOperation);
  if (!isRecord(value.patch) || (!deleteOperation && Object.keys(value.patch).length === 0)) {
    errors.push({ path: `${path}.patch`, code: "PATCH_REQUIRED", message: "UPDATE and INSERT proposals must map allowed fields to fixed or arg values." });
  } else if (deleteOperation && Object.keys(value.patch).length > 0) {
    errors.push({ path: `${path}.patch`, code: "DELETE_PATCH_FORBIDDEN", message: "DELETE proposals must not contain a model-generated patch." });
  } else {
    for (const [field, patch] of Object.entries(value.patch)) {
      const patchPath = `${path}.patch.${field}`;
      if (!isSafeIdentifier(field)) errors.push({ path: patchPath, code: "INVALID_PATCH_FIELD", message: "patch field must be a safe identifier." });
      if (Array.isArray(value.allowed_fields) && !value.allowed_fields.includes(field)) errors.push({ path: patchPath, code: "PATCH_FIELD_NOT_ALLOWED", message: "patch field must be listed in allowed_fields." });
      if (!isRecord(patch)) {
        errors.push({ path: patchPath, code: "PATCH_BINDING_NOT_OBJECT", message: "patch binding must be an object." });
        continue;
      }
      checkUnknownKeys(patch, PATCH_KEYS, patchPath, errors);
      const bindingCount = [patch.fixed !== undefined, isSafeIdentifier(patch.from_arg), isSafeIdentifier(patch.from_item)].filter(Boolean).length;
      if (bindingCount !== 1) errors.push({ path: patchPath, code: "PATCH_BINDING_REQUIRED", message: "patch binding must include exactly one of fixed, from_arg, or from_item." });
    }
  }
  validateNumericBounds(value.numeric_bounds, value.patch, `${path}.numeric_bounds`, errors);
  validateTransitionGuards(value.transition_guards, value.patch, `${path}.transition_guards`, errors);
  if (value.reversibility !== undefined) {
    if (!isRecord(value.reversibility)) {
      errors.push({ path: `${path}.reversibility`, code: "REVERSIBILITY_NOT_OBJECT", message: "reversibility must be an object." });
    } else {
      checkUnknownKeys(value.reversibility, REVERSIBILITY_KEYS, `${path}.reversibility`, errors);
      if (value.reversibility.mode !== "reviewed_inverse") {
        errors.push({ path: `${path}.reversibility.mode`, code: "INVALID_REVERSIBILITY_MODE", message: "reversibility.mode must be reviewed_inverse." });
      }
    }
  }
  if (value.conflict_guard !== undefined) {
    if (!isRecord(value.conflict_guard)) errors.push({ path: `${path}.conflict_guard`, code: "CONFLICT_GUARD_NOT_OBJECT", message: "conflict_guard must be an object." });
    else {
      checkUnknownKeys(value.conflict_guard, CONFLICT_GUARD_KEYS, `${path}.conflict_guard`, errors);
      if (value.conflict_guard.column !== undefined && !isSafeIdentifier(value.conflict_guard.column)) errors.push({ path: `${path}.conflict_guard.column`, code: "INVALID_CONFLICT_COLUMN", message: "conflict_guard.column must be a safe identifier." });
      if (value.conflict_guard.column === undefined && value.conflict_guard.weak_guard_ack !== true) errors.push({ path: `${path}.conflict_guard`, code: "CONFLICT_GUARD_REQUIRED", message: "proposal needs conflict_guard.column unless weak_guard_ack is explicit." });
    }
  }
  if (value.approval !== undefined) {
    validateNestedObject(value.approval, APPROVAL_KEYS, `${path}.approval`, errors);
    if (isRecord(value.approval) && value.approval.mode !== undefined && !["human", "operator", "policy"].includes(String(value.approval.mode))) {
      errors.push({ path: `${path}.approval.mode`, code: "INVALID_APPROVAL_MODE", message: "approval.mode must be human, operator, or policy." });
    }
    if (isRecord(value.approval) && value.approval.required_approvals !== undefined
      && (!Number.isSafeInteger(value.approval.required_approvals) || Number(value.approval.required_approvals) < 1 || Number(value.approval.required_approvals) > 10)) {
      errors.push({
        path: `${path}.approval.required_approvals`,
        code: "INVALID_REQUIRED_APPROVALS",
        message: "approval.required_approvals must be a safe integer from 1 through 10.",
      });
    }
  }
  if (value.execution !== undefined) {
    validateNestedObject(value.execution, EXECUTION_KEYS, `${path}.execution`, errors);
    if (isRecord(value.execution) && value.execution.supervised_worker !== "allowed") {
      errors.push({
        path: `${path}.execution.supervised_worker`,
        code: "INVALID_SUPERVISED_WORKER_PERMISSION",
        message: "execution.supervised_worker must be allowed when the optional permission is present.",
      });
    }
    if (isRecord(value.execution) && value.execution.supervised_worker === "allowed") {
      const cardinality = isRecord(value.operation) ? value.operation.cardinality ?? "single" : "single";
      const writebackMode = isRecord(value.writeback) ? value.writeback.mode : "direct_sql";
      if (writebackMode !== "direct_sql") {
        errors.push({
          path: `${path}.writeback.mode`,
          code: "SUPERVISED_WORKER_DIRECT_SQL_REQUIRED",
          message: "supervised-worker execution is initially limited to Runner-owned direct_sql writeback.",
        });
      }
      if (cardinality !== "single") {
        errors.push({
          path: `${path}.operation.cardinality`,
          code: "SUPERVISED_WORKER_SINGLE_ROW_REQUIRED",
          message: "supervised-worker execution is initially limited to deterministic single-row writes.",
        });
      }
      if (deleteOperation) {
        errors.push({
          path: `${path}.operation.kind`,
          code: "SUPERVISED_WORKER_DELETE_FORBIDDEN",
          message: "hard DELETE is not eligible for supervised-worker execution in this release.",
        });
      }
      if (value.reversibility !== undefined) {
        errors.push({
          path: `${path}.reversibility`,
          code: "SUPERVISED_WORKER_REVERSIBILITY_FORBIDDEN",
          message: "reviewed compensation actions require manual execution in this release.",
        });
      }
      if (operation === "update"
        && (!isRecord(value.conflict_guard)
          || !isSafeIdentifier(value.conflict_guard.column)
          || value.conflict_guard.weak_guard_ack === true)) {
        errors.push({
          path: `${path}.conflict_guard.column`,
          code: "SUPERVISED_WORKER_EXACT_CONFLICT_GUARD_REQUIRED",
          message: "supervised-worker UPDATE requires an exact source version/conflict column; a weak row hash is not eligible.",
        });
      }
    }
  }
  if (value.writeback !== undefined) {
    validateNestedObject(value.writeback, WRITEBACK_KEYS, `${path}.writeback`, errors);
    if (isRecord(value.writeback) && !["direct_sql", "app_handler", "cloud_worker", "none"].includes(String(value.writeback.mode))) errors.push({ path: `${path}.writeback.mode`, code: "INVALID_WRITEBACK_MODE", message: "writeback.mode must be direct_sql, app_handler, cloud_worker, or none." });
  }
  if (organizationScoped) {
    const writebackMode = isRecord(value.writeback) ? value.writeback.mode : "direct_sql";
    if (writebackMode !== "none") {
      errors.push({
        path: `${path}.writeback.mode`,
        code: "PROPOSAL_ORGANIZATION_WRITEBACK_UNSUPPORTED",
        message: "reviewed single-organization proposal authority is proposal-only in this release; executable writeback still requires a direct reviewed tenant column.",
      });
    }
    if (value.execution !== undefined) {
      errors.push({
        path: `${path}.execution`,
        code: "PROPOSAL_ORGANIZATION_EXECUTION_UNSUPPORTED",
        message: "reviewed single-organization proposal authority cannot grant supervised execution in this release.",
      });
    }
    if (operation === "insert") {
      errors.push({
        path: `${path}.operation.kind`,
        code: "PROPOSAL_ORGANIZATION_INSERT_UNSUPPORTED",
        message: "reviewed single-organization proposal authority currently supports UPDATE and DELETE proposals; INSERT still requires source-enforced tenant deduplication.",
      });
    }
  }
  if (deleteOperation && isRecord(value.writeback) && value.writeback.mode === "direct_sql") {
    const approvalMode = isRecord(value.approval) ? value.approval.mode : undefined;
    if (approvalMode !== "human" && approvalMode !== "operator") {
      errors.push({ path: `${path}.approval.mode`, code: "HARD_DELETE_HUMAN_APPROVAL_REQUIRED", message: "Direct hard DELETE must require human/operator approval and cannot use policy auto-approval." });
    }
  }
  if (isRecord(value.operation) && value.operation.cardinality === "set") {
    const approvalMode = isRecord(value.approval) ? value.approval.mode : undefined;
    if (approvalMode !== "human" && approvalMode !== "operator") errors.push({ path: `${path}.approval.mode`, code: "SET_WRITE_HUMAN_APPROVAL_REQUIRED", message: "bounded set writes require human/operator approval in the first release." });
    if (!isRecord(value.writeback) || value.writeback.mode !== "direct_sql") errors.push({ path: `${path}.writeback.mode`, code: "SET_WRITE_DIRECT_SQL_REQUIRED", message: "bounded set writes require Runner-owned direct_sql writeback." });
    if (value.operation.kind === "update" && (!isRecord(value.operation.version_advance) || value.operation.version_advance.strategy !== "integer_increment")) errors.push({ path: `${path}.operation.version_advance`, code: "SET_INTEGER_VERSION_REQUIRED", message: "bounded set UPDATE requires integer_increment version advancement." });
  }
  if (isRecord(value.reversibility) && value.reversibility.mode === "reviewed_inverse") {
    const writebackMode = isRecord(value.writeback) ? value.writeback.mode : undefined;
    const approvalMode = isRecord(value.approval) ? value.approval.mode : undefined;
    if (writebackMode !== "direct_sql") {
      errors.push({ path: `${path}.writeback.mode`, code: "REVERSIBILITY_DIRECT_SQL_REQUIRED", message: "reviewed inverse capture is supported only for Runner-owned direct_sql writeback." });
    }
    if (approvalMode !== "human" && approvalMode !== "operator") {
      errors.push({ path: `${path}.approval.mode`, code: "REVERSIBILITY_HUMAN_APPROVAL_REQUIRED", message: "reversible writes require human/operator approval; policy auto-approval is not allowed." });
    }
    if (operation === "update") {
      if (!isRecord(value.conflict_guard) || !isSafeIdentifier(value.conflict_guard.column)) {
        errors.push({ path: `${path}.conflict_guard.column`, code: "REVERSIBILITY_CONFLICT_GUARD_REQUIRED", message: "reversible UPDATE requires an exact conflict_guard.column." });
      }
      if (!isRecord(value.operation) || !isRecord(value.operation.version_advance) || value.operation.version_advance.strategy !== "integer_increment") {
        errors.push({ path: `${path}.operation.version_advance`, code: "REVERSIBILITY_INTEGER_VERSION_REQUIRED", message: "reversible UPDATE requires integer_increment version advancement so compensation advances rather than rewinds concurrency state." });
      }
    }
    if (operation === "insert" && isRecord(subject)) {
      const primaryKey = subject.primary_key;
      const components = isRecord(value.operation) && isRecord(value.operation.deduplication) && Array.isArray(value.operation.deduplication.components)
        ? value.operation.deduplication.components
        : [];
      if (!isSafeIdentifier(primaryKey) || !components.some((component) => isRecord(component) && component.column === primaryKey)) {
        errors.push({ path: `${path}.operation.deduplication.components`, code: "REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED", message: "reversible INSERT requires a deterministic primary-key component in its reviewed deduplication key." });
      }
    }
  }
}

function validateProposalOperation(
  value: unknown,
  subject: unknown,
  patch: unknown,
  conflictGuard: unknown,
  path: string,
  errors: ValidationIssue[],
): "update" | "insert" | "delete" {
  if (value === undefined) return "update";
  if (!isRecord(value)) {
    errors.push({ path, code: "OPERATION_NOT_OBJECT", message: "proposal.operation must be an object." });
    return "update";
  }
  checkUnknownKeys(value, OPERATION_KEYS, path, errors);
  const kind = value.kind;
  if (kind !== "update" && kind !== "insert" && kind !== "delete") {
    errors.push({ path: `${path}.kind`, code: "INVALID_OPERATION_KIND", message: "operation.kind must be update, insert, or delete." });
    return "update";
  }
  const cardinality = value.cardinality ?? "single";
  if (cardinality !== "single" && cardinality !== "set") {
    errors.push({ path: `${path}.cardinality`, code: "INVALID_OPERATION_CARDINALITY", message: "operation.cardinality must be single or set." });
  }
  if (cardinality === "set") {
    validateSetOperation(value, kind, path, errors);
  } else {
    for (const key of ["selection", "max_rows", "aggregate_bounds", "batch"]) {
      if (value[key] !== undefined) errors.push({ path: `${path}.${key}`, code: "SET_FIELD_REQUIRES_SET_CARDINALITY", message: `${key} requires operation.cardinality set.` });
    }
  }
  if (value.version_advance !== undefined) {
    if (!isRecord(value.version_advance)) {
      errors.push({ path: `${path}.version_advance`, code: "VERSION_ADVANCE_NOT_OBJECT", message: "version_advance must be an object." });
    } else {
      checkUnknownKeys(value.version_advance, VERSION_ADVANCE_KEYS, `${path}.version_advance`, errors);
      if (!isSafeIdentifier(value.version_advance.column)) errors.push({ path: `${path}.version_advance.column`, code: "INVALID_VERSION_ADVANCE_COLUMN", message: "version_advance.column must be a fixed safe identifier." });
      if (value.version_advance.strategy !== "integer_increment" && value.version_advance.strategy !== "database_generated") errors.push({ path: `${path}.version_advance.strategy`, code: "INVALID_VERSION_ADVANCE_STRATEGY", message: "version_advance.strategy must be integer_increment or database_generated." });
      const conflictColumn = isRecord(conflictGuard) ? conflictGuard.column : undefined;
      if (isSafeIdentifier(value.version_advance.column) && value.version_advance.column !== conflictColumn) errors.push({ path: `${path}.version_advance.column`, code: "VERSION_ADVANCE_GUARD_MISMATCH", message: "version_advance.column must match conflict_guard.column." });
    }
    if (kind !== "update") errors.push({ path: `${path}.version_advance`, code: "VERSION_ADVANCE_UPDATE_ONLY", message: "version_advance is valid only for UPDATE." });
  }
  if (kind === "insert") {
    validateDeduplication(value.deduplication, subject, patch, `${path}.deduplication`, errors, cardinality === "set");
  } else if (value.deduplication !== undefined) {
    errors.push({ path: `${path}.deduplication`, code: "DEDUPLICATION_INSERT_ONLY", message: "deduplication is valid only for INSERT." });
  }
  if (kind === "delete") {
    if (!isRecord(conflictGuard) || !isSafeIdentifier(conflictGuard.column)) errors.push({ path: `${path.replace(/\.operation$/, "")}.conflict_guard.column`, code: "DELETE_CONFLICT_GUARD_REQUIRED", message: "DELETE requires an exact conflict_guard.column." });
  }
  return kind;
}

function validateSetOperation(value: JsonRecord, kind: "update" | "insert" | "delete", path: string, errors: ValidationIssue[]): void {
  if (!Number.isSafeInteger(value.max_rows) || Number(value.max_rows) < 1 || Number(value.max_rows) > SET_MAX_ROWS_HARD_CEILING) {
    errors.push({ path: `${path}.max_rows`, code: "SET_MAX_ROWS_REQUIRED", message: `bounded set writes require max_rows from 1 through ${SET_MAX_ROWS_HARD_CEILING}.` });
  }
  if (!Array.isArray(value.aggregate_bounds) || value.aggregate_bounds.length === 0 || value.aggregate_bounds.length > 8) {
    errors.push({ path: `${path}.aggregate_bounds`, code: "SET_AGGREGATE_BOUND_REQUIRED", message: "bounded set writes require 1 through 8 aggregate value bounds." });
  } else {
    value.aggregate_bounds.forEach((bound, index) => {
      const boundPath = `${path}.aggregate_bounds[${index}]`;
      if (!isRecord(bound)) {
        errors.push({ path: boundPath, code: "AGGREGATE_BOUND_NOT_OBJECT", message: "aggregate bound must be an object." });
        return;
      }
      checkUnknownKeys(bound, AGGREGATE_BOUND_KEYS, boundPath, errors);
      if (!isSafeIdentifier(bound.column)) errors.push({ path: `${boundPath}.column`, code: "INVALID_AGGREGATE_BOUND_COLUMN", message: "aggregate bound column must be a fixed safe identifier." });
      if (!["before", "after", "absolute_delta"].includes(String(bound.measure))) errors.push({ path: `${boundPath}.measure`, code: "INVALID_AGGREGATE_BOUND_MEASURE", message: "aggregate bound measure must be before, after, or absolute_delta." });
      if (!isFiniteNumber(bound.maximum) || Number(bound.maximum) < 0) errors.push({ path: `${boundPath}.maximum`, code: "INVALID_AGGREGATE_BOUND_MAXIMUM", message: "aggregate bound maximum must be a finite non-negative number." });
    });
  }
  if (kind === "insert") {
    if (value.selection !== undefined) errors.push({ path: `${path}.selection`, code: "BATCH_INSERT_SELECTION_FORBIDDEN", message: "batch INSERT reviews explicit items and cannot use a selection predicate." });
    if (!isRecord(value.batch)) errors.push({ path: `${path}.batch`, code: "BATCH_INSERT_ITEMS_REQUIRED", message: "batch INSERT requires batch.items_from_arg." });
    else {
      checkUnknownKeys(value.batch, BATCH_KEYS, `${path}.batch`, errors);
      if (!isSafeIdentifier(value.batch.items_from_arg)) errors.push({ path: `${path}.batch.items_from_arg`, code: "INVALID_BATCH_ITEMS_ARG", message: "batch.items_from_arg must be a fixed argument name." });
    }
    return;
  }
  if (value.batch !== undefined) errors.push({ path: `${path}.batch`, code: "BATCH_INSERT_ONLY", message: "batch is valid only for set INSERT." });
  if (!isRecord(value.selection)) {
    errors.push({ path: `${path}.selection`, code: "SET_FIXED_SELECTION_REQUIRED", message: "set UPDATE/DELETE requires a contract-fixed typed selection." });
    return;
  }
  checkUnknownKeys(value.selection, SELECTION_KEYS, `${path}.selection`, errors);
  if (!Array.isArray(value.selection.all) || value.selection.all.length === 0 || value.selection.all.length > 8) {
    errors.push({ path: `${path}.selection.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed predicate terms." });
    return;
  }
  value.selection.all.forEach((term, index) => {
    const termPath = `${path}.selection.all[${index}]`;
    if (!isRecord(term)) {
      errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." });
      return;
    }
    checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column)) errors.push({ path: `${termPath}.column`, code: "INVALID_PREDICATE_COLUMN", message: "predicate column must be a fixed safe identifier." });
    if (term.operator !== "eq") errors.push({ path: `${termPath}.operator`, code: "INVALID_PREDICATE_OPERATOR", message: "the first bounded-set release supports only literal equality predicates." });
    if (!("value" in term) || !isJsonScalar(term.value)) errors.push({ path: `${termPath}.value`, code: "FIXED_PREDICATE_VALUE_REQUIRED", message: "predicate value must be a contract literal." });
  });
}

function validateDeduplication(value: unknown, subject: unknown, patch: unknown, path: string, errors: ValidationIssue[], batch = false): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "INSERT_DEDUPLICATION_REQUIRED", message: "INSERT requires source-enforced deduplication components." });
    return;
  }
  checkUnknownKeys(value, DEDUPLICATION_KEYS, path, errors);
  if (!Array.isArray(value.components) || value.components.length === 0 || value.components.length > 8) {
    errors.push({ path: `${path}.components`, code: "INVALID_DEDUPLICATION_COMPONENTS", message: "deduplication.components must contain 1 through 8 fixed components." });
    return;
  }
  const seen = new Set<string>();
  let hasProposalId = false;
  let hasItemField = false;
  let hasTrustedTenant = false;
  const patchFields = isRecord(patch) ? new Set(Object.keys(patch)) : new Set<string>();
  const tenantKey = isRecord(subject) ? subject.tenant_key : undefined;
  value.components.forEach((component, index) => {
    const componentPath = `${path}.components[${index}]`;
    if (!isRecord(component)) {
      errors.push({ path: componentPath, code: "DEDUPLICATION_COMPONENT_NOT_OBJECT", message: "deduplication component must be an object." });
      return;
    }
    checkUnknownKeys(component, DEDUPLICATION_COMPONENT_KEYS, componentPath, errors);
    if (!isSafeIdentifier(component.column)) errors.push({ path: `${componentPath}.column`, code: "INVALID_DEDUPLICATION_COLUMN", message: "deduplication column must be a fixed safe identifier." });
    else if (seen.has(component.column)) errors.push({ path: `${componentPath}.column`, code: "DUPLICATE_DEDUPLICATION_COLUMN", message: "deduplication columns must be unique." });
    else seen.add(component.column);
    if (patchFields.has(String(component.column))) errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_COLUMN_MODEL_CONTROLLED", message: "deduplication columns are Runner-supplied and must not also be patch fields." });
    if (component.source !== "proposal_id" && component.source !== "trusted_tenant" && component.source !== "fixed" && component.source !== "item_field") errors.push({ path: `${componentPath}.source`, code: "INVALID_DEDUPLICATION_SOURCE", message: "deduplication source must be proposal_id, trusted_tenant, fixed, or item_field." });
    if (component.source === "proposal_id") hasProposalId = true;
    if (component.source === "item_field") {
      hasItemField = true;
      if (!isSafeIdentifier(component.item_field)) errors.push({ path: `${componentPath}.item_field`, code: "DEDUPLICATION_ITEM_FIELD_REQUIRED", message: "item_field deduplication requires a fixed item field name." });
    }
    if (component.source === "trusted_tenant") {
      if (isSafeIdentifier(tenantKey) && component.column === tenantKey) hasTrustedTenant = true;
      else errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_TENANT_MISMATCH", message: "trusted_tenant deduplication must map to subject.tenant_key." });
    }
    if (component.source === "fixed" && component.fixed === undefined) errors.push({ path: `${componentPath}.fixed`, code: "DEDUPLICATION_FIXED_VALUE_REQUIRED", message: "fixed deduplication components require fixed." });
    if (component.source !== "fixed" && component.fixed !== undefined) errors.push({ path: `${componentPath}.fixed`, code: "DEDUPLICATION_FIXED_VALUE_FORBIDDEN", message: "fixed is valid only when source is fixed." });
    if (component.source !== "item_field" && component.item_field !== undefined) errors.push({ path: `${componentPath}.item_field`, code: "DEDUPLICATION_ITEM_FIELD_FORBIDDEN", message: "item_field is valid only when source is item_field." });
  });
  if (batch ? !hasItemField : !hasProposalId) errors.push({ path: `${path}.components`, code: batch ? "ITEM_DEDUPLICATION_REQUIRED" : "PROPOSAL_DEDUPLICATION_REQUIRED", message: batch ? "batch INSERT deduplication must include a source-unique item_field component." : "INSERT deduplication must include a proposal_id component so retries are source-identifiable." });
  if (!hasTrustedTenant) errors.push({ path: `${path}.components`, code: "TRUSTED_TENANT_DEDUPLICATION_REQUIRED", message: "INSERT deduplication must include subject.tenant_key from trusted_tenant so retries cannot cross tenant scope." });
}

function validateNumericBounds(value: unknown, patch: unknown, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "NUMERIC_BOUNDS_NOT_OBJECT", message: "numeric_bounds must map patch fields to numeric bounds." });
    return;
  }
  const patchFields = isRecord(patch) ? new Set(Object.keys(patch)) : new Set<string>();
  for (const [field, bounds] of Object.entries(value)) {
    const boundPath = `${path}.${field}`;
    if (!isSafeIdentifier(field)) errors.push({ path: boundPath, code: "INVALID_NUMERIC_BOUND_FIELD", message: "numeric_bounds keys must be safe patch fields." });
    if (!patchFields.has(field)) errors.push({ path: boundPath, code: "NUMERIC_BOUND_PATCH_FIELD_REQUIRED", message: "numeric_bounds can only constrain fields in proposal.patch." });
    if (!isRecord(bounds)) {
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_NOT_OBJECT", message: "numeric bound must be an object." });
      continue;
    }
    checkUnknownKeys(bounds, NUMERIC_BOUND_KEYS, boundPath, errors);
    const hasMinimum = bounds.minimum !== undefined;
    const hasMaximum = bounds.maximum !== undefined;
    if (!hasMinimum && !hasMaximum) errors.push({ path: boundPath, code: "NUMERIC_BOUND_EMPTY", message: "numeric bound must define minimum, maximum, or both." });
    if (hasMinimum && !isFiniteNumber(bounds.minimum)) errors.push({ path: `${boundPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    if (hasMaximum && !isFiniteNumber(bounds.maximum)) errors.push({ path: `${boundPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    if (isFiniteNumber(bounds.minimum) && isFiniteNumber(bounds.maximum) && Number(bounds.minimum) > Number(bounds.maximum)) {
      errors.push({ path: boundPath, code: "INVALID_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    }
  }
}

function validateTransitionGuards(value: unknown, patch: unknown, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "TRANSITION_GUARDS_NOT_OBJECT", message: "transition_guards must map patch fields to allowed state transitions." });
    return;
  }
  const patchFields = isRecord(patch) ? new Set(Object.keys(patch)) : new Set<string>();
  for (const [field, guard] of Object.entries(value)) {
    const guardPath = `${path}.${field}`;
    if (!isSafeIdentifier(field)) errors.push({ path: guardPath, code: "INVALID_TRANSITION_GUARD_FIELD", message: "transition_guards keys must be safe patch fields." });
    if (!patchFields.has(field)) errors.push({ path: guardPath, code: "TRANSITION_GUARD_PATCH_FIELD_REQUIRED", message: "transition_guards can only constrain fields in proposal.patch." });
    if (!isRecord(guard)) {
      errors.push({ path: guardPath, code: "TRANSITION_GUARD_NOT_OBJECT", message: "transition guard must be an object." });
      continue;
    }
    checkUnknownKeys(guard, TRANSITION_GUARD_KEYS, guardPath, errors);
    if (guard.from_column !== undefined && !isSafeIdentifier(guard.from_column)) {
      errors.push({ path: `${guardPath}.from_column`, code: "INVALID_TRANSITION_FROM_COLUMN", message: "from_column must be a safe identifier." });
    }
    if (!isRecord(guard.allowed) || Object.keys(guard.allowed).length === 0) {
      errors.push({ path: `${guardPath}.allowed`, code: "TRANSITION_ALLOWED_REQUIRED", message: "transition guard must define allowed transitions." });
      continue;
    }
    for (const [from, toValues] of Object.entries(guard.allowed)) {
      const allowedPath = `${guardPath}.allowed.${from}`;
      if (!isNonEmptyString(from)) errors.push({ path: allowedPath, code: "TRANSITION_FROM_REQUIRED", message: "transition source state must be a non-empty string." });
      if (!Array.isArray(toValues) || toValues.length === 0 || toValues.some((item) => !isNonEmptyString(item))) {
        errors.push({ path: allowedPath, code: "TRANSITION_TO_VALUES_REQUIRED", message: "transition target states must be non-empty strings." });
      }
    }
  }
}

function validateWorkflows(value: unknown, contextNames: Set<string>, capabilityNames: Set<string>, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.workflows", code: "WORKFLOWS_NOT_ARRAY", message: "workflows must be an array." });
    return;
  }
  const names = new Set<string>();
  value.forEach((workflow, index) => {
    const path = `$.workflows[${index}]`;
    if (!isRecord(workflow)) {
      errors.push({ path, code: "WORKFLOW_NOT_OBJECT", message: "workflow must be an object." });
      return;
    }
    checkUnknownKeys(workflow, WORKFLOW_KEYS, path, errors);
    if (!isQualifiedName(workflow.name)) errors.push({ path: `${path}.name`, code: "INVALID_WORKFLOW_NAME", message: "workflow name must be namespace.name." });
    else addUnique(names, workflow.name, `${path}.name`, "DUPLICATE_WORKFLOW_NAME", errors);
    if (!isNonEmptyString(workflow.context) || !contextNames.has(workflow.context)) errors.push({ path: `${path}.context`, code: "UNKNOWN_CONTEXT", message: "workflow.context must reference a declared context." });
    if (!Array.isArray(workflow.allowed_capabilities) || workflow.allowed_capabilities.length === 0) {
      errors.push({ path: `${path}.allowed_capabilities`, code: "WORKFLOW_CAPABILITIES_REQUIRED", message: "workflow.allowed_capabilities must list allowed capabilities." });
    } else {
      workflow.allowed_capabilities.forEach((name, allowedIndex) => {
        if (!isNonEmptyString(name) || !capabilityNames.has(name)) errors.push({ path: `${path}.allowed_capabilities[${allowedIndex}]`, code: "UNKNOWN_CAPABILITY", message: "workflow allowed capability must reference a declared capability." });
      });
    }
  });
}

function validatePolicies(value: unknown, errors: ValidationIssue[]): Map<string, JsonRecord> {
  const names = new Map<string, JsonRecord>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.policies", code: "POLICIES_NOT_ARRAY", message: "$.policies must be an array." });
    return names;
  }
  value.forEach((policy, index) => {
    const path = `$.policies[${index}]`;
    if (!isRecord(policy)) {
      errors.push({ path, code: "POLICY_NOT_OBJECT", message: "policy entry must be an object." });
      return;
    }
    checkUnknownKeys(policy, POLICY_KEYS, path, errors);
    if (!isQualifiedOrSafeName(policy.name)) errors.push({ path: `${path}.name`, code: "INVALID_POLICY_NAME", message: "policy name must be a safe identifier or qualified name." });
    else {
      if (names.has(String(policy.name))) errors.push({ path: `${path}.name`, code: "DUPLICATE_POLICY_NAME", message: `Duplicate name: ${String(policy.name)}` });
      names.set(String(policy.name), policy);
    }
    if (!["approval", "settlement", "scope", "custom"].includes(String(policy.kind))) errors.push({ path: `${path}.kind`, code: "INVALID_POLICY_KIND", message: "policy.kind must be approval, settlement, scope, or custom." });
    if (policy.mode !== undefined && !["green", "yellow", "red", "manual", "block"].includes(String(policy.mode))) errors.push({ path: `${path}.mode`, code: "INVALID_POLICY_MODE", message: "policy.mode must be green, yellow, red, manual, or block." });
    if (policy.rules !== undefined) {
      if (!Array.isArray(policy.rules)) {
        errors.push({ path: `${path}.rules`, code: "POLICY_RULES_NOT_ARRAY", message: "policy.rules must be an array." });
      } else if (policy.kind === "approval") {
        policy.rules.forEach((rule, ruleIndex) => validateApprovalPolicyRuleShape(rule, `${path}.rules[${ruleIndex}]`, errors));
      }
    }
    if (policy.limits !== undefined) {
      if (!Array.isArray(policy.limits) || policy.limits.length === 0) {
        errors.push({ path: `${path}.limits`, code: "APPROVAL_POLICY_LIMITS_NOT_ARRAY", message: "approval policy limits must be a non-empty array." });
      } else if (policy.kind !== "approval") {
        errors.push({ path: `${path}.limits`, code: "APPROVAL_POLICY_LIMITS_KIND_REQUIRED", message: "aggregate limits are supported only for approval policies." });
      } else {
        policy.limits.forEach((limit, limitIndex) => validateApprovalPolicyLimitShape(limit, `${path}.limits[${limitIndex}]`, errors));
      }
    }
  });
  return names;
}

function validateApprovalPolicyLimitShape(limit: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(limit)) {
    errors.push({ path, code: "APPROVAL_POLICY_LIMIT_NOT_OBJECT", message: "approval policy limits must be objects." });
    return;
  }
  checkUnknownKeys(limit, APPROVAL_POLICY_LIMIT_KEYS, path, errors);
  if (limit.kind !== "count" && limit.kind !== "total") {
    errors.push({ path: `${path}.kind`, code: "INVALID_APPROVAL_POLICY_LIMIT_KIND", message: "approval policy limit kind must be count or total." });
  }
  if (!Number.isSafeInteger(limit.max) || Number(limit.max) < 0) {
    errors.push({ path: `${path}.max`, code: "INVALID_APPROVAL_POLICY_LIMIT_MAX", message: "approval policy limit max must be a safe non-negative integer." });
  }
  if (limit.period !== "day") {
    errors.push({ path: `${path}.period`, code: "INVALID_APPROVAL_POLICY_LIMIT_PERIOD", message: "approval policy limit period must be day." });
  }
  if (limit.scope !== undefined && limit.scope !== "tenant_policy" && limit.scope !== "tenant_policy_object") {
    errors.push({ path: `${path}.scope`, code: "INVALID_APPROVAL_POLICY_LIMIT_SCOPE", message: "approval policy limit scope must be tenant_policy or tenant_policy_object." });
  }
  if (limit.kind === "total" && !isSafeIdentifier(limit.field)) {
    errors.push({ path: `${path}.field`, code: "APPROVAL_POLICY_TOTAL_FIELD_REQUIRED", message: "total approval limits require a safe numeric field." });
  }
  if (limit.kind === "count" && limit.field !== undefined) {
    errors.push({ path: `${path}.field`, code: "APPROVAL_POLICY_COUNT_FIELD_FORBIDDEN", message: "count approval limits must not declare a field." });
  }
}

function validateApprovalPolicyRuleShape(rule: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(rule)) {
    errors.push({ path, code: "APPROVAL_POLICY_RULE_NOT_OBJECT", message: "approval policy rules must be objects." });
    return;
  }
  const keys = new Set(["source", "field", "max", "operator", "value", "values"]);
  checkUnknownKeys(rule, keys, path, errors);
  if (!isSafeIdentifier(rule.field)) errors.push({ path: `${path}.field`, code: "INVALID_APPROVAL_POLICY_FIELD", message: "approval policy rule field must be a safe identifier." });
  if (rule.source !== undefined && rule.source !== "patch" && rule.source !== "before") {
    errors.push({ path: `${path}.source`, code: "INVALID_APPROVAL_POLICY_SOURCE", message: "approval policy rule source must be patch or before." });
  }
  const legacy = rule.max !== undefined;
  if (legacy) {
    if (!Number.isInteger(rule.max) || Number(rule.max) < 0) errors.push({ path: `${path}.max`, code: "INVALID_APPROVAL_POLICY_MAX", message: "approval policy rule max must be a non-negative integer." });
    if (rule.source === "before" || rule.operator !== undefined || rule.value !== undefined || rule.values !== undefined) {
      errors.push({ path, code: "APPROVAL_POLICY_LEGACY_RULE_CONFLICT", message: "legacy max rules cannot also declare source, operator, value, or values." });
    }
    return;
  }
  if (rule.operator !== "lte" && rule.operator !== "gte" && rule.operator !== "eq" && rule.operator !== "in" && rule.operator !== "max_length") {
    errors.push({ path: `${path}.operator`, code: "INVALID_APPROVAL_POLICY_OPERATOR", message: "typed approval rules require lte, gte, eq, in, or max_length." });
    return;
  }
  if (rule.operator === "in") {
    if (!Array.isArray(rule.values) || rule.values.length < 1 || rule.values.length > 64 || rule.values.some((value) => !isJsonScalar(value))) {
      errors.push({ path: `${path}.values`, code: "INVALID_APPROVAL_POLICY_VALUES", message: "in rules require 1 through 64 JSON scalar values." });
    }
    if (rule.value !== undefined) errors.push({ path: `${path}.value`, code: "APPROVAL_POLICY_VALUE_FORBIDDEN", message: "in rules use values, not value." });
  } else {
    if (!isJsonScalar(rule.value)) errors.push({ path: `${path}.value`, code: "INVALID_APPROVAL_POLICY_VALUE", message: "lte, gte, and eq rules require one JSON scalar value." });
    if (rule.values !== undefined) errors.push({ path: `${path}.values`, code: "APPROVAL_POLICY_VALUES_FORBIDDEN", message: "lte, gte, and eq rules use value, not values." });
    if ((rule.operator === "lte" || rule.operator === "gte" || rule.operator === "max_length") && typeof rule.value !== "number") {
      errors.push({ path: `${path}.value`, code: "APPROVAL_POLICY_NUMERIC_VALUE_REQUIRED", message: "lte, gte, and max_length rules require a numeric value." });
    }
    if (rule.operator === "max_length" && (!Number.isSafeInteger(rule.value) || Number(rule.value) < 1)) {
      errors.push({ path: `${path}.value`, code: "APPROVAL_POLICY_LENGTH_INVALID", message: "max_length rules require a positive safe integer." });
    }
  }
}

function validateCapabilityApprovalPolicies(capabilities: unknown[], policies: unknown[], policyByName: Map<string, JsonRecord>, errors: ValidationIssue[]): void {
  const policyIndexByName = new Map<string, number>();
  policies.forEach((policy, index) => {
    if (isRecord(policy) && typeof policy.name === "string") policyIndexByName.set(policy.name, index);
  });
  capabilities.forEach((capability, index) => {
    if (!isRecord(capability) || !isRecord(capability.proposal)) return;
    const proposal = capability.proposal as ProposalActionSpec;
    const approval = proposal.approval;
    if (!isRecord(approval)) return;
    const path = `$.capabilities[${index}].proposal.approval`;
    const mode = approval.mode;
    const policyName = approval.policy;
    if (mode === "policy") {
      if (!isNonEmptyString(approval.required_role)) {
        errors.push({ path: `${path}.required_role`, code: "APPROVAL_POLICY_ROLE_REQUIRED", message: "approval.mode policy still requires required_role for human fallback." });
      }
      if (!isQualifiedOrSafeName(policyName)) {
        errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_REQUIRED", message: "approval.mode policy requires approval.policy." });
        return;
      }
      const policy = policyByName.get(policyName);
      if (!policy) {
        errors.push({ path: `${path}.policy`, code: "UNKNOWN_APPROVAL_POLICY", message: `approval.policy must reference an existing approval policy: ${policyName}` });
        return;
      }
      if (policy.kind !== "approval") {
        errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_KIND_REQUIRED", message: "approval.policy must reference a policy with kind approval." });
        return;
      }
      validateApprovalPolicyRulesAgainstCapability(policy, policyIndexByName.get(policyName) ?? 0, capability as CapabilitySpec, index, errors);
    } else if (policyName !== undefined) {
      errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_MODE_REQUIRED", message: "approval.policy can only be set when approval.mode is policy." });
    }
  });
}

function validateApprovalPolicyRulesAgainstCapability(policy: JsonRecord, policyIndex: number, capability: CapabilitySpec, capabilityIndex: number, errors: ValidationIssue[]): void {
  const proposal = capability.proposal;
  if (!proposal) return;
  if (Array.isArray(policy.rules)) policy.rules.forEach((rule, ruleIndex) => {
    if (!isRecord(rule)) return;
    const field = rule.field;
    const max = rule.max;
    const rulePath = `$.policies[${policyIndex}].rules[${ruleIndex}]`;
    if (!isSafeIdentifier(field)) return;
    const source = rule.source === "before" ? "before" : "patch";
    const operator = typeof max === "number" ? "lte" : rule.operator;
    const value = typeof max === "number" ? max : rule.value;
    if (source === "patch" && !Object.prototype.hasOwnProperty.call(proposal.patch, field)) {
      errors.push({
        path: `${rulePath}.field`,
        code: "APPROVAL_POLICY_FIELD_NOT_PATCHED",
        message: `approval policy patch field ${field} must be written by capability ${capability.name}.`,
      });
      return;
    }
    if (source === "before"
      && !capability.visible_fields.includes(field)
      && proposal.conflict_guard?.column !== field
      && !Object.prototype.hasOwnProperty.call(proposal.transition_guards ?? {}, field)) {
      errors.push({
        path: `${rulePath}.field`,
        code: "APPROVAL_POLICY_BEFORE_FIELD_NOT_CAPTURED",
        message: `approval policy before field ${field} must be in the reviewed pre-change snapshot for ${capability.name}.`,
      });
      return;
    }
    if ((operator === "lte" || operator === "gte") && !isNumericProposalField(proposal, capability.args, field)) {
      errors.push({
        path: `${rulePath}.field`,
        code: "APPROVAL_POLICY_FIELD_NOT_NUMERIC",
        message: `approval policy ${operator} field ${field} must be numeric for capability ${capability.name}.`,
      });
    }
    const bound = proposal.numeric_bounds?.[field];
    if (operator === "lte" && bound?.maximum !== undefined && Number(value) > Number(bound.maximum)) {
      errors.push({
        path: `${rulePath}.${max !== undefined ? "max" : "value"}`,
        code: "APPROVAL_POLICY_MAX_EXCEEDS_BOUND",
        message: `approval policy max for ${field} must be <= numeric_bounds maximum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.maximum.`,
      });
    }
    if (operator === "lte" && bound?.minimum !== undefined && Number(value) < Number(bound.minimum)) {
      errors.push({
        path: `${rulePath}.${max !== undefined ? "max" : "value"}`,
        code: "APPROVAL_POLICY_MAX_BELOW_BOUND",
        message: `approval policy max for ${field} must be >= numeric_bounds minimum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.minimum.`,
      });
    }
    if (operator === "gte" && bound?.minimum !== undefined && Number(value) < Number(bound.minimum)) {
      errors.push({
        path: `${rulePath}.value`,
        code: "APPROVAL_POLICY_MIN_BELOW_BOUND",
        message: `approval policy minimum for ${field} must be >= numeric_bounds minimum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.minimum.`,
      });
    }
    if (operator === "gte" && bound?.maximum !== undefined && Number(value) > Number(bound.maximum)) {
      errors.push({
        path: `${rulePath}.value`,
        code: "APPROVAL_POLICY_MIN_ABOVE_BOUND",
        message: `approval policy minimum for ${field} must be <= numeric_bounds maximum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.maximum.`,
      });
    }
    if (source === "patch" && (operator === "eq" || operator === "in")) {
      const patch = proposal.patch[field];
      const argument = patch?.from_arg ? capability.args[patch.from_arg] : undefined;
      const values = operator === "in" && Array.isArray(rule.values) ? rule.values : [value];
      if (argument && argument.type !== "object_array" && argument.enum?.length
        && values.some((candidate) => !argument.enum!.some((allowed) => allowed === candidate))) {
        errors.push({
          path: `${rulePath}.${operator === "in" ? "values" : "value"}`,
          code: "APPROVAL_POLICY_VALUE_OUTSIDE_ENUM",
          message: `approval policy values for ${field} must stay inside the reviewed argument enum for ${capability.name}.`,
        });
      }
    }
    if (source === "patch" && operator === "max_length") {
      const patch = proposal.patch[field];
      const argument = patch?.from_arg ? capability.args[patch.from_arg] : undefined;
      if (!argument || argument.type !== "string") {
        errors.push({
          path: `${rulePath}.field`,
          code: "APPROVAL_POLICY_LENGTH_FIELD_NOT_STRING",
          message: `approval policy max_length field ${field} must come from a reviewed string argument for ${capability.name}.`,
        });
      } else if (argument.max_length !== undefined && Number(value) > argument.max_length) {
        errors.push({
          path: `${rulePath}.value`,
          code: "APPROVAL_POLICY_LENGTH_EXCEEDS_BOUND",
          message: `approval policy max_length for ${field} must be <= the reviewed argument max_length for ${capability.name}.`,
        });
      }
    }
  });
  if (Array.isArray(policy.limits)) policy.limits.forEach((limit, limitIndex) => {
    if (!isRecord(limit) || limit.kind !== "total" || !isSafeIdentifier(limit.field)) return;
    if (!isNumericProposalField(proposal, capability.args, limit.field)) {
      errors.push({
        path: `$.policies[${policyIndex}].limits[${limitIndex}].field`,
        code: "APPROVAL_POLICY_TOTAL_FIELD_NOT_NUMERIC",
        message: `aggregate approval total field ${limit.field} must be numeric for capability ${capability.name}.`,
      });
    }
  });
}

export function isNumericProposalField(proposal: ProposalActionSpec, args: CapabilitySpec["args"], field: string): boolean {
  if (proposal.numeric_bounds?.[field] !== undefined) return true;
  const patch = proposal.patch?.[field];
  if (!patch) return false;
  if (typeof patch.fixed === "number" && Number.isInteger(patch.fixed)) return true;
  if (patch.from_arg && args[patch.from_arg]?.type === "number") return true;
  return false;
}

export function isPolicyQualifyingInteger(value: JsonScalar): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function validateEvidenceRecords(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  validateArrayRecords(value, "$.evidence", EVIDENCE_RECORD_KEYS, "EVIDENCE", errors);
}

function validateProposalRecords(value: unknown, capabilityNames: Set<string>, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.proposals", code: "PROPOSALS_NOT_ARRAY", message: "proposals must be an array." });
    return;
  }
  value.forEach((proposal, index) => {
    const path = `$.proposals[${index}]`;
    if (!isRecord(proposal)) {
      errors.push({ path, code: "PROPOSAL_NOT_OBJECT", message: "proposal must be an object." });
      return;
    }
    checkUnknownKeys(proposal, PROPOSAL_RECORD_KEYS, path, errors);
    if (!isNonEmptyString(proposal.id)) errors.push({ path: `${path}.id`, code: "INVALID_PROPOSAL_ID", message: "proposal.id must be non-empty." });
    if (!isNonEmptyString(proposal.capability) || (capabilityNames.size > 0 && !capabilityNames.has(String(proposal.capability)))) errors.push({ path: `${path}.capability`, code: "UNKNOWN_CAPABILITY", message: "proposal.capability must reference a declared capability." });
  });
}

function validateReceiptRecords(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  validateArrayRecords(value, "$.receipts", RECEIPT_KEYS, "RECEIPT", errors);
}

function validateReplay(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.replay", code: "REPLAY_NOT_ARRAY", message: "replay must be an array." });
    return;
  }
  value.forEach((record, index) => {
    const path = `$.replay[${index}]`;
    if (!isRecord(record)) {
      errors.push({ path, code: "REPLAY_RECORD_NOT_OBJECT", message: "replay record must be an object." });
      return;
    }
    checkUnknownKeys(record, REPLAY_KEYS, path, errors);
    if (!isNonEmptyString(record.id)) errors.push({ path: `${path}.id`, code: "INVALID_REPLAY_ID", message: "replay id must be non-empty." });
    if (!Array.isArray(record.events)) errors.push({ path: `${path}.events`, code: "REPLAY_EVENTS_REQUIRED", message: "replay.events must be an array." });
  });
}

function validateExternalActions(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  validateArrayRecords(value, "$.external_actions", EXTERNAL_ACTION_KEYS, "EXTERNAL_ACTION", errors);
}

function validateActionRuleAuthority(
  contract: JsonRecord,
  resourceNames: Set<string>,
  contextNames: Set<string>,
  errors: ValidationIssue[],
): void {
  const boundaryNames = new Set<string>();
  const envelopeNames = new Set<string>();

  if (contract.verification_boundaries !== undefined) {
    if (!Array.isArray(contract.verification_boundaries)) {
      errors.push({ path: "$.verification_boundaries", code: "VERIFICATION_BOUNDARIES_NOT_ARRAY", message: "verification_boundaries must be an array." });
    } else {
      contract.verification_boundaries.forEach((raw, index) => {
        const path = `$.verification_boundaries[${index}]`;
        if (!isRecord(raw)) {
          errors.push({ path, code: "VERIFICATION_BOUNDARY_NOT_OBJECT", message: "verification boundary must be an object." });
          return;
        }
        checkUnknownKeys(raw, VERIFICATION_BOUNDARY_KEYS, path, errors);
        if (raw.schema_version !== "synapsor.verification-boundary.v1") errors.push({ path: `${path}.schema_version`, code: "INVALID_VERIFICATION_BOUNDARY_VERSION", message: "schema_version must be synapsor.verification-boundary.v1." });
        validateNamedAuthority(raw.name, `${path}.name`, boundaryNames, "VERIFICATION_BOUNDARY", errors);
        if (!isSafeIdentifier(raw.source)) errors.push({ path: `${path}.source`, code: "INVALID_VERIFICATION_SOURCE", message: "source must be a fixed safe identifier." });
        if (!isQualifiedOrSafeName(raw.context) || !contextNames.has(String(raw.context))) errors.push({ path: `${path}.context`, code: "UNKNOWN_VERIFICATION_CONTEXT", message: "context must reference a declared trusted context." });
        if (!isSha256Digest(raw.generation_lock_fingerprint)) errors.push({ path: `${path}.generation_lock_fingerprint`, code: "INVALID_VERIFICATION_GENERATION_LOCK", message: "generation_lock_fingerprint must be an exact sha256 digest." });
        validateVerificationResources(raw.resources, path, resourceNames, errors);
        if (!Array.isArray(raw.lock_order) || raw.lock_order.length === 0 || raw.lock_order.some((item) => !isSafeIdentifier(item))) errors.push({ path: `${path}.lock_order`, code: "INVALID_VERIFICATION_LOCK_ORDER", message: "lock_order must contain fixed binding names." });
        if (!isRecord(raw.transaction)) errors.push({ path: `${path}.transaction`, code: "VERIFICATION_TRANSACTION_REQUIRED", message: "transaction must freeze isolation and UTC timezone." });
        else {
          checkUnknownKeys(raw.transaction, VERIFICATION_TRANSACTION_KEYS, `${path}.transaction`, errors);
          if (!["read_committed", "repeatable_read", "serializable"].includes(String(raw.transaction.isolation))) errors.push({ path: `${path}.transaction.isolation`, code: "INVALID_VERIFICATION_ISOLATION", message: "unsupported transaction isolation." });
          if (raw.transaction.timezone !== "UTC") errors.push({ path: `${path}.transaction.timezone`, code: "VERIFICATION_TIMEZONE_MUST_BE_UTC", message: "Action Rule verification uses UTC." });
        }
      });
    }
  }

  if (contract.derived_effect_envelopes !== undefined) {
    if (!Array.isArray(contract.derived_effect_envelopes)) {
      errors.push({ path: "$.derived_effect_envelopes", code: "EFFECT_ENVELOPES_NOT_ARRAY", message: "derived_effect_envelopes must be an array." });
    } else {
      contract.derived_effect_envelopes.forEach((raw, index) => {
        const path = `$.derived_effect_envelopes[${index}]`;
        if (!isRecord(raw)) {
          errors.push({ path, code: "EFFECT_ENVELOPE_NOT_OBJECT", message: "derived effect envelope must be an object." });
          return;
        }
        checkUnknownKeys(raw, EFFECT_ENVELOPE_KEYS, path, errors);
        if (raw.schema_version !== "synapsor.derived-effect-envelope.v1") errors.push({ path: `${path}.schema_version`, code: "INVALID_EFFECT_ENVELOPE_VERSION", message: "schema_version must be synapsor.derived-effect-envelope.v1." });
        validateNamedAuthority(raw.name, `${path}.name`, envelopeNames, "EFFECT_ENVELOPE", errors);
        if (!isSafeIdentifier(raw.source)) errors.push({ path: `${path}.source`, code: "INVALID_EFFECT_SOURCE", message: "source must be a fixed safe identifier." });
        if (raw.operation !== "update" && raw.operation !== "insert") errors.push({ path: `${path}.operation`, code: "INVALID_DERIVED_EFFECT_OPERATION", message: "derived effects support update or insert only." });
        if (!isQualifiedOrSafeName(raw.target_resource) || !resourceNames.has(String(raw.target_resource))) errors.push({ path: `${path}.target_resource`, code: "UNKNOWN_EFFECT_RESOURCE", message: "target_resource must reference a declared resource." });
        for (const key of ["target_binding", "primary_key", "tenant_key", "principal_scope_key", "conflict_key"] as const) {
          if (raw[key] !== undefined && !isSafeIdentifier(raw[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_EFFECT_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
        }
        if (!isSafeIdentifier(raw.primary_key)) errors.push({ path: `${path}.primary_key`, code: "DERIVED_EFFECT_PRIMARY_KEY_REQUIRED", message: "derived effects require one exact target primary key." });
        const organizationScoped = validateProtectedOrganizationScope(raw.organization_scope, `${path}.organization_scope`, errors);
        if ((raw.tenant_key === undefined) === !organizationScoped) {
          errors.push({
            path,
            code: "DERIVED_EFFECT_SCOPE_REQUIRED",
            message: "derived effect envelope must declare exactly one trusted tenant key or reviewed single-organization scope.",
          });
        }
        if (raw.max_rows !== 1) errors.push({ path: `${path}.max_rows`, code: "DERIVED_EFFECT_SINGLE_ROW_REQUIRED", message: "first-release derived effects must change exactly one row." });
        validateDerivedEffectFields(raw.allowed_fields, path, errors);
        if (raw.operation === "update") {
          if (!isSafeIdentifier(raw.target_binding) || !isSafeIdentifier(raw.conflict_key)) errors.push({ path, code: "DERIVED_UPDATE_GUARDS_REQUIRED", message: "derived UPDATE requires target_binding and conflict_key." });
          if (raw.deduplication !== undefined) errors.push({ path: `${path}.deduplication`, code: "DERIVED_UPDATE_DEDUP_FORBIDDEN", message: "derived UPDATE uses row identity and a conflict guard, not INSERT deduplication." });
        }
        if (raw.operation === "insert") {
          if (!isRecord(raw.deduplication)) errors.push({ path: `${path}.deduplication`, code: "DERIVED_INSERT_DEDUP_REQUIRED", message: "derived INSERT requires reviewed source-enforced deduplication." });
          for (const key of ["target_binding", "conflict_key", "version_advance"] as const) {
            if (raw[key] !== undefined) errors.push({ path: `${path}.${key}`, code: "DERIVED_INSERT_UPDATE_GUARD_FORBIDDEN", message: `derived INSERT cannot declare UPDATE-only ${key}.` });
          }
        }
        if (raw.version_advance !== undefined) {
          if (!isRecord(raw.version_advance)) errors.push({ path: `${path}.version_advance`, code: "INVALID_DERIVED_VERSION_ADVANCE", message: "version_advance must freeze one integer conflict-column increment." });
          else {
            checkUnknownKeys(raw.version_advance, EFFECT_VERSION_ADVANCE_KEYS, `${path}.version_advance`, errors);
            if (!isSafeIdentifier(raw.version_advance.column) || raw.version_advance.strategy !== "integer_increment") errors.push({ path: `${path}.version_advance`, code: "INVALID_DERIVED_VERSION_ADVANCE", message: "version_advance must freeze one integer conflict-column increment." });
            if (raw.operation === "update" && raw.version_advance.column !== raw.conflict_key) errors.push({ path: `${path}.version_advance.column`, code: "DERIVED_VERSION_GUARD_MISMATCH", message: "version_advance must increment the reviewed conflict key." });
          }
        }
        if (raw.deduplication !== undefined) validateDerivedDedup(raw.deduplication, `${path}.deduplication`, errors);
        if (!Array.isArray(raw.approval_classes)
          || raw.approval_classes.length === 0
          || raw.approval_classes.length > 64
          || raw.approval_classes.some((item) => !isDottedName(item))
          || new Set(raw.approval_classes).size !== raw.approval_classes.length) errors.push({ path: `${path}.approval_classes`, code: "EFFECT_APPROVAL_CLASSES_REQUIRED", message: "approval_classes must contain 1 through 64 unique fixed names." });
        if (!isRecord(raw.writeback)) errors.push({ path: `${path}.writeback`, code: "EFFECT_WRITEBACK_REQUIRED", message: "writeback posture is required." });
        else {
          checkUnknownKeys(raw.writeback, EFFECT_WRITEBACK_KEYS, `${path}.writeback`, errors);
          if (raw.writeback.mode !== "none" && raw.writeback.mode !== "direct_sql") errors.push({ path: `${path}.writeback.mode`, code: "INVALID_DERIVED_WRITEBACK", message: "derived effects support none or direct_sql." });
          if (raw.writeback.supervised_worker !== "disabled" && raw.writeback.supervised_worker !== "allowed") errors.push({ path: `${path}.writeback.supervised_worker`, code: "INVALID_DERIVED_WORKER_POSTURE", message: "supervised_worker must be disabled or allowed." });
          if (raw.writeback.mode === "none" && raw.writeback.supervised_worker === "allowed") errors.push({ path: `${path}.writeback`, code: "INVALID_DERIVED_WORKER_POSTURE", message: "a supervised worker requires reviewed direct_sql writeback." });
        }
      });
    }
  }

  if (contract.action_rules === undefined) return;
  if (!Array.isArray(contract.action_rules)) {
    errors.push({ path: "$.action_rules", code: "ACTION_RULES_NOT_ARRAY", message: "action_rules must be an array." });
    return;
  }
  const ruleNames = new Set<string>();
  const outcomes = new Set<string>();
  contract.action_rules.forEach((raw, index) => {
    const path = `$.action_rules[${index}]`;
    if (!isRecord(raw)) {
      errors.push({ path, code: "ACTION_RULE_NOT_OBJECT", message: "action rule must be an object." });
      return;
    }
    checkUnknownKeys(raw, ACTION_RULE_KEYS, path, errors);
    if (raw.schema_version !== "synapsor.action-rule.v1") errors.push({ path: `${path}.schema_version`, code: "INVALID_ACTION_RULE_VERSION", message: "schema_version must be synapsor.action-rule.v1." });
    validateNamedAuthority(raw.name, `${path}.name`, ruleNames, "ACTION_RULE", errors);
    if (!isDottedName(raw.outcome)) errors.push({ path: `${path}.outcome`, code: "INVALID_ACTION_OUTCOME", message: "outcome must be a fixed qualified business name." });
    else addUnique(outcomes, raw.outcome, `${path}.outcome`, "DUPLICATE_ACTION_OUTCOME", errors);
    if (!isQualifiedOrSafeName(raw.context) || !contextNames.has(String(raw.context))) errors.push({ path: `${path}.context`, code: "UNKNOWN_ACTION_RULE_CONTEXT", message: "context must reference a declared trusted context." });
    if (!isSafeIdentifier(raw.source)) errors.push({ path: `${path}.source`, code: "INVALID_ACTION_RULE_SOURCE", message: "source must be a fixed safe identifier." });
    if (!boundaryNames.has(String(raw.verification_boundary_ref))) errors.push({ path: `${path}.verification_boundary_ref`, code: "UNKNOWN_VERIFICATION_BOUNDARY", message: "verification_boundary_ref must reference this contract." });
    if (!envelopeNames.has(String(raw.effect_envelope_ref))) errors.push({ path: `${path}.effect_envelope_ref`, code: "UNKNOWN_EFFECT_ENVELOPE", message: "effect_envelope_ref must reference this contract." });
    validateActionRuleSubjects(raw.subjects, path, resourceNames, errors);
    if (raw.inputs !== undefined) validateRuleInputs(raw.inputs, `${path}.inputs`, errors);
    validateRuleBooleanExpression(raw.require, `${path}.require`, errors, 0);
    if (!isRecord(raw.derive)) errors.push({ path: `${path}.derive`, code: "ACTION_RULE_DERIVE_NOT_OBJECT", message: "derive must map fixed names to scalar expressions." });
    else for (const [name, expression] of Object.entries(raw.derive)) {
      if (!isSafeIdentifier(name)) errors.push({ path: `${path}.derive.${name}`, code: "INVALID_DERIVED_NAME", message: "derived value names must be safe identifiers." });
      validateRuleScalarExpression(expression, `${path}.derive.${name}`, errors, 0);
    }
    if (!isRecord(raw.effect)) errors.push({ path: `${path}.effect`, code: "ACTION_RULE_EFFECT_REQUIRED", message: "effect must be an exact object." });
    else {
      checkUnknownKeys(raw.effect, ACTION_RULE_EFFECT_KEYS, `${path}.effect`, errors);
      if (raw.effect.operation !== "update" && raw.effect.operation !== "insert") errors.push({ path: `${path}.effect.operation`, code: "INVALID_ACTION_RULE_EFFECT", message: "effect operation must be update or insert." });
      if (!isQualifiedOrSafeName(raw.effect.target_resource) || !resourceNames.has(String(raw.effect.target_resource))) errors.push({ path: `${path}.effect.target_resource`, code: "UNKNOWN_ACTION_RULE_EFFECT_RESOURCE", message: "effect target_resource must reference a declared resource." });
      if (raw.effect.target_binding !== undefined && !isSafeIdentifier(raw.effect.target_binding)) errors.push({ path: `${path}.effect.target_binding`, code: "INVALID_ACTION_RULE_TARGET_BINDING", message: "target_binding must be a safe identifier." });
      if (!isRecord(raw.effect.set) || Object.keys(raw.effect.set).length === 0) errors.push({ path: `${path}.effect.set`, code: "ACTION_RULE_EFFECT_SET_REQUIRED", message: "effect.set must contain at least one derived field." });
      else for (const [field, expression] of Object.entries(raw.effect.set)) {
        if (!isSafeIdentifier(field)) errors.push({ path: `${path}.effect.set.${field}`, code: "INVALID_ACTION_RULE_EFFECT_FIELD", message: "effect fields must be safe identifiers." });
        validateRuleScalarExpression(expression, `${path}.effect.set.${field}`, errors, 0);
      }
    }
    if (!isDottedName(raw.approval_class)) errors.push({ path: `${path}.approval_class`, code: "INVALID_ACTION_RULE_APPROVAL_CLASS", message: "approval_class must be a fixed name." });
    if (!Number.isSafeInteger(raw.ttl_seconds) || Number(raw.ttl_seconds) < 15 || Number(raw.ttl_seconds) > 3600) errors.push({ path: `${path}.ttl_seconds`, code: "INVALID_ACTION_RULE_TTL", message: "ttl_seconds must be an integer from 15 through 3600." });
  });
}

function validateVerificationResources(value: unknown, boundaryPath: string, resourceNames: Set<string>, errors: ValidationIssue[]): void {
  const path = `${boundaryPath}.resources`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    errors.push({ path, code: "VERIFICATION_RESOURCES_REQUIRED", message: "verification resources must contain 1 through 32 bounded bindings." });
    return;
  }
  const bindings = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) { errors.push({ path: itemPath, code: "VERIFICATION_RESOURCE_NOT_OBJECT", message: "verification resource must be an object." }); return; }
    checkUnknownKeys(raw, VERIFICATION_RESOURCE_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.binding)) errors.push({ path: `${itemPath}.binding`, code: "INVALID_VERIFICATION_BINDING", message: "binding must be a safe identifier." });
    else addUnique(bindings, raw.binding, `${itemPath}.binding`, "DUPLICATE_VERIFICATION_BINDING", errors);
    if (!isQualifiedOrSafeName(raw.resource) || !resourceNames.has(String(raw.resource))) errors.push({ path: `${itemPath}.resource`, code: "UNKNOWN_VERIFICATION_RESOURCE", message: "resource must reference a declared resource." });
    if (!isSafeIdentifier(raw.primary_key)) errors.push({ path: `${itemPath}.primary_key`, code: "INVALID_VERIFICATION_PRIMARY_KEY", message: "primary_key must be a safe identifier." });
    if (raw.version_field !== undefined && !isSafeIdentifier(raw.version_field)) errors.push({ path: `${itemPath}.version_field`, code: "INVALID_VERIFICATION_VERSION_FIELD", message: "version_field must be a safe identifier." });
    validateVerificationBindingSource(raw.source, `${itemPath}.source`, errors);
    validateVerificationFields(raw.fields, `${itemPath}.fields`, errors);
    validateVerificationScope(raw.scope, `${itemPath}.scope`, errors);
    if (raw.cardinality !== "one" && raw.cardinality !== "many") errors.push({ path: `${itemPath}.cardinality`, code: "INVALID_VERIFICATION_CARDINALITY", message: "cardinality must be one or many." });
    if (!Number.isSafeInteger(raw.max_rows) || Number(raw.max_rows) < 1 || Number(raw.max_rows) > 100 || (raw.cardinality === "one" && raw.max_rows !== 1)) errors.push({ path: `${itemPath}.max_rows`, code: "INVALID_VERIFICATION_ROW_BOUND", message: "one bindings require 1 row; many bindings require an explicit maximum no greater than 100." });
    if (raw.overflow !== "ineligible" && raw.overflow !== "unsupported") errors.push({ path: `${itemPath}.overflow`, code: "INVALID_VERIFICATION_OVERFLOW", message: "overflow must fail as ineligible or unsupported." });
    if (raw.lock !== "for_update") errors.push({ path: `${itemPath}.lock`, code: "VERIFICATION_LOCK_REQUIRED", message: "first-release rule facts require for_update locking." });
    if (raw.deterministic_order !== undefined) {
      if (!Array.isArray(raw.deterministic_order) || raw.deterministic_order.length === 0) errors.push({ path: `${itemPath}.deterministic_order`, code: "INVALID_VERIFICATION_ORDER", message: "deterministic_order must be a non-empty bounded list." });
      else raw.deterministic_order.forEach((entry, orderIndex) => {
        const orderPath = `${itemPath}.deterministic_order[${orderIndex}]`;
        if (!isRecord(entry)) errors.push({ path: orderPath, code: "VERIFICATION_ORDER_NOT_OBJECT", message: "order entry must be an object." });
        else {
          checkUnknownKeys(entry, VERIFICATION_ORDER_KEYS, orderPath, errors);
          if (!isSafeIdentifier(entry.field) || (entry.direction !== "asc" && entry.direction !== "desc")) errors.push({ path: orderPath, code: "INVALID_VERIFICATION_ORDER", message: "order requires one fixed field and direction." });
        }
      });
    }
  });
  if (Array.isArray(value)) value.forEach((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.source) || raw.source.kind !== "relationship") return;
    if (!bindings.has(String(raw.source.from_binding))) errors.push({ path: `${path}[${index}].source.from_binding`, code: "UNKNOWN_VERIFICATION_PARENT_BINDING", message: "relationship source must reference another binding." });
  });
}

function validateVerificationBindingSource(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "VERIFICATION_SOURCE_REQUIRED", message: "binding source is required." }); return; }
  checkUnknownKeys(value, VERIFICATION_SOURCE_KEYS, path, errors);
  if (value.kind === "subject_ref") {
    checkVariantKeys(value, VERIFICATION_SOURCE_KEYS, new Set(["kind"]), path, errors);
    for (const key of ["from_binding", "relationship", "local_field", "target_field", "field_pairs", "direction"]) if (value[key] !== undefined) errors.push({ path: `${path}.${key}`, code: "SUBJECT_SOURCE_FIELD_FORBIDDEN", message: "subject_ref has no relationship fields." });
    return;
  }
  if (value.kind !== "relationship") { errors.push({ path: `${path}.kind`, code: "INVALID_VERIFICATION_SOURCE_KIND", message: "source kind must be subject_ref or relationship." }); return; }
  checkVariantKeys(value, VERIFICATION_SOURCE_KEYS, VERIFICATION_SOURCE_KEYS, path, errors);
  for (const key of ["from_binding", "relationship"] as const) if (!isSafeIdentifier(value[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: `${key} must be a fixed identifier.` });
  if (value.field_pairs === undefined) {
    for (const key of ["local_field", "target_field"] as const) if (!isSafeIdentifier(value[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: `${key} must be a fixed identifier.` });
  } else {
    const pairs = value.field_pairs;
    const local = new Set<string>();
    const target = new Set<string>();
    if (value.local_field !== undefined || value.target_field !== undefined || !Array.isArray(pairs) || pairs.length < 2 || pairs.length > 16) {
      errors.push({ path, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Composite relationships require 2 through 16 ordered field pairs and no singular fields." });
    } else pairs.forEach((pair, index) => {
      const pairPath = `${path}.field_pairs[${index}]`;
      if (!isRecord(pair)) { errors.push({ path: pairPath, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Expected a fixed field pair." }); return; }
      checkUnknownKeys(pair, new Set(["local_field", "target_field"]), pairPath, errors);
      for (const [key, seen] of [["local_field", local], ["target_field", target]] as const) {
        if (!isSafeIdentifier(pair[key]) || seen.has(String(pair[key]))) errors.push({ path: `${pairPath}.${key}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Relationship fields must be fixed, non-repeated identifiers." });
        seen.add(String(pair[key]));
      }
    });
  }
  if (value.direction !== "forward" && value.direction !== "inverse") errors.push({ path: `${path}.direction`, code: "INVALID_VERIFICATION_DIRECTION", message: "direction must be forward or inverse." });
}

function validateVerificationFields(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) { errors.push({ path, code: "VERIFICATION_FIELDS_REQUIRED", message: "fields must contain 1 through 256 reviewed fields." }); return; }
  const names = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) { errors.push({ path: itemPath, code: "VERIFICATION_FIELD_NOT_OBJECT", message: "field must be an object." }); return; }
    checkUnknownKeys(raw, VERIFICATION_FIELD_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.name)) errors.push({ path: `${itemPath}.name`, code: "INVALID_VERIFICATION_FIELD", message: "field name must be a safe identifier." });
    else addUnique(names, raw.name, `${itemPath}.name`, "DUPLICATE_VERIFICATION_FIELD", errors);
    validateRuleScalarType(raw.type, `${itemPath}.type`, errors);
    if (raw.nullable !== undefined && typeof raw.nullable !== "boolean") errors.push({ path: `${itemPath}.nullable`, code: "INVALID_VERIFICATION_NULLABLE", message: "nullable must be boolean." });
    if (raw.model_visible !== undefined && typeof raw.model_visible !== "boolean") errors.push({ path: `${itemPath}.model_visible`, code: "INVALID_VERIFICATION_VISIBILITY", message: "model_visible must be boolean." });
  });
}

function validateVerificationScope(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "VERIFICATION_SCOPE_REQUIRED", message: "every verification resource requires reviewed trusted scope." }); return; }
  checkUnknownKeys(value, VERIFICATION_SCOPE_KEYS, path, errors);
  if (value.mode === "columns") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, new Set(["mode", "tenant_field", "principal_field"]), path, errors);
    if (!isSafeIdentifier(value.tenant_field)) errors.push({ path: `${path}.tenant_field`, code: "VERIFICATION_TENANT_FIELD_REQUIRED", message: "column scope requires tenant_field." });
    if (value.principal_field !== undefined && !isSafeIdentifier(value.principal_field)) errors.push({ path: `${path}.principal_field`, code: "INVALID_VERIFICATION_PRINCIPAL_FIELD", message: "principal_field must be fixed." });
  } else if (value.mode === "inherited") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, new Set(["mode", "from_binding"]), path, errors);
    if (!isSafeIdentifier(value.from_binding)) errors.push({ path: `${path}.from_binding`, code: "VERIFICATION_SCOPE_PARENT_REQUIRED", message: "inherited scope requires a parent binding." });
  } else if (value.mode === "single_organization") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, new Set(["mode", "organization_id", "principal_field"]), path, errors);
    if (!isNonEmptyString(value.organization_id)) errors.push({ path: `${path}.organization_id`, code: "VERIFICATION_ORGANIZATION_REQUIRED", message: "single-organization scope requires the reviewed organization ID." });
    if (value.principal_field !== undefined && !isSafeIdentifier(value.principal_field)) errors.push({ path: `${path}.principal_field`, code: "INVALID_VERIFICATION_PRINCIPAL_FIELD", message: "principal_field must be fixed." });
  } else errors.push({ path: `${path}.mode`, code: "INVALID_VERIFICATION_SCOPE", message: "scope mode must be columns, inherited, or single_organization." });
}

function validateDerivedEffectFields(value: unknown, envelopePath: string, errors: ValidationIssue[]): void {
  const path = `${envelopePath}.allowed_fields`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) { errors.push({ path, code: "DERIVED_EFFECT_FIELDS_REQUIRED", message: "allowed_fields must contain 1 through 64 exact fields." }); return; }
  const names = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) { errors.push({ path: itemPath, code: "DERIVED_EFFECT_FIELD_NOT_OBJECT", message: "allowed effect field must be an object." }); return; }
    checkUnknownKeys(raw, EFFECT_FIELD_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.name)) errors.push({ path: `${itemPath}.name`, code: "INVALID_DERIVED_EFFECT_FIELD", message: "effect field must be fixed." });
    else addUnique(names, raw.name, `${itemPath}.name`, "DUPLICATE_DERIVED_EFFECT_FIELD", errors);
    validateRuleScalarType(raw.type, `${itemPath}.type`, errors);
    if (raw.minimum !== undefined && !Number.isSafeInteger(raw.minimum)) errors.push({ path: `${itemPath}.minimum`, code: "INVALID_DERIVED_EFFECT_MINIMUM", message: "numeric minimum must be a safe integer." });
    if (raw.maximum !== undefined && !Number.isSafeInteger(raw.maximum)) errors.push({ path: `${itemPath}.maximum`, code: "INVALID_DERIVED_EFFECT_MAXIMUM", message: "numeric maximum must be a safe integer." });
    if (typeof raw.minimum === "number" && typeof raw.maximum === "number" && raw.minimum > raw.maximum) errors.push({ path: itemPath, code: "INVALID_DERIVED_EFFECT_RANGE", message: "minimum must not exceed maximum." });
    if ((raw.minimum !== undefined || raw.maximum !== undefined)
      && (!isRecord(raw.type) || (raw.type.kind !== "integer" && raw.type.kind !== "money_minor"))) {
      errors.push({ path: itemPath, code: "INVALID_DERIVED_EFFECT_RANGE_TYPE", message: "minimum and maximum are valid only for integer or money_minor fields." });
    }
    if (raw.values !== undefined) {
      if (!Array.isArray(raw.values)
        || raw.values.length === 0
        || raw.values.length > 256
        || raw.values.some((item) => !isJsonScalar(item))
        || new Set(raw.values.map((item) => JSON.stringify(item))).size !== raw.values.length) {
        errors.push({ path: `${itemPath}.values`, code: "INVALID_DERIVED_EFFECT_VALUES", message: "values must be a bounded, unique finite scalar allowlist." });
      } else {
        raw.values.forEach((item, valueIndex) => validateRuleLiteralValue(item, raw.type, `${itemPath}.values[${valueIndex}]`, errors));
      }
    }
  });
}

function validateDerivedDedup(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "DERIVED_INSERT_DEDUP_REQUIRED", message: "deduplication must be an object." }); return; }
  checkUnknownKeys(value, EFFECT_DEDUP_KEYS, path, errors);
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 8) { errors.push({ path: `${path}.components`, code: "INVALID_DERIVED_DEDUP_COMPONENTS", message: "deduplication requires 1 through 8 components." }); return; }
  const columns = new Set<string>();
  value.components.forEach((raw, index) => {
    const itemPath = `${path}.components[${index}]`;
    if (!isRecord(raw)) { errors.push({ path: itemPath, code: "DERIVED_DEDUP_COMPONENT_NOT_OBJECT", message: "deduplication component must be an object." }); return; }
    checkUnknownKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.column)) errors.push({ path: `${itemPath}.column`, code: "INVALID_DERIVED_DEDUP_COLUMN", message: "deduplication column must be fixed." });
    else addUnique(columns, raw.column, `${itemPath}.column`, "DUPLICATE_DERIVED_DEDUP_COLUMN", errors);
    if (!["proposal_id", "trusted_tenant", "derived", "fixed"].includes(String(raw.source))) errors.push({ path: `${itemPath}.source`, code: "INVALID_DERIVED_DEDUP_SOURCE", message: "unsupported deduplication source." });
    if (raw.source === "derived") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, new Set(["column", "source", "derived"]), itemPath, errors);
      if (!isSafeIdentifier(raw.derived)) errors.push({ path: `${itemPath}.derived`, code: "DERIVED_DEDUP_VALUE_REQUIRED", message: "derived source requires one derived value name." });
    } else if (raw.source === "fixed") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, new Set(["column", "source", "fixed"]), itemPath, errors);
      if (!isJsonScalar(raw.fixed)) errors.push({ path: `${itemPath}.fixed`, code: "FIXED_DEDUP_VALUE_REQUIRED", message: "fixed source requires one scalar." });
    } else if (raw.source === "proposal_id" || raw.source === "trusted_tenant") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, new Set(["column", "source"]), itemPath, errors);
    }
  });
}

function validateActionRuleSubjects(value: unknown, rulePath: string, resourceNames: Set<string>, errors: ValidationIssue[]): void {
  const path = `${rulePath}.subjects`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) { errors.push({ path, code: "ACTION_RULE_SUBJECTS_REQUIRED", message: "subjects must contain 1 through 8 opaque-reference bindings." }); return; }
  const bindings = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) { errors.push({ path: itemPath, code: "ACTION_RULE_SUBJECT_NOT_OBJECT", message: "subject must be an object." }); return; }
    checkUnknownKeys(raw, ACTION_RULE_SUBJECT_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.binding)) errors.push({ path: `${itemPath}.binding`, code: "INVALID_ACTION_RULE_SUBJECT_BINDING", message: "subject binding must be fixed." });
    else addUnique(bindings, raw.binding, `${itemPath}.binding`, "DUPLICATE_ACTION_RULE_SUBJECT_BINDING", errors);
    if (!isQualifiedOrSafeName(raw.resource) || !resourceNames.has(String(raw.resource))) errors.push({ path: `${itemPath}.resource`, code: "UNKNOWN_ACTION_RULE_SUBJECT_RESOURCE", message: "subject resource must be declared." });
    if (raw.input !== "opaque_subject_ref") errors.push({ path: `${itemPath}.input`, code: "ACTION_RULE_OPAQUE_SUBJECT_REQUIRED", message: "rule subjects must use opaque_subject_ref." });
  });
}

function validateRuleScalarType(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "ACTION_RULE_TYPE_REQUIRED", message: "one portable scalar type is required." }); return; }
  checkUnknownKeys(value, ACTION_RULE_SCALAR_TYPE_KEYS, path, errors);
  if (!["boolean", "integer", "money_minor", "string", "date", "timestamp"].includes(String(value.kind))) { errors.push({ path: `${path}.kind`, code: "INVALID_ACTION_RULE_TYPE", message: "unsupported portable scalar type." }); return; }
  checkVariantKeys(
    value,
    ACTION_RULE_SCALAR_TYPE_KEYS,
    ACTION_RULE_SCALAR_TYPE_VARIANT_KEYS[value.kind as keyof typeof ACTION_RULE_SCALAR_TYPE_VARIANT_KEYS],
    path,
    errors,
  );
  if (value.kind === "integer" && value.unit !== undefined && !isSafeUnit(value.unit)) errors.push({ path: `${path}.unit`, code: "INVALID_ACTION_RULE_UNIT", message: "integer unit must be a short fixed unit." });
  if (value.kind === "money_minor" && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency))) errors.push({ path: `${path}.currency`, code: "ACTION_RULE_CURRENCY_REQUIRED", message: "money_minor requires an ISO-style three-letter currency." });
  if (value.kind === "string") {
    if (!Number.isSafeInteger(value.max_length) || Number(value.max_length) < 1 || Number(value.max_length) > 4096) errors.push({ path: `${path}.max_length`, code: "ACTION_RULE_STRING_BOUND_REQUIRED", message: "string max_length must be 1 through 4096." });
    if (value.comparison !== "exact") errors.push({ path: `${path}.comparison`, code: "ACTION_RULE_EXACT_STRING_REQUIRED", message: "first-release string comparisons are exact." });
    if (value.enum !== undefined && (!Array.isArray(value.enum)
      || value.enum.length === 0
      || value.enum.length > 256
      || value.enum.some((item) => typeof item !== "string" || item.length > Number(value.max_length))
      || new Set(value.enum).size !== value.enum.length)) {
      errors.push({ path: `${path}.enum`, code: "INVALID_ACTION_RULE_ENUM", message: "enum must be a bounded, unique string allowlist whose values fit max_length." });
    }
  }
}

function validateRuleLiteralValue(value: unknown, type: unknown, path: string, errors: ValidationIssue[]): void {
  if (value === null || !isRecord(type)) return;
  let valid = false;
  switch (type.kind) {
    case "boolean": valid = typeof value === "boolean"; break;
    case "integer":
    case "money_minor": valid = Number.isSafeInteger(value); break;
    case "string": valid = typeof value === "string"
      && Number.isSafeInteger(type.max_length)
      && value.length <= Number(type.max_length)
      && (!Array.isArray(type.enum) || type.enum.includes(value)); break;
    case "date": valid = isCanonicalDate(value); break;
    case "timestamp": valid = isCanonicalUtcInstant(value); break;
    default: return;
  }
  if (!valid) errors.push({ path, code: "ACTION_RULE_LITERAL_TYPE_MISMATCH", message: "literal value must exactly match its declared portable type." });
}

function validateRuleInputs(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > 32) {
    errors.push({ path, code: "INVALID_ACTION_INPUTS", message: "inputs must contain at most 32 reviewed business inputs." });
    return;
  }
  const names = new Set<string>();
  value.forEach((input, index) => {
    const location = `${path}[${index}]`;
    if (!isRecord(input)) { errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input must be an object." }); return; }
    checkUnknownKeys(input, new Set(["name", "description", "type", "minimum", "maximum"]), location, errors);
    if (!isSafeIdentifier(input.name) || names.has(String(input.name)) || ["__proto__", "constructor", "prototype"].includes(String(input.name))) errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input name must be safe and unique." });
    names.add(String(input.name));
    if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500) errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input requires a concise business description." });
    validateRuleScalarType(input.type, `${location}.type`, errors);
    const numeric = isRecord(input.type) && ["integer", "money_minor"].includes(String(input.type.kind));
    if (numeric && (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || Number(input.minimum) > Number(input.maximum))) errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "numeric inputs require finite reviewed minimum and maximum bounds." });
    if (!numeric && (input.minimum !== undefined || input.maximum !== undefined)) errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "non-numeric inputs cannot have numeric bounds." });
    if (isRecord(input.type) && input.type.kind === "string" && Number(input.type.max_length) > 4096) errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "business text inputs cannot exceed 4096 characters." });
  });
}

function validateRuleScalarExpression(value: unknown, path: string, errors: ValidationIssue[], depth: number): void {
  if (depth > 24) { errors.push({ path, code: "ACTION_RULE_EXPRESSION_TOO_DEEP", message: "rule expressions may be at most 24 levels deep." }); return; }
  if (!isRecord(value)) { errors.push({ path, code: "ACTION_RULE_SCALAR_EXPRESSION_REQUIRED", message: "scalar expression must be an object." }); return; }
  checkUnknownKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, path, errors);
  switch (value.kind) {
    case "input":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.input, path, errors);
      if (!isSafeIdentifier(value.name)) errors.push({ path: `${path}.name`, code: "INVALID_ACTION_INPUT_REFERENCE", message: "input reference must name a reviewed business input." });
      return;
    case "literal":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.literal, path, errors);
      if (!isJsonScalar(value.value)) errors.push({ path: `${path}.value`, code: "INVALID_ACTION_RULE_LITERAL", message: "literal must be a finite JSON scalar." });
      validateRuleScalarType(value.value_type, `${path}.value_type`, errors);
      validateRuleLiteralValue(value.value, value.value_type, `${path}.value`, errors);
      return;
    case "trusted":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.trusted, path, errors);
      if (!["tenant", "organization", "principal", "transaction_time"].includes(String(value.binding))) errors.push({ path: `${path}.binding`, code: "INVALID_TRUSTED_RULE_BINDING", message: "trusted binding must be tenant, organization, principal, or transaction_time." });
      return;
    case "field":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.field, path, errors);
      if (!isSafeIdentifier(value.binding) || !isSafeIdentifier(value.field)) errors.push({ path, code: "INVALID_ACTION_RULE_FIELD_REFERENCE", message: "field references require fixed binding and field identifiers." });
      return;
    case "derived":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.derived, path, errors);
      if (!isSafeIdentifier(value.name)) errors.push({ path: `${path}.name`, code: "INVALID_ACTION_RULE_DERIVED_REFERENCE", message: "derived reference must be fixed." });
      return;
    case "aggregate":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.aggregate, path, errors);
      if (!["count", "sum", "min", "max"].includes(String(value.operation)) || !isSafeIdentifier(value.binding) || (value.operation !== "count" && !isSafeIdentifier(value.field))) errors.push({ path, code: "INVALID_ACTION_RULE_AGGREGATE", message: "aggregate requires a supported operation and fixed bounded binding." });
      return;
    case "math":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.math, path, errors);
      if (!["add", "subtract", "min", "max"].includes(String(value.operation)) || !Array.isArray(value.inputs) || value.inputs.length < 2 || value.inputs.length > 16) errors.push({ path, code: "INVALID_ACTION_RULE_MATH", message: "math requires 2 through 16 inputs." });
      else value.inputs.forEach((item, index) => validateRuleScalarExpression(item, `${path}.inputs[${index}]`, errors, depth + 1));
      return;
    case "scale":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.scale, path, errors);
      if (value.operation !== "multiply" && value.operation !== "divide") errors.push({ path: `${path}.operation`, code: "INVALID_ACTION_RULE_SCALE", message: "scale supports multiply or divide." });
      if (!Number.isSafeInteger(value.constant) || value.constant === 0) errors.push({ path: `${path}.constant`, code: "INVALID_ACTION_RULE_SCALE_CONSTANT", message: "scale constant must be a non-zero safe integer." });
      if (!["floor", "ceiling", "half_even"].includes(String(value.rounding))) errors.push({ path: `${path}.rounding`, code: "ACTION_RULE_ROUNDING_REQUIRED", message: "scale requires explicit rounding." });
      validateRuleScalarExpression(value.input, `${path}.input`, errors, depth + 1);
      return;
    case "clamp":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.clamp, path, errors);
      validateRuleScalarExpression(value.input, `${path}.input`, errors, depth + 1);
      validateRuleScalarExpression(value.minimum, `${path}.minimum`, errors, depth + 1);
      validateRuleScalarExpression(value.maximum, `${path}.maximum`, errors, depth + 1);
      return;
    case "add_duration":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.add_duration, path, errors);
      if (!Number.isSafeInteger(value.seconds) || Number(value.seconds) < -31_536_000 || Number(value.seconds) > 31_536_000) errors.push({ path: `${path}.seconds`, code: "INVALID_ACTION_RULE_DURATION", message: "duration must be a reviewed whole-second value within one year." });
      validateRuleScalarExpression(value.timestamp, `${path}.timestamp`, errors, depth + 1);
      return;
    default:
      errors.push({ path: `${path}.kind`, code: "UNKNOWN_ACTION_RULE_SCALAR_OPERATOR", message: "unsupported scalar expression kind." });
  }
}

function validateRuleBooleanExpression(value: unknown, path: string, errors: ValidationIssue[], depth: number): void {
  if (depth > 24) { errors.push({ path, code: "ACTION_RULE_EXPRESSION_TOO_DEEP", message: "rule expressions may be at most 24 levels deep." }); return; }
  if (!isRecord(value)) { errors.push({ path, code: "ACTION_RULE_BOOLEAN_EXPRESSION_REQUIRED", message: "boolean expression must be an object." }); return; }
  checkUnknownKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, path, errors);
  if (value.kind === "all" || value.kind === "any") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS[value.kind], path, errors);
    if (!Array.isArray(value.expressions) || value.expressions.length < 1 || value.expressions.length > 32) errors.push({ path: `${path}.expressions`, code: "INVALID_ACTION_RULE_BOOLEAN_SET", message: "all/any requires 1 through 32 expressions." });
    else value.expressions.forEach((item, index) => validateRuleBooleanExpression(item, `${path}.expressions[${index}]`, errors, depth + 1));
    return;
  }
  if (value.kind === "not") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.not, path, errors);
    validateRuleBooleanExpression(value.expression, `${path}.expression`, errors, depth + 1);
    return;
  }
  if (value.kind === "compare") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.compare, path, errors);
    if (!["eq", "neq", "lt", "lte", "gt", "gte"].includes(String(value.operator))) errors.push({ path: `${path}.operator`, code: "INVALID_ACTION_RULE_COMPARISON", message: "unsupported comparison operator." });
    validateRuleScalarExpression(value.left, `${path}.left`, errors, depth + 1);
    validateRuleScalarExpression(value.right, `${path}.right`, errors, depth + 1);
    return;
  }
  if (value.kind === "null_check") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.null_check, path, errors);
    if (value.operator !== "is_null" && value.operator !== "is_not_null") errors.push({ path: `${path}.operator`, code: "INVALID_ACTION_RULE_NULL_CHECK", message: "null check must be is_null or is_not_null." });
    validateRuleScalarExpression(value.value, `${path}.value`, errors, depth + 1);
    return;
  }
  if (value.kind === "in") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.in, path, errors);
    validateRuleScalarExpression(value.value, `${path}.value`, errors, depth + 1);
    if (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > 256) errors.push({ path: `${path}.values`, code: "INVALID_ACTION_RULE_IN_SET", message: "in requires 1 through 256 reviewed scalar expressions." });
    else value.values.forEach((item, index) => validateRuleScalarExpression(item, `${path}.values[${index}]`, errors, depth + 1));
    return;
  }
  if (value.kind === "exists") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.exists, path, errors);
    if (!isSafeIdentifier(value.binding)) errors.push({ path: `${path}.binding`, code: "INVALID_ACTION_RULE_EXISTS_BINDING", message: "exists binding must be fixed." });
    validateRuleBooleanExpression(value.where, `${path}.where`, errors, depth + 1);
    return;
  }
  errors.push({ path: `${path}.kind`, code: "UNKNOWN_ACTION_RULE_BOOLEAN_OPERATOR", message: "unsupported boolean expression kind." });
}

function validateNamedAuthority(value: unknown, path: string, names: Set<string>, label: string, errors: ValidationIssue[]): void {
  if (!isDottedName(value)) errors.push({ path, code: `INVALID_${label}_NAME`, message: "name must be a fixed safe or qualified name." });
  else addUnique(names, value, path, `DUPLICATE_${label}_NAME`, errors);
}

function isDottedName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
}

function isSafeUnit(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(value);
}

function validateArrayRecords(value: unknown, path: string, keys: Set<string>, label: string, errors: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, code: `${label}_NOT_ARRAY`, message: `${path} must be an array.` });
    return;
  }
  value.forEach((record, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(record)) {
      errors.push({ path: itemPath, code: `${label}_NOT_OBJECT`, message: `${label.toLowerCase()} entry must be an object.` });
      return;
    }
    checkUnknownKeys(record, keys, itemPath, errors);
  });
}

function validateFieldList(value: unknown, path: string, code: string, errors: ValidationIssue[], allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push({ path, code, message: "field list must be a non-empty array of safe identifiers." });
    return;
  }
  const seen = new Set<string>();
  value.forEach((field, index) => {
    if (!isSafeIdentifier(field)) errors.push({ path: `${path}[${index}]`, code: "INVALID_FIELD_IDENTIFIER", message: "field names must be fixed safe identifiers." });
    else addUnique(seen, field, `${path}[${index}]`, "DUPLICATE_FIELD", errors);
  });
}

function validateKeptOutExclusion(visible: unknown, keptOut: unknown, path: string, errors: ValidationIssue[]): void {
  if (!Array.isArray(visible) || !Array.isArray(keptOut)) return;
  const visibleSet = new Set(visible);
  for (const field of keptOut) {
    if (visibleSet.has(field)) errors.push({ path: `${path}.kept_out_fields`, code: "KEPT_OUT_FIELD_VISIBLE", message: `kept-out field must not also be visible: ${String(field)}` });
  }
}

function validateModelWithheldExclusion(
  keptOut: unknown,
  modelWithheld: unknown,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(keptOut) || !Array.isArray(modelWithheld)) return;
  const keptOutSet = new Set(keptOut);
  for (const field of modelWithheld) {
    if (keptOutSet.has(field)) {
      errors.push({
        path: `${path}.model_withheld_fields`,
        code: "MODEL_WITHHELD_FIELD_KEPT_OUT",
        message: `model-withheld field must not also be kept out: ${String(field)}`,
      });
    }
  }
}

function validateNestedObject(value: unknown, keys: Set<string>, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "NESTED_VALUE_NOT_OBJECT", message: "nested value must be an object." });
    return;
  }
  checkUnknownKeys(value, keys, path, errors);
}

function scanForInlineSecrets(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForInlineSecrets(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/database_url|read_url|write_url|connection_string|password|secret|token/i.test(key) && typeof child === "string" && /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+|[A-Za-z0-9+/=]{24,})/i.test(child)) {
      errors.push({ path: childPath, code: "INLINE_SECRET_OR_URL", message: "Contracts must not contain database URLs, passwords, bearer tokens, or secrets. Put runtime wiring in runner config/env vars." });
    }
    scanForInlineSecrets(child, childPath, errors);
  }
}

function checkUnknownKeys(value: JsonRecord, allowed: Set<string>, path: string, errors: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key) || isExtensionKey(key)) continue;
    errors.push({ path: `${path}.${key}`, code: "UNKNOWN_CORE_FIELD", message: `Unknown core field ${key}. Use x-cloud-*, x-runner-*, or x-experimental-* for extensions.` });
  }
}

function checkVariantKeys(
  value: JsonRecord,
  unionKeys: Set<string>,
  variantKeys: Set<string>,
  path: string,
  errors: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!unionKeys.has(key) || variantKeys.has(key) || isExtensionKey(key)) continue;
    errors.push({
      path: `${path}.${key}`,
      code: "INVALID_DISCRIMINATED_VARIANT_FIELD",
      message: `${key} is not valid when kind/mode/source is ${String(value.kind ?? value.mode ?? value.source)}.`,
    });
  }
}

function addUnique(seen: Set<string>, name: unknown, path: string, code: string, errors: ValidationIssue[]): void {
  const value = String(name);
  if (seen.has(value)) errors.push({ path, code, message: `Duplicate name: ${value}` });
  seen.add(value);
}

function isExtensionKey(key: string): boolean {
  return /^x-(cloud|runner|experimental)-[A-Za-z0-9_.-]+$/.test(key);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isQualifiedName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isQualifiedOrSafeName(value: unknown): value is string {
  return isSafeIdentifier(value) || isQualifiedName(value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCanonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}
