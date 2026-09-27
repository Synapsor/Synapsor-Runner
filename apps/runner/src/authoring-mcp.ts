import type { Readable, Writable } from "node:stream";
import { projectDescribeDataForModel } from "./read-catalog-presentation.js";
export { projectDescribeDataForModel } from "./read-catalog-presentation.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createInactiveSemanticActionRuntime,
  semanticActionInputSchema,
  semanticActionCatalogJsonSchema,
  publishToolInputContracts,
  portableDiscoveryInputJsonSchema,
  McpRuntimeError,
  type SemanticActionRuntime,
  projectAuthorityMetadataForModel,
  scopedExploreDescribeToolOutputSchema,
  scopedExploreQueryToolOutputSchema,
  type ModelAuthorityMetadataMode,
  type LocalToolPresentationSink,
  type SubjectReferenceService,
  CATALOG_LIMITS,
  catalogResponseBytes,
  catalogContractSizeError,
  withResultEvidence,
  withPolicyManagementInput,
  policyManagementToolInputSchema,
  type PolicyManagementTools,
} from "@synapsor-runner/mcp-server";
import type { ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { z } from "zod";
import { createScopedReadDiscovery } from "./scoped-read-discovery.js";
import { createActionSubjectNavigation } from "./action-subject-navigation.js";
import { RuntimeAdmissionError } from "./project-runtime-admission.js";
import { operationalLog, safeOperationalErrorCode } from "./cli-logging.js";
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
  schema.nullish().transform((value): z.infer<T> | undefined => value ?? undefined);
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
const contractSectionSelector = z.string().min(1).max(128).describe("Exact public section from the returned contract_navigation; no private or guessed paths.");
const contractRevisionSelector = optionalModelArgument(z.string().regex(/^rev_[A-Za-z0-9_-]{43}$/u).describe("Exact opaque public revision returned with the section navigation."));
const contractItemSelector = optionalModelArgument(z.string().min(1).max(256).describe("One exact public item key/field/input id in this section."));
// Detail/listing are existing operations, not arbitrary combinations of optional
// fields. Keep canonical branch meanings; publish a portable field projection.
// The host still refuses meaningful mixtures after neutral-value normalization.
const readCatalogInput = z.union([
  z.object({ boundary: optionalBoundarySelector, resource: z.string().min(1).max(256),
    query: z.null().optional(), cursor: z.union([z.literal(0), z.null()]).optional(),
    limit: z.union([z.literal(0), z.null()]).optional() }).strict(),
  z.object({ boundary: optionalBoundarySelector, resource: z.string().min(1).max(256), section: contractSectionSelector,
    item: contractItemSelector, contract_revision: contractRevisionSelector, query: z.null().optional(),
    cursor: optionalModelArgument(z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u)),
    limit: optionalModelArgument(z.number().int().min(1).max(20)) }).strict(),
  z.object({ boundary: optionalBoundarySelector, resource: z.union([z.literal(""), z.null()]).optional(),
    query: optionalModelArgument(z.string().max(256)),
    cursor: optionalModelArgument(z.union([z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u), z.literal(0)])),
    limit: optionalModelArgument(z.number().int().min(0).max(20)) }).strict(),
]).describe("Exact detail: resource with optional boundary; query absent/null, cursor and limit absent/null/0. Listing: optional boundary, query, limit and returned cursor; resource absent/null/empty. Never mix meaningful detail and listing arguments.");
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
  options: {
    mode?: "local_authoring" | "production_http";
    localPresentation?: LocalToolPresentationSink;
    semanticActions?: SemanticActionRuntime;
    policyManagement?: PolicyManagementTools;
  } = {},
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
    related: optionalModelArgument(modelArray(z.array(z.object({
      relationship: relationshipId,
      select: modelArray(z.array(fieldId).min(1).max(20)),
    }).strict()).min(1).max(3))),
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
  const reviewedDimensions = [
    z.object({ field: fieldId, relationship: optionalModelArgument(relationshipId) }).strict(),
    z.object({ numeric_band: numericBandId }).strict(),
  ] as const;
  const dimension = automaticBandsReviewed
    ? z.union([...reviewedDimensions, z.object({
      numeric_band: z.object({
        field: fieldId,
        buckets: modelInteger(z.number().int().min(2).max(16)),
        method: z.enum(["quantile", "equal_width"]),
      }).strict(),
    }).strict()])
    : z.union(reviewedDimensions);
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
    dimensions: optionalModelArgument(modelArray(z.array(dimension))),
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

  // Keep the dispatcher responsible for safe, actionable grammar diagnostics.
  // tools/list publishes exploreInput below; this envelope never authorizes a plan.
  const exploreDiscoveryInput = z.object({ boundary: optionalBoundarySelector,
    plan: z.object({ kind: z.string(), resource: resourceId }).passthrough(),
  }).strict();

  const server = new McpServer(
    { name: production ? "synapsor-runner-production-explore" : "synapsor-runner-authoring", version: runnerPackage.version },
    { capabilities: { tools: {} } },
  );
  const policyManagement = options.policyManagement;
  publishToolInputContracts(server, name => name === "app.describe_actions"
    ? semanticActionCatalogJsonSchema(policyManagement ? policyManagementToolInputSchema(name) : undefined)
    : name === SCOPED_EXPLORE_DESCRIBE_TOOL
      ? portableDiscoveryInputJsonSchema(policyManagement ? z.union([readCatalogInput, policyManagementToolInputSchema(name)]) : readCatalogInput)
    : name === SCOPED_EXPLORE_QUERY_TOOL
      ? portableDiscoveryInputJsonSchema(policyManagement ? z.union([exploreInput, policyManagementToolInputSchema(name)]) : exploreInput)
      : undefined);
  const settingsHint = policyManagement ? " For your own agent settings, use policy_view: agent_rules instead of source-data arguments; app.explore_data section summary provides its current typed control reference." : "";
  const describeSubjectNavigation = createActionSubjectNavigation(runtime);
  if (options.semanticActions || policyManagement) {
    const actions = options.semanticActions ?? createInactiveSemanticActionRuntime();
    for (const tool of actions.listTools()) {
      const sourceSchema = semanticActionInputSchema(tool.name);
      server.registerTool(tool.name, {
        title: tool.title, description: tool.description + settingsHint,
        inputSchema: policyManagement ? withPolicyManagementInput(sourceSchema, tool.name) : sourceSchema,
        annotations: { readOnlyHint: tool.name === "app.describe_actions", destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async (args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => toolResult(async () => {
        if (policyManagement?.handles(args)) return policyManagement.callTool(tool.name, args);
        const source = sourceSchema.safeParse(args);
        if (!source.success) throw new McpRuntimeError("ARGUMENT_INVALID", "Use one complete source Action contract, or the separately enabled agent-rules view; do not mix them.");
        if (isBoundarySetRuntime(runtime)) await runtime.requireTrustedScope?.();
        return tool.name === "app.describe_actions"
          ? actions.callTool(tool.name, source.data, { describeSubjectNavigation })
          : actions.callTool(tool.name, source.data);
      }, undefined, {
        toolName: tool.name,
        requestMeta: extra._meta, localPresentation: options.localPresentation,
        authorityMetadata: runtime.model_authority_metadata ?? "semantic",
        withOperation: runtime.withOperation,
      }));
    }
  }
  const discoverReads = createScopedReadDiscovery(runtime, (result, detail) =>
    projectDescribeDataForModel(result, detail, runtime.model_authority_metadata ?? "semantic"));
  const describeInput = z.object({
    boundary: optionalBoundarySelector,
    resource: optionalResourceSelector,
    section: optionalModelArgument(contractSectionSelector), contract_revision: contractRevisionSelector, item: contractItemSelector,
    query: optionalModelArgument(z.string().max(256)),
    cursor: optionalModelArgument(z.union([z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u), z.literal(0)]).transform((value) => value === 0 ? undefined : value)),
    limit: z.preprocess((value) => value === 0 ? undefined : value, optionalModelArgument(z.number().int().positive().max(20))),
  }).strict();
  server.registerTool(SCOPED_EXPLORE_DESCRIBE_TOOL, {
    title: "Describe reviewed data",
    description: 'Metadata only; no source rows. List {} or {"query":"text","limit":5}; exact detail {"resource":"<exact id>"}, optionally boundary. Oversized detail returns a partial contract_navigation: follow its exact section calls; section pages may include item, limit and returned section cursor. Missing sections are not permission. Never mix query with exact detail/sections. Follow discovery.next_steps and pagination.state; CATALOG_CURSOR_INVALID requires a fresh current lookup without the rejected cursor. Small detail permits null query and absent/null/0 limit/cursor; listing permits absent/null/empty resource. Copy exact permitted fields/operators into app.explore_data; reuse still-current detail. Search ranks exact/full matches before labelled partial matches, not row eligibility. Catalog totals count authorized metadata only; section totals count that exact section/selection. Keep the same query/section/item/limit/boundary/context on continuation. Explore returns bounded live results without a source continuation cursor or complete source total.' + settingsHint,
    inputSchema: policyManagement ? withPolicyManagementInput(describeInput, SCOPED_EXPLORE_DESCRIBE_TOOL) : describeInput,
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
  }, async (input: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => toolResult(
    async () => {
      if (policyManagement?.handles(input)) return policyManagement.callTool(SCOPED_EXPLORE_DESCRIBE_TOOL, input);
      const parsed = describeInput.safeParse(input);
      if (!parsed.success) throw new McpRuntimeError("ARGUMENT_INVALID", "Use source discovery arguments or the agent-rules view, not a mixture.");
      const source = parsed.data;
      return discoverReads({
        ...(source.boundary ? { boundary: source.boundary } : {}),
        ...(source.resource ? { resource: source.resource } : {}),
        ...(source.section === undefined ? {} : { section: source.section }),
        ...(source.contract_revision === undefined ? {} : { contract_revision: source.contract_revision }), ...(source.item === undefined ? {} : { item: source.item }),
        ...(source.query === undefined ? {} : { query: source.query }),
        ...(source.cursor === undefined ? {} : { cursor: source.cursor }),
        ...(source.limit === undefined ? {} : { limit: source.limit }),
      });
    },
    (result) => {
      if (policyManagement?.handles(input)) return { value: result, withheld: false };
      const authorityMetadata = runtime.model_authority_metadata ?? "semantic";
      const authority = projectAuthorityMetadataForModel(result, authorityMetadata);
      const value = projectDescribeDataForModel(
          result,
          Boolean(input.resource),
          authorityMetadata,
        );
      if (catalogResponseBytes(value, "compact") > CATALOG_LIMITS.responseBytes) {
        throw catalogContractSizeError("response", catalogResponseBytes(value, "compact"), CATALOG_LIMITS.responseBytes);
      }
      return {
        value,
        withheld: false,
        ...(authority.withheld ? { operator_metadata_withheld: true } : {}),
      };
    },
    {
      toolName: SCOPED_EXPLORE_DESCRIBE_TOOL,
      requestMeta: extra._meta,
      localPresentation: options.localPresentation,
      authorityMetadata: runtime.model_authority_metadata ?? "semantic",
      withOperation: runtime.withOperation,
    },
  ));
  server.registerTool(SCOPED_EXPLORE_QUERY_TOOL, {
    title: "Explore reviewed data",
    description: exploreToolDescription(production, automaticBandsReviewed) + settingsHint,
    inputSchema: policyManagement ? withPolicyManagementInput(exploreDiscoveryInput, SCOPED_EXPLORE_QUERY_TOOL) : exploreDiscoveryInput,
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
  }, async (discoveryInput: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => {
    if (policyManagement?.handles(discoveryInput)) return toolResult(
      () => policyManagement.callTool(SCOPED_EXPLORE_QUERY_TOOL, discoveryInput), undefined,
      { toolName: SCOPED_EXPLORE_QUERY_TOOL, requestMeta: extra._meta, localPresentation: options.localPresentation,
        authorityMetadata: runtime.model_authority_metadata ?? "semantic", withOperation: runtime.withOperation },
    );
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
          authorityMetadata: runtime.model_authority_metadata ?? "semantic",
        }),
      {
        toolName: SCOPED_EXPLORE_QUERY_TOOL,
        requestMeta: extra._meta,
        localPresentation: options.localPresentation,
        authorityMetadata: runtime.model_authority_metadata ?? "semantic",
        withOperation: runtime.withOperation,
      },
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
    'Related row details use "related":[{"relationship":"<exact reviewed relationship id>","select":["<exact target field>"]}]. At most three paths and twenty total fields; each path preserves the reviewed customer scope. Returned keys are <relationship>.<field>.',
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
  store?: ProposalRuntimeStore;
  semanticActions?: SemanticActionRuntime;
  policyManagement?: PolicyManagementTools;
  subjectReferences?: {
    service: SubjectReferenceService;
    workflow_session_id: string;
  };
  stdin?: Readable;
  stdout?: Writable;
  modelAuthorityMetadata?: ModelAuthorityMetadataMode;
}): Promise<void> {
  let runtime: ScopedExploreBoundarySetRuntime | undefined;
  try {
    runtime = await createScopedExploreBoundarySetRuntime({
    projectRoot: options.projectRoot,
    transport: "stdio",
    env: options.env,
    ...(options.store ? { store: options.store } : {}),
    ...(options.subjectReferences ? { subjectReferences: options.subjectReferences } : {}),
    modelAuthorityMetadata: options.modelAuthorityMetadata ?? "semantic",
    deferTrustedScope: true,
    });
  } catch (error) {
    if (!options.policyManagement || !(error instanceof ScopedExploreError) || error.code !== "EXPLORE_DISABLED") throw error;
  }
  const server = runtime ? createScopedExploreMcpServer(runtime, {
    semanticActions: options.semanticActions ?? createInactiveSemanticActionRuntime(),
    policyManagement: options.policyManagement,
  }) : createOwnerSettingsMcpServer(options.policyManagement!);
  const input = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(input, options.stdout ?? process.stdout);
  try {
    await server.connect(transport);
  } catch (error) {
    await runtime?.close();
    throw error;
  }
  process.stderr.write(runtime ? "Synapsor local authoring MCP ready. Scoped Explore is digest-bound, read-only, and unavailable over HTTP.\n"
    : "Synapsor agent settings MCP ready. Source Read authority remains disabled.\n");
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
      void Promise.allSettled([server.close(), runtime?.close()]).finally(resolve);
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

/** Owner settings remain reviewable without granting source Read authority. */
export function createOwnerSettingsMcpServer(provider: PolicyManagementTools): McpServer {
  const server = new McpServer({ name: "synapsor-owner-settings", version: runnerPackage.version });
  for (const name of ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]) {
    server.registerTool(name, {
      description: "Authenticated agent-rule settings only. Use policy_view: agent_rules. Discover current rules and delegable vocabulary before proposing a disabled revision. Source-data access is unavailable; a separate human review activates settings.",
      inputSchema: policyManagementToolInputSchema(name),
      annotations: { readOnlyHint: name !== "app.request_change", destructiveHint: false },
      _meta: { "synapsor/owner-settings-only": true },
    }, (args) => toolResult(() => provider.callTool(name, args), undefined, { toolName: name }));
  }
  return server;
}

function isBoundarySetRuntime(
  runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
): runtime is ScopedExploreBoundarySetRuntime {
  return "active_boundary_set_digest" in runtime;
}

async function toolResult(
  action: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  projectForModel: ((
    result: Record<string, unknown>,
  ) => {
    value: Record<string, unknown>;
    withheld: boolean;
    operator_metadata_withheld?: boolean;
  }) | undefined,
  options: {
    toolName: string;
    requestMeta?: Record<string, unknown>;
    localPresentation?: LocalToolPresentationSink;
    authorityMetadata?: ModelAuthorityMetadataMode;
    withOperation?: ScopedExploreRuntime["withOperation"];
  },
) {
  try {
    const prepare = async () => {
      const result = await action();
      const projection = projectForModel?.(result);
      const authority = projectAuthorityMetadataForModel(
        projection?.value ?? result,
        options.authorityMetadata ?? "semantic",
      );
      const modelResult = withResultEvidence(options.toolName, authority.value);
      const operatorMetadataWithheld = projection?.operator_metadata_withheld === true
        || authority.withheld;
      if (projection?.withheld || operatorMetadataWithheld) {
        options.localPresentation?.capture(options.requestMeta, {
          value: result,
          provider_value: modelResult,
          model_withheld_values: projection?.withheld === true,
          operator_metadata_withheld: operatorMetadataWithheld,
        });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(modelResult) }],
        structuredContent: modelResult,
        ...(projection?.withheld || operatorMetadataWithheld
          ? {
            _meta: {
              ...(projection?.withheld ? { "synapsor.model_withheld_values": true } : {}),
              ...(operatorMetadataWithheld
                ? { "synapsor.operator_metadata_withheld": true }
                : {}),
            },
          }
          : {}),
      };
    };
    return options.withOperation ? await options.withOperation(prepare) : await prepare();
  } catch (error) {
    // Connection diagnostics can contain credentials, hosts and role names.
    // Classify only known driver codes; never forward their raw message.
    const sourceCode = error instanceof Error && "code" in error ? error.code : undefined;
    if (["28P01", "28000", "ER_ACCESS_DENIED_ERROR"].includes(String(sourceCode))) {
      error = new ScopedExploreError("EXPLORE_SOURCE_UNAVAILABLE",
        "The database connection could not authenticate. Ask the operator to recheck the connection and restart this client after updating its credentials.",
        { category: "connection_authentication", recovery: "operator_connection_review", retryable: false });
    } else if (["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "08006", "08001", "57P01", "53300", "PROTOCOL_CONNECTION_LOST"].includes(String(sourceCode))) {
      error = new ScopedExploreError("EXPLORE_SOURCE_UNAVAILABLE",
        "The database connection is unavailable. Ask the operator to check database availability before retrying; permissions have not changed.",
        { category: "connection_unavailable", recovery: "operator_connection_review", retryable: true });
    }
    const catalogDetails = error instanceof McpRuntimeError && error.code === "CATALOG_CONTRACT_TOO_LARGE"
      && error.details && Number.isSafeInteger(error.details.measured_bytes) && Number.isSafeInteger(error.details.limit_bytes)
      ? { kind: error.details.kind, measured_bytes: error.details.measured_bytes, limit_bytes: error.details.limit_bytes,
          retryable: false, recovery: "operator_boundary_review" } : undefined;
    if (!(error instanceof ScopedExploreError || error instanceof McpRuntimeError || error instanceof RuntimeAdmissionError)) {
      operationalLog("warn", "mcp_operation_failed", { code: safeOperationalErrorCode(error), result_code: "EXPLORE_INTERNAL" });
    }
    const payload = error instanceof ScopedExploreError || error instanceof McpRuntimeError || error instanceof RuntimeAdmissionError
      ? {
        ok: false,
        outcome: {
          type: "refusal" as const,
          code: error.code,
          message: error.message,
          ...(error instanceof ScopedExploreError && error.details ? { details: error.details } : {}),
        },
        error_code: error.code,
        message: error.message,
        ...(catalogDetails ? { details: catalogDetails } : {}),
        ...(error instanceof ScopedExploreError && error.details ? { details: error.details } : {}),
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
    const authority = projectAuthorityMetadataForModel(
      payload,
      options.authorityMetadata ?? "semantic",
    );
    if (authority.withheld) {
      options.localPresentation?.capture(options.requestMeta, {
        value: payload,
        provider_value: authority.value,
        model_withheld_values: false,
        operator_metadata_withheld: true,
      });
    }
    const modelResult = withResultEvidence(options.toolName, authority.value);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(modelResult) }],
      structuredContent: modelResult,
      isError: true,
      ...(authority.withheld
        ? { _meta: { "synapsor.operator_metadata_withheld": true } }
        : {}),
    };
  }
}
