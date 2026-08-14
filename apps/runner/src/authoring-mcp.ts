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
import {
  RELATIVE_TIME_COMPARISONS,
  RELATIVE_TIME_WINDOWS,
} from "./relative-time-window.js";

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
  const automaticBandsReviewed = (isBoundarySetRuntime(runtime)
    ? runtime.boundaries
    : [runtime.boundary]).some((boundary) => boundary.pack.resources.some(
      (resource) => Boolean(resource.auto_bands?.length),
    ));
  const absoluteRowTimeWindow = z.object({
    field: fieldId,
    start: z.string().datetime(),
    end: z.string().datetime(),
  }).strict();
  const relativeRowTimeWindow = z.object({
    field: fieldId,
    window: z.enum(RELATIVE_TIME_WINDOWS),
  }).strict();
  const absoluteAggregateTimeWindow = z.object({
    field: fieldId,
    relationship: optionalModelArgument(relationshipId),
    start: z.string().datetime(),
    end: z.string().datetime(),
  }).strict();
  const relativeAggregateTimeWindow = z.object({
    field: fieldId,
    relationship: optionalModelArgument(relationshipId),
    window: z.enum(RELATIVE_TIME_WINDOWS),
  }).strict();
  const rowPlan = z.object({
    kind: z.literal("rows"),
    resource: resourceId,
    select: modelArray(z.array(fieldId).min(1).max(20)),
    time_window: optionalModelArgument(modelObject(z.union([
      absoluteRowTimeWindow,
      relativeRowTimeWindow,
    ]))),
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
      z.object({
        numeric_band: z.object({
          field: fieldId,
          buckets: modelInteger(z.number().int().min(2).max(16)),
          method: z.enum(["quantile", "equal_width"]),
        }).strict(),
      }).strict(),
    ])))),
    time_bucket: optionalModelArgument(modelObject(z.object({
      field: fieldId,
      bucket: z.enum(EXPLORATION_TIME_BUCKETS),
      relationship: optionalModelArgument(relationshipId),
    }).strict())),
    time_window: optionalModelArgument(modelObject(z.union([
      absoluteAggregateTimeWindow,
      relativeAggregateTimeWindow,
    ]))),
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
    comparison: optionalModelArgument(modelObject(z.union([
      z.object({
        field: fieldId,
        relationship: optionalModelArgument(relationshipId),
        ranges: modelArray(z.array(z.object({
          start: z.string().datetime(),
          end: z.string().datetime(),
        }).strict()).length(2).describe("Two non-overlapping ranges, earlier then later.")),
      }).strict(),
      z.object({
        field: fieldId,
        relationship: optionalModelArgument(relationshipId),
        window: z.enum(RELATIVE_TIME_WINDOWS),
        compare_to: z.enum(RELATIVE_TIME_COMPARISONS),
      }).strict(),
    ]))),
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
  const reviewedOptionalControls = [
    "time_window",
    'order_by kind "comparison_change"',
    ...(automaticBandsReviewed ? ['auto-band methods "quantile" or "equal_width"'] : []),
  ].join(", ");
  const exploreDiscoveryInput = z.object({
    boundary: optionalBoundarySelector,
    plan: z.object({
      kind: z.string().describe('Exactly "rows" or "aggregate".'),
      resource: resourceId,
    }).passthrough().describe(
      `Copy one complete plan from app.describe_data or this tool description. Optional reviewed controls include ${reviewedOptionalControls}. Dimension-by-time returns one row per dimension/time combination. Runner strictly validates every nested key before execution.`,
    ),
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
    description: exploreToolDescription(production, automaticBandsReviewed),
    inputSchema: exploreDiscoveryInput,
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
  }, async (discoveryInput) => {
    let boundary: string | undefined;
    let parsedPlan: z.infer<typeof plan> | undefined;
    return toolResult(
      () => {
        const validated = exploreInput.safeParse(discoveryInput);
        if (!validated.success) {
          const issue = validated.error.issues[0];
          const path = issue?.path.length ? issue.path.join(".") : "plan";
          throw new ScopedExploreError(
            "EXPLORE_PLAN_INVALID",
            `Invalid Explore plan at ${path}: ${explorePlanValidationMessage(issue)}`,
            { issues: validated.error.issues.map((item) => ({ path: item.path, message: item.message })) },
          );
        }
        boundary = validated.data.boundary || undefined;
        parsedPlan = validated.data.plan;
        const normalizedPlan = omitUndefinedModelArguments(parsedPlan);
        return isBoundarySetRuntime(runtime)
          ? runtime.explore(normalizedPlan, boundary)
          : runtime.explore(normalizedPlan);
      },
      (result) => isBoundarySetRuntime(runtime)
        ? runtime.projectResultForModel({
          tool: SCOPED_EXPLORE_QUERY_TOOL,
          arguments: {
            ...(boundary ? { boundary } : {}),
            plan: omitUndefinedModelArguments(parsedPlan ?? {}),
          },
          result,
        })
        : projectScopedExploreResultForModel({
          tool: SCOPED_EXPLORE_QUERY_TOOL,
          arguments: { plan: omitUndefinedModelArguments(parsedPlan ?? {}) },
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

function comparisonPlanRecoveryMessage(): string {
  return 'use plan.comparison and plan.time_bucket in this complete shape: {"plan":{"kind":"aggregate","resource":"<exact resource id>","measures":[{"function":"count"}],"dimensions":[{"field":"<group field>"}],"time_bucket":{"field":"<reviewed time field>","bucket":"month"},"comparison":{"field":"<same time field>","window":"this_month","compare_to":"preceding_period"}}}; time_bucket and comparison are sibling plan keys';
}

function explorePlanValidationMessage(issue: z.ZodIssue | undefined): string {
  if (!issue) return "the plan did not match the reviewed grammar";
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const keys = new Set(issue.keys);
    if (keys.has("filter") || keys.has("filters")) {
      return 'use plan.where:[{"field":"<exact field>","op":"eq","value":"<reviewed value>"}]; filter and filters are not grammar keys';
    }
    if (keys.has("comparison_partner") || keys.has("comparison_to") || keys.has("compare_to")) {
      return comparisonPlanRecoveryMessage();
    }
    if (keys.has("time_bucket") && issue.path.includes("dimensions")) {
      return comparisonPlanRecoveryMessage();
    }
    if (keys.has("limit") && issue.path.includes("plan")) {
      return 'aggregate plans use top_n, not limit; rows plans use limit';
    }
  }
  if (issue.path.includes("comparison")) {
    return comparisonPlanRecoveryMessage();
  }
  if (issue.path.includes("time_window")) {
    return 'time_window accepts only field plus one reviewed window name (or absolute start/end); use plan.comparison for two periods';
  }
  if (issue.path.includes("where")) {
    return 'where must be an array of {"field":"<exact field>","op":"eq|neq|lt|lte|gt|gte|in","value":<concrete value>}';
  }
  if (issue.path.includes("order_by")) {
    return 'aggregate order_by is one object; use "order_by":{"kind":"measure","index":0,"direction":"desc"},"top_n":25';
  }
  return issue.message;
}

function exploreToolDescription(production: boolean, automaticBandsReviewed: boolean): string {
  return [
    `Runs one reviewed read-only ${production ? "production" : "local"} plan.`,
    "Call app.describe_data first and copy exact ids. Send {boundary?,plan:{...}}; plan.kind is exactly rows or aggregate.",
    'Aggregate: {"plan":{"kind":"aggregate","resource":"<exact resource id>","measures":[{"function":"count"}],"dimensions":[{"field":"<field>"}]}}. For totals or averages, use sum or avg with one exact reviewed measure field. Omitted top_n uses Runner\'s reviewed bound.',
    'Related grouping: {"dimensions":[{"field":"<exact target field>","relationship":"<exact reviewed relationship id>"}]}. When the question asks base records by a related field, use that pair instead of a similar local field; never concatenate the ids.',
    'Rows: {"plan":{"kind":"rows","resource":"<exact resource id>","select":["<field>"]}}. Omitted limit uses Runner\'s reviewed bound.',
    'Named controls use {"derived_measure":"<name>"} in measures or {"numeric_band":"<name>"} in dimensions.',
    ...(automaticBandsReviewed
      ? ['Reviewed auto-band example: {"numeric_band":{"field":"amount_cents","method":"quantile","buckets":5}}. Copy the field, method, and bucket range from app.describe_data; never send edges, widths, offsets, formulas, or labels.']
      : []),
    'Filter example: "where":[{"field":"status","op":"eq","value":"completed"}]. Use exactly where + op, never filter(s) + operator. Values must be concrete, not null; use null_count, non_null_count, or completion_rate for missing-data analysis.',
    'Ranked aggregate example: "order_by":{"kind":"measure","index":0,"direction":"desc"},"top_n":25. Aggregate order_by is one object and uses top_n, never limit.',
    'One reviewed relative window uses {"time_window":{"field":"<reviewed time field>","window":"previous_month"}}. Complete two-period plan: {"plan":{"kind":"aggregate","resource":"<exact resource id>","measures":[{"function":"count"}],"dimensions":[{"field":"<group field>"}],"time_bucket":{"field":"<time field>","bucket":"month"},"comparison":{"field":"<time field>","window":"this_month","compare_to":"preceding_period"}}}. time_bucket and comparison are sibling plan keys, never nested. Runner resolves names once in authority-bound UTC. Never calculate dates or invent offsets.',
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
  const projected: Record<string, unknown> = {
    ...structuredClone(result),
    resources,
    catalog_view: resourceDetail ? "resource_detail" : "resource_index",
    metadata_only: true,
    contains_source_values: false,
    next_action: resourceDetail
      ? "For application-data values, call app.explore_data with one smallest valid plan. Do not answer from this metadata."
      : "Choose an exact resource id. Call app.describe_data with that resource only when focused relationship or filter details are needed, then call app.explore_data for values. Do not answer from this metadata.",
  };
  // Keep the compact index small for weaker models. The fixed vocabulary is
  // useful only after one resource and its reviewed time fields are selected.
  if (!resourceDetail) delete projected.relative_time_windows;
  return projected;
}

function modelResourceIndex(resource: Record<string, unknown>): Record<string, unknown> {
  const relationships = modelRecords(resource.relationships).map((relationship) => ({
    id: modelString(relationship.id),
    target_resource: modelString(relationship.target_resource),
    target_label: modelString(relationship.target_label),
    target_description: modelString(relationship.target_description),
    activation: modelString(relationship.activation),
    path_depth: modelNumber(relationship.path_depth),
  }));
  return withoutUndefined({
    id: modelString(resource.id),
    label: modelString(resource.label),
    description: modelString(resource.description),
    boundary_name: modelString(resource.boundary_name),
    fields: modelReviewedFields(resource.fields),
    selectable_fields: modelStrings(resource.selectable_fields),
    filter_operators: modelStringArrayRecord(resource.filter_operators),
    sortable_fields: modelStrings(resource.sortable_fields),
    groupable_fields: modelStrings(resource.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(resource.aggregate_measure_functions),
    presence_measure_fields: modelStrings(resource.presence_measure_fields),
    presence_measure_functions: modelStrings(resource.presence_measure_functions),
    derived_measures: modelRecords(resource.derived_measures),
    numeric_bands: modelRecords(resource.numeric_bands),
    auto_bands: modelRecords(resource.auto_bands).map((policy) => withoutUndefined({
      field: modelString(policy.field),
      methods: modelStrings(policy.methods),
      min_buckets: modelNumber(policy.min_buckets),
      max_buckets: modelNumber(policy.max_buckets),
      label_style: modelString(policy.label_style),
      raw_edges_returned: false,
    })),
    count_distinct_fields: modelStrings(resource.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(resource.time_bucket_fields),
    relative_time_window_fields: modelStrings(resource.relative_time_window_fields),
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
  const dimension = modelStrings(resource.groupable_fields)[0];
  return {
    kind: "aggregate",
    resource: resourceId,
    measures: [{ function: "count" }],
    ...(dimension ? { dimensions: [{ field: dimension }] } : {}),
  };
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
    target_label: modelString(relationship.target_label),
    target_description: modelString(relationship.target_description),
    cardinality: modelString(relationship.cardinality),
    counted_entity: modelString(relationship.counted_entity),
    path_depth: modelNumber(relationship.path_depth),
    nullable: typeof relationship.nullable === "boolean" ? relationship.nullable : undefined,
    unmatched_rows: modelString(relationship.unmatched_rows),
    model_withheld_fields: withheldFieldNames(relationship.field_egress),
    fields: modelReviewedFields(relationship.fields),
    filter_operators: modelStringArrayRecord(relationship.filter_operators),
    groupable_fields: modelStrings(relationship.groupable_fields),
    aggregate_measure_functions: modelStringArrayRecord(relationship.aggregate_measure_functions),
    presence_measure_fields: modelStrings(relationship.presence_measure_fields),
    presence_measure_functions: modelStrings(relationship.presence_measure_functions),
    derived_measures: modelRecords(relationship.derived_measures),
    count_distinct_fields: modelStrings(relationship.count_distinct_fields),
    time_bucket_fields: modelStringArrayRecord(relationship.time_bucket_fields),
    relative_time_window_fields: modelStrings(relationship.relative_time_window_fields),
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

function modelReviewedFields(value: unknown): Array<Record<string, unknown>> {
  return modelRecords(value).flatMap((field) => {
    const id = modelString(field.id);
    if (!id) return [];
    return [withoutUndefined({
      id,
      label: modelString(field.label),
      description: modelString(field.description),
    })];
  });
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
  ) => {
    value: Record<string, unknown>;
    withheld: boolean;
    operator_metadata_withheld?: boolean;
  },
) {
  try {
    const result = await action();
    const projection = projectForModel?.(result);
    const modelResult = projection?.value ?? result;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelResult) }],
      structuredContent: modelResult,
      ...(projection?.withheld || projection?.operator_metadata_withheld
        ? {
          _meta: {
            ...(projection.withheld ? { "synapsor.model_withheld_values": true } : {}),
            ...(projection.operator_metadata_withheld
              ? { "synapsor.operator_metadata_withheld": true }
              : {}),
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
