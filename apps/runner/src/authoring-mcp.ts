import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  scopedExploreDescribeOutputSchema,
  scopedExploreQueryToolOutputSchema,
} from "@synapsor-runner/mcp-server";
import { z } from "zod";
import runnerPackage from "../package.json" with { type: "json" };
import {
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

const scalar = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const fieldId = z.string().min(1).max(256).describe("Copy the exact field id from app.describe_data. Do not prefix it; put any related-table path in relationship.");
const resourceId = z.string().min(1).max(256)
  .describe("Copy the exact resource id from app.describe_data for the root table that owns the counted entity or measure.");
// Smaller models often serialize an omitted optional JSON field as null.
const optionalModelArgument = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value === null ? undefined : value, schema.optional());
const optionalBoundarySelector = optionalModelArgument(z.string()
  .regex(/^(?:[a-z][a-z0-9_.-]{0,63})?$/)
  .describe("An active reviewed boundary name; empty means omitted."));
const optionalResourceSelector = optionalModelArgument(z.string().max(256)
  .describe("Copy the exact resource id from app.describe_data. Empty means omitted."));
const relationshipId = z.string().min(1).max(256).describe("Copy the exact active relationship id from app.describe_data; keep it separate from field.");
const filter = z.object({
  field: fieldId,
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([scalar, z.array(scalar).min(1).max(20)]),
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
    select: z.array(fieldId).min(1).max(20),
    where: optionalModelArgument(z.array(filter).max(8)),
    order_by: optionalModelArgument(z.array(z.object({
      field: fieldId,
      direction: z.enum(["asc", "desc"]),
    }).strict()).max(3)),
    limit: z.number().int().positive(),
  }).strict();
  const aggregatePlan = z.object({
    kind: z.literal("aggregate"),
    resource: resourceId,
    relationship: optionalModelArgument(relationshipId),
    measures: z.array(z.object({
      function: z.enum(["count", "count_distinct", "sum", "avg"]),
      field: optionalModelArgument(fieldId),
      relationship: optionalModelArgument(relationshipId),
    }).strict()).min(1),
    dimensions: optionalModelArgument(z.array(z.object({
      field: fieldId,
      relationship: optionalModelArgument(relationshipId),
    }).strict())),
    time_bucket: optionalModelArgument(z.object({
      field: fieldId,
      bucket: z.enum(["day", "week", "month"]),
      relationship: optionalModelArgument(relationshipId),
    }).strict()),
    where: optionalModelArgument(z.array(filter).max(8)),
    order_by: optionalModelArgument(z.union([
      z.object({
        kind: z.literal("measure"),
        index: z.number().int().nonnegative(),
        direction: z.enum(["asc", "desc"]),
      }).strict(),
      z.object({
        kind: z.literal("comparison_change"),
        index: z.number().int().nonnegative(),
        change: z.enum(["absolute", "percentage"]),
        direction: z.enum(["asc", "desc"]),
      }).strict().describe("Rank a reviewed two-period comparison by its signed absolute or percentage change; desc finds growth and asc finds decline."),
      z.object({
        kind: z.literal("time_bucket"),
        direction: z.enum(["asc", "desc"]),
      }).strict(),
    ])),
    top_n: z.number().int().positive().describe("Maximum aggregate rows; dimension-by-time uses one row per dimension/time combination; comparisons need both periods."),
    comparison: optionalModelArgument(z.object({
      field: fieldId,
      relationship: optionalModelArgument(relationshipId),
      ranges: z.array(z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
      }).strict()).length(2).describe("Two non-overlapping half-open ranges, earlier then later; change is period_2 minus period_1."),
    }).strict()),
  }).strict();

  const server = new McpServer(
    { name: production ? "synapsor-runner-production-explore" : "synapsor-runner-authoring", version: runnerPackage.version },
    { capabilities: { tools: {} } },
  );
  server.registerTool(SCOPED_EXPLORE_DESCRIBE_TOOL, {
    title: "Describe reviewed data",
    description: "Lists the active reviewed boundaries and a bounded page of their exact resource ids, field ids, aggregate dimensions, measures, time buckets, relationship ids, and privacy limits. Copy the exact ids into app.explore_data. Use boundary when the same resource appears in more than one boundary. It returns metadata only, never source rows.",
    inputSchema: z.object({
      boundary: optionalBoundarySelector,
      resource: optionalResourceSelector,
      cursor: optionalModelArgument(z.number().int().nonnegative()),
      limit: optionalModelArgument(z.number().int().positive().max(10)),
    }).strict(),
    outputSchema: scopedExploreDescribeOutputSchema,
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
  }, async (input) => toolResult(() => runtime.describe({
    ...(input.boundary ? { boundary: input.boundary } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })));
  server.registerTool(SCOPED_EXPLORE_QUERY_TOOL, {
    title: "Explore reviewed data",
    description: `Runs one bounded row or descriptive aggregate plan against exactly one active reviewed ${production ? "production" : "local"} boundary. Copy the exact resource id from app.describe_data into plan.resource. Choose the root resource that owns the counted entity or measure. For a related dimension, measure, filter, or time field, pass the exact target field id in field and its exact active relationship id separately in relationship; never concatenate them. Choose boundary from app.describe_data when required. Plans cannot join or combine separate boundaries. Raw SQL, arbitrary identifiers, model-selected tenant/principal, mutation, approval, and commit are unavailable.`,
    inputSchema: z.object({
      boundary: optionalBoundarySelector,
      plan: z.discriminatedUnion("kind", [rowPlan, aggregatePlan]),
    }).strict(),
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
