import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  ControlPlaneClient,
  type AdapterToolCatalogEntry,
} from "@synapsor-runner/control-plane-client";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { protocolVersions, type ChangeSetV1 } from "@synapsor-runner/protocol";
import mysql from "mysql2/promise";
import { Pool } from "pg";
import { z } from "zod";

export type RunnerMode = "read_only" | "shadow" | "review" | "cloud";
export type SourceEngine = "postgres" | "mysql";
export type ContextProvider = "static_dev" | "environment" | "http_claims" | "cloud_session";
export type CapabilityKind = "read" | "proposal";
export type Scalar = string | number | boolean | null;

export type RuntimeSourceConfig = {
  engine: SourceEngine;
  read_url_env: string;
  write_url_env?: string;
  statement_timeout_ms?: number;
};

export type RuntimeArgConfig = {
  type: "string" | "number" | "boolean";
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
};

export type RuntimeConfig = {
  version: 1;
  mode: RunnerMode;
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
  assertValidRunnerCapabilityConfig(parsed);
  return parsed as RuntimeConfig;
}

export function createMcpRuntime(config: RuntimeConfig, options: McpRuntimeOptions = {}): McpRuntime {
  assertValidRunnerCapabilityConfig(config);
  const env = options.env ?? process.env;
  const store = options.store ?? new ProposalStore(options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db");
  const readRow = options.readRow ?? readCurrentRow;
  const cloudClient = options.controlPlaneClient ?? (config.mode === "cloud" ? createCloudClient(config, env) : undefined);
  const cloudTools = options.cloudTools ?? [];

  return {
    config,
    store,
    listTools: () => config.mode === "cloud" ? cloudTools : listedLocalCapabilities(config).map((capability) => toolMetadata(capability)),
    callTool: async (name, args) => callConfiguredTool({ config, env, store, readRow, cloudClient, name, args }),
    readResource: (uri) => readLocalResource(store, uri),
    close: () => {
      if (!options.store) store.close();
    },
  };
}

export function createSynapsorMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer(
    { name: "synapsor-runner", version: "0.1.0-alpha.3" },
    { capabilities: { tools: {}, resources: {} } },
  );

  if (runtime.config.mode === "cloud") {
    for (const tool of runtime.listTools()) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
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
            "synapsor.raw_sql_exposed": false,
            "synapsor.approval_tool": false,
          },
        },
        async (args) => toolCallResult(runtime, tool.name, args as Record<string, unknown>),
      );
    }
  } else {
    for (const capability of listedLocalCapabilities(runtime.config)) {
      server.registerTool(
        capability.name,
        {
          title: capability.name,
          description: capabilityDescription(capability),
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
            "synapsor.raw_sql_exposed": false,
            "synapsor.approval_tool": false,
          },
        },
        async (args) => toolCallResult(runtime, capability.name, args as Record<string, unknown>),
      );
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

export async function serveStdio(options: { configPath?: string; storePath?: string; config?: RuntimeConfig } = {}): Promise<void> {
  const config = options.config ?? loadRuntimeConfigFromFile(options.configPath);
  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, process.env) : undefined;
  const runtime = createMcpRuntime(config, { storePath: options.storePath, cloudTools });
  const server = createSynapsorMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
  const baseUrl = env[cloud.base_url_env];
  const runnerToken = env[cloud.runner_token_env];
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
      mode: "trusted_worker_required",
      executor: input.capability.executor ?? "sql_update",
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
  const connectionString = input.env[input.source.read_url_env];
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
  const uri = input.env[input.source.read_url_env];
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
    const tenant = env[tenantEnv];
    const principal = env[principalEnv];
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
  if (typeof envName === "string" && env[envName]) return env[envName];
  return typeof literal === "string" && literal.length > 0 ? literal : undefined;
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
    shape[name] = schema.describe(`${name} business argument`);
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

function capabilityDescription(capability: RuntimeCapabilityConfig): string {
  if (capability.kind === "read") {
    return `Read ${capability.target.schema}.${capability.target.table} through a reviewed Synapsor capability with trusted tenant context and evidence.`;
  }
  return `Create an evidence-backed Synapsor proposal for ${capability.target.schema}.${capability.target.table}; the source database is not mutated by this tool.`;
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
    return { ok: false, code: error.code, error: error.message };
  }
  return { ok: false, code: "MCP_TOOL_FAILED", error: error instanceof Error ? error.message : String(error) };
}
