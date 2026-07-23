import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createScopedExploreRuntime,
  SCOPED_EXPLORE_DESCRIBE_TOOL,
  SCOPED_EXPLORE_QUERY_TOOL,
  ScopedExploreError,
  type ScopedExploreRuntime,
} from "./scoped-explore.js";

const scalar = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const fieldId = z.string().min(1).max(256).describe("A reviewed field alias returned by app.describe_data.");
const relationshipId = z.string().min(1).max(256).describe("An activated one-hop relationship alias returned by app.describe_data.");
const filter = z.object({
  field: fieldId,
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([scalar, z.array(scalar).min(1).max(20)]),
  relationship: relationshipId.optional(),
}).strict();

export function createScopedExploreMcpServer(runtime: ScopedExploreRuntime): McpServer {
  const resources = runtime.boundary.pack.resources.map((resource) => resource.id);
  if (resources.length === 0) throw new ScopedExploreError("EXPLORE_DISABLED", "The activated authoring pack contains no reviewed resources.");
  const resource = z.enum(resources as [string, ...string[]]);
  const rowPlan = z.object({
    kind: z.literal("rows"),
    resource,
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
    resource,
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
        kind: z.literal("time_bucket"),
        direction: z.enum(["asc", "desc"]),
      }).strict(),
    ]).optional(),
    top_n: z.number().int().positive(),
    comparison: z.object({
      field: fieldId,
      relationship: relationshipId.optional(),
      ranges: z.array(z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
      }).strict()).min(1).max(2),
    }).strict().optional(),
  }).strict();

  const server = new McpServer(
    { name: "synapsor-runner-authoring", version: "1.6.1" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(SCOPED_EXPLORE_DESCRIBE_TOOL, {
    title: "Describe reviewed data",
    description: "Lists a bounded page of the exact resources, fields, aggregate dimensions, measures, time buckets, relationships, and privacy limits activated for this local authoring session. It returns metadata only, never source rows.",
    inputSchema: {
      resource: resource.optional(),
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(10).optional(),
    },
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
      "synapsor.boundary_digest": runtime.boundary.activation.digest,
    },
  }, async (input) => toolResult(() => runtime.describe(input)));
  server.registerTool(SCOPED_EXPLORE_QUERY_TOOL, {
    title: "Explore reviewed data",
    description: "Runs one bounded row or descriptive aggregate plan against the activated local staging boundary. Use only aliases from app.describe_data. Raw SQL, arbitrary identifiers, model-selected tenant/principal, mutation, approval, and commit are unavailable.",
    inputSchema: {
      plan: z.discriminatedUnion("kind", [rowPlan, aggregatePlan]),
    },
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
      "synapsor.boundary_digest": runtime.boundary.activation.digest,
    },
  }, async ({ plan }) => toolResult(() => runtime.explore(plan)));
  return server;
}

export async function serveScopedExploreStdio(options: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
}): Promise<void> {
  const runtime = await createScopedExploreRuntime({
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

async function toolResult(action: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
  try {
    const result = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const payload = error instanceof ScopedExploreError
      ? { ok: false, error_code: error.code, message: error.message, source_database_changed: false }
      : { ok: false, error_code: "EXPLORE_INTERNAL", message: "Scoped Explore refused the request.", source_database_changed: false };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
