import type {
  GuidedActionOperation,
  GuidedActionResourceOption,
} from "./guided-action.js";

export const ACTION_SUGGESTION_VERSION = "synapsor.action-suggestion.v1" as const;

export type ActionAutoApprovalConditionSuggestion = {
  source?: "patch" | "before";
  field: string;
  operator: "lte" | "gte" | "eq" | "in" | "max_length";
  value?: string | number | boolean;
  values?: Array<string | number | boolean>;
};

export type ActionSharedApprovalLimitSuggestion = {
  kind: "count" | "total";
  scope: "tenant" | "tenant_principal" | "tenant_object";
  maximum: number;
  window_seconds: number;
  field?: string;
};

/**
 * Non-authoritative policy input. Runner revalidates it against the exact
 * reviewed action and the operator must accept or edit it before activation.
 */
export type ActionApprovalPolicySuggestion = {
  mode: "deterministic";
  conditions: ActionAutoApprovalConditionSuggestion[];
  max_per_day: number;
  max_total_per_day?: number;
  total_field?: string;
  shared_limits?: ActionSharedApprovalLimitSuggestion[];
  rationale?: string;
};

/** Untrusted convenience metadata. This object never grants authority. */
export type ActionSuggestion = {
  schema_version: typeof ACTION_SUGGESTION_VERSION;
  intent: string;
  operation?: GuidedActionOperation;
  resource?: string;
  fields?: string[];
  rationale?: string;
  approval_policy_proposal?: ActionApprovalPolicySuggestion;
  suggested_by: {
    kind: "operator" | "model";
    provider?: "openai" | "anthropic" | "openai_compatible";
    model?: string;
  };
};

export type ActionSuggestionAssessment = {
  status: "suggested" | "blocked";
  suggestion: ActionSuggestion;
  structural_evidence: Array<{
    decision: "resource" | "operation" | "field" | "approval_condition" | "shared_limit";
    value: string;
    state: "proven_candidate" | "unknown" | "unavailable";
    reason: string;
  }>;
  blockers: string[];
  authority_granted: false;
  source_database_changed: false;
};

const forbiddenSuggestionKeys = new Set([
  "approval",
  "approval_role",
  "auto_approval",
  "apply",
  "authority_posture",
  "credential",
  "executor",
  "principal",
  "principal_id",
  "sql",
  "supervised_worker_execution",
  "tenant",
  "tenant_id",
  "worker_policy",
  "write_url",
  "write_url_env",
  "writeback",
]);

export function assessActionSuggestion(
  value: unknown,
  resources: GuidedActionResourceOption[],
): ActionSuggestionAssessment {
  const suggestion = normalizeActionSuggestion(value);
  const evidence: ActionSuggestionAssessment["structural_evidence"] = [];
  const blockers: string[] = [];
  const resource = suggestion.resource
    ? resources.find((candidate) => candidate.id === suggestion.resource)
    : undefined;
  if (!suggestion.resource) blockers.push("A suggestion must name one exact structurally eligible resource.");
  if (!suggestion.operation) blockers.push("A suggestion must name insert, update, or delete.");
  if (suggestion.resource) {
    evidence.push({
      decision: "resource",
      value: suggestion.resource,
      state: resource ? "proven_candidate" : "unknown",
      reason: resource
        ? "The exact resource is present in the active reviewed Read Boundary and has direct write-scope proofs."
        : "The exact resource is not a structurally eligible action target.",
    });
    if (!resource) blockers.push(`Unknown or ineligible resource ${suggestion.resource}.`);
  }
  if (suggestion.operation && resource) {
    const availability = resource.operation_availability[suggestion.operation];
    evidence.push({
      decision: "operation",
      value: suggestion.operation,
      state: availability.available ? "proven_candidate" : "unavailable",
      reason: availability.reason,
    });
    if (!availability.available) blockers.push(availability.reason);
  }
  if (suggestion.fields?.length) {
    const eligible = new Set(resource?.structurally_eligible_fields.map((field) => field.name) ?? []);
    for (const field of suggestion.fields) {
      const available = eligible.has(field);
      evidence.push({
        decision: "field",
        value: field,
        state: available ? "proven_candidate" : "unknown",
        reason: available
          ? "The inspected column is structurally eligible for a human write review; no write permission is implied."
          : "The field is kept out, generated, scope-owned, unknown, or otherwise not structurally eligible.",
      });
      if (!available) blockers.push(`Field ${field} is not structurally eligible on ${suggestion.resource ?? "the suggested resource"}.`);
    }
  }
  if ((suggestion.operation === "insert" || suggestion.operation === "update")
    && !suggestion.fields?.length) {
    blockers.push(`${suggestion.operation} suggestions must name at least one exact candidate field.`);
  }
  if (suggestion.operation === "delete" && suggestion.fields?.length) {
    blockers.push("Delete suggestions cannot name patch fields; DELETE authority is reviewed separately.");
  }
  assessApprovalPolicyProposal(suggestion, resource, evidence, blockers);
  return {
    status: blockers.length ? "blocked" : "suggested",
    suggestion,
    structural_evidence: evidence,
    blockers,
    authority_granted: false,
    source_database_changed: false,
  };
}

export function normalizeActionSuggestion(value: unknown): ActionSuggestion {
  if (!isRecord(value)) throw new Error("ACTION_SUGGESTION_OBJECT_REQUIRED: suggestion must be a bounded JSON object.");
  rejectForbiddenSuggestionKeys(value);
  const allowed = new Set([
    "schema_version",
    "intent",
    "operation",
    "resource",
    "fields",
    "rationale",
    "approval_policy_proposal",
    "suggested_by",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`ACTION_SUGGESTION_KEY_UNKNOWN: unsupported keys: ${unknown.join(", ")}.`);
  if (value.schema_version !== ACTION_SUGGESTION_VERSION) {
    throw new Error(`ACTION_SUGGESTION_VERSION_INVALID: expected ${ACTION_SUGGESTION_VERSION}.`);
  }
  const intent = boundedText(value.intent, "intent", 500);
  const rationale = value.rationale === undefined ? undefined : boundedText(value.rationale, "rationale", 500);
  const operation = value.operation;
  if (operation !== undefined && operation !== "insert" && operation !== "update" && operation !== "delete") {
    throw new Error("ACTION_SUGGESTION_OPERATION_INVALID: operation must be insert, update, or delete.");
  }
  const resource = value.resource === undefined ? undefined : exactId(value.resource, "resource");
  const fields = value.fields === undefined
    ? undefined
    : boundedFields(value.fields);
  const approvalPolicyProposal = value.approval_policy_proposal === undefined
    ? undefined
    : normalizeApprovalPolicyProposal(value.approval_policy_proposal);
  if (!isRecord(value.suggested_by)) throw new Error("ACTION_SUGGESTION_SOURCE_REQUIRED: suggested_by is required.");
  rejectForbiddenSuggestionKeys(value.suggested_by);
  const kind = value.suggested_by.kind;
  if (kind !== "operator" && kind !== "model") throw new Error("ACTION_SUGGESTION_SOURCE_INVALID: suggested_by.kind must be operator or model.");
  const provider = value.suggested_by.provider;
  if (provider !== undefined && provider !== "openai" && provider !== "anthropic" && provider !== "openai_compatible") {
    throw new Error("ACTION_SUGGESTION_PROVIDER_INVALID: unsupported model provider.");
  }
  const model = value.suggested_by.model === undefined
    ? undefined
    : boundedText(value.suggested_by.model, "model", 128);
  if (kind === "model" && (!provider || !model)) {
    throw new Error("ACTION_SUGGESTION_MODEL_IDENTITY_REQUIRED: model suggestions must name provider and model.");
  }
  return {
    schema_version: ACTION_SUGGESTION_VERSION,
    intent,
    ...(operation ? { operation } : {}),
    ...(resource ? { resource } : {}),
    ...(fields ? { fields } : {}),
    ...(rationale ? { rationale } : {}),
    ...(approvalPolicyProposal ? { approval_policy_proposal: approvalPolicyProposal } : {}),
    suggested_by: {
      kind,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    },
  };
}

function normalizeApprovalPolicyProposal(value: unknown): ActionApprovalPolicySuggestion {
  if (!isRecord(value)) {
    throw new Error("ACTION_SUGGESTION_POLICY_OBJECT_REQUIRED: approval_policy_proposal must be one bounded object.");
  }
  assertOnlyKeys(value, [
    "mode",
    "conditions",
    "max_per_day",
    "max_total_per_day",
    "total_field",
    "shared_limits",
    "rationale",
  ], "ACTION_SUGGESTION_POLICY_KEY_UNKNOWN");
  if (value.mode !== "deterministic") {
    throw new Error("ACTION_SUGGESTION_POLICY_MODE_INVALID: policy proposals must use deterministic mode.");
  }
  if (!Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 16) {
    throw new Error("ACTION_SUGGESTION_POLICY_CONDITIONS_INVALID: use 1 through 16 deterministic conditions.");
  }
  const conditions = value.conditions.map(normalizeApprovalConditionSuggestion);
  const seen = new Set<string>();
  for (const condition of conditions) {
    const key = `${condition.source ?? "patch"}:${condition.field}:${condition.operator}`;
    if (seen.has(key)) throw new Error(`ACTION_SUGGESTION_POLICY_CONDITION_DUPLICATE: ${key}.`);
    seen.add(key);
  }
  const maxPerDay = boundedPositiveInteger(value.max_per_day, "max_per_day", 1_000_000);
  const maxTotalPerDay = value.max_total_per_day === undefined
    ? undefined
    : boundedPositiveInteger(value.max_total_per_day, "max_total_per_day", 1_000_000_000);
  const totalField = value.total_field === undefined ? undefined : exactId(value.total_field, "total_field");
  if ((maxTotalPerDay === undefined) !== (totalField === undefined)) {
    throw new Error("ACTION_SUGGESTION_POLICY_TOTAL_SHAPE_INVALID: max_total_per_day and total_field must be supplied together.");
  }
  const sharedLimits = value.shared_limits === undefined
    ? undefined
    : normalizeSharedApprovalLimitSuggestions(value.shared_limits);
  const rationale = value.rationale === undefined
    ? undefined
    : boundedText(value.rationale, "approval policy rationale", 500);
  return {
    mode: "deterministic",
    conditions,
    max_per_day: maxPerDay,
    ...(maxTotalPerDay === undefined ? {} : { max_total_per_day: maxTotalPerDay, total_field: totalField! }),
    ...(sharedLimits?.length ? { shared_limits: sharedLimits } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeApprovalConditionSuggestion(value: unknown): ActionAutoApprovalConditionSuggestion {
  if (!isRecord(value)) {
    throw new Error("ACTION_SUGGESTION_POLICY_CONDITION_INVALID: each condition must be one bounded object.");
  }
  assertOnlyKeys(value, ["source", "field", "operator", "value", "values"], "ACTION_SUGGESTION_POLICY_CONDITION_KEY_UNKNOWN");
  const source = value.source === undefined ? undefined : value.source;
  if (source !== undefined && source !== "patch" && source !== "before") {
    throw new Error("ACTION_SUGGESTION_POLICY_SOURCE_INVALID: condition source must be patch or before.");
  }
  const field = exactId(value.field, "condition field");
  const operator = value.operator;
  if (operator !== "lte" && operator !== "gte" && operator !== "eq" && operator !== "in" && operator !== "max_length") {
    throw new Error("ACTION_SUGGESTION_POLICY_OPERATOR_INVALID: use lte, gte, eq, in, or max_length.");
  }
  if (operator === "in") {
    if (value.value !== undefined || !Array.isArray(value.values) || value.values.length < 1 || value.values.length > 64) {
      throw new Error("ACTION_SUGGESTION_POLICY_VALUES_INVALID: IN requires 1 through 64 scalar values and no value field.");
    }
    return {
      ...(source ? { source } : {}),
      field,
      operator,
      values: value.values.map((candidate) => boundedPolicyScalar(candidate, field)),
    };
  }
  if (value.values !== undefined || value.value === undefined) {
    throw new Error(`ACTION_SUGGESTION_POLICY_VALUE_INVALID: ${operator} requires one scalar value and no values array.`);
  }
  const scalar = boundedPolicyScalar(value.value, field);
  if ((operator === "lte" || operator === "gte" || operator === "max_length") && typeof scalar !== "number") {
    throw new Error(`ACTION_SUGGESTION_POLICY_NUMERIC_VALUE_REQUIRED: ${operator} requires a finite number.`);
  }
  if (operator === "max_length"
    && (typeof scalar !== "number" || !Number.isSafeInteger(scalar) || scalar < 1 || scalar > 100_000)) {
    throw new Error("ACTION_SUGGESTION_POLICY_LENGTH_INVALID: max_length must be an integer from 1 through 100000.");
  }
  return { ...(source ? { source } : {}), field, operator, value: scalar };
}

function normalizeSharedApprovalLimitSuggestions(value: unknown): ActionSharedApprovalLimitSuggestion[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("ACTION_SUGGESTION_SHARED_LIMITS_INVALID: shared_limits must contain at most 8 bounded limits.");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_INVALID: each shared limit must be one bounded object.");
    }
    assertOnlyKeys(candidate, ["kind", "scope", "maximum", "window_seconds", "field"], "ACTION_SUGGESTION_SHARED_LIMIT_KEY_UNKNOWN");
    if (candidate.kind !== "count" && candidate.kind !== "total") {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_KIND_INVALID: shared limit kind must be count or total.");
    }
    if (candidate.scope !== "tenant" && candidate.scope !== "tenant_principal" && candidate.scope !== "tenant_object") {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_SCOPE_INVALID: model proposals may use tenant, tenant_principal, or tenant_object.");
    }
    const maximum = boundedPositiveInteger(candidate.maximum, "shared limit maximum", Number.MAX_SAFE_INTEGER);
    const windowSeconds = boundedPositiveInteger(candidate.window_seconds, "shared limit window_seconds", 31_536_000);
    if (windowSeconds < 60) {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_WINDOW_INVALID: window_seconds must be between 60 and 31536000.");
    }
    const field = candidate.field === undefined ? undefined : exactId(candidate.field, "shared limit field");
    if (candidate.kind === "total" && !field) {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_TOTAL_FIELD_REQUIRED: total limits require one exact field.");
    }
    if (candidate.kind === "count" && field) {
      throw new Error("ACTION_SUGGESTION_SHARED_LIMIT_COUNT_FIELD_FORBIDDEN: count limits cannot name a field.");
    }
    return {
      kind: candidate.kind,
      scope: candidate.scope,
      maximum,
      window_seconds: windowSeconds,
      ...(field ? { field } : {}),
    };
  });
}

function assessApprovalPolicyProposal(
  suggestion: ActionSuggestion,
  resource: GuidedActionResourceOption | undefined,
  evidence: ActionSuggestionAssessment["structural_evidence"],
  blockers: string[],
): void {
  const policy = suggestion.approval_policy_proposal;
  if (!policy) return;
  if (suggestion.operation === "delete") {
    blockers.push("Hard DELETE cannot carry an auto-approval policy proposal; it always requires human review.");
  }
  if (suggestion.operation !== "insert" && suggestion.operation !== "update") {
    blockers.push("A deterministic approval policy proposal requires an INSERT or UPDATE suggestion.");
  }
  const selectedFields = new Set(suggestion.fields ?? []);
  const fieldByName = new Map(resource?.structurally_eligible_fields.map((field) => [field.name, field]) ?? []);
  for (const condition of policy.conditions) {
    const source = condition.source ?? "patch";
    const field = fieldByName.get(condition.field);
    let reason = field
      ? `${source}.${condition.field} is structurally available for exact operator policy review.`
      : `${condition.field} is not a structurally eligible reviewed field.`;
    if (!field) blockers.push(`Approval condition field ${condition.field} is not structurally eligible on ${suggestion.resource ?? "the suggested resource"}.`);
    if (source === "patch" && !selectedFields.has(condition.field)) {
      blockers.push(`Approval condition patch.${condition.field} is not one of the suggested model-controlled fields.`);
      reason = `${reason} Patch conditions must cover an exact suggested field.`;
    }
    if (field) assessApprovalConditionType(condition, field, blockers);
    evidence.push({
      decision: "approval_condition",
      value: `${source}.${condition.field} ${condition.operator}`,
      state: field && (source !== "patch" || selectedFields.has(condition.field)) ? "proven_candidate" : "unknown",
      reason,
    });
  }
  for (const field of selectedFields) {
    if (!policy.conditions.some((condition) => (condition.source ?? "patch") === "patch" && condition.field === field)) {
      blockers.push(`Deterministic approval proposal does not cover model-controlled patch field ${field}.`);
    }
  }
  if (policy.total_field) {
    const field = fieldByName.get(policy.total_field);
    if (!field || !selectedFields.has(policy.total_field) || !numericDataType(field.data_type)) {
      blockers.push(`Aggregate auto-approval field ${policy.total_field} must be one suggested numeric patch field.`);
    }
  }
  for (const [index, limit] of (policy.shared_limits ?? []).entries()) {
    if (limit.scope === "tenant_principal" && !resource?.principal_key && !resource?.principal_rls_setting) {
      blockers.push("A tenant_principal approval limit requires direct reviewed principal scope on the action resource.");
    }
    if (limit.kind === "total") {
      const field = limit.field ? fieldByName.get(limit.field) : undefined;
      if (!field || !selectedFields.has(limit.field!) || !numericDataType(field.data_type)) {
        blockers.push(`Shared total limit field ${limit.field ?? "(missing)"} must be one suggested numeric patch field.`);
      }
    }
    evidence.push({
      decision: "shared_limit",
      value: `${limit.kind}:${limit.scope}:${index + 1}`,
      state: limit.scope !== "tenant_principal" || Boolean(resource?.principal_key || resource?.principal_rls_setting) ? "proven_candidate" : "unavailable",
      reason: "The scope selects trusted runtime identity dimensions only; the model supplies no tenant, principal, or object value.",
    });
  }
}

function assessApprovalConditionType(
  condition: ActionAutoApprovalConditionSuggestion,
  field: GuidedActionResourceOption["structurally_eligible_fields"][number],
  blockers: string[],
): void {
  if ((condition.operator === "lte" || condition.operator === "gte") && !numericDataType(field.data_type)) {
    blockers.push(`${condition.operator} is available only for numeric fields; ${field.name} is ${field.data_type}.`);
  }
  if (condition.operator === "max_length" && (numericDataType(field.data_type) || booleanDataType(field.data_type))) {
    blockers.push(`max_length is unavailable for ${field.name} because ${field.data_type} is not a text type.`);
  }
  if (condition.operator === "in" && field.enum_values.length) {
    const outside = (condition.values ?? []).find((value) => typeof value !== "string" || !field.enum_values.includes(value));
    if (outside !== undefined) blockers.push(`${field.name} policy values must come from its reviewed enum.`);
  }
}

function numericDataType(value: string): boolean {
  return /(?:^|\b)(?:smallint|integer|bigint|int|decimal|numeric|real|double|float|money)(?:\b|$)/i.test(value);
}

function booleanDataType(value: string): boolean {
  return /(?:^|\b)(?:bool|boolean)(?:\b|$)/i.test(value);
}

function boundedPolicyScalar(value: unknown, field: string): string | number | boolean {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`ACTION_SUGGESTION_POLICY_SCALAR_INVALID: ${field} must use a finite number.`);
    return value;
  }
  if (typeof value === "boolean") return value;
  return boundedText(value, `${field} policy value`, 500);
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`ACTION_SUGGESTION_POLICY_LIMIT_INVALID: ${label} must be an integer from 1 through ${maximum}.`);
  }
  return Number(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  code: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${code}: unsupported key ${unknown}.`);
}

function rejectForbiddenSuggestionKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (forbiddenSuggestionKeys.has(key.toLowerCase())) {
      throw new Error(
        `ACTION_SUGGESTION_AUTHORITY_FORBIDDEN: ${key} is a human-owned authority decision and cannot appear in a suggestion.`,
      );
    }
  }
}

function boundedFields(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("ACTION_SUGGESTION_FIELDS_INVALID: fields must contain 1 through 32 exact ids.");
  }
  const fields = value.map((field) => exactId(field, "field"));
  if (new Set(fields).size !== fields.length) throw new Error("ACTION_SUGGESTION_FIELDS_DUPLICATED: each field may appear once.");
  return fields;
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(value)) {
    throw new Error(`ACTION_SUGGESTION_ID_INVALID: ${label} must be an exact bounded id.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`ACTION_SUGGESTION_TEXT_INVALID: ${label} must be text.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`ACTION_SUGGESTION_TEXT_INVALID: ${label} must be 1 through ${maximum} safe characters.`);
  }
  if (/(?:postgres|mysql):\/\/|BEGIN [A-Z ]*PRIVATE KEY|bearer\s+[A-Za-z0-9._-]+/i.test(normalized)) {
    throw new Error(`ACTION_SUGGESTION_SECRET_BLOCKED: ${label} appears to contain secret material.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
