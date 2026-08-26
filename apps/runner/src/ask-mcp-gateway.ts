import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import runnerPackage from "../package.json" with { type: "json" };
import {
  createMcpRuntime,
  createSynapsorMcpServer,
  loadRuntimeConfigFromFile,
  TrustedLocalToolPresentationChannel,
  type LocalToolPresentation,
  type McpRuntime,
} from "@synapsor-runner/mcp-server";
import {
  createScopedExploreMcpServer,
} from "./authoring-mcp.js";
import {
  NO_REVIEWED_ANALYTICS_ACCESS_MESSAGE,
  ScopedExploreError,
} from "./scoped-explore.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import {
  askIntentCheckModesForBoundaries,
  type AskIntentCheckMode,
} from "./ask-intent-preferences.js";
import {
  createScopedExploreBoundarySetRuntime,
  type ScopedExploreBoundarySetRuntime,
} from "./scoped-explore-boundary-set.js";
import type {
  AskToolCallResult,
  AskToolDefinition,
  AskToolGateway,
} from "./model-ask.js";
import { AskError } from "./model-ask.js";
import { readModelAuthorityMetadataMode } from "./model-output-config.js";

type ConnectedMcpSurface = {
  kind: "runtime" | "authoring";
  client: Client;
  server: McpServer;
  localPresentation: TrustedLocalToolPresentationChannel;
  closeRuntime: () => Promise<void>;
  tools: AskToolDefinition[];
  projectResultForModel?: (
    tool: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ) => {
    value: Record<string, unknown>;
    withheld: boolean;
    operator_metadata_withheld?: boolean;
  };
  describeOperatorMetadata?: (
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

export async function createWorkbenchAskMcpGateway(input: {
  configPath: string;
  storePath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  mode?: "auto" | "authoring" | "runtime";
}): Promise<AskToolGateway> {
  const surfaces: ConnectedMcpSurface[] = [];
  try {
    const authoring = await connectAuthoringSurface(input);
    const requestedMode = input.mode ?? "auto";
    let selectedMode: "authoring" | "runtime";
    if (authoring) {
      if (requestedMode === "runtime") {
        await closeSurface(authoring);
        throw new AskError(
          "ASK_MODE_CONFLICT",
          "Runtime Ask is unavailable while Scoped Explore is active. Use authoring mode or disable Explore first.",
          409,
        );
      }
      surfaces.push(authoring);
      assertExactAuthoringSurface(authoring.tools);
      selectedMode = "authoring";
    } else {
      if (requestedMode === "authoring") {
        throw new AskError(
          "ASK_AUTHORING_UNAVAILABLE",
          NO_REVIEWED_ANALYTICS_ACCESS_MESSAGE,
          409,
        );
      }
      const runtime = await connectRuntimeSurface(input);
      if (runtime) surfaces.push(runtime);
      selectedMode = "runtime";
    }
    const toolSurface = singleToolSurface(surfaces);
    const surfaceByTool = new Map<string, ConnectedMcpSurface>();
    for (const surface of surfaces) {
      for (const tool of surface.tools) surfaceByTool.set(tool.name, surface);
    }
    let closed = false;
    return {
      mode: selectedMode,
      listTools: () => toolSurface,
      callTool: async (name, args) => {
        const surface = surfaceByTool.get(name);
        if (!surface) {
          return {
            ok: false,
            value: {
              ok: false,
              error_code: "ASK_UNKNOWN_TOOL",
              message: "The requested tool is outside the reviewed Synapsor surface.",
              source_database_changed: false,
            },
            error_code: "ASK_UNKNOWN_TOOL",
          };
        }
        try {
          const pendingPresentation = surface.localPresentation.begin();
          try {
            const result = await surface.client.callTool({
              name,
              arguments: args,
              _meta: pendingPresentation.request_meta,
            });
            const localPresentation = pendingPresentation.take();
            if (result.isError === true && isMcpInputValidationRefusal(result)) {
              return invalidModelToolArgumentsResult(name);
            }
            const views = askToolResultViews(result, localPresentation);
            const value = views.local;
            const providerProjection = views.withheld || views.operator_metadata_withheld
              ? {
                value: views.provider,
                withheld: views.withheld,
                ...(views.operator_metadata_withheld
                  ? { operator_metadata_withheld: true }
                  : {}),
              }
              : surface.projectResultForModel?.(name, args, value);
            const errorCode = typeof value.error_code === "string"
              ? value.error_code
              : result.isError === true
                ? "MCP_TOOL_REFUSED"
                : undefined;
            return {
              ok: result.isError !== true && value.ok !== false,
              value,
              ...(providerProjection
                && (providerProjection.withheld || providerProjection.operator_metadata_withheld)
                ? { provider_value: providerProjection.value }
                : {}),
              ...(providerProjection?.withheld ? { model_withheld_values: true } : {}),
              ...(errorCode ? { error_code: errorCode } : {}),
            };
          } finally {
            pendingPresentation.cancel();
          }
        } catch {
          return invalidModelToolArgumentsResult(name);
        }
      },
      ...(toolSurface.some((tool) => tool.name === "app.describe_data")
        && surfaces[0]?.describeOperatorMetadata
        ? {
          describeOperatorMetadata: async (args: Record<string, unknown>) => ({
            ok: true,
            value: await surfaces[0]!.describeOperatorMetadata!(args),
          }),
        }
        : {}),
      ...(selectedMode === "authoring"
        ? {
          resolveAskIntentCheck: (args: Record<string, unknown>) =>
            resolveLocalAskIntentCheck(input.projectRoot, args),
        }
        : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled(surfaces.map(closeSurface));
      },
    };
  } catch (error) {
    await Promise.allSettled(surfaces.map(closeSurface));
    throw error;
  }
}

async function resolveLocalAskIntentCheck(
  projectRoot: string,
  args: Record<string, unknown>,
): Promise<{ mode: AskIntentCheckMode; boundary_name?: string }> {
  const boundaries = await loadActivatedExplorationBoundaries(projectRoot);
  const requestedBoundary = typeof args.boundary === "string" && args.boundary.length > 0
    ? args.boundary
    : undefined;
  const plan = isRecord(args.plan) ? args.plan : undefined;
  const resource = typeof plan?.resource === "string" ? plan.resource : undefined;
  const matches = requestedBoundary
    ? boundaries.filter((boundary) => boundary.pack.name === requestedBoundary)
    : resource
      ? boundaries.filter((boundary) =>
          boundary.pack.resources.some((candidate) => candidate.id === resource))
      : boundaries.length === 1
        ? boundaries
        : [];
  if (matches.length === 0) return { mode: "balanced" };
  const modes = await askIntentCheckModesForBoundaries(
    projectRoot,
    matches.map((boundary) => boundary.pack.name),
  );
  if (matches.length === 1) {
    const boundaryName = matches[0]!.pack.name;
    return {
      mode: modes[boundaryName] ?? "balanced",
      boundary_name: boundaryName,
    };
  }
  const distinctModes = [...new Set(matches.map((boundary) =>
    modes[boundary.pack.name] ?? "balanced"))];
  return { mode: distinctModes.length === 1 ? distinctModes[0]! : "balanced" };
}

function invalidModelToolArgumentsMessage(name: string): string {
  if (name === "app.describe_data") {
    return "Invalid app.describe_data arguments. Send {} to list the compact reviewed resource index, or {resource:\"<exact resource id>\"} for focused details. Omit optional values; limit, when present, is an integer from 1 to 10.";
  }
  if (name === "app.explore_data") {
    return "Invalid app.explore_data arguments. Send {plan:{kind:\"rows\"|\"aggregate\",resource:\"<exact resource id>\",...}} using exact ids from app.describe_data. Do not send empty ids. Aggregate plans require measures; rows plans require select. Omit optional limit/top_n to use Runner defaults.";
  }
  return "The reviewed MCP tool refused the supplied arguments. Check its declared input schema and retry without unknown or empty fields.";
}

function invalidModelToolArgumentsResult(name: string): AskToolCallResult {
  return {
    ok: false,
    value: {
      ok: false,
      error_code: "MCP_TOOL_ARGUMENTS_INVALID",
      message: invalidModelToolArgumentsMessage(name),
      source_database_changed: false,
    },
    error_code: "MCP_TOOL_ARGUMENTS_INVALID",
  };
}

function isMcpInputValidationRefusal(
  result: Awaited<ReturnType<Client["callTool"]>>,
): boolean {
  if (!Array.isArray(result.content)) return false;
  return result.content.some((item) =>
    isRecord(item)
    && item.type === "text"
    && typeof item.text === "string"
    && item.text.includes("Input validation error: Invalid arguments for tool"));
}

async function connectRuntimeSurface(input: {
  configPath: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<ConnectedMcpSurface | undefined> {
  const config = loadRuntimeConfigFromFile(input.configPath);
  if ((config.capabilities?.length ?? 0) === 0) return undefined;
  const runtime = createMcpRuntime(config, {
    storePath: input.storePath,
    env: input.env,
  });
  const localPresentation = new TrustedLocalToolPresentationChannel();
  const server = createSynapsorMcpServer(runtime, { localPresentation });
  return connectSurface("runtime", server, localPresentation, () => runtime.close());
}

async function connectAuthoringSurface(input: {
  configPath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<ConnectedMcpSurface | undefined> {
  let runtime: ScopedExploreBoundarySetRuntime | undefined;
  try {
    const modelAuthorityMetadata = await readModelAuthorityMetadataMode(input.configPath);
    runtime = await createScopedExploreBoundarySetRuntime({
      projectRoot: input.projectRoot,
      transport: "loopback_workbench",
      env: input.env,
      modelAuthorityMetadata,
    });
    const localPresentation = new TrustedLocalToolPresentationChannel();
    const server = createScopedExploreMcpServer(runtime, { localPresentation });
    const surface = await connectSurface(
      "authoring",
      server,
      localPresentation,
      () => runtime!.close(),
    );
    surface.projectResultForModel = (tool, args, result) =>
      runtime!.projectResultForModel({
        tool,
        arguments: args,
        result,
      });
    surface.describeOperatorMetadata = async (args) => {
      const described = await runtime!.describe({
        ...(typeof args.boundary === "string" ? { boundary: args.boundary } : {}),
        ...(typeof args.resource === "string" ? { resource: args.resource } : {}),
        ...(typeof args.cursor === "number" ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        include_time_coverage: false,
      });
      return addAskOperatorReviewMetadata(runtime!, args, described);
    };
    return surface;
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    if (error instanceof ScopedExploreError) {
      if (error.code === "EXPLORE_DISABLED") return undefined;
      if (error.code === "EXPLORE_LOCK_STALE"
        || error.code === "EXPLORE_BOUNDARY_MISMATCH") {
        throw new AskError(
          "ASK_AUTHORITY_CHANGED",
          `Reviewed analytics access changed. ${error.message} No query was executed. Next: rescan and review the affected table or view.`,
          409,
        );
      }
      if (error.code === "EXPLORE_ROLE_UNSAFE") {
        throw new AskError(
          "ASK_AUTHORING_ROLE_UNSAFE",
          `${error.message} No query was executed. Next: reconnect the reviewed read-only role and rescan.`,
          409,
        );
      }
      if (error.code === "EXPLORE_PROFILE_FORBIDDEN"
        || error.code === "EXPLORE_TRANSPORT_FORBIDDEN") {
        throw new AskError(
          "ASK_AUTHORING_UNAVAILABLE",
          `${error.message} No query was executed. Scoped Explore remains local development/staging authority only.`,
          409,
        );
      }
    }
    throw error;
  }
}

function addAskOperatorReviewMetadata(
  runtime: ScopedExploreBoundarySetRuntime,
  args: Record<string, unknown>,
  described: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(described.resources)) return described;
  const requestedBoundary = typeof args.boundary === "string" ? args.boundary : undefined;
  const requestedResource = typeof args.resource === "string" ? args.resource : undefined;
  const boundary = requestedBoundary
    ? runtime.boundaries.find((candidate) => candidate.pack.name === requestedBoundary)
    : requestedResource
      ? runtime.boundaries.find((candidate) =>
          candidate.pack.resources.some((resource) => resource.id === requestedResource))
      : runtime.boundaries.length === 1
        ? runtime.boundaries[0]
        : undefined;
  if (!boundary) return described;

  const reviewedById = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
  return {
    ...described,
    resources: described.resources.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const resource = value as Record<string, unknown>;
      const id = typeof resource.id === "string" ? resource.id : undefined;
      const reviewed = id ? reviewedById.get(id) : undefined;
      if (!reviewed) return resource;
      return {
        ...resource,
        operator_review_metadata: {
          boundary_resource_count: boundary.pack.resources.length,
          fields: Object.keys(reviewed.field_types).sort().map((field) => ({
            id: field,
            kept_out: reviewed.kept_out_fields.includes(field),
            model_visible: reviewed.selectable_fields.includes(field),
            count_unique_reviewed: reviewed.count_distinct_fields.includes(field),
          })),
        },
      };
    }),
  };
}

async function connectSurface(
  kind: ConnectedMcpSurface["kind"],
  server: McpServer,
  localPresentation: TrustedLocalToolPresentationChannel,
  closeRuntime: () => Promise<void>,
): Promise<ConnectedMcpSurface> {
  const client = new Client({
    name: `synapsor-workbench-ask-${kind}`,
    version: runnerPackage.version,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = client.getServerCapabilities()?.tools
      ? await client.listTools()
      : { tools: [] };
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? "",
      input_schema: asRecord(tool.inputSchema),
      ...(tool._meta ? { metadata: asRecord(tool._meta) } : {}),
    }));
    return { kind, client, server, localPresentation, closeRuntime, tools };
  } catch (error) {
    localPresentation.close();
    await Promise.allSettled([client.close(), server.close(), closeRuntime()]);
    throw error;
  }
}

function singleToolSurface(surfaces: ConnectedMcpSurface[]): AskToolDefinition[] {
  if (surfaces.length > 1) {
    throw new AskError(
      "ASK_MIXED_TOOL_SURFACE_REFUSED",
      "Ask refuses to combine authoring and runtime tool catalogs.",
      409,
    );
  }
  const byName = new Map<string, AskToolDefinition>();
  for (const surface of surfaces) {
    for (const tool of surface.tools) {
      if (byName.has(tool.name)) {
        throw new Error(`Ask tool surface contains duplicate MCP tool ${tool.name}.`);
      }
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function assertExactAuthoringSurface(tools: AskToolDefinition[]): void {
  const expected = ["app.describe_data", "app.explore_data"];
  const actual = tools.map((tool) => tool.name).sort();
  if (actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])) {
    throw new AskError(
      "ASK_AUTHORING_TOOL_SURFACE_INVALID",
      "Scoped Explore Ask must expose exactly app.describe_data and app.explore_data.",
      409,
    );
  }
}

async function closeSurface(surface: ConnectedMcpSurface): Promise<void> {
  surface.localPresentation.close();
  await Promise.allSettled([
    surface.client.close(),
    surface.server.close(),
    surface.closeRuntime(),
  ]);
}

export function askToolResultViews(
  result: Awaited<ReturnType<Client["callTool"]>>,
  localPresentation?: LocalToolPresentation,
): {
  local: Record<string, unknown>;
  provider: Record<string, unknown>;
  withheld: boolean;
  operator_metadata_withheld: boolean;
} {
  const metadata = isRecord(result._meta) ? result._meta : {};
  const provider = modelFacingToolResult(result);
  return {
    local: localPresentation?.value ?? provider,
    provider,
    withheld: localPresentation?.model_withheld_values
      ?? metadata["synapsor.model_withheld_values"] === true,
    operator_metadata_withheld: localPresentation?.operator_metadata_withheld
      ?? metadata["synapsor.operator_metadata_withheld"] === true,
  };
}

function modelFacingToolResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const text = result.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (text && typeof text.text === "string") {
      try {
        const parsed: unknown = JSON.parse(text.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        return {
          ok: result.isError !== true,
          summary: text.text.slice(0, 16_384),
          source_database_changed: false,
        };
      }
    }
  }
  return {
    ok: result.isError !== true,
    error_code: result.isError === true ? "MCP_TOOL_REFUSED" : undefined,
    message: result.isError === true
      ? "The reviewed MCP tool refused the request."
      : "The reviewed MCP tool returned no structured result.",
    source_database_changed: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
