import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
import { createPostgresPool } from "@synapsor-runner/postgres";
import { PostgresProposalRuntimeStore, ProposalStore, ProposalStoreError, type ProposalRuntimeStore, type StoredProposal } from "@synapsor-runner/proposal-store";
import { protocolVersions, type ChangeSetV1 } from "@synapsor-runner/protocol";
import { isNumericProposalField, normalizeContract, type AgentContextSpec, type CapabilitySpec, type PolicySpec, type ProposalActionSpec, type ResourceSpec, type SynapsorContract } from "@synapsor/spec";
import mysql from "mysql2/promise";
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
  approval?: { mode?: "human" | "policy" | string; required_role?: string; policy?: string };
  writeback?: { mode: RuntimeWritebackMode; executor?: string };
};

export type RuntimeConfig = {
  version: 1;
  mode: RunnerMode;
  result_format?: ResultFormat;
  contracts?: string[];
  policies?: PolicySpec[];
  approvals?: { disable_auto_approval?: boolean };
  operator_identity?: {
    provider: "dev_env" | "signed_key";
    actor_env?: string;
    roles_env?: string;
    apply_roles?: string[];
    operators?: Record<string, { public_key_path: string; roles: string[] }>;
  };
  session_auth?: {
    provider: "jwt_hs256";
    secret_env: string;
    previous_secret_env?: string;
    issuer?: string;
    audience?: string;
    tenant_claim?: string;
    principal_claim?: string;
    clock_skew_seconds?: number;
  };
  storage?: {
    sqlite_path?: string;
    shared_postgres?: {
      mode: "mirror" | "runtime_store" | "disabled";
      url_env: string;
      schema?: string;
      lock_timeout_ms?: number;
    };
  };
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
  store?: ProposalRuntimeStore;
  storePath?: string;
  resultFormat?: ResultFormat;
  readRow?: DbRowReader;
  controlPlaneClient?: CloudAdapterClient;
  cloudTools?: LocalToolMetadata[];
  trustedContext?: TrustedContext;
};

export type McpRuntime = {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  listTools(): LocalToolMetadata[];
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  readResource(uri: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
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
  tls?: StreamableHttpTlsOptions;
};

export type HttpMcpServerHandle = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export type StreamableHttpTlsOptions = {
  cert: string;
  key: string;
  ca?: string;
  requestClientCert?: boolean;
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
  | "PROPOSAL_ALREADY_EXISTS"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL";

type StreamableHttpSession = {
  transport: StreamableHTTPServerTransport;
  runtime: McpRuntime;
  sessionId?: string;
  authFingerprint: string;
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
  const seenPolicies = new Map<string, string>();
  for (const [index, capability] of (config.capabilities ?? []).entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `embedded capabilities[${index}]`);
  }
  for (const [index, policy] of (config.policies ?? []).entries()) {
    rememberPolicyName(seenPolicies, policy.name, `embedded policies[${index}]`);
  }
  const resolved: RuntimeConfig = {
    ...config,
    contexts: { ...(config.contexts ?? {}) },
    capabilities: [...(config.capabilities ?? [])],
    policies: [...(config.policies ?? [])],
  };
  for (const [contractIndex, contractPath] of config.contracts.entries()) {
    const fullPath = path.resolve(baseDir, contractPath);
    const contract = normalizeContract(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    mergeContractIntoRuntimeConfig(resolved, contract, `contracts[${contractIndex}] ${contractPath}`, seenCapabilities, seenPolicies);
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

function rememberPolicyName(seen: Map<string, string>, name: string, origin: string): void {
  const previous = seen.get(name);
  if (previous) {
    throw new Error(`Duplicate policy ${name}: ${origin} conflicts with ${previous}. Policy names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name, origin);
}

function mergeContractIntoRuntimeConfig(config: RuntimeConfig, contract: SynapsorContract, origin: string, seenCapabilities: Map<string, string>, seenPolicies: Map<string, string>): void {
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
  if (contract.policies?.length) {
    if (!config.policies) config.policies = [];
    for (const [policyIndex, policy] of contract.policies.entries()) {
      rememberPolicyName(seenPolicies, policy.name, `${origin} policies[${policyIndex}]`);
      config.policies.push(policy);
    }
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
    ...(capability.returns_hint ? { returns_hint: capability.returns_hint } : {}),
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
    runtime.numeric_bounds = capability.proposal.numeric_bounds;
    runtime.transition_guards = capability.proposal.transition_guards;
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
  const sharedPostgres = config.storage?.shared_postgres;
  const ownsStore = !options.store;
  const store = options.store ?? createDefaultRuntimeStore(config, env, storePath);
  const readRow = options.readRow ?? readCurrentRow;
  const cloudClient = options.controlPlaneClient ?? (config.mode === "cloud" ? createCloudClient(config, env) : undefined);
  const cloudTools = options.cloudTools ?? [];
  const resultFormat = options.resultFormat ?? config.result_format ?? 1;
  const trustedContext = options.trustedContext;
  const assertLocalStoreAvailable = ownsStore && sharedPostgres?.mode !== "runtime_store";
  const assertStoreAvailable = () => {
    if (assertLocalStoreAvailable) assertPersistentStoreAvailable(storePath);
  };

  return {
    config,
    store,
    listTools: () => config.mode === "cloud" ? cloudTools : listedLocalCapabilities(config).map((capability) => toolMetadata(capability)),
    callTool: async (name, args) => {
      const capability = config.mode === "cloud" ? undefined : localCapabilities(config).find((item) => item.name === name);
      try {
        if (resultFormat === 2) {
          assertStoreAvailable();
          return await callConfiguredToolV2({ config, env, store, readRow, cloudClient, trustedContext, name, args });
        }
        assertStoreAvailable();
        return await callConfiguredTool({ config, env, store, readRow, cloudClient, trustedContext, name, args });
      } catch (error) {
        logToolRejection(error, config, env, capability, name, trustedContext);
        if (resultFormat === 2) return errorEnvelopeFromError(error, capability, name);
        throw error;
      }
    },
    readResource: async (uri) => {
      assertStoreAvailable();
      return readLocalResource(store, uri);
    },
    close: async () => {
      if (!options.store) await store.close();
    },
  };
}

function createDefaultRuntimeStore(config: RuntimeConfig, env: NodeJS.ProcessEnv, storePath: string): ProposalRuntimeStore {
  const sharedPostgres = config.storage?.shared_postgres;
  if (sharedPostgres?.mode === "runtime_store") {
    const databaseUrl = envValue(env, sharedPostgres.url_env);
    if (!databaseUrl) {
      throw new McpRuntimeError("POSTGRES_RUNTIME_STORE_URL_MISSING", `${sharedPostgres.url_env} is required when storage.shared_postgres.mode is runtime_store.`);
    }
    return new PostgresProposalRuntimeStore({
      pool: createPostgresPool(databaseUrl),
      schema: sharedPostgres.schema ?? "synapsor_runner",
      lockTimeoutMs: sharedPostgres.lock_timeout_ms,
      autoMigrate: true,
      closePool: true,
    });
  }
  return new ProposalStore(storePath);
}

function assertRuntimeStoreStartupReady(config: RuntimeConfig, env: NodeJS.ProcessEnv): void {
  const sharedPostgres = config.storage?.shared_postgres;
  if (sharedPostgres?.mode !== "runtime_store") return;
  if (!envValue(env, sharedPostgres.url_env)) {
    throw new McpRuntimeError("POSTGRES_RUNTIME_STORE_URL_MISSING", `${sharedPostgres.url_env} is required when storage.shared_postgres.mode is runtime_store.`);
  }
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
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void runtime.close().finally(resolve);
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
  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);

  if (devNoAuth && !isLoopbackHost(host)) {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_UNSAFE_HOST", "--dev-no-auth is only allowed with localhost or 127.0.0.1.");
  }
  if (configUsesHttpClaims(config)) {
    throw new McpRuntimeError("HTTP_CLAIMS_REQUIRES_STREAMABLE", "http_claims trusted context requires spec MCP Streamable HTTP sessions; the legacy JSON-RPC bridge cannot bind per-session context.");
  }

  const authToken = devNoAuth ? undefined : envValue(env, authTokenEnv);
  if (!devNoAuth && !authToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_MISSING", `${authTokenEnv} is not set. HTTP MCP requires bearer auth by default.`);
  }

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
    await runtime.close();
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
  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);
  const usesSessionAuth = configUsesHttpClaims(config);

  if (devNoAuth && !isLoopbackHost(host)) {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_UNSAFE_HOST", "--dev-no-auth is only allowed with localhost or 127.0.0.1.");
  }
  if (devNoAuth && usesSessionAuth) {
    throw new McpRuntimeError("HTTP_CLAIMS_AUTH_REQUIRED", "http_claims trusted context cannot run with --dev-no-auth.");
  }

  const authToken = devNoAuth || usesSessionAuth ? undefined : envValue(env, authTokenEnv);
  if (!devNoAuth && !usesSessionAuth && !authToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_MISSING", `${authTokenEnv} is not set. Streamable HTTP MCP requires bearer auth by default.`);
  }
  assertRuntimeStoreStartupReady(config, env);
  if (usesSessionAuth) assertSessionAuthReady(config, env);
  if (options.tls?.requestClientCert && !options.tls.ca) {
    throw new McpRuntimeError("MTLS_CA_REQUIRED", "Streamable HTTP mTLS requires a CA bundle when client certificates are required.");
  }

  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  const sessions = new Map<string, StreamableHttpSession>();
  const openSessions = new Set<StreamableHttpSession>();
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
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
  };
  const server = options.tls
    ? createHttpsServer({
      cert: options.tls.cert,
      key: options.tls.key,
      ca: options.tls.ca,
      requestCert: options.tls.requestClientCert === true,
      rejectUnauthorized: options.tls.requestClientCert === true,
    }, requestHandler)
    : createServer(requestHandler);

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
  const scheme = options.tls ? "https" : "http";
  const url = `${scheme}://${actualHost}:${actualPort}/mcp`;

  if (options.log !== false) {
    const log = options.log ?? process.stderr;
    log.write(`Synapsor Runner Streamable HTTP MCP listening on ${url}\n`);
    if (options.tls) log.write(options.tls.requestClientCert ? "TLS: enabled, client certificates required\n" : "TLS: enabled\n");
    log.write(devNoAuth
      ? "Auth: disabled for localhost development only\n"
      : usesSessionAuth
        ? `Auth: signed per-session JWT from ${config.session_auth?.secret_env}\n`
        : `Auth: bearer token from ${authTokenEnv}\n`);
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
    const authentication = authenticateStreamableRequest(config, request.headers.authorization, env, authToken, devNoAuth);
    if (!authentication) {
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
      if (existing.authFingerprint !== authentication.fingerprint) {
        writeJson(response, 401, { ok: false, error: "session_auth_mismatch" });
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
    const runtime = createMcpRuntime(config, { env, storePath, resultFormat, readRow, cloudTools, trustedContext: authentication.context });
    session = { transport, runtime, authFingerprint: authentication.fingerprint };
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
    return await resourceResult(uri, runtime.readResource);
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

type StreamableAuthentication = {
  fingerprint: string;
  context?: TrustedContext;
};

function configUsesHttpClaims(config: RuntimeConfig): boolean {
  if (config.trusted_context?.provider === "http_claims") return true;
  return Object.values(config.contexts ?? {}).some((context) => context.provider === "http_claims");
}

function assertSessionAuthReady(config: RuntimeConfig, env: NodeJS.ProcessEnv): void {
  const auth = config.session_auth;
  if (!auth || auth.provider !== "jwt_hs256") {
    throw new McpRuntimeError("SESSION_AUTH_REQUIRED", "http_claims trusted context requires session_auth.provider jwt_hs256.");
  }
  const activeSecret = envValue(env, auth.secret_env);
  if (!activeSecret || Buffer.byteLength(activeSecret) < 32) {
    throw new McpRuntimeError("SESSION_AUTH_SECRET_INVALID", `${auth.secret_env} must contain at least 32 bytes of HMAC key material.`);
  }
  if (auth.previous_secret_env) {
    const previousSecret = envValue(env, auth.previous_secret_env);
    if (!previousSecret || Buffer.byteLength(previousSecret) < 32) {
      throw new McpRuntimeError("SESSION_AUTH_PREVIOUS_SECRET_INVALID", `${auth.previous_secret_env} must contain at least 32 bytes of previous HMAC key material during token rotation.`);
    }
  }
}

function authenticateStreamableRequest(
  config: RuntimeConfig,
  authorization: string | undefined,
  env: NodeJS.ProcessEnv,
  staticToken: string | undefined,
  devNoAuth: boolean,
): StreamableAuthentication | undefined {
  if (devNoAuth) return { fingerprint: "dev-no-auth" };
  const token = bearerToken(authorization);
  if (!token) return undefined;
  if (!configUsesHttpClaims(config)) {
    if (!staticToken || !validBearerToken(authorization, staticToken)) return undefined;
    return { fingerprint: tokenFingerprint(token) };
  }
  try {
    const context = verifySessionJwt(config, token, env);
    return { fingerprint: tokenFingerprint(token), context };
  } catch {
    return undefined;
  }
}

function verifySessionJwt(config: RuntimeConfig, token: string, env: NodeJS.ProcessEnv): TrustedContext {
  const auth = config.session_auth;
  if (!auth || auth.provider !== "jwt_hs256") throw new Error("session auth is not configured");
  const secrets = sessionAuthSecrets(auth, env);
  if (secrets.length === 0) throw new Error("session auth secret is unavailable");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("invalid JWT shape");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
  if (!isRecord(header) || header.alg !== "HS256" || !isRecord(claims)) throw new Error("invalid JWT header or claims");
  const actual = Buffer.from(parts[2], "base64url");
  if (!secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  })) {
    throw new Error("invalid JWT signature");
  }
  const now = Math.floor(Date.now() / 1000);
  const skew = auth.clock_skew_seconds ?? 30;
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < now - skew) throw new Error("JWT is expired or has no exp");
  if (claims.nbf !== undefined && (!Number.isFinite(Number(claims.nbf)) || Number(claims.nbf) > now + skew)) throw new Error("JWT is not active");
  if (auth.issuer && claims.iss !== auth.issuer) throw new Error("JWT issuer mismatch");
  if (auth.audience && !jwtAudienceIncludes(claims.aud, auth.audience)) throw new Error("JWT audience mismatch");
  const tenant = safeSessionClaim(claims[auth.tenant_claim ?? "tenant_id"]);
  const principal = safeSessionClaim(claims[auth.principal_claim ?? "sub"]);
  if (!tenant || !principal) throw new Error("JWT trusted context claims are missing or unsafe");
  return { tenant_id: tenant, principal, provenance: "http_claims" };
}

function sessionAuthSecrets(auth: NonNullable<RuntimeConfig["session_auth"]>, env: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = [];
  for (const envName of [auth.secret_env, auth.previous_secret_env]) {
    if (!envName) continue;
    const secret = envValue(env, envName);
    if (secret && Buffer.byteLength(secret) >= 32) secrets.push(secret);
  }
  return secrets;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function jwtAudienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.some((item) => item === expected));
}

function safeSessionClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
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
  }).finally(() => runtime.close());
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
  void session.runtime.close();
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
  store: ProposalRuntimeStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  trustedContext?: TrustedContext;
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
    assertApprovalPolicyResolvable(input.config, capability);
  }
  const source = input.config.sources?.[capability.source];
  if (!source) throw new McpRuntimeError("SOURCE_NOT_FOUND", `Unknown source: ${capability.source}`);
  const context = resolveTrustedContext(input.config, input.env, capability, input.trustedContext);
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
  await input.store.recordEvidenceBundle({
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
  await input.store.recordQueryAudit({
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
  const activeProposal = await input.store.findActiveProposal({
    tenant_id: context.tenant_id,
    action: capability.name,
    business_object: capability.target.table,
    object_id: objectId,
  });
  if (activeProposal) throw proposalAlreadyExists(activeProposal);
  let proposal: StoredProposal;
  try {
    proposal = await input.store.createProposal(changeSet);
  } catch (error) {
    if (error instanceof ProposalStoreError && error.code === "PROPOSAL_ALREADY_EXISTS") {
      const existing = await input.store.findActiveProposal({
        tenant_id: context.tenant_id,
        action: capability.name,
        business_object: capability.target.table,
        object_id: objectId,
      });
      if (existing) throw proposalAlreadyExists(existing);
    }
    throw error;
  }
  const approvalResult = await maybeAutoApproveProposal({
    config: input.config,
    capability,
    store: input.store,
    proposal,
    patch: changeSet.patch,
  });
  await input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    proposal_id: proposal.proposal_id,
    tenant_id: context.tenant_id,
    payload: {
      capability: capability.name,
      proposal_id: proposal.proposal_id,
      source_database_changed: false,
      approval_status: approvalResult.proposal.state === "approved" ? "approved" : changeSet.approval.status,
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
  await input.store.recordQueryAudit({
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
    status: input.config.mode === "shadow" ? "shadow_proposal_created" : approvalResult.proposal.state === "approved" ? "approved" : "review_required",
    action: capability.name,
    proposal_id: approvalResult.proposal.proposal_id,
    proposal_version: approvalResult.proposal.proposal_version,
    proposal_hash: approvalResult.proposal.proposal_hash,
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
    approval: approvalResult.approved
      ? { mode: "policy", policy: approvalResult.policy }
      : {
        mode: capability.approval?.mode ?? "human",
        ...(capability.approval?.policy ? { policy: capability.approval.policy } : {}),
        ...(capability.approval?.required_role ? { required_role: capability.approval.required_role } : {}),
        ...(approvalResult.tripped_limits?.length ? {
          fallback: "human_review",
          tripped_limits: approvalResult.tripped_limits,
        } : {}),
      },
    approval_required: approvalResult.proposal.state === "pending_review",
    writeback: changeSet.writeback,
    source_database_changed: false,
    source_database_mutated: false,
  };
}

async function callConfiguredToolV2(input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalRuntimeStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  trustedContext?: TrustedContext;
  name: string;
  args: Record<string, unknown>;
}): Promise<ResultEnvelopeV2> {
  const capability = input.config.mode === "cloud"
    ? undefined
    : localCapabilities(input.config).find((item) => item.name === input.name);
  const legacy = await callConfiguredTool(input);
  return resultEnvelopeFromLegacy(legacy, capability, input.name);
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
    const approval = isRecord(legacy.approval) ? legacy.approval : undefined;
    const state = typeof legacy.status === "string" ? legacy.status : "review_required";
    const approvalRequired = legacy.approval_required !== false;
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
        state,
        target: `${targetType}:${targetId}`,
        diff: isRecord(legacy.diff) ? legacy.diff : {},
        approval_required: approvalRequired,
        ...(approval ? { approval } : {}),
        writeback: {
          mode: writebackMode,
          applied: false,
        },
        next: approvalRequired
          ? "A human must approve outside this model-facing tool surface; nothing is committed yet."
          : "The proposal is approved outside the model-facing tool surface; trusted writeback/apply is still separate.",
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

export function assertApprovalPolicyResolvable(config: RuntimeConfig, capability: RuntimeCapabilityConfig): void {
  if (capability.kind !== "proposal" || capability.approval?.mode !== "policy") return;
  const policyName = capability.approval.policy;
  if (!policyName) {
    throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${capability.name} uses policy approval but does not name approval.policy.`);
  }
  const policy = approvalPolicyByName(config, policyName);
  if (!policy) {
    throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${capability.name} references missing approval policy ${policyName}.`);
  }
}

async function maybeAutoApproveProposal(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  store: ProposalRuntimeStore;
  proposal: StoredProposal;
  patch: Record<string, Scalar>;
}): Promise<{
  proposal: StoredProposal;
  approved: boolean;
  policy?: string;
  tripped_limits?: Array<Record<string, unknown>>;
}> {
  if (input.config.mode !== "review") return { proposal: input.proposal, approved: false };
  if (input.config.approvals?.disable_auto_approval === true) return { proposal: input.proposal, approved: false };
  if (input.capability.approval?.mode !== "policy" || !input.capability.approval.policy) return { proposal: input.proposal, approved: false };
  if (input.proposal.state === "approved") return { proposal: input.proposal, approved: true, policy: input.capability.approval.policy };
  if (input.proposal.state !== "pending_review") return { proposal: input.proposal, approved: false };
  const policyName = input.capability.approval.policy;
  const policy = approvalPolicyByName(input.config, policyName);
  if (!policy) throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${input.capability.name} references missing approval policy ${policyName}.`);
  const evaluation = evaluateApprovalPolicy(input.capability, policy, input.patch);
  if (!evaluation.qualifies) return { proposal: input.proposal, approved: false, policy: policyName };

  // Safety boundary: policy approval is contract-owned server behavior only.
  // No MCP tool can choose a policy, approve a proposal, or apply the writeback.
  const decision = await input.store.approveProposalByPolicy(input.proposal.proposal_id, {
    policy: policyName,
    proposal_hash: input.proposal.proposal_hash,
    proposal_version: input.proposal.proposal_version,
    reason: `auto-approved by policy ${policyName}: ${evaluation.reason}`,
    limits: policy.limits,
  });
  return {
    proposal: decision.proposal,
    approved: decision.approved,
    policy: policyName,
    tripped_limits: decision.tripped_limits,
  };
}

function approvalPolicyByName(config: RuntimeConfig, policyName: string): PolicySpec | undefined {
  return (config.policies ?? []).find((policy) => policy.kind === "approval" && policy.name === policyName);
}

function evaluateApprovalPolicy(capability: RuntimeCapabilityConfig, policy: PolicySpec, patch: Record<string, Scalar>): { qualifies: boolean; reason: string } {
  const ruleByField = new Map<string, number>();
  for (const rule of policy.rules ?? []) {
    const field = typeof rule.field === "string" ? rule.field : undefined;
    const max = typeof rule.max === "number" && Number.isInteger(rule.max) ? rule.max : undefined;
    if (field && max !== undefined) ruleByField.set(field, max);
  }
  const numericFields = Object.keys(patch).filter((field) => isNumericRuntimeProposalField(capability, field));
  if (numericFields.length === 0) return { qualifies: false, reason: "no numeric patch fields covered by policy" };
  const reasons: string[] = [];
  for (const field of numericFields) {
    const max = ruleByField.get(field);
    const value = patch[field];
    if (max === undefined) return { qualifies: false, reason: `${field} has no matching policy rule` };
    if (typeof value !== "number" || !Number.isInteger(value)) return { qualifies: false, reason: `${field} is not an integer` };
    if (value > max) return { qualifies: false, reason: `${field} ${value} > ${max}` };
    reasons.push(`${field} ${value} <= ${max}`);
  }
  return { qualifies: true, reason: reasons.join(", ") };
}

function isNumericRuntimeProposalField(capability: RuntimeCapabilityConfig, field: string): boolean {
  const proposal: ProposalActionSpec = {
    action: capability.name,
    allowed_fields: capability.allowed_columns ?? Object.keys(capability.patch ?? {}),
    patch: capability.patch ?? {},
    ...(capability.numeric_bounds ? { numeric_bounds: capability.numeric_bounds } : {}),
  };
  return isNumericProposalField(proposal, capability.args, field);
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
  if (runtimeCode === "PROPOSAL_ALREADY_EXISTS") {
    return { code: "PROPOSAL_ALREADY_EXISTS", message: error instanceof Error ? error.message : "An active proposal already exists.", retryable: false };
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

function logToolRejection(
  error: unknown,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability: RuntimeCapabilityConfig | undefined,
  canonicalName: string,
  trustedContext?: TrustedContext,
): void {
  const safe = safeToolError(error);
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: safe.retryable ? "warn" : "info",
    event: "tool_rejected",
    capability: capability?.name ?? canonicalName,
    tenant: trustedTenantForLog(config, env, capability, trustedContext),
    error_code: safe.code,
    runtime_code: error instanceof McpRuntimeError ? error.code : "UNCLASSIFIED",
    retryable: safe.retryable,
    source_database_changed: false,
  })}\n`);
}

function trustedTenantForLog(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability: RuntimeCapabilityConfig | undefined,
  trustedContext?: TrustedContext,
): string | undefined {
  try {
    const context = resolveTrustedContext(config, env, capability, trustedContext);
    return /^[A-Za-z0-9_.:@/-]{1,128}$/.test(context.tenant_id) ? context.tenant_id : "<redacted>";
  } catch {
    return undefined;
  }
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
  const createdAt = new Date().toISOString();
  const proposalCore = {
    schema_version: protocolVersions.changeSet,
    proposal_id: stableId("wrp", {
      action: input.capability.name,
      tenant: input.context.tenant_id,
      object: input.objectId,
      before,
      patch,
      created_at: createdAt,
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
      ...(input.capability.approval?.mode ? { mode: input.capability.approval.mode } : {}),
      ...(input.capability.approval?.policy ? { policy: input.capability.approval.policy } : {}),
      required_role: input.capability.approval?.required_role,
    },
    writeback: {
      status: "not_applied",
      mode: changeSetWritebackMode,
      executor: writebackExecutor,
    },
    source_database_mutated: false,
    created_at: createdAt,
  } satisfies Omit<ChangeSetV1, "integrity">;

  return {
    ...proposalCore,
    integrity: { proposal_hash: hashJson(proposalCore) },
  };
}

function expectedVersionGuard(capability: RuntimeCapabilityConfig, row: Record<string, Scalar>): { column: string; value: Scalar } {
  const column = capability.conflict_guard?.column;
  if (column && row[column] !== undefined) return { column, value: conflictGuardScalar(row[column]) };
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
  const pool = createPostgresPool(connectionString);
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

function resolveTrustedContext(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  capability?: RuntimeCapabilityConfig,
  sessionContext?: TrustedContext,
): TrustedContext {
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
  if (provider === "http_claims" || provider === "cloud_session") {
    if (!sessionContext || sessionContext.provenance !== provider) {
      throw new McpRuntimeError("TRUSTED_BINDING_MISSING", `${provider} trusted context requires a verified per-session binding.`);
    }
    return sessionContext;
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

async function readLocalResource(store: ProposalRuntimeStore, uri: string): Promise<Record<string, unknown>> {
  const parsed = new URL(uri);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const collection = parsed.hostname;
  const id = parts[0];
  if (!id) throw new McpRuntimeError("RESOURCE_ID_MISSING", `Resource id missing in ${uri}.`);
  if (collection === "proposals") {
    const proposal = await store.getProposal(id);
    if (!proposal) throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Proposal not found: ${id}`);
    return { proposal, events: await store.events(id), receipts: await store.receipts(id) };
  }
  if (collection === "evidence") {
    const evidence = await store.getEvidenceBundle(id);
    if (!evidence) throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Evidence bundle not found: ${id}`);
    return evidence;
  }
  if (collection === "replay") {
    const proposalId = id.startsWith("replay_") ? id.slice("replay_".length) : id;
    return await store.replay(proposalId);
  }
  throw new McpRuntimeError("RESOURCE_NOT_FOUND", `Unsupported Synapsor resource: ${uri}`);
}

async function resourceResult(uri: string, reader: (uri: string) => Promise<Record<string, unknown>>) {
  const payload = await reader(uri);
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

function conflictGuardScalar(value: Scalar): Scalar {
  if (typeof value !== "string") return value;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (!match) return value;
  const fraction = (match[3] ?? "").padEnd(6, "0").slice(0, 6);
  return `${match[1]} ${match[2]}.${fraction}${match[4] ?? ""}`;
}

function proposalAlreadyExists(existing: StoredProposal): McpRuntimeError {
  return new McpRuntimeError(
    "PROPOSAL_ALREADY_EXISTS",
    `Active proposal ${existing.proposal_id} is already ${existing.state} for this object. Inspect or resolve it before proposing again.`,
  );
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
