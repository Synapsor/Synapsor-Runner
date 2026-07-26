import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpRuntime,
  createSynapsorMcpServer,
  loadRuntimeConfigFromFile,
  type McpRuntime,
} from "@synapsor-runner/mcp-server";
import {
  createScopedExploreMcpServer,
} from "./authoring-mcp.js";
import {
  createScopedExploreRuntime,
  ScopedExploreError,
  type ScopedExploreRuntime,
} from "./scoped-explore.js";
import type {
  AskToolCallResult,
  AskToolDefinition,
  AskToolGateway,
} from "./model-ask.js";

type ConnectedMcpSurface = {
  kind: "runtime" | "authoring";
  client: Client;
  server: McpServer;
  closeRuntime: () => Promise<void>;
  tools: AskToolDefinition[];
};

export async function createWorkbenchAskMcpGateway(input: {
  configPath: string;
  storePath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<AskToolGateway> {
  const surfaces: ConnectedMcpSurface[] = [];
  try {
    const runtime = await connectRuntimeSurface(input);
    if (runtime) surfaces.push(runtime);
    const authoring = await connectAuthoringSurface(input);
    if (authoring) surfaces.push(authoring);
    const toolSurface = combinedToolSurface(surfaces);
    const surfaceByTool = new Map<string, ConnectedMcpSurface>();
    for (const surface of surfaces) {
      for (const tool of surface.tools) surfaceByTool.set(tool.name, surface);
    }
    let closed = false;
    return {
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
          const result = await surface.client.callTool({ name, arguments: args });
          const value = structuredToolResult(result);
          const errorCode = typeof value.error_code === "string"
            ? value.error_code
            : result.isError === true
              ? "MCP_TOOL_REFUSED"
              : undefined;
          return {
            ok: result.isError !== true && value.ok !== false,
            value,
            ...(errorCode ? { error_code: errorCode } : {}),
          };
        } catch {
          return {
            ok: false,
            value: {
              ok: false,
              error_code: "MCP_TOOL_ARGUMENTS_INVALID",
              message: "The reviewed MCP tool refused the supplied arguments.",
              source_database_changed: false,
            },
            error_code: "MCP_TOOL_ARGUMENTS_INVALID",
          };
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled(surfaces.flatMap((surface) => [
          surface.client.close(),
          surface.server.close(),
          surface.closeRuntime(),
        ]));
      },
    };
  } catch (error) {
    await Promise.allSettled(surfaces.flatMap((surface) => [
      surface.client.close(),
      surface.server.close(),
      surface.closeRuntime(),
    ]));
    throw error;
  }
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
  const server = createSynapsorMcpServer(runtime);
  return connectSurface("runtime", server, () => runtime.close());
}

async function connectAuthoringSurface(input: {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<ConnectedMcpSurface | undefined> {
  let runtime: ScopedExploreRuntime | undefined;
  try {
    runtime = await createScopedExploreRuntime({
      projectRoot: input.projectRoot,
      transport: "loopback_workbench",
      env: input.env,
    });
    const server = createScopedExploreMcpServer(runtime);
    return await connectSurface("authoring", server, () => runtime!.close());
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    if (error instanceof ScopedExploreError && [
      "EXPLORE_DISABLED",
      "EXPLORE_PROFILE_REFUSED",
      "EXPLORE_TRANSPORT_REFUSED",
      "EXPLORE_LOCK_STALE",
      "EXPLORE_CREDENTIAL_POSTURE_REFUSED",
    ].includes(error.code)) {
      return undefined;
    }
    throw error;
  }
}

async function connectSurface(
  kind: ConnectedMcpSurface["kind"],
  server: McpServer,
  closeRuntime: () => Promise<void>,
): Promise<ConnectedMcpSurface> {
  const client = new Client({
    name: `synapsor-workbench-ask-${kind}`,
    version: "1.6.4",
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
    return { kind, client, server, closeRuntime, tools };
  } catch (error) {
    await Promise.allSettled([client.close(), server.close(), closeRuntime()]);
    throw error;
  }
}

function combinedToolSurface(surfaces: ConnectedMcpSurface[]): AskToolDefinition[] {
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

function structuredToolResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
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
