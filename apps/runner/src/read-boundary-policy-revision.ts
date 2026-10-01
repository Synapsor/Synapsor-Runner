import { EXPLORATION_BUDGET_REVIEW_CEILINGS } from "./auto-boundary.js";
import type { BoundaryResourceReviewRequest } from "./read-authoring-contract-types.js";

const fieldLists = ["selectable_fields", "filterable_fields", "sortable_fields", "groupable_fields", "time_bucket_fields", "count_distinct_fields"] as const;
const numericLimits = {
  minimum_cohort_size: 5, max_ranked_groups: 10_000, max_queries_per_session: 1_000, rate_limit_per_minute: 120,
  ...Object.fromEntries(["max_rows", "max_groups", "max_top_n", "max_response_cells", "max_response_bytes", "statement_timeout_ms", "max_measures", "max_dimensions"].map((key) => [key, EXPLORATION_BUDGET_REVIEW_CEILINGS[key as keyof typeof EXPLORATION_BUDGET_REVIEW_CEILINGS]])),
};

type PolicyKey = typeof fieldLists[number] | "metadata" | "field_metadata" | "relationship_ids" | "relationship_only" | "exclude"
  | "minimum_cohort_size" | "max_ranked_groups" | "max_queries_per_session" | "rate_limit_per_minute"
  | "max_rows" | "max_groups" | "max_top_n" | "max_response_cells" | "max_response_bytes"
  | "statement_timeout_ms" | "max_measures" | "max_dimensions";
export type ReadBoundaryPolicySettings = Pick<BoundaryResourceReviewRequest, PolicyKey>;
export type ReadBoundaryPolicyChange = { resource: string; settings: ReadBoundaryPolicySettings };

const metadataProperties = {
  label: { type: ["string", "null"], maxLength: 120 },
  description: { type: ["string", "null"], maxLength: 500 },
};
export const READ_POLICY_SETTINGS_SCHEMA = {
  type: "object", additionalProperties: false, minProperties: 1,
  properties: {
    exclude: { type: "boolean", const: true, description: "Remove this resource and its incoming Read paths from discovery and all Read queries, including counts. Use alone, only when the operator requests no Read access to this resource. Private Action dependencies are separately revalidated; this does not revoke them." },
    relationship_only: { type: "boolean", const: true, description: "Remove independent queries; retain only existing reviewed incoming paths. Cannot restore independent access." },
    ...Object.fromEntries(fieldLists.map((name) => [name, {
      type: "array", maxItems: 128, uniqueItems: true, items: { type: "string", maxLength: 256 },
    }])),
    relationship_ids: {
      type: "array", maxItems: 128, uniqueItems: true, items: { type: "string", maxLength: 256 },
      description: "Replace this root resource's outgoing Read paths with a subset of its current relationship ids. Retain unrequested paths. Empty removes all outgoing paths, not the root's own access or private Action verification. Narrow incoming access to a target by editing each unwanted root, not the target's list.",
    },
    ...Object.fromEntries(Object.entries(numericLimits).map(([name, maximum]) => [name, { type: "integer", minimum: 1, maximum }])),
    metadata: { type: "object", additionalProperties: false, minProperties: 1, properties: metadataProperties },
    field_metadata: {
      type: "array", minItems: 1, maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["field"], properties: { field: { type: "string" }, ...metadataProperties } },
    },
  },
};

/** This allowlist intentionally excludes trusted scope, resource creation, and activation. */
export function parseReadPolicySettings(value: unknown, resource: {
  fields: Array<{ id: string; roles: string[] }>;
  relationships: string[];
}): ReadBoundaryPolicySettings {
  if (!record(value) || !Object.keys(value).length) throw new Error("settings must contain a reviewed Read policy change.");
  if (value.exclude !== undefined && (value.exclude !== true || Object.keys(value).length !== 1)) {
    throw new Error("exclude must be true and used alone to remove this resource from Read access. Restoring a resource requires a separate scope review.");
  }
  const keys = new Set(Object.keys(READ_POLICY_SETTINGS_SCHEMA.properties));
  const fields = new Map(resource.fields.map((field) => [field.id, field]));
  for (const [key, setting] of Object.entries(value)) {
    if (!keys.has(key)) throw new Error(`Read setting ${key} is not available through this revision. Trusted scope and authority cannot change here.`);
    if (key in numericLimits) {
      const ceiling = numericLimits[key as keyof typeof numericLimits];
      if (!Number.isSafeInteger(setting) || Number(setting) < 1 || Number(setting) > Number(ceiling)) {
        throw new Error(`${key} must be an integer from 1 through ${ceiling}.`);
      }
    } else if (key === "exclude") {
      // Validated above: resource removal cannot also replace field policy.
    } else if (key === "relationship_only") {
      if (setting !== true) throw new Error("relationship_only can only remove independent query access; restoring it requires a separate scope review.");
    } else if (key === "metadata") {
      validateMetadata(setting, false);
    } else if (key === "field_metadata") {
      if (!Array.isArray(setting) || !setting.length || setting.length > 128) throw new Error("field_metadata must contain 1-128 exact fields.");
      const seen = new Set<string>();
      for (const item of setting) {
        validateMetadata(item, true);
        const name = String(item.field);
        if (!fields.has(name) || seen.has(name)) throw new Error(`Unknown or repeated metadata field ${name}.`);
        seen.add(name);
      }
    } else {
      if (!Array.isArray(setting) || setting.length > 128 || new Set(setting).size !== setting.length) throw new Error(`${key} must be a bounded unique list.`);
      for (const name of setting) {
        if (typeof name !== "string" || (key === "relationship_ids" ? !resource.relationships.includes(name) : !fields.has(name))) {
          throw new Error(`${key} contains an identifier outside the reviewed catalog.`);
        }
        if (key !== "relationship_ids" && fields.get(name)!.roles.includes("trusted_scope")) throw new Error("Trusted scope fields cannot acquire model-controlled Read operations.");
      }
    }
  }
  if (value.max_top_n !== undefined && value.max_groups !== undefined && Number(value.max_top_n) > Number(value.max_groups)) {
    throw new Error("max_top_n cannot exceed max_groups.");
  }
  return structuredClone(value) as ReadBoundaryPolicySettings;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateMetadata(value: unknown, field: boolean): asserts value is Record<string, unknown> {
  if (!record(value) || !Object.keys(value).length
    || Object.keys(value).some((key) => !["label", "description", ...(field ? ["field"] : [])].includes(key))) throw new Error("Invalid reviewed metadata.");
  if (field && typeof value.field !== "string") throw new Error("Field metadata requires an exact field.");
  for (const key of ["label", "description"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    const maximum = key === "label" ? 120 : 500;
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > maximum || /[\u0000-\u001f\u007f]/u.test(value[key])) throw new Error(`${key} must be safe reviewed text of at most ${maximum} characters.`);
  }
}
