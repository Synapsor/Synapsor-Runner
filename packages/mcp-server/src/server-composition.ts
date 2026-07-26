import type {
  Readable,
  Writable,
} from "node:stream";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StdioServerTransport,
} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  PROPOSAL_APP_URI,
  proposalAppHtml,
} from "./proposal-app.js";
import type {
  ToolNameStyle,
  ResultFormat,
  RuntimeConfig,
  DbRowReader,
  TenantCredentialResolver,
  McpRuntime,
  SynapsorMcpServerOptions,
} from "./runtime-types.js";
import {
  listedLocalCapabilities,
} from "./capability-authority.js";
import {
  fetchCloudToolMetadata,
} from "./cloud-linked.js";
import {
  preflightGeneratedAuthority,
} from "./generated-authority.js";
import {
  resourceResult,
} from "./local-resources.js";
import {
  createMcpRuntime,
} from "./runtime-composition.js";
import {
  loadRuntimeConfigFromFile,
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  preflightPostgresDatabaseScope,
} from "./source-runtime.js";
import {
  capabilityDescription,
  toolCallResult,
  toolDescriptionWithCanonical,
  zodInputShape,
  zodInputShapeFromJsonSchema,
} from "./tool-catalog.js";
import {
  toolNameExposureMap,
} from "./tool-naming.js";

export function createSynapsorMcpServer(runtime: McpRuntime, options: SynapsorMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "synapsor-runner", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  const toolNameStyle = options.toolNameStyle ?? "canonical";

  if (runtime.config.mode === "cloud") {
    const tools = runtime.listTools();
    const exposedNames = toolNameExposureMap(tools.map((tool) => tool.name), toolNameStyle);
    for (const tool of tools) {
      for (const exposedName of exposedNames.get(tool.name) ?? [tool.name]) {
        const toolConfig = {
          title: tool.title,
          description: toolDescriptionWithCanonical(tool.description, tool.name, exposedName),
          inputSchema: zodInputShapeFromJsonSchema(tool.input_schema),
          annotations: {
            readOnlyHint: Boolean(tool.annotations.readOnlyHint),
            destructiveHint: false,
            idempotentHint: Boolean(tool.annotations.idempotentHint),
            openWorldHint: false,
          },
          _meta: {
            ...tool.annotations,
            "synapsor.cloud_delegated": true,
            "synapsor.canonical_tool_name": tool.name,
            "synapsor.exposed_tool_name": exposedName,
            "synapsor.tool_name_style": toolNameStyle,
            "synapsor.raw_sql_exposed": false,
            "synapsor.approval_tool": false,
          },
        };
        const callback = async (args: unknown) =>
          toolCallResult(runtime, tool.name, args as Record<string, unknown>);
        if (tool.annotations.readOnlyHint === false) {
          registerAppTool(server, exposedName, {
            ...toolConfig,
            _meta: {
              ...toolConfig._meta,
              ui: { resourceUri: PROPOSAL_APP_URI, visibility: ["model", "app"] },
              "synapsor.mcp_app_mode": "display_only",
            },
          }, callback);
        } else {
          server.registerTool(exposedName, toolConfig, callback);
        }
      }
    }
  } else {
    const capabilities = listedLocalCapabilities(runtime.config);
    const exposedNames = toolNameExposureMap(capabilities.map((capability) => capability.name), toolNameStyle);
    for (const capability of capabilities) {
      for (const exposedName of exposedNames.get(capability.name) ?? [capability.name]) {
        const toolConfig = {
          title: capability.name,
          description: capabilityDescription(capability, runtime.config, exposedName),
          inputSchema: zodInputShape(capability),
          annotations: {
            readOnlyHint: capability.kind === "read" || capability.kind === "aggregate_read",
            destructiveHint: false,
            idempotentHint: capability.kind === "read" || capability.kind === "aggregate_read",
            openWorldHint: false,
          },
          _meta: {
            "synapsor.kind": capability.kind,
            "synapsor.source": capability.source,
            "synapsor.target": `${capability.target.schema}.${capability.target.table}`,
            "synapsor.canonical_tool_name": capability.name,
            "synapsor.exposed_tool_name": exposedName,
            "synapsor.tool_name_style": toolNameStyle,
            "synapsor.raw_sql_exposed": false,
            "synapsor.approval_tool": false,
          },
        };
        const callback = async (args: unknown) =>
          toolCallResult(runtime, capability.name, args as Record<string, unknown>);
        if (capability.kind === "proposal") {
          registerAppTool(server, exposedName, {
            ...toolConfig,
            _meta: {
              ...toolConfig._meta,
              ui: { resourceUri: PROPOSAL_APP_URI, visibility: ["model", "app"] },
              "synapsor.mcp_app_mode": "display_only",
            },
          }, callback);
        } else {
          server.registerTool(exposedName, toolConfig, callback);
        }
      }
    }
  }

  registerAppResource(
    server,
    "Synapsor proposal review",
    PROPOSAL_APP_URI,
    {
      title: "Synapsor proposal review",
      description: "Display-only proposal diff and trusted-scope summary. Approval and apply remain outside MCP.",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
          permissions: {},
        },
      },
    },
    async () => ({
      contents: [{
        uri: PROPOSAL_APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: proposalAppHtml(),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
            permissions: {},
          },
        },
      }],
    }),
  );

  server.registerResource(
    "synapsor-proposals",
    new ResourceTemplate("synapsor://proposals/{proposal_id}", { list: undefined }),
    { title: "Synapsor proposal", mimeType: "application/json" },
    async (_uri, variables) => resourceResult(`synapsor://proposals/${variables.proposal_id}`, runtime.readResource),
  );
  server.registerResource(
    "synapsor-evidence",
    new ResourceTemplate("synapsor://evidence/{evidence_bundle_id}", { list: undefined }),
    { title: "Synapsor evidence bundle", mimeType: "application/json" },
    async (_uri, variables) => resourceResult(`synapsor://evidence/${variables.evidence_bundle_id}`, runtime.readResource),
  );
  server.registerResource(
    "synapsor-replay",
    new ResourceTemplate("synapsor://replay/{replay_id}", { list: undefined }),
    { title: "Synapsor replay record", mimeType: "application/json" },
    async (_uri, variables) => resourceResult(`synapsor://replay/${variables.replay_id}`, runtime.readResource),
  );

  return server;
}

export async function serveStdio(options: { configPath?: string; storePath?: string; config?: RuntimeConfig; toolNameStyle?: ToolNameStyle; resultFormat?: ResultFormat; stdin?: Readable; stdout?: Writable; readRow?: DbRowReader; credentialResolver?: TenantCredentialResolver } = {}): Promise<void> {
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
  await preflightGeneratedAuthority(config, process.env);
  await preflightPostgresDatabaseScope(config, process.env, options.credentialResolver);
  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, process.env) : undefined;
  const runtime = createMcpRuntime(config, {
    storePath: options.storePath,
    resultFormat: options.resultFormat,
    cloudTools,
    readRow: options.readRow,
    credentialResolver: options.credentialResolver,
  });
  const server = createSynapsorMcpServer(runtime, { toolNameStyle: options.toolNameStyle });
  const input = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(input, options.stdout ?? process.stdout);
  await server.connect(transport);
  // stdout is reserved for MCP protocol frames; human feedback goes to stderr.
  process.stderr.write("synapsor-runner MCP stdio server ready. Waiting for an MCP client on stdio; logs stay on stderr.\n");
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
