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
const fieldId = z.string().min(1).max(256).describe("Exact field alias from app.describe_data. Do not prefix it; put any related-table path in relationship.");
const resourceId = z.string().min(1).max(256)
  .describe("Root resource alias from app.describe_data that owns the counted entity or measure.");
const optionalBoundarySelector = z.string()
  .regex(/^(?:[a-z][a-z0-9_.-]{0,63})?$/)
  .describe("An active reviewed boundary name; empty means omitted.")
  .optional();
const optionalResourceSelector = z.string().max(256)
  .describe("A reviewed resource alias; empty means omitted.")
  .optional();
const relationshipId = z.string().min(1).max(256).describe("Exact active relationship alias from app.describe_data; keep it separate from field.");
const filter = z.object({
  field: fieldId,
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([scalar, z.array(scalar).min(1).max(20)]),
  relationship: relationshipId.optional(),
}).strict();

export function createScopedExploreMcpServer(
  runtime: ScopedExploreRuntime | ScopedExploreBoundarySetRuntime,
): McpServer {
  const rowPlan = z.object({
    kind: z.literal("rows"),
    resource: resourceId,
    select: z.array(fieldId).min(1).max(20),
    where: z.array(filter).max(8).optional(),
    order_by: z.array(z.object({
      field: fieldId,
      direction: z.enum(["asc", "desc"]),
    }).strict()).max(3).optional(),
    limit: z.number().int().positive(),
  }).strict();
  const aggregatePlan = z.object({
    kind: z.literal("aggregate"),
    resource: resourceId,
    relationship: relationshipId.optional(),
    measures: z.array(z.object({
      function: z.enum(["count", "count_distinct", "sum", "avg"]),
      field: fieldId.optional(),
      relationship: relationshipId.optional(),
    }).strict()).min(1),
    dimensions: z.array(z.object({
      field: fieldId,
      relationship: relationshipId.optional(),
    }).strict()).optional(),
    time_bucket: z.object({
      field: fieldId,
      bucket: z.enum(["day", "week", "month"]),
      relationship: relationshipId.optional(),
    }).strict().optional(),
    where: z.array(filter).max(8).optional(),
    order_by: z.union([
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
    ]).optional(),
    top_n: z.number().int().positive().describe("Maximum aggregate rows; dimension-by-time uses one row per dimension/time combination; comparisons need both periods."),
    comparison: z.object({
      field: fieldId,
      relationship: relationshipId.optional(),
      ranges: z.array(z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
      }).strict()).length(2).describe("Two non-overlapping half-open ranges, earlier then later; change is period_2 minus period_1."),
    }).strict().optional(),
  }).strict();

  const server = new McpServer(
    { name: "synapsor-runner-authoring", version: runnerPackage.version },
    { capabilities: { tools: {} } },
  );
  server.registerTool(SCOPED_EXPLORE_DESCRIBE_TOOL, {
    title: "Describe reviewed data",
    description: "Lists the active reviewed boundaries and a bounded page of their exact resources, fields, aggregate dimensions, measures, time buckets, relationships, and privacy limits. Use boundary when the same resource appears in more than one boundary. It returns metadata only, never source rows.",
    inputSchema: z.object({
      boundary: optionalBoundarySelector,
      resource: optionalResourceSelector,
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(10).optional(),
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
      "synapsor.authoring_only": true,
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
    description: "Runs one bounded row or descriptive aggregate plan against exactly one active reviewed local boundary. Choose the root resource that owns the counted entity or measure. For a related dimension, measure, filter, or time field, pass the target field alias in field and its exact active path alias separately in relationship; never concatenate them. Choose boundary from app.describe_data when required. Plans cannot join or combine separate boundaries. Raw SQL, arbitrary identifiers, model-selected tenant/principal, mutation, approval, and commit are unavailable.",
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
      "synapsor.authoring_only": true,
      "synapsor.untrusted_output": true,
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  }, async ({ boundary: selectedBoundary, plan }) => {
    const boundary = selectedBoundary || undefined;
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
