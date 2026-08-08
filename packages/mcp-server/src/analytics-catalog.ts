import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  z,
} from "zod";
import {
  analyticalToolOutputSchema,
  schemaAsJsonSchema,
  type JsonSchemaObject,
} from "./analytics-output-schema.js";
import {
  listedLocalCapabilities,
} from "./capability-authority.js";
import type {
  ResultFormat,
  RuntimeCapabilityConfig,
  RuntimeConfig,
} from "./runtime-types.js";
import {
  zodInputShape,
} from "./tool-input-schema.js";

export const ANALYTICS_CATALOG_SCHEMA_VERSION = "synapsor.analytics-catalog.v1" as const;
export const ANALYTICS_CATALOG_URI = "synapsor://analytics/catalog/v1" as const;

export type AnalyticsCatalogScalarType = "integer" | "number" | "string" | "scalar";

export type AnalyticsCatalogMeasure = {
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
  scalar_type: AnalyticsCatalogScalarType;
};

export type AnalyticsCatalogDimension = {
  name: string;
  scalar_type: "scalar";
};

export type AnalyticsCatalogTimeField = {
  name: string;
  bucket: "hour" | "day" | "week" | "month" | "quarter" | "year" | "day_of_week";
  scalar_type: "string";
};

export type AnalyticsCatalogCapability = {
  capability: string;
  description?: string;
  kind: "aggregate_read";
  origin: "protected" | "authored";
  contract: {
    digest: `sha256:${string}`;
    version: string;
  };
  input_schema: JsonSchemaObject;
  output_schema: JsonSchemaObject;
  counted_entity: "subject";
  result_grain: "single_aggregate" | "reviewed_groups";
  measures: AnalyticsCatalogMeasure[];
  dimensions: AnalyticsCatalogDimension[];
  time_fields: AnalyticsCatalogTimeField[];
  reporting_timezone?: {
    name: "UTC";
    authority: "reviewed_digest";
  };
  suppression: {
    minimum_cohort_size: number;
    overridden?: true;
    totals_returned: false;
  };
  limits: {
    maximum_groups: number;
    maximum_response_cells?: number;
    maximum_response_bytes?: number;
  };
  safe_reviewed_lineage: {
    relationship_paths: Array<{
      name: string;
      path_depth: number;
      cardinality: "many_to_one";
    }>;
  };
};

export type AnalyticsCatalogV1 = {
  schema_version: typeof ANALYTICS_CATALOG_SCHEMA_VERSION;
  catalog_digest: `sha256:${string}`;
  result_format: ResultFormat;
  capabilities: AnalyticsCatalogCapability[];
};

export type AnalyticsCatalogPinResult = {
  schema_version: "synapsor.analytics-catalog-pin.v1";
  status: "current" | "review_required";
  capability: string;
  requested_digest: string;
  current_digest?: `sha256:${string}`;
  catalog_digest: `sha256:${string}`;
  metadata?: AnalyticsCatalogCapability;
  message: string;
  source_database_changed: false;
};

export function buildAnalyticsCatalog(
  config: RuntimeConfig,
  resultFormat: ResultFormat = config.result_format ?? 1,
): AnalyticsCatalogV1 {
  const capabilities = listedLocalCapabilities(config)
    .flatMap((capability) => {
      const entry = analyticsCatalogCapability(
        capability,
        resultFormat,
        config.generated_authority?.reporting_timezone,
        config.generated_authority?.minimum_cohort_overrides?.[capability.name],
      );
      return entry ? [entry] : [];
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
  const authority = {
    schema_version: ANALYTICS_CATALOG_SCHEMA_VERSION,
    result_format: resultFormat,
    capabilities,
  };
  return {
    ...authority,
    catalog_digest: canonicalJsonDigest(authority),
  };
}

export function pinAnalyticsCatalogCapability(
  catalog: AnalyticsCatalogV1,
  capabilityName: string,
  requestedDigest: string,
): AnalyticsCatalogPinResult {
  const capability = catalog.capabilities.find((candidate) => candidate.capability === capabilityName);
  if (!capability || capability.contract.digest !== requestedDigest) {
    return {
      schema_version: "synapsor.analytics-catalog-pin.v1",
      status: "review_required",
      capability: capabilityName,
      requested_digest: requestedDigest,
      ...(capability ? { current_digest: capability.contract.digest } : {}),
      catalog_digest: catalog.catalog_digest,
      message: capability
        ? "The requested contract digest is stale. Review the current analytical capability before using it."
        : "The requested analytical capability is not active in this authenticated deployment.",
      source_database_changed: false,
    };
  }
  return {
    schema_version: "synapsor.analytics-catalog-pin.v1",
    status: "current",
    capability: capabilityName,
    requested_digest: requestedDigest,
    current_digest: capability.contract.digest,
    catalog_digest: catalog.catalog_digest,
    metadata: capability,
    message: "The analytical capability and exact contract digest are current.",
    source_database_changed: false,
  };
}

function analyticsCatalogCapability(
  capability: RuntimeCapabilityConfig,
  resultFormat: ResultFormat,
  reportingTimezone?: "UTC",
  minimumCohortOverride?: {
    contract_digest: `sha256:${string}`;
    minimum_cohort_size: number;
    review_digest: `sha256:${string}`;
  },
): AnalyticsCatalogCapability | undefined {
  if (capability.kind !== "aggregate_read" || !capability.contract_provenance) return undefined;
  const outputSchema = analyticalToolOutputSchema(capability, resultFormat);
  if (!outputSchema) return undefined;
  const inputSchema = schemaAsJsonSchema(z.object(zodInputShape(capability)).strict());
  const protectedRead = capability.protected_read;
  const protectedAggregate = protectedRead?.mode === "aggregate"
    ? protectedRead.aggregate
    : undefined;
  if (protectedRead && protectedAggregate) {
    const relationships = protectedRead.relationships
      ?? (protectedRead.relationship
        ? [{
          name: protectedRead.relationship.name,
          links: [protectedRead.relationship],
        }]
        : []);
    return {
      capability: capability.name,
      ...(capability.description ? { description: capability.description } : {}),
      kind: "aggregate_read",
      origin: "protected",
      contract: capability.contract_provenance,
      input_schema: inputSchema,
      output_schema: schemaAsJsonSchema(outputSchema),
      counted_entity: protectedAggregate.counted_entity,
      result_grain: protectedAggregate.dimensions?.length || protectedAggregate.time_bucket
        ? "reviewed_groups"
        : "single_aggregate",
      measures: protectedAggregate.measures.map((measure) => ({
        name: measure.name,
        function: measure.function,
        scalar_type: measureScalarType(measure.function),
      })),
      dimensions: (protectedAggregate.dimensions ?? []).map((dimension) => ({
        name: dimension.name,
        scalar_type: "scalar",
      })),
      time_fields: protectedAggregate.time_bucket
        ? [{
          name: protectedAggregate.time_bucket.name,
          bucket: protectedAggregate.time_bucket.bucket,
          scalar_type: "string",
        }]
        : [],
      ...(reportingTimezone
        ? {
          reporting_timezone: {
            name: reportingTimezone,
            authority: "reviewed_digest",
          },
        }
        : {}),
      suppression: {
        minimum_cohort_size: effectiveProtectedMinimumGroupSize(protectedAggregate),
        ...(minimumCohortOverride
          && minimumCohortOverride.contract_digest === capability.contract_provenance.digest
          && minimumCohortOverride.minimum_cohort_size === protectedAggregate.minimum_group_size
          ? { overridden: true as const }
          : {}),
        totals_returned: false,
      },
      limits: {
        maximum_groups: protectedRead.limits.max_groups,
        maximum_response_cells: protectedRead.limits.max_response_cells,
        maximum_response_bytes: protectedRead.limits.max_response_bytes,
      },
      safe_reviewed_lineage: {
        relationship_paths: relationships.map((relationship) => ({
          name: relationship.name,
          path_depth: relationship.links.length,
          cardinality: "many_to_one",
        })),
      },
    };
  }
  if (!capability.aggregate) return undefined;
  return {
    capability: capability.name,
    ...(capability.description ? { description: capability.description } : {}),
    kind: "aggregate_read",
    origin: "authored",
    contract: capability.contract_provenance,
    input_schema: inputSchema,
    output_schema: schemaAsJsonSchema(outputSchema),
    counted_entity: "subject",
    result_grain: "single_aggregate",
    measures: [{
      name: "value",
      function: capability.aggregate.function,
      scalar_type: measureScalarType(capability.aggregate.function),
    }],
    dimensions: [],
    time_fields: [],
    suppression: {
      minimum_cohort_size: capability.aggregate.minimum_group_size,
      totals_returned: false,
    },
    limits: {
      maximum_groups: 1,
    },
    safe_reviewed_lineage: {
      relationship_paths: [],
    },
  };
}

function measureScalarType(
  fn: AnalyticsCatalogMeasure["function"],
): AnalyticsCatalogScalarType {
  return fn === "count" || fn === "count_distinct" || fn === "null_count" || fn === "non_null_count"
    ? "integer"
    : "number";
}

function effectiveProtectedMinimumGroupSize(
  aggregate: NonNullable<NonNullable<RuntimeCapabilityConfig["protected_read"]>["aggregate"]>,
): number {
  return aggregate.measures.some((measure) =>
    ["stddev_samp", "stddev_pop", "var_samp", "var_pop", "reviewed_derived"].includes(measure.function))
    ? Math.max(aggregate.minimum_group_size, 5)
    : aggregate.minimum_group_size;
}
