import { SPEC_VERSION } from "./version.js";
import type { SynapsorContract, ValidationIssue, ValidationResult } from "./types.js";
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
const CAPABILITY_KEYS = new Set(["name", "description", "returns_hint", "kind", "context", "source", "subject", "args", "lookup", "visible_fields", "kept_out_fields", "evidence", "max_rows", "proposal"]);
const SUBJECT_KEYS = new Set(["resource", "schema", "table", "primary_key", "tenant_key", "conflict_key", "single_tenant_dev"]);
const ARG_KEYS = new Set(["type", "description", "required", "max_length", "minimum", "maximum", "enum"]);
const LOOKUP_KEYS = new Set(["id_from_arg"]);
const EVIDENCE_KEYS = new Set(["required", "sources", "query_audit", "handle_prefix"]);
const PROPOSAL_KEYS = new Set(["action", "allowed_fields", "patch", "numeric_bounds", "transition_guards", "conflict_guard", "approval", "writeback"]);
const PATCH_KEYS = new Set(["fixed", "from_arg"]);
const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);
const TRANSITION_GUARD_KEYS = new Set(["from_column", "allowed"]);
const CONFLICT_GUARD_KEYS = new Set(["column", "weak_guard_ack"]);
const APPROVAL_KEYS = new Set(["mode", "required_role"]);
const WRITEBACK_KEYS = new Set(["mode", "executor", "idempotency_key"]);
const WORKFLOW_KEYS = new Set(["name", "description", "context", "allowed_capabilities", "required_evidence", "approval", "settlement", "replay"]);
const POLICY_KEYS = new Set(["name", "kind", "mode", "rules"]);
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
  const capabilityNames = validateCapabilities(input.capabilities, contextNames, resourceNames, errors, warnings);
  validateWorkflows(input.workflows, contextNames, capabilityNames, errors);
  validatePolicies(input.policies, errors);
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
    if (!["read", "proposal", "external_action", "answer_with_evidence"].includes(String(capability.kind))) errors.push({ path: `${path}.kind`, code: "INVALID_CAPABILITY_KIND", message: "kind must be read, proposal, external_action, or answer_with_evidence." });
    if (!isNonEmptyString(capability.context) || !contextNames.has(capability.context)) errors.push({ path: `${path}.context`, code: "UNKNOWN_CONTEXT", message: "capability.context must reference a declared context." });
    validateSubject(capability.subject, `${path}.subject`, resourceNames, errors, warnings);
    validateArgs(capability.args, `${path}.args`, errors);
    if (capability.lookup !== undefined) validateLookup(capability.lookup, `${path}.lookup`, capability.args, errors);
    validateFieldList(capability.visible_fields, `${path}.visible_fields`, "VISIBLE_FIELDS_REQUIRED", errors);
    if (capability.kept_out_fields !== undefined) validateFieldList(capability.kept_out_fields, `${path}.kept_out_fields`, "INVALID_KEPT_OUT_FIELDS", errors, true);
    validateKeptOutExclusion(capability.visible_fields, capability.kept_out_fields, path, errors);
    if (capability.evidence !== undefined) validateEvidenceRequirement(capability.evidence, `${path}.evidence`, errors);
    if (capability.max_rows !== undefined && !isPositiveInteger(capability.max_rows)) errors.push({ path: `${path}.max_rows`, code: "INVALID_MAX_ROWS", message: "max_rows must be a positive integer." });
    if (capability.kind === "proposal") validateProposalAction(capability.proposal, `${path}.proposal`, errors);
    if (capability.kind !== "proposal" && capability.proposal !== undefined) errors.push({ path: `${path}.proposal`, code: "PROPOSAL_ONLY_FOR_PROPOSAL_KIND", message: "proposal is only valid for proposal capabilities." });
  });
  return names;
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
  if (value.single_tenant_dev === true) warnings.push({ path: `${path}.single_tenant_dev`, code: "SINGLE_TENANT_DEV", message: "single_tenant_dev is only for local demos and must not be used for shared tenant data." });
}

function validateArgs(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
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
    if (!["string", "number", "boolean"].includes(String(arg.type))) errors.push({ path: `${argPath}.type`, code: "INVALID_ARG_TYPE", message: "arg type must be string, number, or boolean." });
    if (arg.description !== undefined && !isNonEmptyString(arg.description)) errors.push({ path: `${argPath}.description`, code: "INVALID_ARG_DESCRIPTION", message: "arg description must be a non-empty string." });
    if (arg.max_length !== undefined && (!Number.isInteger(arg.max_length) || Number(arg.max_length) <= 0)) errors.push({ path: `${argPath}.max_length`, code: "INVALID_MAX_LENGTH", message: "max_length must be a positive integer." });
    if ((arg.minimum !== undefined || arg.maximum !== undefined) && arg.type !== "number") errors.push({ path: argPath, code: "NUMERIC_BOUNDS_REQUIRE_NUMBER", message: "minimum/maximum can only be used with number args." });
    if (arg.minimum !== undefined && !isFiniteNumber(arg.minimum)) errors.push({ path: `${argPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    if (arg.maximum !== undefined && !isFiniteNumber(arg.maximum)) errors.push({ path: `${argPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    if (isFiniteNumber(arg.minimum) && isFiniteNumber(arg.maximum) && Number(arg.minimum) > Number(arg.maximum)) errors.push({ path: argPath, code: "INVALID_ARG_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    if (arg.enum !== undefined && (!Array.isArray(arg.enum) || arg.enum.length === 0)) errors.push({ path: `${argPath}.enum`, code: "INVALID_ARG_ENUM", message: "enum must be a non-empty array when provided." });
  }
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

function validateProposalAction(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "PROPOSAL_REQUIRED", message: "proposal capabilities must define proposal action semantics." });
    return;
  }
  checkUnknownKeys(value, PROPOSAL_KEYS, path, errors);
  if (!isQualifiedOrSafeName(value.action)) errors.push({ path: `${path}.action`, code: "INVALID_PROPOSAL_ACTION", message: "proposal.action must be a safe action name." });
  validateFieldList(value.allowed_fields, `${path}.allowed_fields`, "ALLOWED_FIELDS_REQUIRED", errors);
  if (!isRecord(value.patch) || Object.keys(value.patch).length === 0) {
    errors.push({ path: `${path}.patch`, code: "PATCH_REQUIRED", message: "proposal.patch must map allowed fields to fixed or arg values." });
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
      if (patch.fixed === undefined && !isSafeIdentifier(patch.from_arg)) errors.push({ path: patchPath, code: "PATCH_BINDING_REQUIRED", message: "patch binding must include fixed or from_arg." });
    }
  }
  validateNumericBounds(value.numeric_bounds, value.patch, `${path}.numeric_bounds`, errors);
  validateTransitionGuards(value.transition_guards, value.patch, `${path}.transition_guards`, errors);
  if (value.conflict_guard !== undefined) {
    if (!isRecord(value.conflict_guard)) errors.push({ path: `${path}.conflict_guard`, code: "CONFLICT_GUARD_NOT_OBJECT", message: "conflict_guard must be an object." });
    else {
      checkUnknownKeys(value.conflict_guard, CONFLICT_GUARD_KEYS, `${path}.conflict_guard`, errors);
      if (value.conflict_guard.column !== undefined && !isSafeIdentifier(value.conflict_guard.column)) errors.push({ path: `${path}.conflict_guard.column`, code: "INVALID_CONFLICT_COLUMN", message: "conflict_guard.column must be a safe identifier." });
      if (value.conflict_guard.column === undefined && value.conflict_guard.weak_guard_ack !== true) errors.push({ path: `${path}.conflict_guard`, code: "CONFLICT_GUARD_REQUIRED", message: "proposal needs conflict_guard.column unless weak_guard_ack is explicit." });
    }
  }
  if (value.approval !== undefined) validateNestedObject(value.approval, APPROVAL_KEYS, `${path}.approval`, errors);
  if (value.writeback !== undefined) {
    validateNestedObject(value.writeback, WRITEBACK_KEYS, `${path}.writeback`, errors);
    if (isRecord(value.writeback) && !["direct_sql", "app_handler", "cloud_worker", "none"].includes(String(value.writeback.mode))) errors.push({ path: `${path}.writeback.mode`, code: "INVALID_WRITEBACK_MODE", message: "writeback.mode must be direct_sql, app_handler, cloud_worker, or none." });
  }
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

function validatePolicies(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  validateArrayRecords(value, "$.policies", POLICY_KEYS, "POLICY", errors);
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

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
