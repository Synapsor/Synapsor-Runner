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
]);
const METADATA_KEYS = new Set(["name", "description", "version", "tags"]);
const RESOURCE_KEYS = new Set(["name", "engine", "schema", "table", "type", "primary_key", "tenant_key", "conflict_key", "single_tenant_dev"]);
const CONTEXT_KEYS = new Set(["name", "description", "bindings", "tenant_binding", "principal_binding"]);
const BINDING_KEYS = new Set(["name", "source", "key", "required"]);
const CAPABILITY_KEYS = new Set(["name", "description", "returns_hint", "kind", "context", "source", "subject", "args", "lookup", "visible_fields", "kept_out_fields", "evidence", "max_rows", "proposal", "aggregate", "protected_read"]);
const SUBJECT_KEYS = new Set(["resource", "schema", "table", "primary_key", "tenant_key", "principal_scope_key", "conflict_key", "single_tenant_dev"]);
const ARG_KEYS = new Set(["type", "description", "required", "max_length", "minimum", "maximum", "enum", "max_items", "fields"]);
const LOOKUP_KEYS = new Set(["id_from_arg"]);
const EVIDENCE_KEYS = new Set(["required", "sources", "query_audit", "handle_prefix"]);
const PROPOSAL_KEYS = new Set(["action", "operation", "allowed_fields", "patch", "numeric_bounds", "transition_guards", "reversibility", "conflict_guard", "approval", "writeback"]);
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
const WRITEBACK_KEYS = new Set(["mode", "executor", "idempotency_key"]);
const REVERSIBILITY_KEYS = new Set(["mode"]);
const AGGREGATE_READ_KEYS = new Set(["function", "count_mode", "column", "selection", "minimum_group_size"]);
const PROTECTED_READ_KEYS = new Set([
  "version",
  "mode",
  "boundary_digest",
  "generation_lock_fingerprint",
  "predicates",
  "relationship",
  "row_order_by",
  "aggregate",
  "limits",
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
const PROTECTED_MEASURE_KEYS = new Set(["name", "function", "field", "relationship"]);
const PROTECTED_DIMENSION_KEYS = new Set(["name", "field", "relationship"]);
const PROTECTED_TIME_BUCKET_KEYS = new Set(["name", "field", "bucket", "relationship"]);
const PROTECTED_COMPARISON_KEYS = new Set(["field", "relationship", "ranges"]);
const PROTECTED_RANGE_KEYS = new Set(["start", "end"]);
const PROTECTED_AGGREGATE_ORDER_KEYS = new Set(["kind", "measure", "direction"]);
const PROTECTED_LIMIT_KEYS = new Set([
  "max_rows",
  "max_groups",
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
  validateWorkflows(input.workflows, contextNames, capabilityNames, errors);
  const policyByName = validatePolicies(input.policies, errors);
  validateCapabilityApprovalPolicies(capabilities, policies, policyByName, errors);
  validateEvidenceRecords(input.evidence, errors);
  validateProposalRecords(input.proposals, capabilityNames, errors);
  validateReceiptRecords(input.receipts, errors);
  validateReplay(input.replay, errors);
  validateExternalActions(input.external_actions, errors);
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
      if (!["session", "environment", "cloud_session", "static_dev", "http_claim"].includes(String(binding.source))) errors.push({ path: `${bindingPath}.source`, code: "INVALID_BINDING_SOURCE", message: "binding source must be session, environment, cloud_session, static_dev, or http_claim." });
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
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.capabilities", code: "CAPABILITIES_REQUIRED", message: "At least one capability is required." });
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
    validateSubject(capability.subject, `${path}.subject`, resourceNames, errors, warnings);
    const hasProtectedRead = capability.protected_read !== undefined;
    validateArgs(capability.args, `${path}.args`, errors, capability.kind === "aggregate_read" || hasProtectedRead);
    if (capability.lookup !== undefined) validateLookup(capability.lookup, `${path}.lookup`, capability.args, errors);
    validateFieldList(capability.visible_fields, `${path}.visible_fields`, "VISIBLE_FIELDS_REQUIRED", errors, capability.kind === "aggregate_read");
    if (capability.kept_out_fields !== undefined) validateFieldList(capability.kept_out_fields, `${path}.kept_out_fields`, "INVALID_KEPT_OUT_FIELDS", errors, true);
    validateKeptOutExclusion(capability.visible_fields, capability.kept_out_fields, path, errors);
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

function validateSubject(value: unknown, path: string, resourceNames: Set<string>, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
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
    if (!isSafeIdentifier(value.tenant_key) && value.single_tenant_dev !== true) {
      errors.push({ path: `${path}.tenant_key`, code: "TENANT_KEY_REQUIRED", message: "tenant_key is required unless single_tenant_dev is explicitly true." });
    }
  }
  if (value.principal_scope_key !== undefined && !isSafeIdentifier(value.principal_scope_key)) {
    errors.push({ path: `${path}.principal_scope_key`, code: "INVALID_PRINCIPAL_SCOPE_KEY", message: "principal_scope_key must be a fixed safe identifier." });
  }
  if (value.principal_scope_key !== undefined && value.resource === undefined && !isSafeIdentifier(value.tenant_key)) {
    errors.push({ path: `${path}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key can only narrow a capability that also declares tenant_key." });
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
    if (!isRecord(capability) || !isRecord(capability.subject) || capability.subject.principal_scope_key === undefined) return;
    const path = `$.capabilities[${index}]`;
    const resource = typeof capability.subject.resource === "string" ? resourceByName.get(capability.subject.resource) : undefined;
    const tenantKey = capability.subject.tenant_key ?? resource?.tenant_key;
    const singleTenantDev = capability.subject.single_tenant_dev ?? resource?.single_tenant_dev;
    if (!isSafeIdentifier(tenantKey) || singleTenantDev === true) {
      errors.push({ path: `${path}.subject.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key can only narrow a capability with a reviewed tenant_key." });
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
  });
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

  const args = isRecord(capability.args) ? capability.args : {};
  const referencedArgs = new Set<string>();
  const keptOut = new Set(Array.isArray(capability.kept_out_fields) ? capability.kept_out_fields.filter((field): field is string => typeof field === "string") : []);
  const subject = isRecord(capability.subject) ? capability.subject : {};
  const trustedScopeFields = new Set([subject.tenant_key, subject.principal_scope_key].filter((field): field is string => isSafeIdentifier(field)));
  const relationshipName = validateProtectedRelationship(
    protectedRead.relationship,
    keptOut,
    trustedScopeFields,
    `${path}.protected_read.relationship`,
    errors,
  );

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
        validateProtectedFieldReference(predicate.field, predicate.relationship, relationshipName, keptOut, trustedScopeFields, predicatePath, errors);
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
      relationshipName,
      keptOut,
      trustedScopeFields,
      maxGroups: isRecord(protectedRead.limits) ? protectedRead.limits.max_groups : undefined,
      path: `${path}.protected_read.aggregate`,
      errors,
    });
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
  errors: ValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_RELATIONSHIP_NOT_OBJECT", message: "protected relationship must be an object." });
    return undefined;
  }
  checkUnknownKeys(value, PROTECTED_RELATIONSHIP_KEYS, path, errors);
  for (const key of ["name", "schema", "table", "primary_key", "tenant_key", "local_key", "target_key"] as const) {
    if (!isSafeIdentifier(value[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
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

function validateProtectedAggregate(
  value: unknown,
  input: {
    args: JsonRecord;
    referencedArgs: Set<string>;
    relationshipName?: string;
    keptOut: Set<string>;
    trustedScopeFields: Set<string>;
    maxGroups: unknown;
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
      if (!["count", "count_distinct", "sum", "avg"].includes(String(measure.function))) errors.push({ path: `${measurePath}.function`, code: "INVALID_PROTECTED_MEASURE_FUNCTION", message: "measure function must be count, count_distinct, sum, or avg." });
      validateProtectedRelationshipReference(measure.relationship, input.relationshipName, `${measurePath}.relationship`, errors);
      if (measure.function === "count") {
        if (measure.field !== undefined) errors.push({ path: `${measurePath}.field`, code: "PROTECTED_COUNT_FIELD_FORBIDDEN", message: "count measures count scoped subject rows and must not declare a field." });
        if (measure.relationship !== undefined) errors.push({ path: `${measurePath}.relationship`, code: "PROTECTED_COUNT_RELATIONSHIP_FORBIDDEN", message: "count measures count the scoped subject entity, not a joined relation." });
      } else {
        validateProtectedFieldReference(measure.field, measure.relationship, input.relationshipName, input.keptOut, input.trustedScopeFields, measurePath, errors);
      }
    });
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
        validateProtectedFieldReference(dimension.field, dimension.relationship, input.relationshipName, input.keptOut, input.trustedScopeFields, dimensionPath, errors);
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
      if (value.time_bucket.bucket !== "day" && value.time_bucket.bucket !== "week" && value.time_bucket.bucket !== "month") errors.push({ path: `${bucketPath}.bucket`, code: "INVALID_PROTECTED_TIME_BUCKET", message: "time bucket must be day, week, or month." });
      validateProtectedFieldReference(value.time_bucket.field, value.time_bucket.relationship, input.relationshipName, input.keptOut, input.trustedScopeFields, bucketPath, errors);
    }
  }

  if (value.comparison !== undefined) {
    const comparisonPath = `${path}.comparison`;
    if (!isRecord(value.comparison)) {
      errors.push({ path: comparisonPath, code: "PROTECTED_COMPARISON_NOT_OBJECT", message: "comparison must be an object." });
    } else {
      checkUnknownKeys(value.comparison, PROTECTED_COMPARISON_KEYS, comparisonPath, errors);
      validateProtectedFieldReference(value.comparison.field, value.comparison.relationship, input.relationshipName, input.keptOut, input.trustedScopeFields, comparisonPath, errors);
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
      } else if (value.order_by.kind === "time_bucket") {
        if (value.order_by.measure !== undefined) errors.push({ path: `${orderPath}.measure`, code: "PROTECTED_TIME_ORDER_MEASURE_FORBIDDEN", message: "time-bucket ordering must not declare a measure." });
        if (!isRecord(value.time_bucket)) errors.push({ path: orderPath, code: "PROTECTED_TIME_ORDER_REQUIRES_BUCKET", message: "time-bucket ordering requires a reviewed time bucket." });
      } else {
        errors.push({ path: `${orderPath}.kind`, code: "INVALID_PROTECTED_AGGREGATE_ORDER", message: "aggregate order kind must be measure or time_bucket." });
      }
    }
  }
  if (!Number.isSafeInteger(value.top_n) || Number(value.top_n) < 1 || Number(value.top_n) > 100 || (Number.isSafeInteger(input.maxGroups) && Number(value.top_n) > Number(input.maxGroups))) {
    errors.push({ path: `${path}.top_n`, code: "INVALID_PROTECTED_TOP_N", message: "top_n must be positive, at most 100, and no greater than limits.max_groups." });
  }
  if (!Number.isSafeInteger(value.minimum_group_size) || Number(value.minimum_group_size) < 2 || Number(value.minimum_group_size) > 1_000_000) {
    errors.push({ path: `${path}.minimum_group_size`, code: "INVALID_PROTECTED_MINIMUM_GROUP_SIZE", message: "minimum_group_size must be from 2 through 1000000." });
  }
}

function validateProtectedReadLimits(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROTECTED_READ_LIMITS_REQUIRED", message: "protected_read requires immutable execution, response, extraction, and differencing limits." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_LIMIT_KEYS, path, errors);
  const ceilings: Record<string, number> = {
    max_rows: 100,
    max_groups: 100,
    max_response_cells: 10_000,
    max_response_bytes: 1_048_576,
    statement_timeout_ms: 30_000,
    max_queries_per_session: 1_000,
    max_extracted_cells_per_session: 100_000,
    max_differencing_queries: 100,
    rate_limit_per_minute: 120,
  };
  for (const [key, maximum] of Object.entries(ceilings)) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > maximum) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_PROTECTED_READ_LIMIT", message: `${key} must be a positive integer no greater than ${maximum}.` });
    }
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
  relationshipName: string | undefined,
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
  validateProtectedRelationshipReference(relationship, relationshipName, `${path}.relationship`, errors);
}

function validateProtectedRelationshipReference(value: unknown, relationshipName: string | undefined, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isSafeIdentifier(value) || value !== relationshipName) errors.push({ path, code: "UNKNOWN_PROTECTED_RELATIONSHIP", message: "relationship must reference the capability's one reviewed many-to-one relationship." });
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
  if (!Number.isSafeInteger(aggregate.minimum_group_size) || Number(aggregate.minimum_group_size) < 2 || Number(aggregate.minimum_group_size) > 1_000_000) {
    errors.push({ path: `${path}.aggregate.minimum_group_size`, code: "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", message: "aggregate reads require minimum_group_size from 2 through 1000000." });
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
  if (value.writeback !== undefined) {
    validateNestedObject(value.writeback, WRITEBACK_KEYS, `${path}.writeback`, errors);
    if (isRecord(value.writeback) && !["direct_sql", "app_handler", "cloud_worker", "none"].includes(String(value.writeback.mode))) errors.push({ path: `${path}.writeback.mode`, code: "INVALID_WRITEBACK_MODE", message: "writeback.mode must be direct_sql, app_handler, cloud_worker, or none." });
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
  const keys = new Set(["field", "max"]);
  checkUnknownKeys(rule, keys, path, errors);
  if (!isSafeIdentifier(rule.field)) errors.push({ path: `${path}.field`, code: "INVALID_APPROVAL_POLICY_FIELD", message: "approval policy rule field must be a safe identifier." });
  if (!Number.isInteger(rule.max) || Number(rule.max) < 0) errors.push({ path: `${path}.max`, code: "INVALID_APPROVAL_POLICY_MAX", message: "approval policy rule max must be a non-negative integer." });
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
    if (!isSafeIdentifier(field) || !Number.isInteger(max)) return;
    if (!isNumericProposalField(proposal, capability.args, field)) {
      errors.push({
        path: `${rulePath}.field`,
        code: "APPROVAL_POLICY_FIELD_NOT_NUMERIC",
        message: `approval policy field ${field} must be numeric for capability ${capability.name}.`,
      });
    }
    const bound = proposal.numeric_bounds?.[field];
    if (bound?.maximum !== undefined && Number(max) > Number(bound.maximum)) {
      errors.push({
        path: `${rulePath}.max`,
        code: "APPROVAL_POLICY_MAX_EXCEEDS_BOUND",
        message: `approval policy max for ${field} must be <= numeric_bounds maximum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.maximum.`,
      });
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

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}
