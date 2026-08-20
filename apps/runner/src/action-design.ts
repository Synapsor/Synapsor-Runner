import type {
  GuidedActionOperation,
  GuidedActionResourceOption,
} from "./guided-action.js";

export const ACTION_SUGGESTION_VERSION = "synapsor.action-suggestion.v1" as const;

/** Untrusted convenience metadata. This object never grants authority. */
export type ActionSuggestion = {
  schema_version: typeof ACTION_SUGGESTION_VERSION;
  intent: string;
  operation?: GuidedActionOperation;
  resource?: string;
  fields?: string[];
  rationale?: string;
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
    decision: "resource" | "operation" | "field";
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
  const allowed = new Set(["schema_version", "intent", "operation", "resource", "fields", "rationale", "suggested_by"]);
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
    suggested_by: {
      kind,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    },
  };
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
