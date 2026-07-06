import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  ControlPlaneClient,
  type AdapterToolCatalogEntry,
} from "@synapsor-runner/control-plane-client";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { protocolVersions, type ChangeSetV1 } from "@synapsor-runner/protocol";
import { normalizeContract, type AgentContextSpec, type CapabilitySpec, type ResourceSpec, type SynapsorContract } from "@synapsor/spec";
import mysql from "mysql2/promise";
import { Pool } from "pg";
import { z } from "zod";

export type RunnerMode = "read_only" | "shadow" | "review" | "cloud";
export type SourceEngine = "postgres" | "mysql";
export type ContextProvider = "static_dev" | "environment" | "http_claims" | "cloud_session";
export type CapabilityKind = "read" | "proposal";
export type RuntimeWritebackMode = "direct_sql" | "app_handler" | "cloud_worker" | "none";
export type ToolNameStyle = "canonical" | "openai" | "both";
export type ResultFormat = 1 | 2;
export type ToolNameExposure = {
  canonicalName: string;
  exposedName: string;
  isAlias: boolean;
  style: ToolNameStyle;
};
export type Scalar = string | number | boolean | null;

export type RuntimeSourceConfig = {
  engine: SourceEngine;
  read_url_env: string;
  write_url_env?: string;
  read_only?: boolean;
  statement_timeout_ms?: number;
};

export type RuntimeArgConfig = {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
  max_length?: number;
  minimum?: number;
  maximum?: number;
  enum?: Scalar[];
};

export type RuntimeNumericBoundConfig = {
  minimum?: number;
  maximum?: number;
};

export type RuntimeTransitionGuardConfig = {
  from_column?: string;
  allowed: Record<string, string[]>;
};

export type RuntimeCapabilityConfig = {
  name: string;
  kind: CapabilityKind;
  description?: string;
  returns_hint?: string;
  source: string;
  context?: string;
  executor?: string;
  target: {
    schema: string;
    table: string;
    primary_key: string;
    tenant_key?: string;
    single_tenant_dev?: boolean;
  };
  args: Record<string, RuntimeArgConfig>;
  lookup: { id_from_arg: string };
  visible_columns: string[];
  evidence?: "required" | "optional" | string;
  max_rows?: number;
  patch?: Record<string, { fixed?: Scalar; from_arg?: string }>;
  allowed_columns?: string[];
  numeric_bounds?: Record<string, RuntimeNumericBoundConfig>;
  transition_guards?: Record<string, RuntimeTransitionGuardConfig>;
  conflict_guard?: { column?: string; weak_guard_ack?: boolean };
  approval?: { mode?: "human" | "policy" | string; required_role?: string };
  writeback?: { mode: RuntimeWritebackMode; executor?: string };
};

export type RuntimeConfig = {
  version: 1;
  mode: RunnerMode;
  result_format?: ResultFormat;
  contracts?: string[];
  storage?: { sqlite_path?: string };
  sources?: Record<string, RuntimeSourceConfig>;
  trusted_context?: {
    provider: ContextProvider;
    values?: Record<string, unknown>;
  };
  contexts?: Record<string, {
    provider: ContextProvider;
    values?: Record<string, unknown>;
  }>;
  executors?: Record<string, unknown>;
  capabilities?: RuntimeCapabilityConfig[];
  cloud?: {
    base_url_env: string;
    runner_token_env: string;
    runner_id?: string;
    runner_version?: string;
    project_id?: string;
    adapter_id: string;
    source_id?: string;
    engines?: SourceEngine[];
    capabilities?: string[];
    session?: Record<string, unknown>;
  };
};

export type TrustedContext = {
  tenant_id: string;
  principal: string;
  provenance: ContextProvider;
};

export type DbRowReader = (input: {
  sourceName: string;
  source: RuntimeSourceConfig;
  capability: RuntimeCapabilityConfig;
  args: Record<string, unknown>;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
}) => Promise<{ row: Record<string, unknown>; rowCount: number }>;

export type McpRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  store?: ProposalStore;
  storePath?: string;
  resultFormat?: ResultFormat;
  readRow?: DbRowReader;
  controlPlaneClient?: CloudAdapterClient;
  cloudTools?: LocalToolMetadata[];
};

export type McpRuntime = {
  config: RuntimeConfig;
  store: ProposalStore;
  listTools(): LocalToolMetadata[];
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  readResource(uri: string): Record<string, unknown>;
  close(): void;
};

export type LocalToolMetadata = {
  name: string;
  title: string;
  description: string;
  kind: CapabilityKind;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

export type HttpMcpServerOptions = {
  configPath?: string;
  storePath?: string;
  config?: RuntimeConfig;
  toolNameStyle?: ToolNameStyle;
  host?: string;
  port?: number;
  authTokenEnv?: string;
  devNoAuth?: boolean;
  corsOrigin?: string;
  env?: NodeJS.ProcessEnv;
  log?: false | { write(chunk: string): unknown };
  resultFormat?: ResultFormat;
  readRow?: DbRowReader;
};

export type HttpMcpServerHandle = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export type SynapsorMcpServerOptions = {
  toolNameStyle?: ToolNameStyle;
};

export type ResultEnvelopeV2 = {
  [key: string]: unknown;
  ok: boolean;
  summary: string;
  action: string;
  kind: CapabilityKind;
  data: Record<string, unknown> | null;
  proposal: Record<string, unknown> | null;
  error: {
    code: SafeToolErrorCode;
    message: string;
    retryable: boolean;
  } | null;
  evidence: {
    bundle_id: string;
    note: string;
  } | null;
  source_database_changed: boolean;
  _meta: {
    tenant_id?: string;
    principal?: string;
    provenance?: string;
    canonical_capability: string;
  };
};

export type SafeToolErrorCode =
  | "NOT_FOUND_IN_TENANT"
  | "INVALID_ARGUMENT"
  | "POLICY_VIOLATION"
  | "CAPABILITY_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "MULTI_ROW_BLOCKED"
  | "APPROVAL_REQUIRED"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL";

type StreamableHttpSession = {
  transport: StreamableHTTPServerTransport;
  runtime: McpRuntime;
  sessionId?: string;
  closed?: boolean;
};

type CloudAdapterClient = Pick<ControlPlaneClient, "adapterTools" | "callAdapterTool">;

const RESERVED_MODEL_ARGS = new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "project_id",
  "source_id",
  "allowed_columns",
  "row_version",
  "expected_version",
  "approval_identity",
]);

export class McpRuntimeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "McpRuntimeError";
  }
}

export function loadRuntimeConfigFromFile(
  configPath = process.env.SYNAPSOR_MCP_CONFIG || "synapsor.runner.json",
): RuntimeConfig {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const config = resolveRuntimeConfig(parsed as RuntimeConfig, path.dirname(resolved));
  assertValidRunnerCapabilityConfig(config);
  return config;
}

export function resolveRuntimeConfig(config: RuntimeConfig, baseDir = process.cwd()): RuntimeConfig {
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) return config;
  const seenCapabilities = new Map<string, string>();
  for (const [index, capability] of (config.capabilities ?? []).entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `embedded capabilities[${index}]`);
  }
  const resolved: RuntimeConfig = {
    ...config,
    contexts: { ...(config.contexts ?? {}) },
    capabilities: [...(config.capabilities ?? [])],
  };
  for (const [contractIndex, contractPath] of config.contracts.entries()) {
    const fullPath = path.resolve(baseDir, contractPath);
    const contract = normalizeContract(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    mergeContractIntoRuntimeConfig(resolved, contract, `contracts[${contractIndex}] ${contractPath}`, seenCapabilities);
  }
  delete resolved.contracts;
  return resolved;
}

function rememberCapabilityName(seen: Map<string, string>, name: string, origin: string): void {
  const previous = seen.get(name);
  if (previous) {
    throw new Error(`Duplicate capability ${name}: ${origin} conflicts with ${previous}. Capability names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name, origin);
}

function mergeContractIntoRuntimeConfig(config: RuntimeConfig, contract: SynapsorContract, origin: string, seenCapabilities: Map<string, string>): void {
  const resources = new Map((contract.resources ?? []).map((resource) => [resource.name, resource]));
  for (const context of contract.contexts) {
    if (!config.contexts) config.contexts = {};
    config.contexts[context.name] ??= runtimeContextFromSpec(context);
  }
  if (!config.trusted_context && contract.contexts.length === 1) {
    const [context] = contract.contexts;
    if (context) config.trusted_context = runtimeContextFromSpec(context);
  }
  if (!config.capabilities) config.capabilities = [];
  for (const [capabilityIndex, capability] of contract.capabilities.entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `${origin} capabilities[${capabilityIndex}]`);
    config.capabilities.push(runtimeCapabilityFromSpec(capability, resources, config));
  }
}

function runtimeContextFromSpec(context: AgentContextSpec): NonNullable<RuntimeConfig["contexts"]>[string] {
  const tenantBinding = context.bindings.find((binding) => binding.name === context.tenant_binding) ?? context.bindings.find((binding) => binding.name === "tenant_id");
  const principalBinding = context.bindings.find((binding) => binding.name === context.principal_binding) ?? context.bindings.find((binding) => binding.name === "principal");
  const provider = context.bindings.some((binding) => binding.source === "environment") ? "environment"
    : context.bindings.some((binding) => binding.source === "cloud_session") ? "cloud_session"
      : context.bindings.some((binding) => binding.source === "http_claim") ? "http_claims"
        : context.bindings.some((binding) => binding.source === "static_dev") ? "static_dev"
          : "environment";
  return {
    provider,
    values: {
      ...(tenantBinding ? { tenant_id_env: tenantBinding.key, tenant_id_key: tenantBinding.key } : {}),
      ...(principalBinding ? { principal_env: principalBinding.key, principal_key: principalBinding.key } : {}),
    },
  };
}

function runtimeCapabilityFromSpec(
  capability: CapabilitySpec,
  resources: Map<string, ResourceSpec>,
  config: RuntimeConfig,
): RuntimeCapabilityConfig {
  const subjectResource = capability.subject.resource ? resources.get(capability.subject.resource) : undefined;
  const source = resolveCapabilitySource(capability, config);
  const target = {
    schema: subjectResource?.schema ?? capability.subject.schema ?? "",
    table: subjectResource?.table ?? capability.subject.table ?? "",
    primary_key: subjectResource?.primary_key ?? capability.subject.primary_key ?? "",
    tenant_key: subjectResource?.tenant_key ?? capability.subject.tenant_key,
    single_tenant_dev: subjectResource?.single_tenant_dev ?? capability.subject.single_tenant_dev,
  };
  const runtime: RuntimeCapabilityConfig = {
    name: capability.name,
    kind: capability.kind === "proposal" ? "proposal" : "read",
    ...(capability.description ? { description: capability.description } : {}),
    source,
    context: capability.context,
    target,
    args: capability.args,
    lookup: capability.lookup ?? { id_from_arg: Object.keys(capability.args)[0] ?? "id" },
    visible_columns: capability.visible_fields,
    evidence: capability.evidence?.required === false ? "optional" : "required",
    ...(capability.max_rows ? { max_rows: capability.max_rows } : {}),
  };
  if (capability.kind === "proposal" && capability.proposal) {
    runtime.patch = capability.proposal.patch;
    runtime.allowed_columns = capability.proposal.allowed_fields;
    runtime.conflict_guard = capability.proposal.conflict_guard;
    runtime.approval = capability.proposal.approval;
    runtime.writeback = {
      mode: capability.proposal.writeback?.mode ?? "direct_sql",
      ...(capability.proposal.writeback?.executor ? { executor: capability.proposal.writeback.executor } : {}),
    };
    if (capability.proposal.writeback?.executor) {
      runtime.executor = capability.proposal.writeback.executor;
    }
  }
  return runtime;
}

function resolveCapabilitySource(capability: CapabilitySpec, config: RuntimeConfig): string {
  if (capability.source) return capability.source;
  const sourceNames = Object.keys(config.sources ?? {});
  if (sourceNames.length === 1 && sourceNames[0]) return sourceNames[0];
  throw new Error(`contract capability ${capability.name} must set source when runner config has ${sourceNames.length} sources`);
}

export function createMcpRuntime(config: RuntimeConfig, options: McpRuntimeOptions = {}): McpRuntime {
  config = resolveRuntimeConfig(config);
  assertValidRunnerCapabilityConfig(config);
  const env = options.env ?? process.env;
  const storePath = options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  const ownsStore = !options.store;
  const store = options.store ?? new ProposalStore(storePath);
  const readRow = options.readRow ?? readCurrentRow;
  const cloudClient = options.controlPlaneClient ?? (config.mode === "cloud" ? createCloudClient(config, env) : undefined);
  const cloudTools = options.cloudTools ?? [];
  const resultFormat = options.resultFormat ?? config.result_format ?? 1;
  const assertStoreAvailable = () => {
    if (ownsStore) assertPersistentStoreAvailable(storePath);
  };

  return {
    config,
    store,
    listTools: () => config.mode === "cloud" ? cloudTools : listedLocalCapabilities(config).map((capability) => toolMetadata(capability)),
    callTool: async (name, args) => {
      if (resultFormat === 2) {
        try {
          assertStoreAvailable();
          return await callConfiguredToolV2({ config, env, store, readRow, cloudClient, name, args });
        } catch (error) {
          const capability = config.mode === "cloud" ? undefined : localCapabilities(config).find((item) => item.name === name);
          return errorEnvelopeFromError(error, capability, name);
        }
      }
      assertStoreAvailable();
      return callConfiguredTool({ config, env, store, readRow, cloudClient, name, args });
    },
    readResource: (uri) => {
      assertStoreAvailable();
      return readLocalResource(store, uri);
    },
    close: () => {
      if (!options.store) store.close();
    },
  };
}

function assertPersistentStoreAvailable(storePath: string): void {
  if (storePath === ":memory:") return;
  if (fs.existsSync(storePath)) return;
  throw new McpRuntimeError(
    "LOCAL_STORE_UNAVAILABLE",
    "The local Synapsor store is temporarily unavailable. Restart the runner or recreate the store before retrying.",
  );
}

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
        server.registerTool(
          exposedName,
          {
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
          },
          async (args) => toolCallResult(runtime, tool.name, args as Record<string, unknown>),
        );
      }
    }
  } else {
    const capabilities = listedLocalCapabilities(runtime.config);
    const exposedNames = toolNameExposureMap(capabilities.map((capability) => capability.name), toolNameStyle);
    for (const capability of capabilities) {
      for (const exposedName of exposedNames.get(capability.name) ?? [capability.name]) {
        server.registerTool(
          exposedName,
          {
            title: capability.name,
            description: capabilityDescription(capability, exposedName),
            inputSchema: zodInputShape(capability),
            annotations: {
              readOnlyHint: capability.kind === "read",
              destructiveHint: false,
              idempotentHint: capability.kind === "read",
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
          },
          async (args) => toolCallResult(runtime, capability.name, args as Record<string, unknown>),
        );
      }
    }
  }

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

export async function serveStdio(options: { configPath?: string; storePath?: string; config?: RuntimeConfig; toolNameStyle?: ToolNameStyle; resultFormat?: ResultFormat } = {}): Promise<void> {
  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);
  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, process.env) : undefined;
  const runtime = createMcpRuntime(config, { storePath: options.storePath, resultFormat: options.resultFormat, cloudTools });
  const server = createSynapsorMcpServer(runtime, { toolNameStyle: options.toolNameStyle });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for MCP protocol frames; human feedback goes to stderr.
  process.stderr.write("synapsor-runner MCP stdio server ready. Waiting for an MCP client on stdio; logs stay on stderr.\n");
  await new Promise<void>((resolve) => {
    const previousOnClose = transport.onclose;
    const close = () => {
      runtime.close();
      resolve();
    };
    transport.onclose = () => {
      previousOnClose?.();
      close();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

export async function startHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<HttpMcpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const authTokenEnv = options.authTokenEnv ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const env = options.env ?? process.env;
  const devNoAuth = options.devNoAuth === true;

  if (devNoAuth && !isLoopbackHost(host)) {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_UNSAFE_HOST", "--dev-no-auth is only allowed with localhost or 127.0.0.1.");
  }

  const authToken = devNoAuth ? undefined : envValue(env, authTokenEnv);
  if (!devNoAuth && !authToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_MISSING", `${authTokenEnv} is not set. HTTP MCP requires bearer auth by default.`);
  }

  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);
  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  const runtime = createMcpRuntime(config, {
    env,
    storePath: options.storePath,
    resultFormat: options.resultFormat,
    readRow: options.readRow,
    cloudTools,
  });
  const server = createServer((request, response) => {
    void handleHttpMcpRequest({
      request,
      response,
      runtime,
      authToken,
      devNoAuth,
      corsOrigin: options.corsOrigin,
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    runtime.close();
    throw error;
  }

  const address = server.address() as AddressInfo;
  const actualHost = address.address === "::" ? host : address.address;
  const actualPort = address.port;
  const url = `http://${actualHost}:${actualPort}/mcp`;

  if (options.log !== false) {
    const log = options.log ?? process.stderr;
    log.write(`Synapsor Runner HTTP MCP listening on ${url}\n`);
    log.write(devNoAuth ? "Auth: disabled for localhost development only\n" : `Auth: bearer token from ${authTokenEnv}\n`);
    log.write(`Config: ${options.configPath ?? "synapsor.runner.json"}\n`);
    log.write(`Store: ${options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db"}\n`);
  }

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: () => closeHttpServer(server, runtime),
  };
}

export async function startStreamableHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<HttpMcpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8766;
  const authTokenEnv = options.authTokenEnv ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const env = options.env ?? process.env;
  const devNoAuth = options.devNoAuth === true;

  if (devNoAuth && !isLoopbackHost(host)) {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_UNSAFE_HOST", "--dev-no-auth is only allowed with localhost or 127.0.0.1.");
  }

  const authToken = devNoAuth ? undefined : envValue(env, authTokenEnv);
  if (!devNoAuth && !authToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_MISSING", `${authTokenEnv} is not set. Streamable HTTP MCP requires bearer auth by default.`);
  }

  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);
  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  const sessions = new Map<string, StreamableHttpSession>();
  const openSessions = new Set<StreamableHttpSession>();
  const server = createServer((request, response) => {
    void handleStreamableHttpMcpRequest({
      request,
      response,
      config,
      storePath: options.storePath,
      readRow: options.readRow,
      cloudTools,
      env,
      toolNameStyle: options.toolNameStyle,
      resultFormat: options.resultFormat,
      authToken,
      devNoAuth,
      corsOrigin: options.corsOrigin,
      sessions,
      openSessions,
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await closeStreamableSessions(openSessions);
    throw error;
  }

  const address = server.address() as AddressInfo;
  const actualHost = address.address === "::" ? host : address.address;
  const actualPort = address.port;
  const url = `http://${actualHost}:${actualPort}/mcp`;

  if (options.log !== false) {
    const log = options.log ?? process.stderr;
    log.write(`Synapsor Runner Streamable HTTP MCP listening on ${url}\n`);
    log.write(devNoAuth ? "Auth: disabled for localhost development only\n" : `Auth: bearer token from ${authTokenEnv}\n`);
    log.write(`Config: ${options.configPath ?? "synapsor.runner.json"}\n`);
    log.write(`Store: ${options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db"}\n`);
  }

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: () => closeStreamableHttpServer(server, openSessions),
  };
}

async function handleStreamableHttpMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  storePath?: string;
  readRow?: DbRowReader;
  cloudTools?: LocalToolMetadata[];
  env: NodeJS.ProcessEnv;
  toolNameStyle?: ToolNameStyle;
  resultFormat?: ResultFormat;
  authToken?: string;
  devNoAuth: boolean;
  corsOrigin?: string;
  sessions: Map<string, StreamableHttpSession>;
  openSessions: Set<StreamableHttpSession>;
}): Promise<void> {
  const { request, response, config, storePath, readRow, cloudTools, env, toolNameStyle, resultFormat, authToken, devNoAuth, corsOrigin, sessions, openSessions } = input;
  try {
    setCorsHeaders(response, corsOrigin);
    if (request.method === "OPTIONS" && corsOrigin) {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        transport: "streamable-http",
        sessions: sessions.size,
        tools: config.mode === "cloud" ? (cloudTools ?? []).length : listedLocalCapabilities(config).length,
        mode: config.mode,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!devNoAuth && !validBearerToken(request.headers.authorization, authToken ?? "")) {
      writeJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        writeJson(response, 404, jsonRpcError(null, -32000, "MCP session not found."));
        return;
      }
      await existing.transport.handleRequest(request, response);
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 400, jsonRpcError(null, -32000, "MCP initialize request is required before using this Streamable HTTP session."));
      return;
    }

    const parsedBody = JSON.parse(await readRequestBody(request)) as unknown;
    if (!containsInitializeRequest(parsedBody)) {
      writeJson(response, 400, jsonRpcError(requestIdFromPayload(parsedBody), -32000, "First Streamable HTTP MCP request must be initialize."));
      return;
    }

    let session: StreamableHttpSession | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        if (session) {
          session.sessionId = newSessionId;
          sessions.set(newSessionId, session);
        }
      },
      onsessionclosed: (closedSessionId) => {
        const closed = sessions.get(closedSessionId);
        if (closed) {
          disposeStreamableSession(closed, sessions, openSessions);
        }
      },
    });
    const runtime = createMcpRuntime(config, { env, storePath, resultFormat, readRow, cloudTools });
    session = { transport, runtime };
    openSessions.add(session);
    transport.onclose = () => {
      if (session) disposeStreamableSession(session, sessions, openSessions);
    };
    await createSynapsorMcpServer(runtime, { toolNameStyle }).connect(transport);
    await transport.handleRequest(request, response, parsedBody);
  } catch (error) {
    const message = sanitizeHttpError(error, authToken);
    if (!response.headersSent) writeJson(response, 200, jsonRpcError(null, -32000, message));
    else response.end();
  }
}

async function handleHttpMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  runtime: McpRuntime;
  authToken?: string;
  devNoAuth: boolean;
  corsOrigin?: string;
}): Promise<void> {
  const { request, response, runtime, authToken, devNoAuth, corsOrigin } = input;
  try {
    setCommonHttpHeaders(response, corsOrigin);
    if (request.method === "OPTIONS" && corsOrigin) {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        transport: "http",
        tools: runtime.listTools().length,
        mode: runtime.config.mode,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!devNoAuth && !validBearerToken(request.headers.authorization, authToken ?? "")) {
      writeJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const body = await readRequestBody(request);
    const payload = JSON.parse(body) as unknown;
    if (!isRecord(payload)) {
      writeJson(response, 400, jsonRpcError(null, -32600, "JSON-RPC request must be an object."));
      return;
    }
    const id = payload.id ?? null;
    const method = typeof payload.method === "string" ? payload.method : undefined;
    if (!method) {
      writeJson(response, 400, jsonRpcError(id, -32600, "JSON-RPC method is required."));
      return;
    }

    const result = await handleHttpJsonRpcMethod(runtime, method, isRecord(payload.params) ? payload.params : {});
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      result: sanitizeHttpPayload(result, authToken),
    });
  } catch (error) {
    const message = sanitizeHttpError(error, authToken);
    writeJson(response, 200, jsonRpcError(null, -32000, message));
  }
}

async function handleHttpJsonRpcMethod(
  runtime: McpRuntime,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (method === "tools/list") {
    return {
      tools: runtime.listTools().map(httpToolMetadata),
    };
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) throw new McpRuntimeError("HTTP_TOOL_NAME_REQUIRED", "tools/call requires params.name.");
    const args = isRecord(params.arguments) ? params.arguments : isRecord(params.args) ? params.args : {};
    return await toolCallResult(runtime, name, args);
  }
  if (method === "resources/read") {
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) throw new McpRuntimeError("HTTP_RESOURCE_URI_REQUIRED", "resources/read requires params.uri.");
    return resourceResult(uri, runtime.readResource);
  }
  throw new McpRuntimeError("HTTP_JSONRPC_METHOD_UNSUPPORTED", `Unsupported MCP HTTP method: ${method}`);
}

function httpToolMetadata(tool: LocalToolMetadata): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input_schema,
    annotations: {
      ...tool.annotations,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
    _meta: {
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.database_credentials_exposed": false,
      "synapsor.model_controlled_tenant_authority": false,
    },
  };
}

function validBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = header.slice("Bearer ".length);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function containsInitializeRequest(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some((message) => isInitializeRequest(message));
  return isInitializeRequest(payload);
}

function requestIdFromPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    const request = payload.find((message) => isRecord(message) && "id" in message);
    return isRecord(request) ? request.id ?? null : null;
  }
  return isRecord(payload) ? payload.id ?? null : null;
}

export function openaiToolNameAlias(canonicalName: string): string {
  const sanitized = canonicalName
    .replace(/[^A-Za-z0-9_-]+/g, "__")
    .replace(/_{3,}/g, "__")
    .replace(/^_+|_+$/g, "");
  const base = sanitized.length > 0 ? sanitized : `tool_${shortToolHash(canonicalName)}`;
  if (base.length <= 64) return base;
  const suffix = shortToolHash(canonicalName);
  return `${base.slice(0, Math.max(1, 63 - suffix.length)).replace(/_+$/g, "")}_${suffix}`;
}

export function toolNameExposures(canonicalNames: string[], style: ToolNameStyle): ToolNameExposure[] {
  const exposedNames = toolNameExposureMap(canonicalNames, style);
  return canonicalNames.flatMap((canonicalName) => {
    return (exposedNames.get(canonicalName) ?? [canonicalName]).map((exposedName) => ({
      canonicalName,
      exposedName,
      isAlias: exposedName !== canonicalName,
      style,
    }));
  });
}

function toolNameExposureMap(canonicalNames: string[], style: ToolNameStyle): Map<string, string[]> {
  const exposedByCanonical = new Map<string, string[]>();
  const canonicalByExposed = new Map<string, string>();
  if (style === "both") {
    for (const canonical of canonicalNames) canonicalByExposed.set(canonical, canonical);
  }
  for (const canonical of canonicalNames) {
    const names = new Set<string>();
    if (style === "canonical" || style === "both") names.add(canonical);
    if (style === "openai" || style === "both") {
      let alias = openaiToolNameAlias(canonical);
      const existing = canonicalByExposed.get(alias);
      if (existing && existing !== canonical) {
        const suffix = shortToolHash(canonical);
        alias = `${alias.slice(0, Math.max(1, 63 - suffix.length)).replace(/_+$/g, "")}_${suffix}`;
      }
      canonicalByExposed.set(alias, canonical);
      names.add(alias);
    }
    exposedByCanonical.set(canonical, [...names]);
  }
  return exposedByCanonical;
}

function shortToolHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function setCorsHeaders(response: ServerResponse, corsOrigin?: string): void {
  if (corsOrigin) {
    response.setHeader("access-control-allow-origin", corsOrigin);
    response.setHeader("access-control-allow-methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id");
  }
}

function setCommonHttpHeaders(response: ServerResponse, corsOrigin?: string): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (corsOrigin) {
    response.setHeader("access-control-allow-origin", corsOrigin);
    response.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) {
      throw new McpRuntimeError("HTTP_BODY_TOO_LARGE", "HTTP MCP request body exceeds 1 MiB.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function sanitizeHttpError(error: unknown, authToken?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeHttpString(raw, authToken);
}

function sanitizeHttpPayload(value: unknown, authToken?: string): unknown {
  if (typeof value === "string") return sanitizeHttpString(value, authToken);
  if (Array.isArray(value)) return value.map((item) => sanitizeHttpPayload(item, authToken));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeHttpPayload(item, authToken)]));
  }
  return value;
}

function sanitizeHttpString(value: string, authToken?: string): string {
  let redacted = value.replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s"']+/gi, "[redacted-database-url]");
  if (authToken) redacted = redacted.split(authToken).join("[redacted-token]");
  return redacted;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function closeHttpServer(server: Server, runtime: McpRuntime): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).finally(() => {
    runtime.close();
  });
}

async function closeStreamableHttpServer(server: Server, sessions: Set<StreamableHttpSession>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).finally(() => closeStreamableSessions(sessions));
}

async function closeStreamableSessions(sessions: Set<StreamableHttpSession>): Promise<void> {
  for (const session of [...sessions]) {
    sessions.delete(session);
    await session.transport.close().catch(() => undefined);
    disposeStreamableSession(session);
  }
}

function disposeStreamableSession(
  session: StreamableHttpSession,
  sessionMap?: Map<string, StreamableHttpSession>,
  openSessions?: Set<StreamableHttpSession>,
): void {
  if (session.closed) return;
  session.closed = true;
  if (session.sessionId) sessionMap?.delete(session.sessionId);
  openSessions?.delete(session);
  session.runtime.close();
}

async function toolCallResult(runtime: McpRuntime, toolName: string, args: Record<string, unknown>) {
  try {
    const structuredContent = await runtime.callTool(toolName, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    const payload = toolErrorPayload(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
}

function localCapabilities(config: RuntimeConfig): RuntimeCapabilityConfig[] {
  return Array.isArray(config.capabilities) ? config.capabilities : [];
}

function listedLocalCapabilities(config: RuntimeConfig): RuntimeCapabilityConfig[] {
  const capabilities = localCapabilities(config);
  if (config.mode === "read_only") return capabilities.filter((capability) => capability.kind === "read");
  return capabilities;
}

function createCloudClient(config: RuntimeConfig, env: NodeJS.ProcessEnv): ControlPlaneClient {
  const cloud = requireCloudConfig(config);
  const baseUrl = envValue(env, cloud.base_url_env);
  const runnerToken = envValue(env, cloud.runner_token_env);
  if (!baseUrl) throw new McpRuntimeError("CLOUD_BASE_URL_MISSING", `${cloud.base_url_env} is not set.`);
  if (!runnerToken) throw new McpRuntimeError("CLOUD_RUNNER_TOKEN_MISSING", `${cloud.runner_token_env} is not set.`);
  return new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId: cloud.source_id,
  });
}

async function fetchCloudToolMetadata(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  client: CloudAdapterClient = createCloudClient(config, env),
): Promise<LocalToolMetadata[]> {
  const cloud = requireCloudConfig(config);
  const catalog = await client.adapterTools(cloud.adapter_id, { session: cloud.session ?? {} });
  return catalog.tools.map((tool) => cloudToolMetadata(tool));
}

async function callCloudTool(
  config: RuntimeConfig,
  client: CloudAdapterClient | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cloud = requireCloudConfig(config);
  if (!client) throw new McpRuntimeError("CLOUD_CLIENT_UNAVAILABLE", "Cloud mode requires a configured Synapsor Cloud client.");
  const result = await client.callAdapterTool(cloud.adapter_id, name, args, {
    session: cloud.session ?? {},
  });
  return {
    mode: "cloud",
    adapter_id: cloud.adapter_id,
    tool_name: name,
    source_database_mutated: false,
    ...result.response,
  };
}

function requireCloudConfig(config: RuntimeConfig): NonNullable<RuntimeConfig["cloud"]> {
  if (!config.cloud) {
    throw new McpRuntimeError("CLOUD_CONFIG_REQUIRED", "cloud mode requires a cloud config block.");
  }
  return config.cloud;
}

function cloudToolMetadata(tool: AdapterToolCatalogEntry): LocalToolMetadata {
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "Synapsor Cloud-reviewed MCP database capability.",
    kind: tool.annotations?.readOnlyHint === true ? "read" : "proposal",
    input_schema: tool.input_schema ?? { type: "object", properties: {} },
    annotations: {
      ...tool.annotations,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
  };
}

function toolDescriptionWithCanonical(description: string, canonicalName: string, exposedName?: string): string {
  if (!exposedName || exposedName === canonicalName) return description;
  return `Canonical Synapsor capability: ${canonicalName}.\n${description}`;
}

function zodInputShapeFromJsonSchema(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = isRecord(rawProperty) ? rawProperty : {};
    let valueSchema: z.ZodTypeAny;
    if (property.type === "number" || property.type === "integer") valueSchema = z.number();
    else if (property.type === "boolean") valueSchema = z.boolean();
    else if (Array.isArray(property.enum)) {
      const allowed = property.enum.map((item) => scalar(item));
      valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]).refine((value) => allowed.includes(value), "value is not allowlisted");
    } else valueSchema = z.string();
    if (!required.has(name)) valueSchema = valueSchema.optional();
    shape[name] = valueSchema.describe(typeof property.description === "string" ? property.description : `${name} argument`);
  }
  return shape;
}

async function callConfiguredTool(input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  name: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  rejectTrustedArgOverrides(input.args);
  if (input.config.mode === "cloud") {
    return callCloudTool(input.config, input.cloudClient, input.name, input.args);
  }
  const capability = localCapabilities(input.config).find((item) => item.name === input.name);
  if (!capability) throw new McpRuntimeError("MCP_TOOL_NOT_FOUND", `Unknown Synapsor tool: ${input.name}`);
  validateToolArgs(capability, input.args);

  if (capability.kind === "proposal" && input.config.mode === "read_only") {
    throw new McpRuntimeError("PROPOSALS_DISABLED", "This runner is in read_only mode; proposal tools are disabled.");
  }
  if (capability.kind === "proposal" && input.config.mode === "review") {
    assertProposalWritebackResolvable(input.config, capability);
  }
  const source = input.config.sources?.[capability.source];
  if (!source) throw new McpRuntimeError("SOURCE_NOT_FOUND", `Unknown source: ${capability.source}`);
  const context = resolveTrustedContext(input.config, input.env, capability);
  const current = await input.readRow({
    sourceName: capability.source,
    source,
    capability,
    args: input.args,
    context,
    env: input.env,
  });
  if (current.rowCount !== 1) {
    throw new McpRuntimeError("ROW_NOT_FOUND", "The scoped capability read did not find exactly one authorized row.");
  }

  const evidenceBundleId = stableId("ev", {
    capability: capability.name,
    source: capability.source,
    tenant: context.tenant_id,
    row: current.row,
    at: new Date().toISOString(),
  });
  const queryFingerprint = queryFingerprintFor(capability, context);
  const objectId = String(current.row[capability.target.primary_key] ?? input.args[capability.lookup.id_from_arg]);
  input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    tenant_id: context.tenant_id,
    payload: {
      capability: capability.name,
      source_id: capability.source,
      target: `${capability.target.schema}.${capability.target.table}`,
      principal: context.principal,
      tenant_id: context.tenant_id,
      source_database_changed: false,
      binding_provenance: context.provenance,
    },
    items: [
      {
        kind: "external_row",
        source_id: capability.source,
        table: `${capability.target.schema}.${capability.target.table}`,
        primary_key: { column: capability.target.primary_key, value: objectId },
        tenant: capability.target.tenant_key ? { column: capability.target.tenant_key, value: context.tenant_id } : undefined,
        visible_row: scalarRecord(current.row),
      },
    ],
  });
  input.store.recordQueryAudit({
    evidence_bundle_id: evidenceBundleId,
    source_id: capability.source,
    query_fingerprint: queryFingerprint,
    table_name: `${capability.target.schema}.${capability.target.table}`,
    row_count: current.rowCount,
    payload: {
      capability: capability.name,
      columns: capability.visible_columns,
      tenant_bound: Boolean(capability.target.tenant_key),
      statement_template: selectTemplate(capability),
      parameters_redacted: true,
    },
  });

  if (capability.kind === "read") {
    return {
      status: "ok",
      action: capability.name,
      mode: input.config.mode,
      business_object: {
        type: capability.target.table,
        id: objectId,
      },
      data: scalarRecord(current.row),
      trusted_context: {
        tenant_id: context.tenant_id,
        principal: context.principal,
        provenance: context.provenance,
      },
      evidence_bundle_id: evidenceBundleId,
      evidence_resource: `synapsor://evidence/${evidenceBundleId}`,
      source_database_changed: false,
      source_database_mutated: false,
    };
  }

  const changeSet = buildChangeSet({
    config: input.config,
    capability,
    args: input.args,
    context,
    sourceName: capability.source,
    source,
    currentRow: current.row,
    evidenceBundleId,
    queryFingerprint,
    objectId,
  });
  const proposal = input.store.createProposal(changeSet);
  input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    proposal_id: proposal.proposal_id,
    tenant_id: context.tenant_id,
    payload: {
      capability: capability.name,
      proposal_id: proposal.proposal_id,
      source_database_changed: false,
      approval_status: changeSet.approval.status,
    },
    items: [
      {
        kind: "proposal_evidence",
        before: changeSet.before,
        patch: changeSet.patch,
        after: changeSet.after,
      },
    ],
  });
  input.store.recordQueryAudit({
    proposal_id: proposal.proposal_id,
    evidence_bundle_id: evidenceBundleId,
    source_id: capability.source,
    query_fingerprint: queryFingerprint,
    table_name: `${capability.target.schema}.${capability.target.table}`,
    row_count: current.rowCount,
    payload: {
      capability: capability.name,
      statement_template: selectTemplate(capability),
      parameters_redacted: true,
    },
  });

  return {
    status: input.config.mode === "shadow" ? "shadow_proposal_created" : "review_required",
    action: capability.name,
    proposal_id: proposal.proposal_id,
    proposal_version: proposal.proposal_version,
    proposal_hash: proposal.proposal_hash,
    target: {
      type: capability.target.table,
      id: objectId,
      tenant_id: context.tenant_id,
    },
    diff: diffFromChangeSet(changeSet),
    evidence_bundle_id: evidenceBundleId,
    evidence_resource: `synapsor://evidence/${evidenceBundleId}`,
    proposal_resource: `synapsor://proposals/${proposal.proposal_id}`,
    replay_resource: `synapsor://replay/replay_${proposal.proposal_id}`,
    approval_required: true,
    writeback: changeSet.writeback,
    source_database_changed: false,
    source_database_mutated: false,
  };
}

async function callConfiguredToolV2(input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  name: string;
  args: Record<string, unknown>;
}): Promise<ResultEnvelopeV2> {
  const capability = input.config.mode === "cloud"
    ? undefined
    : localCapabilities(input.config).find((item) => item.name === input.name);
  try {
    const legacy = await callConfiguredTool(input);
    return resultEnvelopeFromLegacy(legacy, capability, input.name);
  } catch (error) {
    return errorEnvelopeFromError(error, capability, input.name);
  }
}

function resultEnvelopeFromLegacy(
  legacy: Record<string, unknown>,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
): ResultEnvelopeV2 {
  const action = typeof legacy.action === "string" ? legacy.action : canonicalName;
  const kind: CapabilityKind = capability?.kind ?? (typeof legacy.proposal_id === "string" ? "proposal" : "read");
  const evidenceBundleId = typeof legacy.evidence_bundle_id === "string" ? legacy.evidence_bundle_id : undefined;
  const sourceChanged = Boolean(legacy.source_database_changed ?? legacy.source_database_mutated ?? false);
  const context = isRecord(legacy.trusted_context) ? legacy.trusted_context : undefined;
  const target = isRecord(legacy.target) ? legacy.target : undefined;

  if (kind === "proposal") {
    const proposalId = typeof legacy.proposal_id === "string" ? legacy.proposal_id : "wrp_unknown";
    const targetType = typeof target?.type === "string" ? target.type : capability?.target.table ?? "object";
    const targetId = target?.id !== undefined ? String(target.id) : "unknown";
    const executor = writebackExecutorName(legacy.writeback);
    const writebackMode = executor === "read_only" || executor === "none"
      ? "proposal_only"
      : executor && executor !== "sql_update" && executor !== "trusted_worker_required"
        ? "app_handler"
        : "direct_update";
    return {
      ok: true,
      summary: `Created proposal ${proposalId} for ${targetType} ${targetId}. Source database changed: no.`,
      action,
      kind,
      data: null,
      proposal: {
        id: proposalId,
        state: typeof legacy.status === "string" ? legacy.status : "review_required",
        target: `${targetType}:${targetId}`,
        diff: isRecord(legacy.diff) ? legacy.diff : {},
        approval_required: legacy.approval_required !== false,
        writeback: {
          mode: writebackMode,
          applied: false,
        },
        next: "A human must approve outside this model-facing tool surface; nothing is committed yet.",
      },
      error: null,
      evidence: evidenceBundleId ? evidenceHandle(evidenceBundleId) : null,
      source_database_changed: sourceChanged,
      _meta: {
        tenant_id: typeof target?.tenant_id === "string" ? target.tenant_id : undefined,
        principal: typeof context?.principal === "string" ? context.principal : undefined,
        provenance: typeof context?.provenance === "string" ? context.provenance : undefined,
        canonical_capability: action,
      },
    };
  }

  const businessObject = isRecord(legacy.business_object) ? legacy.business_object : undefined;
  const objectType = typeof businessObject?.type === "string" ? businessObject.type : capability?.target.table ?? "record";
  const objectId = businessObject?.id !== undefined ? String(businessObject.id) : String(legacy.action ?? action);
  return {
    ok: true,
    summary: `Read ${objectType} ${objectId} through ${action}. Source database changed: no.`,
    action,
    kind: "read",
    data: isRecord(legacy.data) ? legacy.data : {},
    proposal: null,
    error: null,
    evidence: evidenceBundleId ? evidenceHandle(evidenceBundleId) : null,
    source_database_changed: sourceChanged,
    _meta: {
      tenant_id: typeof context?.tenant_id === "string" ? context.tenant_id : undefined,
      principal: typeof context?.principal === "string" ? context.principal : undefined,
      provenance: typeof context?.provenance === "string" ? context.provenance : undefined,
      canonical_capability: action,
    },
  };
}

function writebackExecutorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.executor === "string" ? value.executor : typeof value.mode === "string" ? value.mode : undefined;
}

export function capabilityWritebackMode(capability: RuntimeCapabilityConfig): RuntimeWritebackMode {
  const mode = capability.writeback?.mode;
  if (mode === "direct_sql" || mode === "app_handler" || mode === "cloud_worker" || mode === "none") return mode;
  if (capability.executor && capability.executor !== "sql_update") return "app_handler";
  return "direct_sql";
}

export function capabilityWritebackExecutor(capability: RuntimeCapabilityConfig): string | undefined {
  return capability.writeback?.executor ?? capability.executor;
}

export function assertProposalWritebackResolvable(config: RuntimeConfig, capability: RuntimeCapabilityConfig): void {
  if (capability.kind !== "proposal") return;
  const mode = capabilityWritebackMode(capability);
  if (mode === "none" || mode === "cloud_worker") return;
  if (mode === "direct_sql") {
    const source = config.sources?.[capability.source];
    if (!source) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} is not configured.`);
    }
    if (source.read_only === true) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} is read-only.`);
    }
    if (!source.write_url_env) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} has no write_url_env.`);
    }
    return;
  }
  const executorName = capabilityWritebackExecutor(capability);
  if (!executorName || executorName === "sql_update") {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but has no executor name.`);
  }
  const executor = config.executors?.[executorName];
  if (!isRecord(executor)) {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but executor ${executorName} is not configured.`);
  }
  if (executor.type !== "http_handler" && executor.type !== "command_handler") {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but executor ${executorName} is not an app-owned handler.`);
  }
}

function evidenceHandle(bundleId: string): ResultEnvelopeV2["evidence"] {
  return {
    bundle_id: bundleId,
    note: "audit/replay handle; you do not need to act on it during this turn",
  };
}

function errorEnvelopeFromError(
  error: unknown,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
): ResultEnvelopeV2 {
  const safe = safeToolError(error);
  const action = capability?.name ?? canonicalName;
  return {
    ok: false,
    summary: safe.message,
    action,
    kind: capability?.kind ?? "read",
    data: null,
    proposal: null,
    error: safe,
    evidence: null,
    source_database_changed: false,
    _meta: {
      canonical_capability: action,
    },
  };
}

function safeToolError(error: unknown): NonNullable<ResultEnvelopeV2["error"]> {
  const runtimeCode = error instanceof McpRuntimeError ? error.code : undefined;
  if (runtimeCode === "ROW_NOT_FOUND") {
    return { code: "NOT_FOUND_IN_TENANT", message: "No authorized row was found in the trusted tenant scope.", retryable: false };
  }
  if (runtimeCode === "MCP_TOOL_NOT_FOUND") {
    return { code: "CAPABILITY_NOT_FOUND", message: "The requested Synapsor capability is not available.", retryable: false };
  }
  if (runtimeCode === "PROPOSALS_DISABLED") {
    return { code: "APPROVAL_REQUIRED", message: "Proposal tools are disabled for this runner mode.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("ARGUMENT_")
    || runtimeCode === "LOOKUP_ARG_MISSING"
    || runtimeCode === "MODEL_CANNOT_OVERRIDE_BINDING"
    || runtimeCode === "TRUSTED_BINDING_MISSING"
    || runtimeCode === "TRUSTED_CONTEXT_MISSING"
  )) {
    return { code: "INVALID_ARGUMENT", message: "The tool input or trusted context binding is invalid.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("PATCH_")
    || runtimeCode === "CONFLICT_GUARD_MISSING"
  )) {
    return { code: "POLICY_VIOLATION", message: "The requested change is outside the reviewed capability policy.", retryable: false };
  }
  if (runtimeCode === "LOCAL_STORE_UNAVAILABLE") {
    return { code: "TEMPORARILY_UNAVAILABLE", message: "The local runner store is temporarily unavailable. Restart the runner or recreate the store before retrying.", retryable: true };
  }
  if (runtimeCode === "SOURCE_CREDENTIAL_MISSING" || looksLikeInfraError(error)) {
    return { code: "TEMPORARILY_UNAVAILABLE", message: "The database is temporarily unavailable. Retry later.", retryable: true };
  }
  return { code: "INTERNAL", message: "The capability failed safely. Check the local runner logs for details.", retryable: false };
}

function looksLikeInfraError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|connect|connection|database|authentication|certificate)\b/i.test(message);
}

function buildChangeSet(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  args: Record<string, unknown>;
  context: TrustedContext;
  sourceName: string;
  source: RuntimeSourceConfig;
  currentRow: Record<string, unknown>;
  evidenceBundleId: string;
  queryFingerprint: string;
  objectId: string;
}): ChangeSetV1 {
  const patch = buildPatch(input.capability, input.args);
  const before = scalarRecord(input.currentRow);
  enforcePatchGuards(input.capability, before, patch);
  const after = { ...before, ...patch };
  const guard = expectedVersionGuard(input.capability, before);
  const writebackMode = capabilityWritebackMode(input.capability);
  const changeSetWritebackMode = writebackMode === "none" ? "read_only" : "trusted_worker_required";
  const writebackExecutor = writebackMode === "none"
    ? "none"
    : writebackMode === "cloud_worker"
      ? "cloud_worker"
      : writebackMode === "direct_sql"
        ? "sql_update"
        : capabilityWritebackExecutor(input.capability);
  const proposalCore = {
    schema_version: protocolVersions.changeSet,
    proposal_id: stableId("wrp", {
      action: input.capability.name,
      tenant: input.context.tenant_id,
      object: input.objectId,
      before,
      patch,
    }),
    proposal_version: 1,
    action: input.capability.name,
    mode: input.config.mode === "shadow" ? "shadow" : "review_required",
    principal: {
      id: input.context.principal,
      source: input.context.provenance === "environment" ? "environment" : input.context.provenance === "cloud_session" ? "cloud_session" : input.context.provenance === "static_dev" ? "static_dev" : "trusted_session",
    },
    scope: {
      tenant_id: input.context.tenant_id,
      business_object: input.capability.target.table,
      object_id: input.objectId,
    },
    source: {
      kind: input.source.engine === "postgres" ? "external_postgres" : "external_mysql",
      source_id: input.sourceName,
      schema: input.capability.target.schema,
      table: input.capability.target.table,
      primary_key: { column: input.capability.target.primary_key, value: scalar(input.currentRow[input.capability.target.primary_key] ?? input.objectId) },
    },
    before,
    patch,
    after,
    guards: {
      tenant: { column: input.capability.target.tenant_key ?? "__single_tenant_dev", value: input.capability.target.tenant_key ? input.context.tenant_id : "single_tenant_dev" },
      allowed_columns: input.capability.allowed_columns ?? Object.keys(patch),
      expected_version: guard,
    },
    evidence: {
      bundle_id: input.evidenceBundleId,
      query_fingerprint: input.queryFingerprint,
      items: [],
    },
    approval: {
      status: "pending",
      required_role: input.capability.approval?.required_role,
    },
    writeback: {
      status: "not_applied",
      mode: changeSetWritebackMode,
      executor: writebackExecutor,
    },
    source_database_mutated: false,
    created_at: new Date().toISOString(),
  } satisfies Omit<ChangeSetV1, "integrity">;

  return {
    ...proposalCore,
    integrity: { proposal_hash: hashJson(proposalCore) },
  };
}

function expectedVersionGuard(capability: RuntimeCapabilityConfig, row: Record<string, Scalar>): { column: string; value: Scalar } {
  const column = capability.conflict_guard?.column;
  if (column && row[column] !== undefined) return { column, value: row[column] };
  if (capability.conflict_guard?.weak_guard_ack === true) {
    return { column: "__row_hash", value: hashJson(row) };
  }
  throw new McpRuntimeError("CONFLICT_GUARD_MISSING", "Proposal capability must read a configured conflict guard column.");
}

async function readCurrentRow(input: {
  sourceName: string;
  source: RuntimeSourceConfig;
  capability: RuntimeCapabilityConfig;
  args: Record<string, unknown>;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
}): Promise<{ row: Record<string, unknown>; rowCount: number }> {
  if (input.source.engine === "postgres") return readPostgresRow(input);
  return readMysqlRow(input);
}

async function readPostgresRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rowCount: number }> {
  const connectionString = envValue(input.env, input.source.read_url_env);
  if (!connectionString) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const query = buildSelect(input.capability, "$");
    await client.query("BEGIN");
    if (input.source.statement_timeout_ms) {
      await client.query(`SET LOCAL statement_timeout = ${Number(input.source.statement_timeout_ms)}`);
    }
    const result = await client.query(query.sql, queryValues(input.capability, input.args, input.context));
    await client.query("COMMIT");
    return { row: result.rows[0] ?? {}, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function readMysqlRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rowCount: number }> {
  const uri = envValue(input.env, input.source.read_url_env);
  if (!uri) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
  const connection = await mysql.createConnection({ uri, dateStrings: true });
  try {
    if (input.source.statement_timeout_ms) {
      await connection.query("SET SESSION max_execution_time = ?", [Number(input.source.statement_timeout_ms)]).catch(() => undefined);
    }
    const query = buildSelect(input.capability, "?");
    const values: Array<string | number | boolean | null> = queryValues(input.capability, input.args, input.context).map(scalar);
    const [rows] = await connection.execute(query.sql, values);
    const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
    return { row: list[0] ?? {}, rowCount: list.length };
  } finally {
    await connection.end();
  }
}

function buildSelect(capability: RuntimeCapabilityConfig, placeholderStyle: "$" | "?"): { sql: string } {
  const columns = readColumns(capability).map((column) => quoteIdentifier(column, placeholderStyle)).join(", ");
  const placeholders = placeholderStyle === "$" ? ["$1", "$2"] : ["?", "?"];
  const where = [
    `${quoteIdentifier(capability.target.primary_key, placeholderStyle)} = ${placeholders[0]}`,
  ];
  if (capability.target.tenant_key) {
    where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholders[1]}`);
  }
  const sql = `SELECT ${columns} FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} WHERE ${where.join(" AND ")} LIMIT ${Math.max(1, capability.max_rows ?? 1)}`;
  return { sql };
}

function queryValues(capability: RuntimeCapabilityConfig, args: Record<string, unknown>, context: TrustedContext): unknown[] {
  const pkValue = args[capability.lookup.id_from_arg];
  if (pkValue === undefined) throw new McpRuntimeError("LOOKUP_ARG_MISSING", `${capability.lookup.id_from_arg} is required.`);
  return capability.target.tenant_key ? [pkValue, context.tenant_id] : [pkValue];
}

function readColumns(capability: RuntimeCapabilityConfig): string[] {
  const columns = new Set(capability.visible_columns);
  columns.add(capability.target.primary_key);
  if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
  if (capability.conflict_guard?.column) columns.add(capability.conflict_guard.column);
  return Array.from(columns);
}

function quoteIdentifier(identifier: string, style: "$" | "?"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new McpRuntimeError("UNSAFE_IDENTIFIER", `Unsafe identifier: ${identifier}`);
  return style === "$" ? `"${identifier}"` : `\`${identifier}\``;
}

function resolveTrustedContext(config: RuntimeConfig, env: NodeJS.ProcessEnv, capability?: RuntimeCapabilityConfig): TrustedContext {
  const namedContext = capability?.context ? config.contexts?.[capability.context] : undefined;
  const contextConfig = namedContext ?? config.trusted_context;
  if (!contextConfig) {
    throw new McpRuntimeError("TRUSTED_CONTEXT_MISSING", capability?.context
      ? `Capability ${capability.name} references missing trusted context ${capability.context}.`
      : "No trusted_context is configured for this capability.");
  }
  const provider = contextConfig.provider;
  const values = contextConfig.values ?? {};
  if (provider === "environment") {
    const tenantEnv = String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
    const principalEnv = String(values.principal_env ?? "SYNAPSOR_PRINCIPAL");
    const tenant = envValue(env, tenantEnv);
    const principal = envValue(env, principalEnv);
    if (!tenant || !principal) throw new McpRuntimeError("TRUSTED_BINDING_MISSING", `${tenantEnv} and ${principalEnv} must be set.`);
    return { tenant_id: tenant, principal, provenance: "environment" };
  }
  if (provider === "static_dev") {
    const tenant = valueFromEnvOrLiteral(values.tenant_id_env, values.tenant_id, env);
    const principal = valueFromEnvOrLiteral(values.principal_env, values.principal, env);
    if (!tenant || !principal) throw new McpRuntimeError("TRUSTED_BINDING_MISSING", "static_dev trusted_context requires tenant_id/principal values or env bindings.");
    return { tenant_id: tenant, principal, provenance: "static_dev" };
  }
  throw new McpRuntimeError("TRUSTED_CONTEXT_UNSUPPORTED", `${provider} trusted context is not available in local stdio mode.`);
}

function valueFromEnvOrLiteral(envName: unknown, literal: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof envName === "string") {
    const value = envValue(env, envName);
    if (value) return value;
  }
  if (typeof literal !== "string") return undefined;
  const value = literal.trim();
  return value.length > 0 ? value : undefined;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateToolArgs(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(capability.args)) {
    const value = args[name];
    if (spec.required !== false && value === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${name} is required.`);
    if (value === undefined) continue;
    if (spec.type === "string" && typeof value !== "string") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a string.`);
    if (spec.type === "number" && typeof value !== "number") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a number.`);
    if (spec.type === "boolean" && typeof value !== "boolean") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a boolean.`);
    if (typeof value === "string" && spec.max_length && value.length > spec.max_length) throw new McpRuntimeError("ARGUMENT_TOO_LONG", `${name} is longer than ${spec.max_length}.`);
    if (typeof value === "number" && spec.minimum !== undefined && value < spec.minimum) throw new McpRuntimeError("ARGUMENT_BELOW_MINIMUM", `${name} must be at least ${spec.minimum}.`);
    if (typeof value === "number" && spec.maximum !== undefined && value > spec.maximum) throw new McpRuntimeError("ARGUMENT_ABOVE_MAXIMUM", `${name} must be at most ${spec.maximum}.`);
    if (spec.enum && !spec.enum.includes(value as Scalar)) throw new McpRuntimeError("ARGUMENT_NOT_ALLOWED", `${name} is not an allowed value.`);
  }
}

function rejectTrustedArgOverrides(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (RESERVED_MODEL_ARGS.has(key)) {
      throw new McpRuntimeError("MODEL_CANNOT_OVERRIDE_BINDING", `${key} is trusted context and cannot be supplied as a model argument.`);
    }
  }
}

function zodInputShape(capability: RuntimeCapabilityConfig): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(capability.args)) {
    let schema: z.ZodTypeAny = spec.type === "number" ? z.number() : spec.type === "boolean" ? z.boolean() : z.string();
    if (spec.type === "string" && spec.max_length) schema = (schema as z.ZodString).max(spec.max_length);
    if (spec.type === "number" && spec.minimum !== undefined) schema = (schema as z.ZodNumber).min(spec.minimum);
    if (spec.type === "number" && spec.maximum !== undefined) schema = (schema as z.ZodNumber).max(spec.maximum);
    if (spec.enum && spec.enum.length > 0) schema = schema.refine((value) => spec.enum?.includes(value as Scalar), "value is not allowlisted");
    if (spec.required === false) schema = schema.optional();
    shape[name] = schema.describe(spec.description ?? `${name} business argument`);
  }
  return shape;
}

function toolMetadata(capability: RuntimeCapabilityConfig): LocalToolMetadata {
  return {
    name: capability.name,
    title: capability.name,
    description: capabilityDescription(capability),
    kind: capability.kind,
    input_schema: Object.fromEntries(Object.entries(capability.args).map(([name, spec]) => [name, {
      type: spec.type,
      required: spec.required !== false,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.max_length !== undefined ? { max_length: spec.max_length } : {}),
      ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
      ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {}),
      ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
    }])),
    annotations: {
      readOnlyHint: capability.kind === "read",
      destructiveHint: false,
      idempotentHint: capability.kind === "read",
      openWorldHint: false,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
  };
}

function capabilityDescription(capability: RuntimeCapabilityConfig, exposedName?: string): string {
  const lines: string[] = [];
  if (exposedName && exposedName !== capability.name) {
    lines.push(`Canonical Synapsor capability: ${capability.name}.`);
  }
  if (capability.description) {
    lines.push(capability.description);
  } else if (capability.kind === "read") {
    lines.push(`Read ${capability.target.schema}.${capability.target.table} through a reviewed Synapsor capability with trusted tenant context and evidence.`);
  } else {
    lines.push(`Create an evidence-backed Synapsor proposal for ${capability.target.schema}.${capability.target.table}; the source database is not mutated by this tool.`);
  }
  if (capability.returns_hint) {
    lines.push(capability.returns_hint);
  }
  lines.push("Evidence handles are audit/replay handles; the model does not need to call them during this turn.");
  return lines.join("\n");
}

function buildPatch(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): Record<string, Scalar> {
  if (!capability.patch) throw new McpRuntimeError("PATCH_REQUIRED", "Proposal capability has no patch mapping.");
  const patch: Record<string, Scalar> = {};
  for (const [column, binding] of Object.entries(capability.patch)) {
    if (binding.from_arg) patch[column] = scalar(args[binding.from_arg]);
    else patch[column] = scalar(binding.fixed ?? null);
  }
  return patch;
}

function enforcePatchGuards(
  capability: RuntimeCapabilityConfig,
  before: Record<string, Scalar>,
  patch: Record<string, Scalar>,
): void {
  for (const [column, bounds] of Object.entries(capability.numeric_bounds ?? {})) {
    if (!(column in patch)) continue;
    const proposed = patch[column];
    if (typeof proposed !== "number") {
      throw new McpRuntimeError("PATCH_NUMERIC_BOUND_TYPE_INVALID", `${column} must be numeric to use numeric_bounds.`);
    }
    if (bounds.minimum !== undefined && proposed < bounds.minimum) {
      throw new McpRuntimeError("PATCH_BELOW_MINIMUM", `${column} must be at least ${bounds.minimum}.`);
    }
    if (bounds.maximum !== undefined && proposed > bounds.maximum) {
      throw new McpRuntimeError("PATCH_ABOVE_MAXIMUM", `${column} must be at most ${bounds.maximum}.`);
    }
  }

  for (const [column, guard] of Object.entries(capability.transition_guards ?? {})) {
    if (!(column in patch)) continue;
    const fromColumn = guard.from_column ?? column;
    const current = before[fromColumn];
    const proposed = patch[column];
    if (typeof current !== "string" || typeof proposed !== "string") {
      throw new McpRuntimeError("PATCH_TRANSITION_TYPE_INVALID", `${column} transition guard requires string current and proposed values.`);
    }
    const allowed = guard.allowed[current] ?? [];
    if (!allowed.includes(proposed)) {
      throw new McpRuntimeError("PATCH_TRANSITION_NOT_ALLOWED", `${column} cannot transition from ${current} to ${proposed}.`);
    }
  }
}

function diffFromChangeSet(changeSet: ChangeSetV1): Record<string, { before: Scalar; proposed: Scalar }> {
  const diff: Record<string, { before: Scalar; proposed: Scalar }> = {};
  for (const column of Object.keys(changeSet.patch)) {
    diff[column] = {
      before: changeSet.before[column] ?? null,
      proposed: changeSet.after[column] ?? null,
    };
  }
  return diff;
}

function readLocalResource(store: ProposalStore, uri: string): Record<string, unknown> {
  const parsed = new URL(uri);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const collection = parsed.hostname;
  const id = parts[0];
  if (!id) throw new McpRuntimeError("RESOURCE_ID_MISSING", `Resource id missing in ${uri}.`);
  if (collection === "proposals") {
    const proposal = store.getProposal(id);
    if (!proposal) throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Proposal not found: ${id}`);
    return { proposal, events: store.events(id), receipts: store.receipts(id) };
  }
  if (collection === "evidence") {
    const evidence = store.getEvidenceBundle(id);
    if (!evidence) throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Evidence bundle not found: ${id}`);
    return evidence;
  }
  if (collection === "replay") {
    const proposalId = id.startsWith("replay_") ? id.slice("replay_".length) : id;
    return store.replay(proposalId);
  }
  throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Unsupported Synapsor resource: ${uri}`);
}

function resourceResult(uri: string, reader: (uri: string) => Record<string, unknown>) {
  const payload = reader(uri);
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function queryFingerprintFor(capability: RuntimeCapabilityConfig, context: TrustedContext): string {
  return hashJson({
    source: capability.source,
    target: capability.target,
    columns: readColumns(capability),
    tenant_bound: Boolean(capability.target.tenant_key),
    tenant: context.tenant_id,
  });
}

function selectTemplate(capability: RuntimeCapabilityConfig): string {
  const where = capability.target.tenant_key
    ? `${capability.target.primary_key} = ? AND ${capability.target.tenant_key} = ?`
    : `${capability.target.primary_key} = ?`;
  return `SELECT ${readColumns(capability).join(", ")} FROM ${capability.target.schema}.${capability.target.table} WHERE ${where} LIMIT ${capability.max_rows ?? 1}`;
}

function scalarRecord(row: Record<string, unknown>): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scalar(value)]));
}

function scalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  return String(value);
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 20)}`;
}

function hashJson(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpRuntimeError) {
    if (error.code === "LOCAL_STORE_UNAVAILABLE") {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE", error: "The local runner store is temporarily unavailable. Restart the runner or recreate the store before retrying." };
    }
    return { ok: false, code: error.code, error: error.message };
  }
  return { ok: false, code: "MCP_TOOL_FAILED", error: error instanceof Error ? error.message : String(error) };
}
