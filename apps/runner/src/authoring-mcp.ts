import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  scopedExploreDescribeToolOutputSchema,
  scopedExploreQueryToolOutputSchema,
} from "@synapsor-runner/mcp-server";
import { z } from "zod";
import runnerPackage from "../package.json" with { type: "json" };
import { EXPLORATION_TIME_BUCKETS } from "./auto-boundary.js";
import {
  AGGREGATE_MEASURE_FUNCTIONS,
  projectScopedExploreResultForModel,
  SCOPED_EXPLORE_DESCRIBE_TOOL,
  SCOPED_EXPLORE_QUERY_TOOL,
  ScopedExploreError,
  type ScopedExploreRuntime,
} from "./scoped-explore.js";
import {
  createScopedExploreBoundarySetRuntime,
  type ScopedExploreBoundarySetRuntime,
} from "./scoped-explore-boundary-set.js";

const filterScalar = z.union([z.string().max(512), z.number().finite(), z.boolean()]).describe(
  "A concrete filter value. Null is not a filter literal; use null_count, non_null_count, or completion_rate for missing-data analysis.",
);
const fieldId = z.string().min(1).max(256).describe("Exact field id; keep relationship separate.");
const resourceId = z.string().min(1).max(256)
  .describe("Exact root resource id.");
// Smaller models often serialize an omitted optional JSON field as null.
const optionalModelArgument = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value === null ? undefined : value, schema.optional());
const modelInteger = <T extends z.ZodNumber>(schema: T) => z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(normalized)) return value;
  return Number(normalized);
}, schema);
const modelArray = <T extends z.ZodTypeAny>(schema: T) => modelJsonContainer(schema, Array.isArray);
const modelObject = <T extends z.ZodTypeAny>(schema: T) => modelJsonContainer(
  schema,
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const optionalBoundarySelector = optionalModelArgument(z.string()
  .regex(/^(?:[a-z][a-z0-9_.-]{0,63})?$/)
  .describe("Exact active boundary name; empty means omitted."));
const optionalResourceSelector = optionalModelArgument(z.string().max(256)
  .describe("Exact resource id; empty means omitted."));
const relationshipId = z.string().min(1).max(256).describe("Exact relationship id.");
const numericBandId = z.string().min(1).max(64).describe(
  "Exact reviewed numeric-band name; never send edges.",
);
const filter = z.object({
  field: fieldId,
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([filterScalar, z.array(filterScalar).min(1).max(20)]),
  relationship: optionalModelArgument(relationshipId),
}).strict();

export function createScopedExploreMcpServer(
  runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
  options: { mode?: "local_authoring" | "production_http" } = {},
): McpServer {
  const production = options.mode === "production_http";
  const rowPlan = z.object({
    kind: z.literal("rows"),
    resource: resourceId,
    select: modelArray(z.array(fieldId).min(1).max(20)),
    where: optionalModelArgument(modelArray(z.array(filter).max(8))),
    order_by: optionalModelArgument(modelArray(z.array(z.object({
      field: fieldId,
      direction: z.enum(["asc", "desc"]),
    }).strict()).max(3))),
    limit: optionalModelArgument(modelInteger(z.number().int().positive().describe(
      "Maximum returned rows. Omit to use Runner's conservative reviewed default.",
    ))),
  }).strict();
  const aggregatePlan = z.object({
    kind: z.literal("aggregate"),
    resource: resourceId,
    relationship: optionalModelArgument(relationshipId),
    measures: modelArray(z.array(z.union([
      z.object({
        function: z.enum(AGGREGATE_MEASURE_FUNCTIONS),
        field: optionalModelArgument(fieldId),
        relationship: optionalModelArgument(relationshipId),
      }).strict(),
      z.object({
        derived_measure: fieldId.describe(
          "Exact reviewed derived-measure name; never send a formula.",
        ),
      }).strict(),
    ])).min(1)),
    dimensions: optionalModelArgument(modelArray(z.array(z.union([
      z.object({
        field: fieldId,
        relationship: optionalModelArgument(relationshipId),
      }).strict(),
      z.object({
        numeric_band: numericBandId,
      }).strict(),
    ])))),
    time_bucket: optionalModelArgument(modelObject(z.object({
      field: fieldId,
      bucket: z.enum(EXPLORATION_TIME_BUCKETS),
      relationship: optionalModelArgument(relationshipId),
    }).strict())),
    where: optionalModelArgument(modelArray(z.array(filter).max(8))),
    order_by: optionalModelArgument(modelObject(z.union([
      z.object({
        kind: z.literal("measure"),
        index: modelInteger(z.number().int().nonnegative()),
        direction: z.enum(["asc", "desc"]),
      }).strict(),
      z.object({
        kind: z.literal("comparison_change"),
        index: modelInteger(z.number().int().nonnegative()),
        change: z.enum(["absolute", "percentage"]),
        direction: z.enum(["asc", "desc"]),
      }).strict().describe("Rank reviewed period change; desc is growth, asc is decline."),
      z.object({
        kind: z.literal("time_bucket"),
        direction: z.enum(["asc", "desc"]),
      }).strict(),
    ]))),
    top_n: optionalModelArgument(modelInteger(z.number().int().positive().describe(
      "Maximum aggregate rows; omit to use Runner's conservative reviewed default. Dimension-by-time uses one row per dimension/time combination; comparisons need both periods.",
    ))),
    comparison: optionalModelArgument(modelObject(z.object({
      field: fieldId,
      relationship: optionalModelArgument(relationshipId),
      ranges: modelArray(z.array(z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
      }).strict()).length(2).describe("Two non-overlapping ranges, earlier then later.")),
    }).strict())),
  }).strict();
  const plan = z.discriminatedUnion("kind", [rowPlan, aggregatePlan], {
    errorMap: (issue, context) => issue.code === z.ZodIssueCode.invalid_union_discriminator
      ? { message: invalidExploreKindMessage() }
      : { message: context.defaultError },
  });
  const exploreInput = z.object({
    boundary: optionalBoundarySelector,
    plan,
  }).strict();

  const server = new McpServer(
    { name: production ? "synapsor-runner-production-explore" : "synapsor-runner-authoring", version: runnerPackage.version },
    { capabilities: { tools: {} } },
  );
  server.registerTool(SCOPED_EXPLORE_DESCRIBE_TOOL, {
    title: "Describe reviewed data",
    description: "Metadata only; never answers a data question. Without resource, lists a compact index of exact active resource ids and direct analysis. With one exact resource id, returns focused fields and relationship details. Copy ids into app.explore_data for values; use boundary only to disambiguate overlaps. No source rows.",
    inputSchema: z.object({
      boundary: optionalBoundarySelector,
      resource: optionalResourceSelector,
      cursor: optionalModelArgument(z.number().int().nonnegative()),
      limit: z.preprocess(
        (value) => value === 0 ? undefined : value,
        optionalModelArgument(z.number().int().positive().max(10)),
      ),
    }).strict(),
    outputSchema: scopedExploreDescribeToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "synapsor.kind": "scoped_explore_description",
      "synapsor.authoring_only": !production,
      "synapsor.production_explore": production,
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  }, async (input) => toolResult(async () => projectDescribeDataForModel(
    await runtime.describe({
      ...(input.boundary ? { boundary: input.boundary } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
    Boolean(input.resource),
  )));
  server.registerTool(SCOPED_EXPLORE_QUERY_TOOL, {
    title: "Explore reviewed data",
    description: exploreToolDescription(production),
    inputSchema: exploreInput,
    outputSchema: scopedExploreQueryToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "synapsor.kind": "scoped_explore",
      "synapsor.authoring_only": !production,
      "synapsor.production_explore": production,
      "synapsor.untrusted_output": true,
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  }, async ({ boundary: selectedBoundary, plan: parsedPlan }) => {
    const boundary = selectedBoundary || undefined;
    const plan = omitUndefinedModelArguments(parsedPlan);
    return toolResult(
      () => isBoundarySetRuntime(runtime)
        ? runtime.explore(plan, boundary)
        : runtime.explore(plan),
      (result) => isBoundarySetRuntime(runtime)
        ? runtime.projectResultForModel({
          tool: SCOPED_EXPLORE_QUERY_TOOL,
          arguments: { ...(boundary ? { boundary } : {}), plan },
          result,
        })
        : projectScopedExploreResultForModel({
          tool: SCOPED_EXPLORE_QUERY_TOOL,
          arguments: { plan },
          result,
          boundary: runtime.boundary,
        }),
    );
  });
  return server;
}

function modelJsonContainer<T extends z.ZodTypeAny>(
  schema: T,
  expected: (value: unknown) => boolean,
): z.ZodEffects<T> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return expected(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }, schema);
}

function invalidExploreKindMessage(): string {
  return "plan.kind must be exactly rows or aggregate. Example: " +
    '{"plan":{"kind":"aggregate","resource":"<exact resource id from app.describe_data>","measures":[{"function":"count"}],"top_n":25}}';
}

function exploreToolDescription(production: boolean): string {
  return [
    `Runs one reviewed read-only ${production ? "production" : "local"} plan.`,
    "Call app.describe_data first and copy exact ids. Send {boundary?,plan:{...}}; plan.kind is exactly rows or aggregate.",
    'Aggregate: {"plan":{"kind":"aggregate","resource":"<exact resource id>","measures":[{"function":"sum","field":"<field>"}],"dimensions":[{"field":"<field>"}]}}. Omitted top_n uses Runner\'s reviewed bound.',
    'Relationship: keep "relationship":"<id>" separate from the related field; never concatenate them.',
    'Rows: {"plan":{"kind":"rows","resource":"<exact resource id>","select":["<field>"]}}. Omitted limit uses Runner\'s reviewed bound.',
    'Named controls use {"derived_measure":"<name>"} in measures or {"numeric_band":"<name>"} in dimensions; never send formulas or edges.',
    "Filter values must be concrete, not null. Use null_count, non_null_count, or completion_rate for reviewed missing-data analysis.",
    "No cross-boundary joins, SQL, model-selected tenant/principal, mutation, approval, or commit.",
  ].join(" ");
}

export function projectDescribeDataForModel(
  result: Record<string, unknown>,
  resourceDetail: boolean,
): Record<string, unknown> {
  if (result.ok === false || !Array.isArray(result.resources)) return structuredClone(result);
  const resources = result.resources
    .filter(modelRecord)
    .map((resource) => resourceDetail
      ? modelResourceDetail(resource)
      : modelResourceIndex(resource));
  return {
    ...structuredClone(result),
    resources,
    catalog_view: resourceDetail ? "resource_detail" : "resource_index",
    metadata_only: true,
    contains_source_values: false,
    next_action: resourceDetail
      ? "For application-data values, call app.explore_data with one smallest valid plan. Do not answer from this metadata."
      : "Choose an exact resource id. Call app.describe_data with that resource only when focused relationship or filter details are needed, then call app.explore_data for values. Do not answer from this metadata.",
  };
}

function modelResourceIndex(resource: Record<string, unknown>): Record<string, unknown> {
  const relationships = modelRecords(resource.relationships).map((relationship) => ({
    id: modelString(relationship.id),
    target_resource: modelString(relationship.target_resource),
    activation: modelString(relationship.activation),
    path_depth: modelNumber(relationship.path_depth),
  }));
  return withoutUndefined({
    id: modelString(resource.id),
    boundary_name: modelString(resource.boundary_name),
    selectable_fields: modelStrings(resource.selectable_fields),
    filter_operators: modelStringArrayRecord(resource.filter_operators),
    sortable_fields: modelStrings(resource.sortable_fields),
    groupable_fields: modelStrings(resource.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(resource.aggregate_measure_functions),
    presence_measure_fields: modelStrings(resource.presence_measure_fields),
    presence_measure_functions: modelStrings(resource.presence_measure_functions),
    derived_measures: modelRecords(resource.derived_measures),
    numeric_bands: modelRecords(resource.numeric_bands),
    count_distinct_fields: modelStrings(resource.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(resource.time_bucket_fields),
    time_coverage: modelRecordOrEmpty(resource.time_coverage),
    field_enums: modelRecordOrEmpty(resource.field_enums),
    relationships,
    minimum_cohort_size: modelNumber(resource.minimum_cohort_size),
    maximum_rows: modelNumber(resource.maximum_rows),
    maximum_groups: modelNumber(resource.maximum_groups),
    valid_plan_example: modelValidAggregatePlan(resource),
  });
}

function modelValidAggregatePlan(resource: Record<string, unknown>): Record<string, unknown> {
  const resourceId = modelString(resource.id) ?? "";
  const aggregateFunctions = modelStringArrayRecord(resource.aggregate_measure_functions);
  const measured = Object.entries(aggregateFunctions).find(([field, functions]) =>
    isUsefulExampleMeasure(field) && functions.some((name) => name === "sum" || name === "avg"));
  const measure = measured
    ? {
      function: measured[1].includes("sum") ? "sum" : "avg",
      field: measured[0],
    }
    : { function: "count" };
  const dimension = modelStrings(resource.groupable_fields)[0];
  return {
    kind: "aggregate",
    resource: resourceId,
    measures: [measure],
    ...(dimension ? { dimensions: [{ field: dimension }] } : {}),
  };
}

function isUsefulExampleMeasure(field: string): boolean {
  const normalized = field.toLowerCase();
  return normalized !== "id"
    && !normalized.endsWith("_id")
    && !/(?:^|_)(?:version|revision|sequence|seq|ordinal|position|rank)(?:$|_)/.test(normalized);
}

function modelResourceDetail(resource: Record<string, unknown>): Record<string, unknown> {
  const indexed = modelResourceIndex(resource);
  const relationships = modelRecords(resource.relationships).map((relationship) => withoutUndefined({
    id: modelString(relationship.id),
    activation: modelString(relationship.activation),
    operator_review_required: typeof relationship.operator_review_required === "boolean"
      ? relationship.operator_review_required
      : undefined,
    target_resource: modelString(relationship.target_resource),
    cardinality: modelString(relationship.cardinality),
    counted_entity: modelString(relationship.counted_entity),
    path_depth: modelNumber(relationship.path_depth),
    nullable: typeof relationship.nullable === "boolean" ? relationship.nullable : undefined,
    unmatched_rows: modelString(relationship.unmatched_rows),
    model_withheld_fields: withheldFieldNames(relationship.field_egress),
    filter_operators: modelStringArrayRecord(relationship.filter_operators),
    groupable_fields: modelStrings(relationship.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(relationship.aggregate_measure_functions),
    presence_measure_fields: modelStrings(relationship.presence_measure_fields),
    presence_measure_functions: modelStrings(relationship.presence_measure_functions),
    derived_measures: modelRecords(relationship.derived_measures),
    count_distinct_fields: modelStrings(relationship.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(relationship.time_bucket_fields),
  }));
  return withoutUndefined({
    ...indexed,
    primary_key: modelString(resource.primary_key),
    model_withheld_fields: withheldFieldNames(resource.field_egress),
    kept_out_field_count: modelNumber(resource.kept_out_field_count),
    relationships,
  });
}

function modelRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(modelRecord) : [];
}

function modelRecordOrEmpty(value: unknown): Record<string, unknown> {
  return modelRecord(value) ? structuredClone(value) : {};
}

function modelString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function modelNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modelStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function modelStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!modelRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, modelStrings(item)]));
}

function withheldFieldNames(value: unknown): string[] {
  if (!modelRecord(value)) return [];
  return Object.entries(value).flatMap(([field, egress]) =>
    modelRecord(egress) && egress.model_egress === "withheld" ? [field] : []);
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function omitUndefinedModelArguments<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefinedModelArguments(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefinedModelArguments(item)]),
  ) as T;
}

export async function serveScopedExploreStdio(options: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
}): Promise<void> {
  const runtime = await createScopedExploreBoundarySetRuntime({
    projectRoot: options.projectRoot,
    transport: "stdio",
    env: options.env,
  });
  const server = createScopedExploreMcpServer(runtime);
  const input = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(input, options.stdout ?? process.stdout);
  try {
    await server.connect(transport);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  process.stderr.write("Synapsor local authoring MCP ready. Scoped Explore is digest-bound, read-only, and unavailable over HTTP.\n");
  await new Promise<void>((resolve) => {
    const previousOnClose = transport.onclose;
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      input.off("end", close);
      input.off("close", close);
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      void Promise.allSettled([server.close(), runtime.close()]).finally(resolve);
    };
    transport.onclose = () => {
      previousOnClose?.();
      close();
    };
    input.once("end", close);
    input.once("close", close);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function isBoundarySetRuntime(
  runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
): runtime is ScopedExploreBoundarySetRuntime {
  return "active_boundary_set_digest" in runtime;
}

async function toolResult(
  action: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  projectForModel?: (
    result: Record<string, unknown>,
  ) => { value: Record<string, unknown>; withheld: boolean },
) {
  try {
    const result = await action();
    const projection = projectForModel?.(result);
    const modelResult = projection?.value ?? result;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelResult) }],
      structuredContent: modelResult,
      ...(projection?.withheld
        ? {
          _meta: {
            "synapsor.model_withheld_values": true,
            "synapsor.local_full_result": result,
          },
        }
        : {}),
    };
  } catch (error) {
    const payload = error instanceof ScopedExploreError
      ? {
        ok: false,
        outcome: {
          type: "refusal" as const,
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        error_code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        source_database_changed: false,
      }
      : {
        ok: false,
        outcome: {
          type: "refusal" as const,
          code: "EXPLORE_INTERNAL",
          message: "Scoped Explore refused the request.",
        },
        error_code: "EXPLORE_INTERNAL",
        message: "Scoped Explore refused the request.",
        source_database_changed: false,
      };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
