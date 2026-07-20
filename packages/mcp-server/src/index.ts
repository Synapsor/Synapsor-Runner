import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  CloudControlError,
  ControlPlaneClient,
  type AdapterToolCatalogEntry,
} from "@synapsor-runner/control-plane-client";
import { assertPostgresRlsTarget, createPostgresPool, quotePostgresIdentifier } from "@synapsor-runner/postgres";
import { migrateSharedPostgresRuntimeStore, PostgresProposalRuntimeStore, ProposalStore, ProposalStoreError, type CloudOutboxItem, type ProposalRuntimeStore, type StoredProposal } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, principalScopeFingerprint, protocolVersions, type ChangeSet, type ChangeSetV1, type ChangeSetV2, type ChangeSetV3, type RunnerActivityV1, type RunnerProposalV1, type WritebackResult } from "@synapsor-runner/protocol";
import { isNumericProposalField, normalizeContract, type AgentContextSpec, type AggregateReadSpec, type CapabilitySpec, type PolicySpec, type ProposalActionSpec, type ResourceSpec, type SynapsorContract } from "@synapsor/spec";
import mysql from "mysql2/promise";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createJwtVerifier, type JwtAlgorithm, type JwtVerifier, type JwtVerificationConfig } from "./jwt-auth.js";

export { createJwtVerifier } from "./jwt-auth.js";
export type { JwtAlgorithm, JwtVerifier, JwtVerificationConfig, VerifiedJwt } from "./jwt-auth.js";

export type RunnerMode = "read_only" | "shadow" | "review" | "cloud";
export type SourceEngine = "postgres" | "mysql";
export type ContextProvider = "static_dev" | "environment" | "http_claims" | "cloud_session";
export type CapabilityKind = "read" | "aggregate_read" | "proposal";
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
  pool?: RuntimeSourcePoolConfig;
  database_scope?: RuntimeDatabaseScopeConfig;
  credential_scope?: RuntimeCredentialScopeConfig;
  receipts?: {
    authority: "source_db" | "runner_ledger";
    provisioning?: "precreated" | "auto_migrate";
    schema?: string;
    table?: string;
  };
};

export type RuntimeDatabaseScopeConfig =
  | { mode: "application" }
  | {
    mode: "postgres_rls";
    tenant_setting: string;
    principal_setting: string;
  };

export type RuntimeCredentialScopeConfig =
  | { mode: "shared" }
  | { mode: "tenant_resolver"; resolver: string };

export type RuntimeSourcePoolConfig = {
  max_connections?: number;
  connection_timeout_ms?: number;
  idle_timeout_ms?: number;
  queue_timeout_ms?: number;
  queue_limit?: number;
};

export type RuntimeScalarArgConfig = {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
  max_length?: number;
  minimum?: number;
  maximum?: number;
  enum?: Scalar[];
};

export type RuntimeArgConfig = RuntimeScalarArgConfig | {
  type: "object_array";
  description?: string;
  required?: boolean;
  max_items: number;
  fields: Record<string, RuntimeScalarArgConfig>;
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
  contract_provenance?: { digest: `sha256:${string}`; version: string };
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
    principal_scope_key?: string;
    single_tenant_dev?: boolean;
  };
  args: Record<string, RuntimeArgConfig>;
  lookup: { id_from_arg: string };
  visible_columns: string[];
  evidence?: "required" | "optional" | string;
  max_rows?: number;
  aggregate?: AggregateReadSpec;
  patch?: Record<string, { fixed?: Scalar; from_arg?: string; from_item?: string }>;
  allowed_columns?: string[];
  numeric_bounds?: Record<string, RuntimeNumericBoundConfig>;
  transition_guards?: Record<string, RuntimeTransitionGuardConfig>;
  reversibility?: { mode: "reviewed_inverse" };
  operation?: NonNullable<ProposalActionSpec["operation"]>;
  conflict_guard?: { column?: string; weak_guard_ack?: boolean };
  approval?: { mode?: "human" | "operator" | "policy" | string; required_role?: string; required_approvals?: number; policy?: string };
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
    provider: "dev_env" | "signed_key" | "jwt_oidc";
    actor_env?: string;
    roles_env?: string;
    apply_roles?: string[];
    operators?: Record<string, { public_key_path: string; roles: string[] }>;
    token_env?: string;
    token_file_env?: string;
    token_stdin?: boolean;
    roles_claim?: string;
    subject_claim?: string;
    attestation_secret_env?: string;
    algorithms?: JwtAlgorithm[];
    jwks_url_env?: string;
    public_key_env?: string;
    public_key_path?: string;
    issuer?: string;
    audience?: string;
    clock_skew_seconds?: number;
    jwks_cache_seconds?: number;
    jwks_cooldown_seconds?: number;
    fetch_timeout_ms?: number;
    max_response_bytes?: number;
  };
  session_auth?: {
    provider: "jwt_hs256" | "jwt_asymmetric";
    secret_env?: string;
    previous_secret_env?: string;
    algorithms?: JwtAlgorithm[];
    jwks_url_env?: string;
    public_key_env?: string;
    public_key_path?: string;
    issuer?: string;
    audience?: string;
    tenant_claim?: string;
    principal_claim?: string;
    clock_skew_seconds?: number;
    jwks_cache_seconds?: number;
    jwks_cooldown_seconds?: number;
    fetch_timeout_ms?: number;
    max_response_bytes?: number;
  };
  rate_limits?: {
    enabled?: boolean;
    default?: RuntimeRateLimitRule;
    capabilities?: Record<string, RuntimeRateLimitRule>;
  };
  metrics?: {
    enabled?: boolean;
    token_env?: string;
  };
  graduated_trust?: {
    enabled?: boolean;
    kill_switch?: boolean;
    workspace_id?: string;
    project_id?: string;
    criteria?: Array<{
      capability: string;
      policy: string;
      field: string;
      minimum_human_reviews: number;
      window_days: number;
      maximum_rejection_rate: number;
      maximum_conflict_rate: number;
      maximum_failure_rate: number;
      maximum_revert_rate: number;
      maximum_threshold_increase: number;
      absolute_ceiling: number;
    }>;
  };
  storage?: {
    sqlite_path?: string;
    shared_postgres?: {
      mode: "mirror" | "runtime_store" | "disabled";
      url_env: string;
      schema?: string;
      lock_timeout_ms?: number;
      max_entries?: number;
    };
  };
  sources?: Record<string, RuntimeSourceConfig>;
  trusted_context?: {
    provider: ContextProvider;
    values?: Record<string, unknown>;
    tenant_binding?: string;
    principal_binding?: string;
  };
  contexts?: Record<string, {
    provider: ContextProvider;
    values?: Record<string, unknown>;
    tenant_binding?: string;
    principal_binding?: string;
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
  governance?: {
    mode: "local_only" | "cloud_linked";
    connection_file?: string;
    evidence_residency?: "metadata_only";
    queue_when_unavailable?: boolean;
    sync_interval_ms?: number;
    max_attempts?: number;
    outbox_retention_days?: number;
  };
};

export type RuntimeRateLimitRule = {
  requests: number;
  window_seconds: number;
};

export type CloudLinkedConnection = {
  protocol_version: string;
  base_url: string;
  runner_token_env: string;
  runner_token: string;
  runner_id: string;
  runner_version: string;
  project_id: string;
  source_id: string;
  runner_source_id: string;
  mapping_id?: string;
  contract_id: string;
  contract_version_id: string;
  contract_digest: `sha256:${string}`;
};

export type CloudLinkedSyncStatus = {
  authority_mode: "local_only" | "cloud_linked";
  evidence_residency: "metadata_only";
  pending: number;
  leased: number;
  acknowledged: number;
  dead_letter: number;
  reconciliation_required: number;
  oldest_pending_at?: string;
  last_acknowledged_at?: string;
  last_reconciled_at?: string;
  last_reconciliation_error_code?: string;
  last_compacted_at?: string;
  last_compacted_count?: number;
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
}) => Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }>;

export type McpRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  store?: ProposalRuntimeStore;
  storePath?: string;
  resultFormat?: ResultFormat;
  readRow?: DbRowReader;
  credentialResolver?: TenantCredentialResolver;
  controlPlaneClient?: CloudAdapterClient;
  cloudTools?: LocalToolMetadata[];
  trustedContext?: TrustedContext;
  clock?: () => number;
  sharedResources?: McpRuntimeSharedResources;
};

export type TenantCredentialResolver = {
  /** Stable implementation identifier matched by source.credential_scope.resolver. */
  id: string;
  resolve(input: {
    source_name: string;
    engine: SourceEngine;
    access: "read" | "write";
    tenant_id: string;
    principal: string;
  }): Promise<{
    connection_url: string;
    /** Non-secret identity used to partition pools; never use the credential itself. */
    credential_id: string;
    expires_at?: string;
  }>;
};

export async function resolveRuntimeSourceCredential(input: {
  sourceName: string;
  source: RuntimeSourceConfig;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
  resolver?: TenantCredentialResolver;
  access?: "read" | "write";
  now?: number;
}): Promise<{ connectionUrl: string; poolKey: string; expiresAt?: number }> {
  if (input.source.credential_scope?.mode !== "tenant_resolver") {
    const connectionUrl = envValue(input.env, input.source.read_url_env);
    if (!connectionUrl) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
    return { connectionUrl, poolKey: input.sourceName };
  }
  const expectedResolver = input.source.credential_scope.resolver;
  if (!input.resolver || input.resolver.id !== expectedResolver) {
    throw new McpRuntimeError(
      "TENANT_CREDENTIAL_RESOLVER_MISSING",
      `Source ${input.sourceName} requires tenant credential resolver ${expectedResolver}.`,
    );
  }
  try {
    const resolved = await input.resolver.resolve({
      source_name: input.sourceName,
      engine: input.source.engine,
      access: input.access ?? "read",
      tenant_id: input.context.tenant_id,
      principal: input.context.principal,
    });
    const connectionUrl = resolved.connection_url.trim();
    const credentialId = resolved.credential_id.trim();
    if (!connectionUrl || !credentialId || credentialId.length > 128 || /[\u0000-\u001f\u007f]/.test(credentialId)) {
      throw new Error("resolver returned an invalid credential");
    }
    const expiresAt = resolved.expires_at === undefined ? undefined : Date.parse(resolved.expires_at);
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now()))) {
      throw new Error("resolver returned an expired credential");
    }
    return {
      connectionUrl,
      poolKey: canonicalJsonDigest({
        source: input.sourceName,
        access: input.access ?? "read",
        tenant: input.context.tenant_id,
        principal: input.context.principal,
        credential_id: credentialId,
      }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  } catch (error) {
    if (error instanceof McpRuntimeError) throw error;
    throw new McpRuntimeError(
      "TENANT_CREDENTIAL_RESOLUTION_FAILED",
      `Tenant credential resolution failed closed for source ${input.sourceName}.`,
    );
  }
}

export type McpRuntimeSharedResources = {
  readRow: DbRowReader;
  consumeRateLimit(context: TrustedContext, capability: string): Promise<void>;
  poolMetrics(): RuntimePoolMetric[];
  rateLimitMetrics(): RuntimeRateLimitMetric[];
  close(): Promise<void>;
};

export type McpRuntime = {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  listTools(): LocalToolMetadata[];
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  readResource(uri: string): Promise<Record<string, unknown>>;
  poolMetrics(): RuntimePoolMetric[];
  rateLimitMetrics(): RuntimeRateLimitMetric[];
  cloudSyncStatus(): Promise<CloudLinkedSyncStatus>;
  close(): Promise<void>;
};

export type RuntimeRateLimitMetric = {
  tenant: string;
  capability: string;
  rejected: number;
};

export type RuntimePoolMetric = {
  source: string;
  engine: SourceEngine;
  active: number;
  waiting: number;
  max: number;
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
  credentialResolver?: TenantCredentialResolver;
  tls?: StreamableHttpTlsOptions;
  readinessCheck?: () => Promise<ReadinessReport>;
};

export type ReadinessComponent = {
  name: string;
  ok: boolean;
  code: string;
  latency_ms: number;
};

export type ReadinessReport = {
  ok: boolean;
  status: "ready" | "not_ready";
  components: ReadinessComponent[];
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
    retry_after_ms?: number;
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
  | "RATE_LIMITED"
  | "INTERNAL";

type StreamableHttpSession = {
  transport: StreamableHTTPServerTransport;
  runtime: McpRuntime;
  sessionId?: string;
  authFingerprint: string;
  closed?: boolean;
};

type MetricsEndpointAccess = {
  enabled: boolean;
  token?: string;
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
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
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
  const governance = config.governance?.connection_file
    ? { ...config.governance, connection_file: path.resolve(baseDir, config.governance.connection_file) }
    : config.governance;
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) {
    return governance === config.governance ? config : { ...config, governance };
  }
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
    ...(governance ? { governance } : {}),
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

export function loadCloudLinkedConnection(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): CloudLinkedConnection {
  if (config.governance?.mode !== "cloud_linked") {
    throw new McpRuntimeError("CLOUD_LINKED_MODE_REQUIRED", "This operation requires governance.mode cloud_linked.");
  }
  const connectionPath = config.governance.connection_file;
  if (!connectionPath) throw new McpRuntimeError("CLOUD_CONNECTION_REQUIRED", "Cloud-linked governance requires governance.connection_file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(connectionPath, "utf8"));
  } catch (error) {
    throw new McpRuntimeError("CLOUD_CONNECTION_INVALID", `Unable to read the reviewed Cloud connection file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = isRecord(parsed) ? parsed : {};
  const cloud = isRecord(root.cloud) ? root.cloud : undefined;
  if (!cloud) throw new McpRuntimeError("CLOUD_CONNECTION_INVALID", "Cloud connection file must contain a cloud object.");
  const baseUrlEnv = nonEmptyString(cloud.base_url_env) ?? "SYNAPSOR_CLOUD_BASE_URL";
  const runnerTokenEnv = nonEmptyString(cloud.runner_token_env) ?? "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = envValue(env, baseUrlEnv) ?? nonEmptyString(cloud.base_url);
  const runnerToken = envValue(env, runnerTokenEnv);
  const sourceId = nonEmptyString(cloud.source_id);
  const runnerSourceId = nonEmptyString(cloud.runner_source_id) ?? sourceId;
  const projectId = nonEmptyString(cloud.project_id);
  const contractId = nonEmptyString(cloud.contract_id);
  const contractVersionId = nonEmptyString(cloud.contract_version_id);
  const digest = nonEmptyString(cloud.contract_digest);
  const missing = [
    !baseUrl ? baseUrlEnv : "",
    !runnerToken ? runnerTokenEnv : "",
    !projectId ? "cloud.project_id" : "",
    !sourceId ? "cloud.source_id" : "",
    !contractId ? "cloud.contract_id" : "",
    !contractVersionId ? "cloud.contract_version_id" : "",
    !digest ? "cloud.contract_digest" : "",
  ].filter(Boolean);
  if (missing.length) throw new McpRuntimeError("CLOUD_CONNECTION_INCOMPLETE", `Cloud-linked connection is missing: ${missing.join(", ")}.`);
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest!)) throw new McpRuntimeError("CLOUD_CONTRACT_DIGEST_INVALID", "cloud.contract_digest must be a full sha256 digest.");
  let normalizedBaseUrl: string;
  try {
    const url = new URL(baseUrl!);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("unsafe URL components");
    normalizedBaseUrl = url.toString().replace(/\/$/, "");
  } catch {
    throw new McpRuntimeError("CLOUD_BASE_URL_INVALID", `${baseUrlEnv} must contain an HTTP(S) origin without credentials, query, or fragment.`);
  }
  return {
    protocol_version: nonEmptyString(cloud.protocol_version) ?? protocolVersions.runnerProposal,
    base_url: normalizedBaseUrl,
    runner_token_env: runnerTokenEnv,
    runner_token: runnerToken!,
    runner_id: nonEmptyString(cloud.runner_id) ?? envValue(env, "SYNAPSOR_RUNNER_ID") ?? "synapsor_runner_local",
    runner_version: nonEmptyString(cloud.runner_version) ?? envValue(env, "npm_package_version") ?? "unknown",
    project_id: projectId!,
    source_id: sourceId!,
    runner_source_id: runnerSourceId!,
    ...(nonEmptyString(cloud.mapping_id) ? { mapping_id: nonEmptyString(cloud.mapping_id) } : {}),
    contract_id: contractId!,
    contract_version_id: contractVersionId!,
    contract_digest: digest!.toLowerCase() as `sha256:${string}`,
  };
}

export async function enqueueCloudLinkedProposal(input: {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  proposal: StoredProposal;
  evidenceBundleId: string;
  queryFingerprint: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CloudOutboxItem | undefined> {
  if (input.config.governance?.mode !== "cloud_linked") return undefined;
  if (!input.store.enqueueCloudOutbox) throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "The configured runtime store does not implement the durable Cloud outbox.");
  const connection = loadCloudLinkedConnection(input.config, input.env ?? process.env);
  if (input.proposal.source_id !== connection.runner_source_id) {
    throw new McpRuntimeError("CLOUD_SOURCE_MAPPING_MISMATCH", `Proposal source ${input.proposal.source_id} is not the reviewed local source ${connection.runner_source_id}.`);
  }
  const evidence = input.store.listEvidenceBundles
    ? await input.store.listEvidenceBundles({ proposal: input.proposal.proposal_id, limit: 100 })
    : [];
  const queryAudit = input.store.listQueryAudit
    ? await input.store.listQueryAudit({ proposal: input.proposal.proposal_id, limit: 100 })
    : [];
  const sanitizedChangeSet = cloudSafeChangeSet(input.proposal.change_set);
  const proposalPayload: RunnerProposalV1 = {
    schema_version: protocolVersions.runnerProposal,
    runner_id: connection.runner_id,
    source_id: connection.source_id,
    ...(connection.mapping_id ? { mapping_id: connection.mapping_id } : {}),
    contract: {
      contract_id: connection.contract_id,
      contract_version_id: connection.contract_version_id,
      digest: connection.contract_digest,
    },
    change_set: sanitizedChangeSet,
    evidence_metadata: {
      bundle_ids: evidence.length ? evidence.map((item) => item.evidence_bundle_id) : [input.evidenceBundleId],
      count: evidence.length || 1,
      query_fingerprints: [...new Set([input.queryFingerprint, ...evidence.map((item) => item.query_fingerprint)].filter((value): value is string => Boolean(value)))],
      payload_uploaded: false,
    },
    query_audit: {
      audit_ids: queryAudit.map((item) => item.audit_id).filter((value) => value !== undefined) as Array<string | number>,
      count: queryAudit.length,
      query_fingerprints: [...new Set(queryAudit.map((item) => typeof item.query_fingerprint === "string" ? item.query_fingerprint : undefined).filter((value): value is string => Boolean(value)))],
      tables: [...new Set(queryAudit.map((item) => typeof item.table_name === "string" ? item.table_name : undefined).filter((value): value is string => Boolean(value)))],
      payload_uploaded: false,
    },
  };
  const maxAttempts = input.config.governance.max_attempts ?? 12;
  const proposalItem = await input.store.enqueueCloudOutbox({
    event_id: `cloud-proposal:${input.proposal.proposal_id}`,
    proposal_id: input.proposal.proposal_id,
    sequence: 0,
    kind: "proposal",
    payload: proposalPayload as unknown as Record<string, unknown>,
    max_attempts: maxAttempts,
  });
  const principalScope = input.proposal.change_set.guards.principal_scope;
  const common = {
    schema_version: protocolVersions.runnerActivity,
    runner_id: connection.runner_id,
    source_id: connection.source_id,
    proposal_id: input.proposal.proposal_id,
    capability: input.proposal.action,
    tenant_id: input.proposal.tenant_id,
    principal: principalScope?.value_fingerprint ?? input.proposal.principal,
    business_object: input.proposal.business_object,
    object_id: input.proposal.object_id,
    status: "pending_cloud_sync",
  } as const;
  for (const [index, bundle] of evidence.entries()) {
    const activity: RunnerActivityV1 = {
      ...common,
      event_id: `evidence:${input.proposal.proposal_id}:${bundle.evidence_bundle_id}`,
      event_type: "evidence.recorded",
      evidence_ids: [bundle.evidence_bundle_id],
      detail: { residency: "metadata_only", stored_locally: true, payload_uploaded: false },
      occurred_at: bundle.created_at,
    };
    await input.store.enqueueCloudOutbox({ event_id: `cloud-activity:${activity.event_id}`, proposal_id: input.proposal.proposal_id, sequence: 10 + index, kind: "activity", payload: activity as unknown as Record<string, unknown>, max_attempts: maxAttempts });
  }
  for (const [index, audit] of queryAudit.entries()) {
    const auditId = String(audit.audit_id);
    const activity: RunnerActivityV1 = {
      ...common,
      event_id: `query-audit:${input.proposal.proposal_id}:${auditId}`,
      event_type: "query_audit.recorded",
      query_audit_ids: [auditId],
      ...(typeof audit.evidence_bundle_id === "string" ? { evidence_ids: [audit.evidence_bundle_id] } : {}),
      detail: { residency: "metadata_only", stored_locally: true, payload_uploaded: false },
      occurred_at: typeof audit.created_at === "string" ? audit.created_at : undefined,
    };
    await input.store.enqueueCloudOutbox({ event_id: `cloud-activity:${activity.event_id}`, proposal_id: input.proposal.proposal_id, sequence: 20 + index, kind: "activity", payload: activity as unknown as Record<string, unknown>, max_attempts: maxAttempts });
  }
  await input.store.recordCloudGovernanceEvent?.({
    event_id: `cloud-governance:pending:${input.proposal.proposal_id}`,
    proposal_id: input.proposal.proposal_id,
    kind: "proposal.pending_cloud_sync",
    state: "pending_cloud_sync",
    payload: { evidence_residency: "metadata_only", contract_digest: connection.contract_digest, project_id: connection.project_id, source_id: connection.source_id },
  });
  return proposalItem;
}

export async function enqueueCloudLinkedResult(input: {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  proposalId: string;
  result: WritebackResult;
  leaseId: string;
}): Promise<CloudOutboxItem | undefined> {
  if (input.config.governance?.mode !== "cloud_linked") return undefined;
  if (!input.store.enqueueCloudOutbox) throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "The configured runtime store does not implement the durable Cloud outbox.");
  if (input.result.job_id !== `wbj_${input.proposalId}` && !input.result.job_id.endsWith(input.proposalId)) {
    throw new McpRuntimeError("CLOUD_RESULT_PROPOSAL_MISMATCH", "Cloud result job identity does not match the local proposal.");
  }
  const proposal = await input.store.getProposal(input.proposalId);
  const localAuthorityRejected = input.result.status === "failed"
    && input.result.affected_rows === 0
    && input.result.error_code === "LOCAL_AUTHORITY_REJECTED";
  if (!proposal && !localAuthorityRejected) {
    throw new McpRuntimeError("CLOUD_RESULT_LOCAL_PROPOSAL_REQUIRED", `Cloud result ${input.result.job_id} has no matching local proposal.`);
  }
  const payload = {
    schema_version: "synapsor.cloud-result-outbox.v1",
    lease_id: input.leaseId,
    result: input.result,
  };
  return input.store.enqueueCloudOutbox({
    event_id: `cloud-result:${input.result.job_id}:${input.result.result_hash}`,
    ...(proposal ? { proposal_id: input.proposalId } : {}),
    sequence: 1_000,
    kind: "result",
    payload,
    max_attempts: input.config.governance.max_attempts ?? 12,
  });
}

async function assertCloudLinkedProposalAvailability(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (config.governance?.mode !== "cloud_linked" || config.governance.queue_when_unavailable !== false) return;
  const connection = loadCloudLinkedConnection(config, env);
  const client = new ControlPlaneClient({
    baseUrl: connection.base_url,
    runnerToken: connection.runner_token,
    sourceId: connection.source_id,
    runnerId: connection.runner_id,
  });
  let result: Awaited<ReturnType<ControlPlaneClient["doctor"]>>;
  try {
    result = await client.doctor();
  } catch (error) {
    throw new McpRuntimeError(
      "CLOUD_TEMPORARILY_UNAVAILABLE",
      "Synapsor Cloud is temporarily unavailable and this Runner is configured not to queue proposals.",
      { retry_after_ms: 1_000, cause_code: safeRuntimeErrorCode(error) },
    );
  }
  if (result.ok && result.authenticated) return;
  const errorCode = nonEmptyString(result.details?.error) ?? nonEmptyString(result.details?.error_code);
  if (result.status === 401) {
    throw new McpRuntimeError("CLOUD_RUNNER_AUTHENTICATION_FAILED", "The reviewed Synapsor Cloud Runner credential is not authenticated.");
  }
  if (result.status === 403) {
    throw new McpRuntimeError("CLOUD_RUNNER_AUTHORIZATION_FAILED", "The reviewed Synapsor Cloud Runner identity is not authorized for this source.");
  }
  if ([409, 412, 422].includes(result.status)) {
    throw new McpRuntimeError("CLOUD_CONNECTION_CONFLICT", "The reviewed local Cloud connection no longer matches the active Cloud contract or source.", {
      ...(errorCode ? { cloud_error_code: errorCode } : {}),
    });
  }
  if (result.status === 429) {
    throw new McpRuntimeError("CLOUD_RATE_LIMITED", "Synapsor Cloud is rate limiting proposal submissions.", { retry_after_ms: 1_000 });
  }
  throw new McpRuntimeError(
    "CLOUD_TEMPORARILY_UNAVAILABLE",
    "Synapsor Cloud is temporarily unavailable and this Runner is configured not to queue proposals.",
    { retry_after_ms: 1_000, cloud_status: result.status, ...(errorCode ? { cloud_error_code: errorCode } : {}) },
  );
}

function cloudSafeChangeSet(changeSet: ChangeSet): ChangeSet {
  const sanitized = JSON.parse(JSON.stringify(changeSet)) as ChangeSet;
  sanitized.evidence.items = [];
  const principalScope = sanitized.guards.principal_scope;
  if (principalScope) {
    stripCloudPrincipalColumn(sanitized, principalScope.column);
    sanitized.principal.id = principalScope.value_fingerprint;
    delete principalScope.value;
  }
  return sanitized;
}

function stripCloudPrincipalColumn(changeSet: ChangeSet, column: string): void {
  const strip = (value: unknown) => { if (isRecord(value)) delete value[column]; };
  strip(changeSet.before);
  strip(changeSet.after);
  if ("frozen_set" in changeSet && isRecord(changeSet.frozen_set) && Array.isArray(changeSet.frozen_set.members)) {
    for (const member of changeSet.frozen_set.members) {
      if (!isRecord(member)) continue;
      strip(member.before);
      strip(member.after);
    }
  }
  if (changeSet.schema_version === protocolVersions.compensationChangeSet) {
    for (const member of changeSet.compensation.descriptor.members) {
      strip(member.expected_state);
      strip(member.restore_values);
    }
  }
}

export class CloudLinkedSynchronizer {
  private readonly connection: CloudLinkedConnection;
  private readonly client: ControlPlaneClient;
  private readonly owner: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private activeDrain?: Promise<{ claimed: number; acknowledged: number; failed: number }>;
  private lastReconciledAt?: string;
  private lastReconciliationErrorCode?: string;
  private lastCompactedAt?: string;
  private lastCompactedCount = 0;

  constructor(private readonly config: RuntimeConfig, private readonly store: ProposalRuntimeStore, env: NodeJS.ProcessEnv = process.env) {
    this.connection = loadCloudLinkedConnection(config, env);
    this.client = new ControlPlaneClient({ baseUrl: this.connection.base_url, runnerToken: this.connection.runner_token, sourceId: this.connection.source_id, runnerId: this.connection.runner_id });
    this.owner = `${this.connection.runner_id}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
    if (!store.claimCloudOutbox || !store.acknowledgeCloudOutbox || !store.failCloudOutbox || !store.listCloudOutbox) {
      throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "Cloud-linked governance requires durable outbox support in the runtime store.");
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async () => {
      if (this.stopped) return;
      await this.drainOnce().catch(() => undefined);
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.config.governance?.sync_interval_ms ?? 2_000);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.activeDrain?.catch(() => undefined);
  }

  async drainOnce(): Promise<{ claimed: number; acknowledged: number; failed: number }> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.performDrainOnce();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = undefined;
    }
  }

  async synchronizeBeforeProposal(): Promise<void> {
    while (this.activeDrain) await this.activeDrain;
    await this.drainOnce();
  }

  async flushEvent(eventId: string, timeoutMs = 30_000): Promise<CloudOutboxItem> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const current = (await this.store.listCloudOutbox!({ limit: 10_000 })).find((item) => item.event_id === eventId);
      if (!current) throw new McpRuntimeError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `Cloud outbox event ${eventId} was not found.`);
      if (current.status === "acknowledged") return current;
      if (current.status === "dead_letter" || current.status === "reconciliation_required") {
        throw new McpRuntimeError(
          current.last_error_code ?? "CLOUD_OUTBOX_DELIVERY_FAILED",
          `Cloud outbox event ${eventId} requires operator attention (${current.status}).`,
        );
      }

      await this.drainOnce();
      const refreshed = (await this.store.listCloudOutbox!({ limit: 10_000 })).find((item) => item.event_id === eventId);
      if (!refreshed) throw new McpRuntimeError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `Cloud outbox event ${eventId} was not found.`);
      if (refreshed.status === "acknowledged") return refreshed;
      if (refreshed.status === "dead_letter" || refreshed.status === "reconciliation_required") {
        throw new McpRuntimeError(
          refreshed.last_error_code ?? "CLOUD_OUTBOX_DELIVERY_FAILED",
          `Cloud outbox event ${eventId} requires operator attention (${refreshed.status}).`,
        );
      }
      if (Date.now() >= deadline) return refreshed;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  private async performDrainOnce(): Promise<{ claimed: number; acknowledged: number; failed: number }> {
    let acknowledged = 0;
    let failed = 0;
    const items = await this.store.claimCloudOutbox!({ owner: this.owner, limit: 10, lease_ms: 30_000 });
    for (const item of items) {
      try {
        const response = await this.deliver(item);
        if (item.proposal_id && item.kind === "proposal") {
          const cloudProposalId = nonEmptyString(response.proposal_id) ?? nonEmptyString(response.id) ?? item.proposal_id;
          const requestId = nonEmptyString(response.request_id);
          await this.store.recordCloudGovernanceEvent?.({
            event_id: `cloud-governance:ack:${item.event_id}`,
            proposal_id: item.proposal_id,
            cloud_proposal_id: cloudProposalId,
            kind: "proposal.cloud_acknowledged",
            state: nonEmptyString(response.status) ?? "pending_review",
            payload: { ...(requestId ? { request_id: requestId } : {}), evidence_residency: "metadata_only", payload_hash: item.payload_hash },
          });
        }
        await this.store.acknowledgeCloudOutbox!(item.event_id, this.owner);
        acknowledged += 1;
      } catch (error) {
        failed += 1;
        const classification = classifyCloudSyncFailure(error);
        await this.store.failCloudOutbox!({ event_id: item.event_id, owner: this.owner, ...classification });
      }
    }
    await this.reconcileOnce().catch((error) => {
      this.lastReconciliationErrorCode = classifyCloudSyncFailure(error).error_code;
    });
    await this.compactAcknowledged().catch(() => undefined);
    return { claimed: items.length, acknowledged, failed };
  }

  async status(): Promise<CloudLinkedSyncStatus> {
    const items = await this.store.listCloudOutbox!({ limit: 10_000 });
    const count = (status: CloudOutboxItem["status"]) => items.filter((item) => item.status === status).length;
    const pending = items.filter((item) => item.status === "pending");
    const acknowledged = items.filter((item) => item.status === "acknowledged" && item.acknowledged_at);
    return {
      authority_mode: "cloud_linked",
      evidence_residency: "metadata_only",
      pending: count("pending"),
      leased: count("leased"),
      acknowledged: count("acknowledged"),
      dead_letter: count("dead_letter"),
      reconciliation_required: count("reconciliation_required"),
      ...(pending[0] ? { oldest_pending_at: pending[0].created_at } : {}),
      ...(acknowledged.length ? { last_acknowledged_at: acknowledged.map((item) => item.acknowledged_at!).sort().at(-1) } : {}),
      ...(this.lastReconciledAt ? { last_reconciled_at: this.lastReconciledAt } : {}),
      ...(this.lastReconciliationErrorCode ? { last_reconciliation_error_code: this.lastReconciliationErrorCode } : {}),
      ...(this.lastCompactedAt ? { last_compacted_at: this.lastCompactedAt, last_compacted_count: this.lastCompactedCount } : {}),
    };
  }

  private async compactAcknowledged(): Promise<void> {
    if (!this.store.compactCloudOutbox) return;
    const now = Date.now();
    if (this.lastCompactedAt && now - Date.parse(this.lastCompactedAt) < 60 * 60 * 1_000) return;
    const retentionDays = this.config.governance?.outbox_retention_days ?? 30;
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    this.lastCompactedCount = await this.store.compactCloudOutbox({ acknowledged_before: cutoff });
    this.lastCompactedAt = new Date(now).toISOString();
  }

  async reconcileOnce(): Promise<{ inspected: number; recorded: number }> {
    if (!this.store.listCloudGovernanceEvents || !this.store.recordCloudGovernanceEvent) return { inspected: 0, recorded: 0 };
    const acknowledged = (await this.store.listCloudOutbox!({ status: "acknowledged", limit: 10_000 }))
      .filter((item) => item.kind === "proposal" && item.proposal_id);
    let recorded = 0;
    for (const item of acknowledged.slice(-100)) {
      const proposalId = item.proposal_id!;
      const events = await this.store.listCloudGovernanceEvents(proposalId);
      const latest = events.at(-1);
      if (latest && ["applied", "failed", "conflict", "indeterminate", "canceled", "rejected"].includes(latest.state)) continue;
      const response = await this.client.proposalStatus(proposalId);
      const state = nonEmptyString(response.status) ?? "unknown";
      const payload = cloudGovernanceStatusPayload(response);
      const identity = canonicalJsonDigest({ proposal_id: proposalId, state, payload });
      const eventId = `cloud-governance:state:${proposalId}:${identity.slice("sha256:".length, "sha256:".length + 20)}`;
      const existed = events.some((event) => event.event_id === eventId);
      await this.store.recordCloudGovernanceEvent({
        event_id: eventId,
        proposal_id: proposalId,
        cloud_proposal_id: nonEmptyString(response.proposal_id) ?? proposalId,
        kind: `proposal.cloud_${state}`,
        state,
        payload,
      });
      if (!existed) recorded += 1;
    }
    this.lastReconciledAt = new Date().toISOString();
    this.lastReconciliationErrorCode = undefined;
    return { inspected: acknowledged.length, recorded };
  }

  private async deliver(item: CloudOutboxItem): Promise<Record<string, unknown>> {
    if (item.kind === "proposal") return this.client.submitProposal(item.payload as unknown as RunnerProposalV1);
    if (item.kind === "activity") return this.client.submitActivity(item.payload as unknown as RunnerActivityV1);
    if (item.kind === "result") {
      const result = isRecord(item.payload.result) ? item.payload.result as unknown as WritebackResult : undefined;
      const leaseId = nonEmptyString(item.payload.lease_id);
      if (!result || !leaseId) throw new McpRuntimeError("CLOUD_RESULT_OUTBOX_INVALID", "Cloud result outbox entry is missing a result or lease identity.");
      return this.client.result(result, leaseId);
    }
    throw new McpRuntimeError("CLOUD_OUTBOX_KIND_UNSUPPORTED", `Unsupported Cloud outbox kind: ${item.kind}`);
  }
}

function cloudGovernanceStatusPayload(response: Record<string, unknown>): Record<string, unknown> {
  const decision = isRecord(response.decision) ? response.decision : undefined;
  const job = isRecord(response.job) ? response.job : undefined;
  const result = isRecord(response.result) ? response.result : undefined;
  const actor = nonEmptyString(decision?.actor);
  return JSON.parse(JSON.stringify({
    contract_id: nonEmptyString(response.contract_id),
    contract_version_id: nonEmptyString(response.contract_version_id),
    contract_digest: nonEmptyString(response.contract_digest),
    source_id: nonEmptyString(response.source_id),
    terminal: response.terminal === true,
    evidence_residency: "metadata_only",
    decision: decision ? {
      status: nonEmptyString(decision.status),
      authority: "synapsor_cloud",
      actor_fingerprint: actor ? canonicalJsonDigest({ actor }) : undefined,
      decided_at: nonEmptyString(decision.decided_at),
    } : undefined,
    job: job ? {
      job_id: nonEmptyString(job.job_id),
      status: nonEmptyString(job.status),
      attempt_count: typeof job.attempt_count === "number" ? job.attempt_count : undefined,
      leased_runner_id: nonEmptyString(job.leased_runner_id),
      lease_expires_at: job.lease_expires_at,
    } : undefined,
    result: result ? {
      status: nonEmptyString(result.status),
      source_database_mutated: result.source_database_mutated === true,
      affected_rows: typeof result.affected_rows === "number" ? result.affected_rows : undefined,
      receipt_id: nonEmptyString(result.receipt_id),
      result_hash: nonEmptyString(result.result_hash),
      error_code: nonEmptyString(result.error_code),
    } : undefined,
    updated_at: response.updated_at,
  })) as Record<string, unknown>;
}

function classifyCloudSyncFailure(error: unknown): { error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean } {
  if (error instanceof CloudControlError) {
    const reconciliation = [409, 412, 422].includes(error.status) || ["contract_digest_mismatch", "proposal_hash_mismatch", "cloud_state_conflict"].includes(error.error_code);
    return {
      error_code: error.error_code,
      retryable: error.retryable && !reconciliation,
      ...(error.retry_after_ms === undefined ? {} : { retry_after_ms: error.retry_after_ms }),
      ...(reconciliation ? { reconciliation: true } : {}),
    };
  }
  if (error instanceof McpRuntimeError) return { error_code: error.code, retryable: false };
  return { error_code: "cloud_sync_internal", retryable: false };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
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
  const provenance = {
    digest: canonicalJsonDigest(contract),
    version: contract.metadata?.version ?? contract.spec_version,
  };
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
    config.capabilities.push(runtimeCapabilityFromSpec(capability, resources, config, provenance));
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
    tenant_binding: context.tenant_binding,
    principal_binding: context.principal_binding,
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
  provenance: { digest: `sha256:${string}`; version: string },
): RuntimeCapabilityConfig {
  const subjectResource = capability.subject.resource ? resources.get(capability.subject.resource) : undefined;
  const source = resolveCapabilitySource(capability, config);
  const target = {
    schema: subjectResource?.schema ?? capability.subject.schema ?? "",
    table: subjectResource?.table ?? capability.subject.table ?? "",
    primary_key: subjectResource?.primary_key ?? capability.subject.primary_key ?? "",
    tenant_key: subjectResource?.tenant_key ?? capability.subject.tenant_key,
    principal_scope_key: capability.subject.principal_scope_key,
    single_tenant_dev: subjectResource?.single_tenant_dev ?? capability.subject.single_tenant_dev,
  };
  const runtime: RuntimeCapabilityConfig = {
    name: capability.name,
    kind: capability.kind === "proposal" ? "proposal" : capability.kind === "aggregate_read" ? "aggregate_read" : "read",
    contract_provenance: provenance,
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
    ...(capability.aggregate ? { aggregate: capability.aggregate } : {}),
  };
  if (capability.kind === "proposal" && capability.proposal) {
    runtime.patch = capability.proposal.patch;
    runtime.allowed_columns = capability.proposal.allowed_fields;
    runtime.numeric_bounds = capability.proposal.numeric_bounds;
    runtime.transition_guards = capability.proposal.transition_guards;
    runtime.reversibility = capability.proposal.reversibility;
    runtime.operation = capability.proposal.operation;
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
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested.");
  }
  const env = options.env ?? process.env;
  const storePath = options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  const sharedPostgres = config.storage?.shared_postgres;
  const ownsStore = !options.store;
  const store = options.store ?? createDefaultRuntimeStore(config, env, storePath);
  const ownsResources = !options.sharedResources;
  const resources = options.sharedResources ?? createMcpRuntimeSharedResources(config, env, options.readRow, options.clock, options.credentialResolver);
  const readRow = resources.readRow;
  const cloudClient = options.controlPlaneClient ?? (config.mode === "cloud" ? createCloudClient(config, env) : undefined);
  const cloudTools = options.cloudTools ?? [];
  const resultFormat = options.resultFormat ?? config.result_format ?? 1;
  const trustedContext = options.trustedContext;
  if (config.governance?.mode === "cloud_linked") loadCloudLinkedConnection(config, env);
  const cloudSynchronizer = ownsStore && config.governance?.mode === "cloud_linked"
    ? new CloudLinkedSynchronizer(config, store, env)
    : undefined;
  cloudSynchronizer?.start();
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
        if (capability?.kind === "proposal") await cloudSynchronizer?.synchronizeBeforeProposal();
        if (capability) {
          const context = resolveTrustedContext(config, env, capability, trustedContext);
          await resources.consumeRateLimit(context, capability.name);
        }
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
      return readLocalResource(store, uri, config, env, trustedContext);
    },
    poolMetrics: () => resources.poolMetrics(),
    rateLimitMetrics: () => resources.rateLimitMetrics(),
    cloudSyncStatus: async () => cloudSynchronizer
      ? cloudSynchronizer.status()
      : ({ authority_mode: "local_only", evidence_residency: "metadata_only", pending: 0, leased: 0, acknowledged: 0, dead_letter: 0, reconciliation_required: 0 }),
    close: async () => {
      await cloudSynchronizer?.stop();
      if (ownsResources) await resources.close();
      if (!options.store) await store.close();
    },
  };
}

export function createMcpRuntimeSharedResources(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  customReadRow?: DbRowReader,
  clock: () => number = Date.now,
  credentialResolver?: TenantCredentialResolver,
): McpRuntimeSharedResources {
  const databasePools = customReadRow ? undefined : new RuntimeDatabasePools(env, credentialResolver);
  const rateLimiter = config.rate_limits && config.rate_limits.enabled !== false
    ? new RuntimeRateLimiter(config, env, clock)
    : undefined;
  return {
    readRow: customReadRow ?? ((input) => databasePools!.read(input)),
    consumeRateLimit: async (context, capability) => {
      await rateLimiter?.consume(context, capability);
    },
    poolMetrics: () => databasePools?.metrics() ?? [],
    rateLimitMetrics: () => rateLimiter?.metrics() ?? [],
    close: async () => {
      await databasePools?.close();
      await rateLimiter?.close();
    },
  };
}

/**
 * Verify shared PostgreSQL RLS roles and target policies before opening an MCP
 * listener. Resolver-backed HTTP-claim sources are checked on first scoped
 * request because no trusted tenant exists at process startup.
 */
export async function preflightPostgresDatabaseScope(
  inputConfig: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  credentialResolver?: TenantCredentialResolver,
  trustedContext?: TrustedContext,
): Promise<void> {
  const config = resolveRuntimeConfig(inputConfig);
  assertValidRunnerCapabilityConfig(config);
  const inspected = new Set<string>();
  for (const capability of localCapabilities(config)) {
    const sourceName = capability.source;
    const source = config.sources?.[sourceName];
    if (!source || source.engine !== "postgres" || source.database_scope?.mode !== "postgres_rls") continue;
    let context = trustedContext;
    if (!context) {
      try {
        context = resolveTrustedContext(config, env, capability);
      } catch (error) {
        if (source.credential_scope?.mode === "tenant_resolver") {
          if (configUsesHttpClaims(config)) continue;
          throw error;
        }
        context = { tenant_id: "__startup_preflight__", principal: "__startup_preflight__", provenance: "static_dev" };
      }
    }
    const credential = await resolveRuntimeSourceCredential({
      sourceName,
      source,
      context,
      env,
      resolver: credentialResolver,
    });
    const key = `${credential.poolKey}\u0000${capability.target.schema}\u0000${capability.target.table}`;
    if (inspected.has(key)) continue;
    const pool = createPostgresPool(credential.connectionUrl, {
      max: 1,
      connectionTimeoutMillis: source.pool?.connection_timeout_ms ?? 3000,
      idleTimeoutMillis: source.pool?.idle_timeout_ms ?? 30000,
    });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await assertPostgresRlsTarget(client, {
        schema: capability.target.schema,
        table: capability.target.table,
        scope: {
          tenantSetting: source.database_scope.tenant_setting,
          principalSetting: source.database_scope.principal_setting,
        },
        operations: ["SELECT"],
      });
      inspected.add(key);
    } catch {
      throw new McpRuntimeError(
        "POSTGRES_RLS_PREREQUISITE_FAILED",
        `PostgreSQL RLS prerequisites failed for configured target ${capability.target.schema}.${capability.target.table}; Runner refused to serve hardened source ${sourceName}.`,
      );
    } finally {
      client?.release();
      await pool.end();
    }
  }
}

export function createDefaultRuntimeStore(config: RuntimeConfig, env: NodeJS.ProcessEnv, storePath: string): ProposalRuntimeStore {
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
      maxEntries: sharedPostgres.max_entries,
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

export async function serveStdio(options: { configPath?: string; storePath?: string; config?: RuntimeConfig; toolNameStyle?: ToolNameStyle; resultFormat?: ResultFormat; stdin?: Readable; stdout?: Writable; readRow?: DbRowReader; credentialResolver?: TenantCredentialResolver } = {}): Promise<void> {
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
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

export async function startHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<HttpMcpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const authTokenEnv = options.authTokenEnv ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const env = options.env ?? process.env;
  const devNoAuth = options.devNoAuth === true;
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  const metricsAccess = resolveMetricsEndpointAccess(config, env, host);

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
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
  await preflightPostgresDatabaseScope(config, env, options.credentialResolver);
  const runtime = createMcpRuntime(config, {
    env,
    storePath: options.storePath,
    resultFormat: options.resultFormat,
    readRow: options.readRow,
    credentialResolver: options.credentialResolver,
    cloudTools,
  });
  const readinessCheck = options.readinessCheck ?? (() => checkRunnerReadiness(config, env));
  const server = createServer((request, response) => {
    void handleHttpMcpRequest({
      request,
      response,
      runtime,
      authToken,
      devNoAuth,
      corsOrigin: options.corsOrigin,
      readinessCheck,
      metricsAccess,
      metricsProvider: () => renderRuntimeMetrics(runtime.store, runtime.poolMetrics(), runtime.rateLimitMetrics(), readinessCheck),
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
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  assertValidRunnerCapabilityConfig(config);
  const usesSessionAuth = configUsesHttpClaims(config);
  const metricsAccess = resolveMetricsEndpointAccess(config, env, host);

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
  const sessionVerifier = usesSessionAuth
    ? sessionAuthVerifier(config, env, options.configPath ? path.dirname(path.resolve(options.configPath)) : process.cwd())
    : undefined;
  const readinessCheck = options.readinessCheck ?? (() => checkRunnerReadiness(config, env));
  if (options.tls?.requestClientCert && !options.tls.ca) {
    throw new McpRuntimeError("MTLS_CA_REQUIRED", "Streamable HTTP mTLS requires a CA bundle when client certificates are required.");
  }

  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
  await preflightPostgresDatabaseScope(config, env, options.credentialResolver);
  const sharedStorePath = options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  const sharedStore = createDefaultRuntimeStore(config, env, sharedStorePath);
  const cloudSynchronizer = config.governance?.mode === "cloud_linked"
    ? new CloudLinkedSynchronizer(config, sharedStore, env)
    : undefined;
  cloudSynchronizer?.start();
  const sharedResources = createMcpRuntimeSharedResources(config, env, options.readRow, Date.now, options.credentialResolver);
  const sessions = new Map<string, StreamableHttpSession>();
  const openSessions = new Set<StreamableHttpSession>();
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    void handleStreamableHttpMcpRequest({
      request,
      response,
      config,
      storePath: sharedStorePath,
      sharedStore,
      sharedResources,
      cloudTools,
      env,
      toolNameStyle: options.toolNameStyle,
      resultFormat: options.resultFormat,
      authToken,
      sessionVerifier,
      devNoAuth,
      corsOrigin: options.corsOrigin,
      sessions,
      openSessions,
      readinessCheck,
      metricsAccess,
      metricsProvider: () => renderRuntimeMetrics(sharedStore, sharedResources.poolMetrics(), sharedResources.rateLimitMetrics(), readinessCheck),
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
    await cloudSynchronizer?.stop();
    await closeStreamableSessions(openSessions);
    await sharedResources.close();
    await sharedStore.close();
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
        ? `Auth: signed per-session JWT (${config.session_auth?.provider})\n`
        : `Auth: bearer token from ${authTokenEnv}\n`);
    log.write(`Config: ${options.configPath ?? "synapsor.runner.json"}\n`);
    log.write(`Store: ${options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db"}\n`);
  }

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: () => closeStreamableHttpServer(server, openSessions, sharedResources, sharedStore, cloudSynchronizer),
  };
}

async function handleStreamableHttpMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  storePath?: string;
  sharedStore: ProposalRuntimeStore;
  sharedResources: McpRuntimeSharedResources;
  cloudTools?: LocalToolMetadata[];
  env: NodeJS.ProcessEnv;
  toolNameStyle?: ToolNameStyle;
  resultFormat?: ResultFormat;
  authToken?: string;
  sessionVerifier?: JwtVerifier;
  devNoAuth: boolean;
  corsOrigin?: string;
  sessions: Map<string, StreamableHttpSession>;
  openSessions: Set<StreamableHttpSession>;
  readinessCheck: () => Promise<ReadinessReport>;
  metricsAccess: MetricsEndpointAccess;
  metricsProvider: () => Promise<string>;
}): Promise<void> {
  const { request, response, config, storePath, sharedStore, sharedResources, cloudTools, env, toolNameStyle, resultFormat, authToken, sessionVerifier, devNoAuth, corsOrigin, sessions, openSessions, readinessCheck, metricsAccess, metricsProvider } = input;
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
        status: "live",
        transport: "streamable-http",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = await readinessCheck();
      writeJson(response, readiness.ok ? 200 : 503, readiness);
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      await handleMetricsRequest(request, response, metricsAccess, metricsProvider);
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    const authentication = await authenticateStreamableRequest(config, request.headers.authorization, sessionVerifier, authToken, devNoAuth);
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
    const runtime = createMcpRuntime(config, {
      env,
      storePath,
      store: sharedStore,
      sharedResources,
      resultFormat,
      cloudTools,
      trustedContext: authentication.context,
    });
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
  readinessCheck: () => Promise<ReadinessReport>;
  metricsAccess: MetricsEndpointAccess;
  metricsProvider: () => Promise<string>;
}): Promise<void> {
  const { request, response, runtime, authToken, devNoAuth, corsOrigin, readinessCheck, metricsAccess, metricsProvider } = input;
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
        status: "live",
        transport: "http",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = await readinessCheck();
      writeJson(response, readiness.ok ? 200 : 503, readiness);
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      await handleMetricsRequest(request, response, metricsAccess, metricsProvider);
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

function resolveMetricsEndpointAccess(config: RuntimeConfig, env: NodeJS.ProcessEnv, host: string): MetricsEndpointAccess {
  if (config.metrics?.enabled !== true) return { enabled: false };
  const tokenEnv = config.metrics.token_env;
  const token = tokenEnv ? envValue(env, tokenEnv) : undefined;
  if (tokenEnv && !token) {
    throw new McpRuntimeError("METRICS_AUTH_TOKEN_MISSING", `${tokenEnv} is not set. Metrics uses a separate bearer token.`);
  }
  if (!isLoopbackHost(host) && !token) {
    throw new McpRuntimeError("METRICS_AUTH_REQUIRED", "Non-loopback metrics exposure requires metrics.token_env with a separate bearer token.");
  }
  return { enabled: true, ...(token ? { token } : {}) };
}

async function handleMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  access: MetricsEndpointAccess,
  provider: () => Promise<string>,
): Promise<void> {
  if (!access.enabled) {
    writeJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  if (access.token && !validBearerToken(request.headers.authorization, access.token)) {
    writeJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const body = await provider();
  response.statusCode = 200;
  response.setHeader("content-type", "application/openmetrics-text; version=1.0.0; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

async function renderRuntimeMetrics(
  store: ProposalRuntimeStore,
  poolMetrics: RuntimePoolMetric[],
  rateLimitMetrics: RuntimeRateLimitMetric[],
  readinessCheck: () => Promise<ReadinessReport>,
): Promise<string> {
  const operational = store.operationalMetrics ? await store.operationalMetrics() : [];
  const fleetEvents = store.fleetEventMetrics ? await store.fleetEventMetrics() : [];
  const readiness = await readinessCheck();
  const lines = [
    "# HELP synapsor_ready Whether all required Runner dependencies are ready.",
    "# TYPE synapsor_ready gauge",
    `synapsor_ready ${readiness.ok ? 1 : 0}`,
  ];
  for (const component of readiness.components) {
    lines.push(`synapsor_readiness_component{component="${prometheusLabel(component.name)}"} ${component.ok ? 1 : 0}`);
  }
  const counters: Array<[keyof (typeof operational)[number], string]> = [
    ["proposals", "synapsor_proposals_total"],
    ["approvals", "synapsor_approvals_total"],
    ["rejections", "synapsor_rejections_total"],
    ["applies", "synapsor_applies_total"],
    ["conflicts", "synapsor_conflicts_total"],
    ["failures", "synapsor_failures_total"],
  ];
  for (const row of operational) {
    const labels = `tenant="${prometheusLabel(row.tenant_id)}",capability="${prometheusLabel(row.capability)}"`;
    for (const [field, name] of counters) lines.push(`${name}{${labels}} ${row[field]}`);
  }
  for (const row of fleetEvents) {
    const labels = `tenant="${prometheusLabel(row.tenant_id)}",capability="${prometheusLabel(row.capability)}"`;
    lines.push(`synapsor_worker_retries_total{${labels}} ${row.worker_retries}`);
    lines.push(`synapsor_dead_letters_total{${labels}} ${row.dead_letters}`);
    lines.push(`synapsor_auto_approval_limit_trips_total{${labels}} ${row.auto_approval_limit_trips}`);
  }
  for (const row of rateLimitMetrics) {
    lines.push(`synapsor_rate_limit_rejections_total{tenant="${prometheusLabel(row.tenant)}",capability="${prometheusLabel(row.capability)}"} ${row.rejected}`);
  }
  for (const row of poolMetrics) {
    const labels = `source="${prometheusLabel(row.source)}",engine="${prometheusLabel(row.engine)}"`;
    lines.push(`synapsor_source_pool_active{${labels}} ${row.active}`);
    lines.push(`synapsor_source_pool_waiting{${labels}} ${row.waiting}`);
    lines.push(`synapsor_source_pool_max{${labels}} ${row.max}`);
  }
  lines.push("# EOF", "");
  return lines.join("\n");
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

type StreamableAuthentication = {
  fingerprint: string;
  context?: TrustedContext;
};

function configUsesHttpClaims(config: RuntimeConfig): boolean {
  if (config.trusted_context?.provider === "http_claims") return true;
  return Object.values(config.contexts ?? {}).some((context) => context.provider === "http_claims");
}

export async function checkRunnerReadiness(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): Promise<ReadinessReport> {
  const components: ReadinessComponent[] = [{ name: "config", ok: true, code: "CONFIG_READY", latency_ms: 0 }];
  for (const [sourceName, source] of Object.entries(config.sources ?? {})) {
    components.push(await readinessComponent(`source:${sourceName}`, "SOURCE_READY", "SOURCE_UNAVAILABLE", timeoutMs, async () => {
      const databaseUrl = envValue(env, source.read_url_env);
      if (!databaseUrl) throw new Error("source URL unavailable");
      await probeDatabase(source.engine, databaseUrl, timeoutMs);
    }));
  }

  if (config.mode === "review") {
    const checkedWriteSources = new Set<string>();
    for (const capability of config.capabilities ?? []) {
      if (capability.kind !== "proposal" || capabilityWritebackMode(capability) !== "direct_sql") continue;
      const source = config.sources?.[capability.source];
      if (!source?.write_url_env || checkedWriteSources.has(capability.source)) continue;
      checkedWriteSources.add(capability.source);
      components.push(await readinessComponent(`writeback:${capability.source}`, "WRITEBACK_READY", "WRITEBACK_UNAVAILABLE", timeoutMs, async () => {
        const databaseUrl = envValue(env, source.write_url_env!);
        if (!databaseUrl) throw new Error("writeback URL unavailable");
        await probeDatabase(source.engine, databaseUrl, timeoutMs);
      }));
    }

    const checkedExecutors = new Set<string>();
    for (const capability of config.capabilities ?? []) {
      if (capability.kind !== "proposal" || capabilityWritebackMode(capability) !== "app_handler") continue;
      const executorName = capabilityWritebackExecutor(capability);
      if (!executorName || checkedExecutors.has(executorName)) continue;
      checkedExecutors.add(executorName);
      components.push(await readinessComponent(`executor:${executorName}`, "EXECUTOR_READY", "EXECUTOR_UNAVAILABLE", timeoutMs, async () => {
        const executor = isRecord(config.executors?.[executorName]) ? config.executors?.[executorName] : undefined;
        if (!executor) throw new Error("executor missing");
        if (executor.type === "http_handler") {
          if (typeof executor.url_env !== "string" || !envValue(env, executor.url_env)) throw new Error("handler URL unavailable");
          const handlerUrl = envValue(env, executor.url_env)!;
          const auth = isRecord(executor.auth) ? executor.auth : undefined;
          if (auth?.type === "bearer_env" && (typeof auth.token_env !== "string" || !envValue(env, auth.token_env))) throw new Error("handler token unavailable");
          const response = await fetch(handlerUrl, {
            method: "HEAD",
            headers: auth?.type === "bearer_env" && typeof auth.token_env === "string"
              ? { authorization: `Bearer ${envValue(env, auth.token_env)}` }
              : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.status >= 500 || response.status === 401 || response.status === 403) throw new Error("handler endpoint unavailable");
        }
        if (executor.type === "command_handler" && (typeof executor.command_env !== "string" || !envValue(env, executor.command_env))) {
          throw new Error("handler command unavailable");
        }
      }));
    }
  }

  const shared = config.storage?.shared_postgres;
  if (shared?.mode === "runtime_store") {
    components.push(await readinessComponent("ledger", "LEDGER_READY", "LEDGER_UNAVAILABLE", timeoutMs, async () => {
      const databaseUrl = envValue(env, shared.url_env);
      if (!databaseUrl) throw new Error("ledger URL unavailable");
      const pool = createPostgresPool(databaseUrl, { connectionTimeoutMillis: timeoutMs });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
        const table = `${quotePostgresIdentifier(shared.schema ?? "synapsor_runner")}.ledger_entries`;
        await client.query(
          `INSERT INTO ${table} (entry_key, kind, payload_json) VALUES ($1, 'readiness_probe', '{}'::jsonb)`,
          [`readiness:${crypto.randomUUID()}`],
        );
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    }));
  }
  const ok = components.every((component) => component.ok);
  return { ok, status: ok ? "ready" : "not_ready", components };
}

async function readinessComponent(
  name: string,
  successCode: string,
  failureCode: string,
  timeoutMs: number,
  check: () => Promise<void>,
): Promise<ReadinessComponent> {
  const started = performance.now();
  try {
    await withReadinessTimeout(check(), timeoutMs);
    return { name, ok: true, code: successCode, latency_ms: Math.max(0, Math.round(performance.now() - started)) };
  } catch {
    return { name, ok: false, code: failureCode, latency_ms: Math.max(0, Math.round(performance.now() - started)) };
  }
}

async function withReadinessTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("readiness timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDatabase(engine: SourceEngine, databaseUrl: string, timeoutMs: number): Promise<void> {
  if (engine === "postgres") {
    const pool = createPostgresPool(databaseUrl, { connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs });
    try {
      await pool.query("SELECT 1");
    } finally {
      await pool.end();
    }
    return;
  }
  const connection = await mysql.createConnection({ uri: databaseUrl, dateStrings: true, connectTimeout: timeoutMs });
  try {
    await connection.query("SELECT 1");
  } finally {
    await connection.end();
  }
}

function sessionAuthVerifier(config: RuntimeConfig, env: NodeJS.ProcessEnv, baseDir: string): JwtVerifier {
  const auth = config.session_auth;
  if (!auth) throw new McpRuntimeError("SESSION_AUTH_REQUIRED", "http_claims trusted context requires signed session_auth.");
  try {
    return createJwtVerifier(auth, env, { baseDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : "session authentication is not ready";
    throw new McpRuntimeError("SESSION_AUTH_INVALID", message);
  }
}

async function authenticateStreamableRequest(
  config: RuntimeConfig,
  authorization: string | undefined,
  sessionVerifier: JwtVerifier | undefined,
  staticToken: string | undefined,
  devNoAuth: boolean,
): Promise<StreamableAuthentication | undefined> {
  if (devNoAuth) return { fingerprint: "dev-no-auth" };
  const token = bearerToken(authorization);
  if (!token) return undefined;
  if (!configUsesHttpClaims(config)) {
    if (!staticToken || !validBearerToken(authorization, staticToken)) return undefined;
    return { fingerprint: tokenFingerprint(token) };
  }
  try {
    if (!sessionVerifier) return undefined;
    const context = await verifySessionJwt(config, token, sessionVerifier);
    return { fingerprint: tokenFingerprint(token), context };
  } catch {
    return undefined;
  }
}

async function verifySessionJwt(config: RuntimeConfig, token: string, verifier: JwtVerifier): Promise<TrustedContext> {
  const auth = config.session_auth;
  if (!auth) throw new Error("session auth is not configured");
  const { payload: claims } = await verifier(token);
  const tenant = safeSessionClaim(claims[auth.tenant_claim ?? "tenant_id"]);
  const principal = safeSessionClaim(claims[auth.principal_claim ?? "sub"]);
  if (!tenant || !principal) throw new Error("JWT trusted context claims are missing or unsafe");
  return { tenant_id: tenant, principal, provenance: "http_claims" };
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

async function closeStreamableHttpServer(
  server: Server,
  sessions: Set<StreamableHttpSession>,
  sharedResources: McpRuntimeSharedResources,
  sharedStore: ProposalRuntimeStore,
  cloudSynchronizer?: CloudLinkedSynchronizer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).finally(async () => {
    await cloudSynchronizer?.stop();
    await closeStreamableSessions(sessions);
    await sharedResources.close();
    await sharedStore.close();
  });
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
    if (Array.isArray(property.enum)) {
      const allowed = property.enum.map((item) => scalar(item));
      valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]).refine((value) => allowed.includes(value), "value is not allowlisted");
    } else if (property.type === "number" || property.type === "integer") valueSchema = z.number();
    else if (property.type === "boolean") valueSchema = z.boolean();
    else valueSchema = z.string();
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
  if (capability.kind === "proposal") {
    await assertCloudLinkedProposalAvailability(input.config, input.env);
  }
  const source = input.config.sources?.[capability.source];
  if (!source) throw new McpRuntimeError("SOURCE_NOT_FOUND", `Unknown source: ${capability.source}`);
  const context = resolveTrustedContext(input.config, input.env, capability, input.trustedContext);
  const operation = capability.kind === "proposal" ? capability.operation?.kind ?? "update" : "update";
  const setOperation = isSetCapability(capability);
  const batchInsert = setOperation && operation === "insert";
  const batchItems = batchInsert ? batchItemsFromArgs(capability, input.args) : [];
  const current = capability.kind === "proposal" && operation === "insert"
    ? { row: {}, rows: [] as Record<string, unknown>[], rowCount: batchItems.length }
    : await input.readRow({
      sourceName: capability.source,
      source,
      capability,
      args: input.args,
      context,
      env: input.env,
    });
  if (capability.kind === "aggregate_read") {
    return recordAggregateRead({ capability, sourceName: capability.source, context, current, store: input.store, mode: input.config.mode });
  }
  const currentRows = setOperation
    ? batchInsert ? [] : current.rows ?? (current.rowCount === 1 ? [current.row] : [])
    : current.rowCount === 1 ? [current.row] : [];
  if (setOperation) {
    const maxRows = capability.operation?.max_rows ?? 0;
    const reviewedCount = batchInsert ? batchItems.length : current.rowCount;
    if (reviewedCount > maxRows) throw new McpRuntimeError("SET_ROW_CAP_EXCEEDED", `Reviewed set exceeds MAX ROWS ${maxRows}; no proposal was created.`);
    if (reviewedCount < 1) throw new McpRuntimeError("SET_EMPTY", "The reviewed set is empty; no proposal was created.");
  } else if ((capability.kind !== "proposal" || operation !== "insert") && current.rowCount !== 1) {
    throw new McpRuntimeError("ROW_NOT_FOUND", "The scoped capability read did not find exactly one authorized row.");
  }

  const patch = capability.kind !== "proposal" || operation === "delete" || batchInsert ? {} : buildPatch(capability, input.args);
  const itemPatches = batchInsert ? batchItems.map((item) => buildItemPatch(capability, item, input.args)) : [];
  const before = scalarRecord(current.row);
  const principalScope = effectivePrincipalScope(input.config, capability, context);
  const principalScopeMetadata = principalScope ? withoutPrincipalScopeValue(principalScope) : undefined;
  if (capability.kind === "proposal") {
    if (setOperation && !batchInsert) currentRows.forEach((row) => enforcePatchGuards(capability, scalarRecord(row), patch));
    else if (batchInsert) itemPatches.forEach((itemPatch) => enforcePatchGuards(capability, {}, itemPatch));
    else enforcePatchGuards(capability, before, patch);
  }
  const createdAt = new Date().toISOString();
  const proposalId = stableId("wrp", capability.operation ? {
    action: capability.name,
    operation,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    before: setOperation ? currentRows.map(scalarRecord) : before,
    patch: batchInsert ? itemPatches : patch,
    created_at: createdAt,
  } : {
    action: capability.name,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    object: String(current.row[capability.target.primary_key] ?? input.args[capability.lookup.id_from_arg]),
    before,
    patch,
    created_at: createdAt,
  });
  const resolvedDeduplication = capability.kind === "proposal" && operation === "insert" && !batchInsert
    ? resolveDeduplication(capability, proposalId, context)
    : undefined;
  const primaryDedup = resolvedDeduplication?.components.find((component) => component.column === capability.target.primary_key);
  const objectId = setOperation
    ? stableId("set", {
      capability: capability.name,
      tenant: context.tenant_id,
      principal_scope: principalScope?.value_fingerprint,
      identities: batchInsert ? batchItems : currentRows.map((row) => row[capability.target.primary_key]),
    })
    : capability.kind === "proposal" && operation === "insert"
    ? String(primaryDedup?.value ?? proposalId)
    : String(current.row[capability.target.primary_key] ?? input.args[capability.lookup.id_from_arg]);

  const evidenceBundleId = stableId("ev", {
    capability: capability.name,
    source: capability.source,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    row: capability.kind === "proposal" && operation === "insert" ? undefined : setOperation ? currentRows : current.row,
    patch: capability.kind === "proposal" && operation === "insert" ? (batchInsert ? itemPatches : patch) : undefined,
    at: createdAt,
  });
  const queryFingerprint = queryFingerprintFor(capability, context);
  const changeSet = capability.kind === "proposal" ? buildChangeSet({
    config: input.config,
    capability,
    args: input.args,
    context,
    sourceName: capability.source,
    source,
    currentRow: current.row,
    currentRows,
    batchItems,
    itemPatches,
    patch,
    proposalId,
    createdAt,
    resolvedDeduplication,
    evidenceBundleId,
    queryFingerprint,
    objectId,
  }) : undefined;
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
      ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
    },
    items: setOperation
      ? boundedSetEvidenceItems(capability, context, operation, currentRows, itemPatches, batchItems)
      : [{
        kind: capability.kind === "proposal" && operation === "insert" ? "reviewed_insert_intent" : "external_row",
        source_id: capability.source,
        table: `${capability.target.schema}.${capability.target.table}`,
        primary_key: { column: capability.target.primary_key, value: objectId },
        tenant: capability.target.tenant_key ? { column: capability.target.tenant_key, value: context.tenant_id } : undefined,
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
        visible_row: capability.kind === "proposal" && operation === "insert" ? patch : visibleScalarRecord(capability, current.row),
        ...(resolvedDeduplication ? { deduplication: resolvedDeduplication } : {}),
      }],
  });
  if (capability.kind !== "proposal" || operation !== "insert") {
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
        principal_bound: Boolean(principalScope),
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
        statement_template: selectTemplate(capability),
        parameters_redacted: true,
      },
    });
  }

  if (capability.kind === "read") {
    return {
      status: "ok",
      action: capability.name,
      mode: input.config.mode,
      business_object: {
        type: capability.target.table,
        id: objectId,
      },
      data: visibleScalarRecord(capability, current.row),
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

  if (!changeSet) throw new McpRuntimeError("PROPOSAL_CHANGE_SET_MISSING", "Proposal change set was not constructed.");
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
  const approvalResult = input.config.governance?.mode === "cloud_linked"
    ? { proposal, approved: false }
    : await maybeAutoApproveProposal({
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
      ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
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
  if (operation !== "insert") {
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
        principal_bound: Boolean(principalScope),
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
      },
    });
  }

  await enqueueCloudLinkedProposal({
    config: input.config,
    store: input.store,
    proposal: approvalResult.proposal,
    evidenceBundleId,
    queryFingerprint,
    env: input.env,
  });

  return {
    status: input.config.governance?.mode === "cloud_linked"
      ? "pending_cloud_sync"
      : input.config.mode === "shadow"
        ? "shadow_proposal_created"
        : approvalResult.proposal.state === "approved"
          ? "approved"
          : "review_required",
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
    governance: input.config.governance?.mode === "cloud_linked"
      ? { authority: "synapsor_cloud", state: "pending_cloud_sync", evidence_residency: "metadata_only" }
      : { authority: "local" },
    writeback: changeSet.writeback,
    source_database_changed: false,
    source_database_mutated: false,
  };
}

async function recordAggregateRead(input: {
  capability: RuntimeCapabilityConfig;
  sourceName: string;
  context: TrustedContext;
  current: { row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number };
  store: ProposalRuntimeStore;
  mode: RunnerMode;
}): Promise<Record<string, unknown>> {
  const aggregate = input.capability.aggregate;
  if (!aggregate) throw new McpRuntimeError("AGGREGATE_DEFINITION_MISSING", "Aggregate capability is missing its reviewed definition.");
  if (input.current.rowCount !== 1 || (input.current.rows && input.current.rows.length !== 1)) throw new McpRuntimeError("AGGREGATE_RESULT_SHAPE_INVALID", "Aggregate adapter must return exactly one scalar envelope row.");
  const groupSize = finiteAggregateNumber(input.current.row.group_size, "AGGREGATE_GROUP_SIZE_INVALID");
  if (!Number.isSafeInteger(groupSize) || groupSize < 0) throw new McpRuntimeError("AGGREGATE_GROUP_SIZE_INVALID", "Aggregate group size must be a non-negative safe integer.");
  const suppressed = groupSize < aggregate.minimum_group_size;
  const value = suppressed ? null : finiteAggregateNumber(input.current.row.aggregate_value, "AGGREGATE_VALUE_INVALID");
  const createdAt = new Date().toISOString();
  const aggregatePrincipalScope = input.capability.target.principal_scope_key ? {
    schema_version: protocolVersions.principalScope,
    column: input.capability.target.principal_scope_key,
    value_fingerprint: canonicalJsonDigest({ principal: input.context.principal }),
  } : undefined;
  const evidenceBundleId = stableId("ev", { capability: input.capability.name, tenant: input.context.tenant_id, principal_scope: aggregatePrincipalScope?.value_fingerprint, aggregate, suppressed, value, at: createdAt });
  const queryFingerprint = queryFingerprintFor(input.capability, input.context);
  await input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    tenant_id: input.context.tenant_id,
    principal: input.context.principal,
    capability: input.capability.name,
    source_id: input.sourceName,
    source_table: `${input.capability.target.schema}.${input.capability.target.table}`,
    business_object: `${input.capability.target.table}_aggregate`,
    object_id: queryFingerprint,
    query_fingerprint: queryFingerprint,
    payload: {
      capability: input.capability.name,
      source_id: input.sourceName,
      principal: input.context.principal,
      tenant_id: input.context.tenant_id,
      binding_provenance: input.context.provenance,
      ...(aggregatePrincipalScope ? { principal_scope: aggregatePrincipalScope } : {}),
      aggregate: aggregate.function,
      aggregate_column: aggregate.column ?? null,
      count_mode: aggregate.count_mode ?? null,
      fixed_selection: aggregate.selection ?? null,
      minimum_group_size: aggregate.minimum_group_size,
      suppressed,
      ...(suppressed ? {} : { aggregate_result: value }),
      member_rows_included: false,
      source_database_changed: false,
    },
    items: [],
  });
  await input.store.recordQueryAudit({
    evidence_bundle_id: evidenceBundleId,
    tenant_id: input.context.tenant_id,
    principal: input.context.principal,
    capability: input.capability.name,
    business_object: `${input.capability.target.table}_aggregate`,
    object_id: queryFingerprint,
    source_id: input.sourceName,
    query_fingerprint: queryFingerprint,
    table_name: `${input.capability.target.schema}.${input.capability.target.table}`,
    row_count: 1,
    payload: {
      capability: input.capability.name,
      operation: "reviewed_aggregate_read",
      aggregate: aggregate.function,
      aggregate_column: aggregate.column ?? null,
      count_mode: aggregate.count_mode ?? null,
      fixed_selection: aggregate.selection ?? null,
      tenant_bound: Boolean(input.capability.target.tenant_key),
      principal_bound: Boolean(aggregatePrincipalScope),
      ...(aggregatePrincipalScope ? { principal_scope: aggregatePrincipalScope } : {}),
      minimum_group_size: aggregate.minimum_group_size,
      suppressed,
      source_member_count_recorded: false,
      raw_sql_included: false,
      parameters_redacted: true,
    },
  });
  return {
    status: suppressed ? "suppressed" : "ok",
    action: input.capability.name,
    mode: input.mode,
    business_object: { type: `${input.capability.target.table}_aggregate`, id: queryFingerprint },
    data: {
      function: aggregate.function,
      column: aggregate.column ?? null,
      suppressed,
      minimum_group_size: aggregate.minimum_group_size,
      value,
      member_rows_included: false,
    },
    trusted_context: { tenant_id: input.context.tenant_id, principal: input.context.principal, provenance: input.context.provenance },
    evidence_bundle_id: evidenceBundleId,
    evidence_resource: `synapsor://evidence/${evidenceBundleId}`,
    source_database_changed: false,
    source_database_mutated: false,
  };
}

function finiteAggregateNumber(value: unknown, code: string): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new McpRuntimeError(code, "Aggregate adapter returned a non-finite scalar.");
  return number;
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
    const operation = capability?.operation?.kind ?? "update";
    const writebackMode = executor === "read_only" || executor === "none"
      ? "proposal_only"
      : executor && executor !== "sql_update" && executor !== "trusted_worker_required"
        ? "app_handler"
        : operation === "insert"
          ? "direct_insert"
          : operation === "delete"
            ? "direct_delete"
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
          operation,
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
    summary: kind === "aggregate_read"
      ? `Read one reviewed aggregate through ${action}. Source member rows exposed: no. Source database changed: no.`
      : `Read ${objectType} ${objectId} through ${action}. Source database changed: no.`,
    action,
    kind,
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
  if (isSetCapability(input.capability)) return { proposal: input.proposal, approved: false };
  if (input.capability.operation?.kind === "delete") return { proposal: input.proposal, approved: false };
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
  if (runtimeCode === "RATE_LIMITED") {
    const retryAfter = error instanceof McpRuntimeError && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : undefined;
    return { code: "RATE_LIMITED", message: "The trusted tenant request limit was reached. Retry after the current window.", retryable: true, ...(retryAfter ? { retry_after_ms: retryAfter } : {}) };
  }
  if (runtimeCode === "CLOUD_RATE_LIMITED") {
    const retryAfter = error instanceof McpRuntimeError && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : DEFAULT_INFRA_RETRY_AFTER_MS;
    return { code: "RATE_LIMITED", message: "Synapsor Cloud is rate limiting proposal submissions. Retry after the current window.", retryable: true, retry_after_ms: retryAfter };
  }
  if (runtimeCode === "CLOUD_TEMPORARILY_UNAVAILABLE") {
    return temporarilyUnavailableError("Synapsor Cloud is temporarily unavailable. Retry later or enable reviewed durable proposal queueing.", error);
  }
  if (runtimeCode && ["CLOUD_RUNNER_AUTHENTICATION_FAILED", "CLOUD_RUNNER_AUTHORIZATION_FAILED", "CLOUD_CONNECTION_CONFLICT"].includes(runtimeCode)) {
    return { code: "POLICY_VIOLATION", message: "The reviewed Synapsor Cloud authority rejected this Runner connection.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("ARGUMENT_")
    || runtimeCode === "LOOKUP_ARG_MISSING"
    || runtimeCode === "MODEL_PREDICATE_REJECTED"
    || runtimeCode === "MODEL_CANNOT_OVERRIDE_BINDING"
    || runtimeCode === "TRUSTED_BINDING_MISSING"
    || runtimeCode === "TRUSTED_CONTEXT_MISSING"
  )) {
    return { code: "INVALID_ARGUMENT", message: "The tool input or trusted context binding is invalid.", retryable: false };
  }
  if (runtimeCode && (
    runtimeCode.startsWith("PATCH_")
    || runtimeCode.startsWith("SET_")
    || runtimeCode.startsWith("BATCH_")
    || runtimeCode === "CONFLICT_GUARD_MISSING"
  )) {
    return { code: "POLICY_VIOLATION", message: "The requested change is outside the reviewed capability policy.", retryable: false };
  }
  if (runtimeCode === "LOCAL_STORE_UNAVAILABLE") {
    return temporarilyUnavailableError(
      "The local runner store is temporarily unavailable. Restart the runner or recreate the store before retrying.",
      error,
    );
  }
  if (runtimeCode === "SOURCE_CREDENTIAL_MISSING" || isTransientInfrastructureError(error)) {
    return temporarilyUnavailableError("The database is temporarily unavailable. Retry later.", error);
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
    runtime_code: safeRuntimeErrorCode(error),
    retry_after_ms: safe.retry_after_ms,
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

const DEFAULT_INFRA_RETRY_AFTER_MS = 1000;
const MAX_INFRA_RETRY_AFTER_MS = 60_000;
const TRANSIENT_RUNTIME_CODES = new Set(["SOURCE_POOL_QUEUE_FULL", "SOURCE_POOL_TIMEOUT"]);
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
const TRANSIENT_POSTGRES_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "55P03", // lock_not_available
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "57014", // query_canceled, including reviewed statement_timeout
]);
const TRANSIENT_MYSQL_CODES = new Set([
  "ER_CON_COUNT_ERROR",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_SERVER_SHUTDOWN",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "ER_QUERY_TIMEOUT",
  "PROTOCOL_CONNECTION_LOST",
]);
const TRANSIENT_MYSQL_ERRNOS = new Set([1040, 1053, 1203, 1205, 1213, 2002, 2003, 2006, 2013, 3024]);

function temporarilyUnavailableError(
  message: string,
  error: unknown,
): NonNullable<ResultEnvelopeV2["error"]> {
  return {
    code: "TEMPORARILY_UNAVAILABLE",
    message,
    retryable: true,
    retry_after_ms: infrastructureRetryAfterMs(error),
  };
}

function infrastructureRetryAfterMs(error: unknown): number {
  for (const candidate of errorChain(error)) {
    if (!(candidate instanceof McpRuntimeError)) continue;
    const configured = candidate.details?.retry_after_ms;
    if (typeof configured === "number" && Number.isFinite(configured)) {
      return Math.min(MAX_INFRA_RETRY_AFTER_MS, Math.max(1, Math.round(configured)));
    }
  }
  return DEFAULT_INFRA_RETRY_AFTER_MS;
}

function isTransientInfrastructureError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (candidate instanceof McpRuntimeError && TRANSIENT_RUNTIME_CODES.has(candidate.code)) return true;
    const code = errorStringProperty(candidate, "code");
    const sqlState = errorStringProperty(candidate, "sqlState") ?? errorStringProperty(candidate, "sqlstate");
    const errno = errorNumberProperty(candidate, "errno");
    if (code && (
      TRANSIENT_SYSTEM_CODES.has(code)
      || TRANSIENT_POSTGRES_CODES.has(code)
      || code.startsWith("08")
      || TRANSIENT_MYSQL_CODES.has(code)
    )) return true;
    if (sqlState && (TRANSIENT_POSTGRES_CODES.has(sqlState) || sqlState.startsWith("08"))) return true;
    if (errno !== undefined && TRANSIENT_MYSQL_ERRNOS.has(errno)) return true;
    const message = errorMessage(candidate);
    if (/\b(ECONNABORTED|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETDOWN|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT)\b/i.test(message)) return true;
    if (/\b(connection (?:queue|pool) (?:is )?(?:full|exhausted|timed out)|pool (?:is )?(?:full|exhausted)|too many (?:clients|connections)|remaining connection slots|cannot connect now)\b/i.test(message)) return true;
    if (/\b(connection (?:closed|lost|refused|reset|terminated|timed out)|database (?:is )?(?:starting up|shutting down|temporarily unavailable)|operation timed out|server closed the connection|socket hang up|timeout expired)\b/i.test(message)) return true;
  }
  return false;
}

function safeRuntimeErrorCode(error: unknown): string {
  if (error instanceof McpRuntimeError) return error.code;
  for (const candidate of errorChain(error)) {
    const code = errorStringProperty(candidate, "code");
    const sqlState = errorStringProperty(candidate, "sqlState") ?? errorStringProperty(candidate, "sqlstate");
    const errno = errorNumberProperty(candidate, "errno");
    if (code && TRANSIENT_SYSTEM_CODES.has(code)) return `NODE_${code}`;
    if (code && TRANSIENT_MYSQL_CODES.has(code)) return `MYSQL_${code}`;
    if (errno !== undefined && TRANSIENT_MYSQL_ERRNOS.has(errno)) return `MYSQL_${errno}`;
    if (code && (TRANSIENT_POSTGRES_CODES.has(code) || code.startsWith("08"))) return `POSTGRES_${code}`;
    if (sqlState && (TRANSIENT_POSTGRES_CODES.has(sqlState) || sqlState.startsWith("08"))) return `POSTGRES_${sqlState}`;
  }
  return "UNCLASSIFIED";
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 6 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function errorStringProperty(error: unknown, property: string): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[property];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim().toUpperCase();
  return normalized || undefined;
}

function errorNumberProperty(error: unknown, property: string): number | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[property];
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(normalized) ? normalized : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "";
}

function effectivePrincipalScope(
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
): NonNullable<ChangeSetV2["guards"]["principal_scope"]> | undefined {
  const column = capability.target.principal_scope_key;
  if (!column) return undefined;
  const contextConfig = (capability.context ? config.contexts?.[capability.context] : undefined) ?? config.trusted_context;
  if (!contextConfig) throw new McpRuntimeError("TRUSTED_CONTEXT_MISSING", `Principal-scoped capability ${capability.name} has no trusted context.`);
  const binding = contextConfig.principal_binding ?? "principal";
  const value = scalar(context.principal);
  const material = { column, binding, provider: contextConfig.provider, value };
  return {
    schema_version: protocolVersions.principalScope,
    ...material,
    value_fingerprint: principalScopeFingerprint(material),
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
  currentRows: Record<string, unknown>[];
  batchItems: Record<string, unknown>[];
  itemPatches: Record<string, Scalar>[];
  patch: Record<string, Scalar>;
  proposalId: string;
  createdAt: string;
  resolvedDeduplication?: NonNullable<ChangeSetV2["guards"]["deduplication"]>;
  evidenceBundleId: string;
  queryFingerprint: string;
  objectId: string;
}): ChangeSet {
  const patch = input.patch;
  const before = scalarRecord(input.currentRow);
  const principalScope = effectivePrincipalScope(input.config, input.capability, input.context);
  if (isSetCapability(input.capability)) return buildBoundedSetChangeSet(input);
  enforcePatchGuards(input.capability, before, patch);
  const operation = input.capability.operation?.kind ?? "update";
  const after = operation === "delete" ? {} : operation === "insert" ? { ...patch } : { ...before, ...patch };
  const guard = operation === "insert" ? undefined : expectedVersionGuard(input.capability, before);
  if (operation === "update" && input.capability.operation?.version_advance?.strategy === "integer_increment") {
    const column = input.capability.operation.version_advance.column;
    if (typeof guard?.value !== "number") throw new McpRuntimeError("VERSION_ADVANCE_REQUIRES_NUMBER", `Integer version advancement requires numeric ${column}.`);
    after[column] = guard.value + 1;
  }
  if (operation === "insert" && input.resolvedDeduplication) {
    for (const component of input.resolvedDeduplication.components) after[component.column] = component.value;
  }
  if (operation === "insert" && principalScope) after[principalScope.column] = principalScope.value!;
  const writebackMode = capabilityWritebackMode(input.capability);
  const changeSetWritebackMode = writebackMode === "none" ? "read_only" : "trusted_worker_required";
  const writebackExecutor = writebackMode === "none"
    ? "none"
    : writebackMode === "cloud_worker"
      ? "cloud_worker"
      : writebackMode === "direct_sql"
        ? "sql_update"
        : capabilityWritebackExecutor(input.capability);
  const createdAt = input.createdAt;
  if (input.capability.operation) {
    const operationName = `single_row_${operation}` as ChangeSetV2["operation"];
    const proposalCore = {
      schema_version: protocolVersions.changeSetV2,
      proposal_id: input.proposalId,
      proposal_version: 1,
      action: input.capability.name,
      ...(input.capability.contract_provenance ? { contract: input.capability.contract_provenance } : {}),
      operation: operationName,
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
        primary_key: {
          column: input.capability.target.primary_key,
          ...(operation === "insert" && !input.resolvedDeduplication?.components.some((component) => component.column === input.capability.target.primary_key)
            ? {}
            : {
              value: operation === "insert"
                ? scalar(input.resolvedDeduplication?.components.find((component) => component.column === input.capability.target.primary_key)?.value)
                : scalar(input.currentRow[input.capability.target.primary_key] ?? input.objectId),
            }),
        },
      },
      before,
      patch,
      after,
      guards: {
        tenant: { column: input.capability.target.tenant_key ?? "__single_tenant_dev", value: input.capability.target.tenant_key ? input.context.tenant_id : "single_tenant_dev" },
        ...(principalScope ? { principal_scope: principalScope } : {}),
        allowed_columns: input.capability.allowed_columns ?? Object.keys(patch),
        ...(guard ? { expected_version: guard } : {}),
        ...(input.capability.operation.version_advance ? { version_advance: input.capability.operation.version_advance } : {}),
        ...(input.resolvedDeduplication ? { deduplication: input.resolvedDeduplication } : {}),
      },
      ...(input.capability.reversibility ? {
        reversibility: {
          mode: "reviewed_inverse" as const,
          lineage: {
            root_proposal_id: input.proposalId,
            parent_proposal_id: input.proposalId,
            reverts_proposal_id: input.proposalId,
            depth: 1,
          },
        },
      } : {}),
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
        ...(input.capability.approval?.required_approvals ? { required_approvals: input.capability.approval.required_approvals } : {}),
      },
      writeback: {
        status: "not_applied",
        mode: changeSetWritebackMode,
        executor: writebackExecutor,
      },
      source_database_mutated: false,
      created_at: createdAt,
    } satisfies Omit<ChangeSetV2, "integrity">;
    return { ...proposalCore, integrity: { proposal_hash: hashJson(proposalCore) } };
  }

  const proposalCore = {
    schema_version: protocolVersions.changeSet,
    proposal_id: input.proposalId,
    proposal_version: 1,
    action: input.capability.name,
    ...(input.capability.contract_provenance ? { contract: input.capability.contract_provenance } : {}),
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
      ...(principalScope ? { principal_scope: principalScope } : {}),
      allowed_columns: input.capability.allowed_columns ?? Object.keys(patch),
      expected_version: guard!,
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
      ...(input.capability.approval?.required_approvals ? { required_approvals: input.capability.approval.required_approvals } : {}),
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

function buildBoundedSetChangeSet(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  args: Record<string, unknown>;
  context: TrustedContext;
  sourceName: string;
  source: RuntimeSourceConfig;
  currentRow: Record<string, unknown>;
  currentRows: Record<string, unknown>[];
  batchItems: Record<string, unknown>[];
  itemPatches: Record<string, Scalar>[];
  patch: Record<string, Scalar>;
  proposalId: string;
  createdAt: string;
  evidenceBundleId: string;
  queryFingerprint: string;
  objectId: string;
}): ChangeSetV3 {
  const principalScope = effectivePrincipalScope(input.config, input.capability, input.context);
  const operation = input.capability.operation;
  if (!operation || operation.cardinality !== "set" || !operation.max_rows || !operation.aggregate_bounds?.length) {
    throw new McpRuntimeError("SET_GUARDS_REQUIRED", `Bounded set capability ${input.capability.name} is missing reviewed set guards.`);
  }
  const kind = operation.kind === "update" ? "set_update" : operation.kind === "delete" ? "set_delete" : "batch_insert";
  if (kind !== "batch_insert" && operation.version_advance?.strategy !== "integer_increment" && kind === "set_update") {
    throw new McpRuntimeError("SET_VERSION_ADVANCE_UNSUPPORTED", "Bounded set UPDATE currently requires integer_increment version advancement.");
  }
  const rawMembers = kind === "batch_insert"
    ? input.itemPatches.map((itemPatch, index) => {
      const deduplication = resolveBatchDeduplication(input.capability, input.batchItems[index] ?? {}, input.proposalId, input.context, index);
      const primary = deduplication.components.find((component) => component.column === input.capability.target.primary_key);
      if (!primary) throw new McpRuntimeError("BATCH_PRIMARY_KEY_REQUIRED", `Batch INSERT must derive ${input.capability.target.primary_key} from a reviewed item field.`);
      const after = { ...itemPatch };
      for (const component of deduplication.components) {
        if (Object.prototype.hasOwnProperty.call(after, component.column)) throw new McpRuntimeError("BATCH_DEDUP_COLUMN_COLLISION", `Batch deduplication column ${component.column} collides with a patch column.`);
        after[component.column] = component.value;
      }
      if (principalScope) after[principalScope.column] = principalScope.value!;
      return {
        primary_key: { column: input.capability.target.primary_key, value: primary.value },
        before: {},
        after,
        after_digest: canonicalJsonDigest({ primary_key: primary.value, after }),
        deduplication,
      };
    })
    : input.currentRows.map((rawRow) => {
      const before = scalarRecord(rawRow);
      const expectedVersion = expectedVersionGuard(input.capability, before);
      if (expectedVersion.column === "__row_hash") throw new McpRuntimeError("SET_WEAK_GUARD_FORBIDDEN", "Bounded set writes require an exact conflict-guard column.");
      const primaryValue = scalar(before[input.capability.target.primary_key]);
      if (primaryValue === null) throw new McpRuntimeError("SET_PRIMARY_KEY_MISSING", "A frozen set member is missing its reviewed primary key.");
      if (kind === "set_delete") {
        return {
          primary_key: { column: input.capability.target.primary_key, value: primaryValue },
          expected_version: expectedVersion,
          before,
          after: {},
          before_digest: canonicalJsonDigest({ primary_key: primaryValue, before }),
          tombstone_digest: canonicalJsonDigest({ primary_key: primaryValue, expected_version: expectedVersion }),
        };
      }
      const after = { ...before, ...input.patch };
      const versionAdvance = operation.version_advance;
      if (!versionAdvance || versionAdvance.strategy !== "integer_increment" || typeof expectedVersion.value !== "number") {
        throw new McpRuntimeError("SET_INTEGER_VERSION_REQUIRED", "Bounded set UPDATE requires a numeric integer_increment conflict guard.");
      }
      after[versionAdvance.column] = expectedVersion.value + 1;
      return {
        primary_key: { column: input.capability.target.primary_key, value: primaryValue },
        expected_version: expectedVersion,
        before,
        after,
        before_digest: canonicalJsonDigest({ primary_key: primaryValue, before }),
        after_digest: canonicalJsonDigest({ primary_key: primaryValue, after }),
      };
    });
  const members = rawMembers.sort((left, right) => JSON.stringify(left.primary_key.value).localeCompare(JSON.stringify(right.primary_key.value)));
  if (new Set(members.map((member) => JSON.stringify(member.primary_key.value))).size !== members.length) {
    throw new McpRuntimeError("SET_IDENTITY_NOT_UNIQUE", "Every frozen set member must have a unique primary-key identity.");
  }
  const aggregateBounds = operation.aggregate_bounds.map((bound) => ({
    column: bound.column,
    measure: bound.measure,
    maximum: bound.maximum,
    actual: aggregateValue(members, bound),
  }));
  for (const bound of aggregateBounds) {
    if (bound.actual > bound.maximum) throw new McpRuntimeError("SET_AGGREGATE_BOUND_EXCEEDED", `${bound.measure} aggregate for ${bound.column} exceeds the reviewed maximum ${bound.maximum}.`);
  }
  const frozenSet = {
    max_rows: operation.max_rows,
    row_count: members.length,
    aggregate_bounds: aggregateBounds,
    members,
    set_digest: canonicalJsonDigest({ operation: kind, members, aggregate_bounds: aggregateBounds }),
  };
  const approvalMode = input.capability.approval?.mode === "operator" ? "operator" : "human";
  const proposalCore = {
    schema_version: protocolVersions.changeSetV3,
    proposal_id: input.proposalId,
    proposal_version: 1,
    action: input.capability.name,
    ...(input.capability.contract_provenance ? { contract: input.capability.contract_provenance } : {}),
    operation: kind,
    mode: input.config.mode === "shadow" ? "shadow" : "review_required",
    principal: {
      id: input.context.principal,
      source: input.context.provenance === "environment" ? "environment" : input.context.provenance === "cloud_session" ? "cloud_session" : input.context.provenance === "static_dev" ? "static_dev" : "trusted_session",
    },
    scope: { tenant_id: input.context.tenant_id, business_object: input.capability.target.table, object_id: input.objectId },
    source: {
      kind: input.source.engine === "postgres" ? "external_postgres" : "external_mysql",
      source_id: input.sourceName,
      schema: input.capability.target.schema,
      table: input.capability.target.table,
      primary_key: { column: input.capability.target.primary_key },
    },
    before: { row_count: kind === "batch_insert" ? 0 : members.length },
    patch: kind === "set_update" ? input.patch : {},
    after: { row_count: kind === "set_delete" ? 0 : members.length },
    guards: {
      tenant: { column: input.capability.target.tenant_key ?? "__single_tenant_dev", value: input.capability.target.tenant_key ? input.context.tenant_id : "single_tenant_dev" },
      ...(principalScope ? { principal_scope: principalScope } : {}),
      allowed_columns: kind === "set_delete" ? [] : input.capability.allowed_columns ?? Object.keys(input.patch),
      ...(kind === "set_update" && operation.version_advance ? { version_advance: operation.version_advance } : {}),
    },
    frozen_set: frozenSet,
    ...(input.capability.reversibility ? {
      reversibility: {
        mode: "reviewed_inverse" as const,
        lineage: {
          root_proposal_id: input.proposalId,
          parent_proposal_id: input.proposalId,
          reverts_proposal_id: input.proposalId,
          depth: 1,
        },
      },
    } : {}),
    evidence: { bundle_id: input.evidenceBundleId, query_fingerprint: input.queryFingerprint, items: [] },
    approval: {
      status: "pending",
      mode: approvalMode,
      required_role: input.capability.approval?.required_role,
      ...(input.capability.approval?.required_approvals ? { required_approvals: input.capability.approval.required_approvals } : {}),
    },
    writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
    source_database_mutated: false,
    created_at: input.createdAt,
  } satisfies Omit<ChangeSetV3, "integrity">;
  return { ...proposalCore, integrity: { proposal_hash: hashJson(proposalCore) } };
}

function resolveBatchDeduplication(
  capability: RuntimeCapabilityConfig,
  item: Record<string, unknown>,
  proposalId: string,
  context: TrustedContext,
  index: number,
): NonNullable<ChangeSetV3["frozen_set"]["members"][number]["deduplication"]> {
  const declared = capability.operation?.deduplication?.components;
  if (!declared?.length) throw new McpRuntimeError("BATCH_DEDUPLICATION_REQUIRED", "Batch INSERT requires reviewed per-item deduplication.");
  const components = declared.map((component) => ({
    column: component.column,
    source: component.source === "item_field" ? "fixed" as const : component.source,
    value: component.source === "item_field"
      ? scalar(item[component.item_field ?? ""])
      : component.source === "proposal_id"
        ? `${proposalId}:${index}`
        : component.source === "trusted_tenant"
          ? context.tenant_id
          : scalar(component.fixed ?? null),
  }));
  if (!components.some((component) => component.column === capability.target.primary_key && component.value !== null)) {
    throw new McpRuntimeError("BATCH_PRIMARY_KEY_REQUIRED", `Batch INSERT must bind primary key ${capability.target.primary_key} from an item field.`);
  }
  if (capability.target.tenant_key && !components.some((component) => component.column === capability.target.tenant_key && component.value === context.tenant_id)) {
    throw new McpRuntimeError("BATCH_TRUSTED_TENANT_REQUIRED", "Batch INSERT deduplication must include the trusted tenant key.");
  }
  return { components };
}

function aggregateValue(
  members: ChangeSetV3["frozen_set"]["members"],
  bound: { column: string; measure: "before" | "after" | "absolute_delta" },
): number {
  return members.reduce((total, member) => {
    const before = member.before[bound.column];
    const after = member.after[bound.column];
    if (bound.measure === "before") return total + Math.abs(numericAggregateValue(before, bound.column));
    if (bound.measure === "after") return total + Math.abs(numericAggregateValue(after, bound.column));
    return total + Math.abs(numericAggregateValue(after, bound.column) - numericAggregateValue(before, bound.column));
  }, 0);
}

function numericAggregateValue(value: Scalar | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new McpRuntimeError("SET_AGGREGATE_VALUE_INVALID", `Aggregate column ${column} must contain finite reviewed numbers.`);
  return value;
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

class RuntimeRateLimiter {
  private readonly local = new Map<string, { windowStart: number; count: number }>();
  private readonly rejected = new Map<string, RuntimeRateLimitMetric>();
  private readonly sharedPool?: ReturnType<typeof createPostgresPool>;
  private readonly sharedSchema?: string;
  private readonly migration?: Promise<unknown>;

  constructor(
    private readonly config: RuntimeConfig,
    env: NodeJS.ProcessEnv,
    private readonly clock: () => number,
  ) {
    const shared = config.storage?.shared_postgres;
    if (shared?.mode === "runtime_store") {
      const databaseUrl = envValue(env, shared.url_env);
      if (!databaseUrl) throw new McpRuntimeError("POSTGRES_RUNTIME_STORE_URL_MISSING", `${shared.url_env} is required for fleet-wide rate limits.`);
      this.sharedSchema = shared.schema ?? "synapsor_runner";
      this.sharedPool = createPostgresPool(databaseUrl);
      this.migration = migrateSharedPostgresRuntimeStore(
        this.sharedPool,
        this.sharedSchema,
        shared.lock_timeout_ms ?? 10_000,
      );
    }
  }

  async consume(context: TrustedContext, capability: string): Promise<void> {
    const rule = this.config.rate_limits?.capabilities?.[capability] ?? this.config.rate_limits?.default;
    if (!rule) return;
    const now = this.clock();
    const windowMs = rule.window_seconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let count: number;
    if (this.sharedPool && this.sharedSchema) {
      await this.migration;
      const table = `${quotePostgresIdentifier(this.sharedSchema)}.rate_limit_buckets`;
      const bucketKey = crypto.createHash("sha256").update(`${context.tenant_id}\u0000${capability}`).digest("hex");
      const result = await this.sharedPool.query(
        `INSERT INTO ${table} AS bucket (bucket_key, window_start, request_count, rejected_count)
         VALUES ($1, $2, 1, 0)
         ON CONFLICT (bucket_key, window_start) DO UPDATE
         SET request_count = bucket.request_count + 1, updated_at = now()
         RETURNING request_count`,
        [bucketKey, windowStart],
      );
      count = Number(result.rows[0]?.request_count ?? 0);
      if (count > rule.requests) {
        await this.sharedPool.query(
          `UPDATE ${table} SET rejected_count = rejected_count + 1, updated_at = now() WHERE bucket_key = $1 AND window_start = $2`,
          [bucketKey, windowStart],
        );
      }
    } else {
      const key = `${context.tenant_id}\u0000${capability}`;
      const current = this.local.get(key);
      const bucket = !current || current.windowStart !== windowStart ? { windowStart, count: 0 } : current;
      bucket.count += 1;
      this.local.set(key, bucket);
      count = bucket.count;
    }
    if (count <= rule.requests) return;
    const retryAfterMs = Math.max(1, windowStart + windowMs - now);
    const metricKey = `${context.tenant_id}\u0000${capability}`;
    const metric = this.rejected.get(metricKey) ?? { tenant: context.tenant_id, capability, rejected: 0 };
    metric.rejected += 1;
    this.rejected.set(metricKey, metric);
    throw new McpRuntimeError(
      "RATE_LIMITED",
      `Capability ${capability} exceeded its trusted tenant request limit.`,
      { retry_after_ms: retryAfterMs },
    );
  }

  metrics(): RuntimeRateLimitMetric[] {
    return [...this.rejected.values()].sort((left, right) => left.tenant.localeCompare(right.tenant) || left.capability.localeCompare(right.capability));
  }

  async close(): Promise<void> {
    await this.sharedPool?.end();
  }
}

class RuntimeDatabasePools {
  private readonly postgres = new Map<string, { pool: ReturnType<typeof createPostgresPool>; expiresAt?: number; connectionDigest: string }>();
  private readonly mysqlPools = new Map<string, { pool: ReturnType<typeof mysql.createPool>; expiresAt?: number; connectionDigest: string }>();
  private readonly counters = new Map<string, { engine: SourceEngine; active: number; waiting: number; max: number }>();
  private readonly postgresRlsPreflight = new Set<string>();

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly credentialResolver?: TenantCredentialResolver,
  ) {}

  async read(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }> {
    const credential = await resolveRuntimeSourceCredential({
      sourceName: input.sourceName,
      source: input.source,
      context: input.context,
      env: this.env,
      resolver: this.credentialResolver,
    });
    const databaseUrl = credential.connectionUrl;
    const connectionDigest = crypto.createHash("sha256").update(databaseUrl).digest("hex");
    const poolKey = credential.poolKey;
    const poolConfig = input.source.pool ?? {};
    const max = poolConfig.max_connections ?? 10;
    const queueLimit = poolConfig.queue_limit ?? Math.max(10, max * 4);
    const counter = this.counters.get(input.sourceName) ?? { engine: input.source.engine, active: 0, waiting: 0, max };
    this.counters.set(input.sourceName, counter);
    if (counter.waiting >= queueLimit) throw new McpRuntimeError("SOURCE_POOL_QUEUE_FULL", `Source ${input.sourceName} connection queue is full.`);
    counter.waiting += 1;
    try {
      if (input.source.engine === "postgres") {
        let entry = this.postgres.get(poolKey);
        if (entry && ((entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) || entry.connectionDigest !== connectionDigest)) {
          this.postgres.delete(poolKey);
          this.clearPostgresRlsPreflight(poolKey);
          await entry.pool.end();
          entry = undefined;
        }
        if (!entry) {
          entry = {
            pool: createPostgresPool(databaseUrl, {
            max,
            connectionTimeoutMillis: poolConfig.connection_timeout_ms ?? 3000,
            idleTimeoutMillis: poolConfig.idle_timeout_ms ?? 30000,
            }),
            expiresAt: credential.expiresAt,
            connectionDigest,
          };
          this.postgres.set(poolKey, entry);
        }
        const client = await withPoolAcquireTimeout(
          entry.pool.connect(),
          poolConfig.queue_timeout_ms ?? 5000,
          input.sourceName,
          (lateClient) => lateClient.release(),
        );
        counter.waiting -= 1;
        counter.active += 1;
        try {
          const query = buildSelect(input.capability, "$");
          await client.query("BEGIN");
          if (input.source.statement_timeout_ms) await client.query(`SET LOCAL statement_timeout = ${Number(input.source.statement_timeout_ms)}`);
          if (input.source.database_scope?.mode === "postgres_rls") {
            const preflightKey = `${poolKey}\u0000${input.capability.target.schema}\u0000${input.capability.target.table}\u0000SELECT`;
            if (!this.postgresRlsPreflight.has(preflightKey)) {
              await assertPostgresRlsTarget(client, {
                schema: input.capability.target.schema,
                table: input.capability.target.table,
                scope: {
                  tenantSetting: input.source.database_scope.tenant_setting,
                  principalSetting: input.source.database_scope.principal_setting,
                },
                operations: ["SELECT"],
              });
              this.postgresRlsPreflight.add(preflightKey);
            }
          }
          await bindPostgresTrustedScope(client, input.source.database_scope, input.context);
          const result = await client.query(query.sql, queryValues(input.capability, input.args, input.context));
          await client.query("COMMIT");
          return { row: result.rows[0] ?? {}, rows: result.rows, rowCount: result.rowCount ?? 0 };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          counter.active -= 1;
          client.release();
        }
      }

      let entry = this.mysqlPools.get(poolKey);
      if (entry && ((entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) || entry.connectionDigest !== connectionDigest)) {
        this.mysqlPools.delete(poolKey);
        await entry.pool.end();
        entry = undefined;
      }
      if (!entry) {
        entry = {
          pool: mysql.createPool({
            uri: databaseUrl,
            dateStrings: true,
            waitForConnections: true,
            connectionLimit: max,
            maxIdle: max,
            idleTimeout: poolConfig.idle_timeout_ms ?? 30000,
            queueLimit,
            connectTimeout: poolConfig.connection_timeout_ms ?? 3000,
          }),
          expiresAt: credential.expiresAt,
          connectionDigest,
        };
        this.mysqlPools.set(poolKey, entry);
      }
      const connection = await withPoolAcquireTimeout(
        entry.pool.getConnection(),
        poolConfig.queue_timeout_ms ?? 5000,
        input.sourceName,
        (lateConnection) => lateConnection.release(),
      );
      counter.waiting -= 1;
      counter.active += 1;
      try {
        if (input.source.statement_timeout_ms) await connection.query("SET SESSION max_execution_time = ?", [Number(input.source.statement_timeout_ms)]).catch(() => undefined);
        const query = buildSelect(input.capability, "?");
        const values = queryValues(input.capability, input.args, input.context).map(scalar);
        const [rows] = await connection.execute(query.sql, values);
        const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
        return { row: list[0] ?? {}, rows: list, rowCount: list.length };
      } finally {
        counter.active -= 1;
        connection.release();
      }
    } catch (error) {
      if (counter.waiting > 0) counter.waiting -= 1;
      throw error;
    }
  }

  metrics(): RuntimePoolMetric[] {
    return [...this.counters.entries()].map(([source, value]) => ({ source, ...value }));
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.postgres.values()].map((entry) => entry.pool.end()),
      ...[...this.mysqlPools.values()].map((entry) => entry.pool.end()),
    ]);
    this.postgres.clear();
    this.mysqlPools.clear();
    this.postgresRlsPreflight.clear();
  }

  private clearPostgresRlsPreflight(poolKey: string): void {
    for (const key of this.postgresRlsPreflight) {
      if (key.startsWith(`${poolKey}\u0000`)) this.postgresRlsPreflight.delete(key);
    }
  }

}

export async function bindPostgresTrustedScope(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  scope: RuntimeDatabaseScopeConfig | undefined,
  context: TrustedContext,
): Promise<void> {
  if (!scope || scope.mode === "application") return;
  await client.query(
    "SELECT set_config($1, $2, true), set_config($3, $4, true)",
    [scope.tenant_setting, context.tenant_id, scope.principal_setting, context.principal],
  );
}

async function withPoolAcquireTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sourceName: string,
  releaseLate: (value: T) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  void promise.then((value) => {
    if (timedOut) releaseLate(value);
  }).catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new McpRuntimeError("SOURCE_POOL_TIMEOUT", `Source ${sourceName} connection queue timed out.`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readPostgresRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }> {
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
    if (input.source.database_scope?.mode === "postgres_rls") {
      await assertPostgresRlsTarget(client, {
        schema: input.capability.target.schema,
        table: input.capability.target.table,
        scope: {
          tenantSetting: input.source.database_scope.tenant_setting,
          principalSetting: input.source.database_scope.principal_setting,
        },
        operations: ["SELECT"],
      });
    }
    await bindPostgresTrustedScope(client, input.source.database_scope, input.context);
    const result = await client.query(query.sql, queryValues(input.capability, input.args, input.context));
    await client.query("COMMIT");
    return { row: result.rows[0] ?? {}, rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function readMysqlRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }> {
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
    return { row: list[0] ?? {}, rows: list, rowCount: list.length };
  } finally {
    await connection.end();
  }
}

function buildSelect(capability: RuntimeCapabilityConfig, placeholderStyle: "$" | "?"): { sql: string } {
  if (capability.kind === "aggregate_read") {
    const aggregate = capability.aggregate;
    if (!aggregate) throw new McpRuntimeError("AGGREGATE_DEFINITION_MISSING", "Aggregate capability is missing its reviewed definition.");
    const fixedTerms = aggregate.selection?.all ?? [];
    const where = fixedTerms.map((term, index) => `${quoteIdentifier(term.column, placeholderStyle)} = ${placeholderStyle === "$" ? `$${index + 1}` : "?"}`);
    if (capability.target.tenant_key) where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${fixedTerms.length + 1}` : "?"}`);
    if (capability.target.principal_scope_key) where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${fixedTerms.length + 2}` : "?"}`);
    const expression = aggregate.function === "count" && aggregate.count_mode === "rows"
      ? "COUNT(*)"
      : `${aggregate.function.toUpperCase()}(${quoteIdentifier(aggregate.column ?? "", placeholderStyle)})`;
    return { sql: `SELECT ${expression} AS aggregate_value, COUNT(*) AS group_size FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` };
  }
  const columns = readColumns(capability).map((column) => quoteIdentifier(column, placeholderStyle)).join(", ");
  if (isSetSelectionCapability(capability)) {
    const fixedTerms = capability.operation?.selection?.all ?? [];
    const where = fixedTerms.map((term, index) => `${quoteIdentifier(term.column, placeholderStyle)} = ${placeholderStyle === "$" ? `$${index + 1}` : "?"}`);
    if (capability.target.tenant_key) {
      const tenantIndex = fixedTerms.length + 1;
      where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${tenantIndex}` : "?"}`);
    }
    if (capability.target.principal_scope_key) {
      const principalIndex = fixedTerms.length + 2;
      where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${principalIndex}` : "?"}`);
    }
    const maxRows = capability.operation?.max_rows ?? 0;
    return {
      sql: `SELECT ${columns} FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} WHERE ${where.join(" AND ")} ORDER BY ${quoteIdentifier(capability.target.primary_key, placeholderStyle)} ASC LIMIT ${maxRows + 1}`,
    };
  }
  const placeholders = placeholderStyle === "$" ? ["$1", "$2", "$3"] : ["?", "?", "?"];
  const where = [
    `${quoteIdentifier(capability.target.primary_key, placeholderStyle)} = ${placeholders[0]}`,
  ];
  if (capability.target.tenant_key) {
    where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholders[1]}`);
  }
  if (capability.target.principal_scope_key) {
    where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholders[2]}`);
  }
  const sql = `SELECT ${columns} FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} WHERE ${where.join(" AND ")} LIMIT ${Math.max(1, capability.max_rows ?? 1)}`;
  return { sql };
}

function queryValues(capability: RuntimeCapabilityConfig, args: Record<string, unknown>, context: TrustedContext): unknown[] {
  if (capability.kind === "aggregate_read") return [
    ...(capability.aggregate?.selection?.all ?? []).map((term) => term.value),
    ...(capability.target.tenant_key ? [context.tenant_id] : []),
    ...(capability.target.principal_scope_key ? [context.principal] : []),
  ];
  if (isSetSelectionCapability(capability)) {
    return [
      ...(capability.operation?.selection?.all ?? []).map((term) => term.value),
      ...(capability.target.tenant_key ? [context.tenant_id] : []),
      ...(capability.target.principal_scope_key ? [context.principal] : []),
    ];
  }
  const pkValue = args[capability.lookup.id_from_arg];
  if (pkValue === undefined) throw new McpRuntimeError("LOOKUP_ARG_MISSING", `${capability.lookup.id_from_arg} is required.`);
  return [
    pkValue,
    ...(capability.target.tenant_key ? [context.tenant_id] : []),
    ...(capability.target.principal_scope_key ? [context.principal] : []),
  ];
}

function readColumns(capability: RuntimeCapabilityConfig): string[] {
  if (capability.kind === "aggregate_read") return [
    ...(capability.aggregate?.column ? [capability.aggregate.column] : []),
    ...(capability.aggregate?.selection?.all ?? []).map((term) => term.column),
    ...(capability.target.tenant_key ? [capability.target.tenant_key] : []),
    ...(capability.target.principal_scope_key ? [capability.target.principal_scope_key] : []),
  ];
  const columns = new Set(capability.visible_columns);
  columns.add(capability.target.primary_key);
  if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
  if (capability.target.principal_scope_key) columns.add(capability.target.principal_scope_key);
  if (capability.conflict_guard?.column) columns.add(capability.conflict_guard.column);
  for (const term of capability.operation?.selection?.all ?? []) columns.add(term.column);
  for (const bound of capability.operation?.aggregate_bounds ?? []) columns.add(bound.column);
  return Array.from(columns);
}

function isSetCapability(capability: RuntimeCapabilityConfig): boolean {
  return capability.kind === "proposal" && capability.operation?.cardinality === "set";
}

function isSetSelectionCapability(capability: RuntimeCapabilityConfig): boolean {
  return isSetCapability(capability) && capability.operation?.kind !== "insert";
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
  for (const name of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(capability.args, name)) continue;
    if (isSetCapability(capability)) {
      throw new McpRuntimeError("MODEL_PREDICATE_REJECTED", `bounded-set argument ${name} is not reviewed; selection, ordering, columns, operators, and row caps are contract-fixed.`);
    }
    throw new McpRuntimeError("ARGUMENT_NOT_ALLOWED", `${name} is not a reviewed capability argument.`);
  }
  for (const [name, spec] of Object.entries(capability.args)) {
    const value = args[name];
    if (spec.required !== false && value === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${name} is required.`);
    if (value === undefined) continue;
    if (spec.type === "object_array") {
      if (!Array.isArray(value)) throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be an array of reviewed objects.`);
      if (value.length < 1 || value.length > spec.max_items) throw new McpRuntimeError("ARGUMENT_ITEM_COUNT_INVALID", `${name} must contain 1 through ${spec.max_items} items.`);
      for (const [index, item] of value.entries()) {
        if (!isRecord(item)) throw new McpRuntimeError("ARGUMENT_ITEM_TYPE_INVALID", `${name}[${index}] must be an object.`);
        for (const key of Object.keys(item)) if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) throw new McpRuntimeError("ARGUMENT_ITEM_FIELD_NOT_ALLOWED", `${name}[${index}].${key} is not a reviewed item field.`);
        for (const [fieldName, fieldSpec] of Object.entries(spec.fields)) validateScalarArg(`${name}[${index}].${fieldName}`, fieldSpec, item[fieldName]);
      }
      continue;
    }
    validateScalarArg(name, spec, value);
  }
}

function validateScalarArg(name: string, spec: RuntimeScalarArgConfig, value: unknown): void {
    if (spec.required !== false && value === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${name} is required.`);
    if (value === undefined) return;
    if (spec.type === "string" && typeof value !== "string") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a string.`);
    if (spec.type === "number" && typeof value !== "number") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a number.`);
    if (spec.type === "boolean" && typeof value !== "boolean") throw new McpRuntimeError("ARGUMENT_TYPE_INVALID", `${name} must be a boolean.`);
    if (typeof value === "string" && spec.max_length && value.length > spec.max_length) throw new McpRuntimeError("ARGUMENT_TOO_LONG", `${name} is longer than ${spec.max_length}.`);
    if (typeof value === "number" && spec.minimum !== undefined && value < spec.minimum) throw new McpRuntimeError("ARGUMENT_BELOW_MINIMUM", `${name} must be at least ${spec.minimum}.`);
    if (typeof value === "number" && spec.maximum !== undefined && value > spec.maximum) throw new McpRuntimeError("ARGUMENT_ABOVE_MAXIMUM", `${name} must be at most ${spec.maximum}.`);
    if (spec.enum && !spec.enum.includes(value as Scalar)) throw new McpRuntimeError("ARGUMENT_NOT_ALLOWED", `${name} is not an allowed value.`);
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
    let schema: z.ZodTypeAny = spec.type === "object_array"
      ? z.array(z.object(Object.fromEntries(Object.entries(spec.fields).map(([field, fieldSpec]) => [field, zodScalarArg(fieldSpec)]))).strict()).min(1).max(spec.max_items)
      : zodScalarArg(spec);
    if (spec.required === false) schema = schema.optional();
    shape[name] = schema.describe(spec.description ?? `${name} business argument`);
  }
  return shape;
}

function zodScalarArg(spec: RuntimeScalarArgConfig): z.ZodTypeAny {
  let schema: z.ZodTypeAny = spec.type === "number" ? z.number() : spec.type === "boolean" ? z.boolean() : z.string();
  if (spec.type === "string" && spec.max_length) schema = (schema as z.ZodString).max(spec.max_length);
  if (spec.type === "number" && spec.minimum !== undefined) schema = (schema as z.ZodNumber).min(spec.minimum);
  if (spec.type === "number" && spec.maximum !== undefined) schema = (schema as z.ZodNumber).max(spec.maximum);
  if (spec.enum && spec.enum.length > 0) schema = schema.refine((value) => spec.enum?.includes(value as Scalar), "value is not allowlisted");
  if (spec.required === false) schema = schema.optional();
  return schema;
}

function toolMetadata(capability: RuntimeCapabilityConfig): LocalToolMetadata {
  return {
    name: capability.name,
    title: capability.name,
    description: capabilityDescription(capability),
    kind: capability.kind,
    input_schema: Object.fromEntries(Object.entries(capability.args).map(([name, spec]) => [name, {
      type: spec.type === "object_array" ? "array" : spec.type,
      required: spec.required !== false,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.type === "object_array" ? { max_items: spec.max_items, fields: spec.fields } : {
        ...(spec.max_length !== undefined ? { max_length: spec.max_length } : {}),
        ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
        ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {}),
        ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
      }),
    }])),
    annotations: {
      readOnlyHint: capability.kind === "read" || capability.kind === "aggregate_read",
      destructiveHint: false,
      idempotentHint: capability.kind === "read" || capability.kind === "aggregate_read",
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

function batchItemsFromArgs(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): Record<string, unknown>[] {
  const argumentName = capability.operation?.batch?.items_from_arg;
  const value = argumentName ? args[argumentName] : undefined;
  if (!argumentName || !Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new McpRuntimeError("BATCH_ITEMS_REQUIRED", `Bounded INSERT capability ${capability.name} requires its reviewed object-array argument.`);
  }
  return value as Record<string, unknown>[];
}

function buildItemPatch(
  capability: RuntimeCapabilityConfig,
  item: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, Scalar> {
  if (!capability.patch) throw new McpRuntimeError("PATCH_REQUIRED", "Proposal capability has no patch mapping.");
  const patch: Record<string, Scalar> = {};
  for (const [column, binding] of Object.entries(capability.patch)) {
    if (binding.from_item) patch[column] = scalar(item[binding.from_item]);
    else if (binding.from_arg) patch[column] = scalar(args[binding.from_arg]);
    else patch[column] = scalar(binding.fixed ?? null);
  }
  return patch;
}

function boundedSetEvidenceItems(
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
  operation: "update" | "insert" | "delete",
  currentRows: Record<string, unknown>[],
  itemPatches: Record<string, Scalar>[],
  batchItems: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (operation === "insert") {
    return itemPatches.map((patch, index) => ({
      kind: "reviewed_batch_insert_intent",
      source_id: capability.source,
      table: `${capability.target.schema}.${capability.target.table}`,
      item_index: index,
      reviewed_item: scalarRecord(batchItems[index] ?? {}),
      visible_row: patch,
      tenant: capability.target.tenant_key ? { column: capability.target.tenant_key, value: context.tenant_id } : undefined,
    }));
  }
  return currentRows.map((row) => ({
    kind: "external_row",
    source_id: capability.source,
    table: `${capability.target.schema}.${capability.target.table}`,
    primary_key: { column: capability.target.primary_key, value: scalar(row[capability.target.primary_key]) },
    tenant: capability.target.tenant_key ? { column: capability.target.tenant_key, value: context.tenant_id } : undefined,
    visible_row: visibleScalarRecord(capability, row),
  }));
}

function resolveDeduplication(
  capability: RuntimeCapabilityConfig,
  proposalId: string,
  context: TrustedContext,
): NonNullable<ChangeSetV2["guards"]["deduplication"]> {
  const declared = capability.operation?.kind === "insert" ? capability.operation.deduplication?.components : undefined;
  if (!declared?.length) throw new McpRuntimeError("INSERT_DEDUPLICATION_REQUIRED", `INSERT capability ${capability.name} requires source-enforced deduplication.`);
  if (declared.some((component) => component.source === "item_field")) throw new McpRuntimeError("INSERT_ITEM_DEDUP_SINGLE_ROW_FORBIDDEN", "item_field deduplication is valid only for batch INSERT.");
  const components = declared.map((component) => ({
    column: component.column,
    source: component.source as "proposal_id" | "trusted_tenant" | "fixed",
    value: component.source === "proposal_id"
      ? proposalId
      : component.source === "trusted_tenant"
        ? context.tenant_id
        : scalar(component.fixed ?? null),
  }));
  if (!components.some((component) => component.source === "proposal_id")) {
    throw new McpRuntimeError("INSERT_PROPOSAL_ID_DEDUP_REQUIRED", `INSERT capability ${capability.name} must include a proposal_id deduplication component.`);
  }
  return { components };
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

function diffFromChangeSet(changeSet: ChangeSet): Record<string, { before: Scalar; proposed: Scalar }> {
  const diff: Record<string, { before: Scalar; proposed: Scalar }> = {};
  if (changeSet.schema_version === protocolVersions.changeSetV3) {
    diff.affected_rows = {
      before: changeSet.operation === "batch_insert" ? 0 : changeSet.frozen_set.row_count,
      proposed: changeSet.operation === "set_delete" ? 0 : changeSet.frozen_set.row_count,
    };
    for (const [column, proposed] of Object.entries(changeSet.patch)) diff[column] = { before: null, proposed };
    return diff;
  }
  if (changeSet.schema_version === protocolVersions.changeSetV2 && changeSet.operation === "single_row_delete") {
    for (const [column, value] of Object.entries(changeSet.before)) diff[column] = { before: value, proposed: null };
    return diff;
  }
  for (const column of Object.keys(changeSet.patch)) {
    diff[column] = {
      before: changeSet.before[column] ?? null,
      proposed: changeSet.after[column] ?? null,
    };
  }
  return diff;
}

async function readLocalResource(
  store: ProposalRuntimeStore,
  uri: string,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  trustedContext?: TrustedContext,
): Promise<Record<string, unknown>> {
  const parsed = new URL(uri);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const collection = parsed.hostname;
  const id = parts[0];
  if (!id) throw new McpRuntimeError("RESOURCE_ID_MISSING", `Resource id missing in ${uri}.`);
  if (collection === "proposals") {
    const proposal = await store.getProposal(id);
    if (!proposal) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.capability ?? proposal.action,
    });
    return { proposal, events: await store.events(id), receipts: await store.receipts(id) };
  }
  if (collection === "evidence") {
    const evidence = await store.getEvidenceBundle(id);
    if (!evidence) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: evidence.tenant_id,
      principal: evidence.principal,
      capability: evidence.capability,
    });
    return evidence;
  }
  if (collection === "replay") {
    const proposalId = id.startsWith("replay_") ? id.slice("replay_".length) : id;
    const proposal = await store.getProposal(proposalId);
    if (!proposal) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.capability ?? proposal.action,
    });
    return await store.replay(proposalId);
  }
  throw localResourceNotFound();
}

function assertLocalResourceAccess(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  trustedContext: TrustedContext | undefined,
  owner: { tenant_id: string; principal?: string; capability?: string },
): void {
  if (!owner.tenant_id || !owner.principal || !owner.capability) throw localResourceNotFound();
  const capability = localCapabilities(config).find((item) => item.name === owner.capability);
  if (!capability) throw localResourceNotFound();
  const context = resolveTrustedContext(config, env, capability, trustedContext);
  if (context.tenant_id !== owner.tenant_id || context.principal !== owner.principal) {
    throw localResourceNotFound();
  }
}

function localResourceNotFound(): McpRuntimeError {
  return new McpRuntimeError("RESOURCE_NOT_FOUND", "Synapsor resource not found.");
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
  const principalScope = capability.target.principal_scope_key ? {
    column: capability.target.principal_scope_key,
    value_fingerprint: canonicalJsonDigest({ principal: context.principal }),
  } : undefined;
  return hashJson({
    source: capability.source,
    target: capability.target,
    selection: capability.operation?.selection,
    max_rows: capability.operation?.max_rows,
    aggregate: capability.aggregate,
    columns: readColumns(capability),
    tenant_bound: Boolean(capability.target.tenant_key),
    tenant: context.tenant_id,
    ...(principalScope ? { principal_scope: principalScope } : {}),
  });
}

function selectTemplate(capability: RuntimeCapabilityConfig): string {
  if (capability.kind === "aggregate_read") {
    const aggregate = capability.aggregate;
    const expression = aggregate?.function === "count" && aggregate.count_mode === "rows" ? "COUNT(*)" : `${aggregate?.function?.toUpperCase() ?? "AGGREGATE"}(${aggregate?.column ?? "<fixed column>"})`;
    const terms = (aggregate?.selection?.all ?? []).map((term) => `${term.column} = <fixed>`);
    if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = <trusted tenant>`);
    if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = <trusted principal>`);
    return `SELECT ${expression}, COUNT(*) AS group_size FROM ${capability.target.schema}.${capability.target.table}${terms.length ? ` WHERE ${terms.join(" AND ")}` : ""}`;
  }
  if (isSetSelectionCapability(capability)) {
    const terms = (capability.operation?.selection?.all ?? []).map((term) => `${term.column} = <fixed>`);
    if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = <trusted tenant>`);
    if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = <trusted principal>`);
    return `SELECT ${readColumns(capability).join(", ")} FROM ${capability.target.schema}.${capability.target.table} WHERE ${terms.join(" AND ")} ORDER BY ${capability.target.primary_key} ASC LIMIT ${(capability.operation?.max_rows ?? 0) + 1}`;
  }
  const terms = [`${capability.target.primary_key} = ?`];
  if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = ?`);
  if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = ?`);
  const where = terms.join(" AND ");
  return `SELECT ${readColumns(capability).join(", ")} FROM ${capability.target.schema}.${capability.target.table} WHERE ${where} LIMIT ${capability.max_rows ?? 1}`;
}

function scalarRecord(row: Record<string, unknown>): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scalar(value)]));
}

function visibleScalarRecord(capability: RuntimeCapabilityConfig, row: Record<string, unknown>): Record<string, Scalar> {
  const visible = new Set(capability.visible_columns);
  return Object.fromEntries(Object.entries(row).filter(([column]) => visible.has(column)).map(([key, value]) => [key, scalar(value)]));
}

function withoutPrincipalScopeValue<T extends { value?: unknown }>(scope: T): Omit<T, "value"> {
  const { value: _value, ...metadata } = scope;
  return metadata;
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
    const retryAfter = error.code === "RATE_LIMITED" && typeof error.details?.retry_after_ms === "number"
      ? Math.max(1, Math.round(error.details.retry_after_ms))
      : undefined;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      ...(retryAfter ? { retry_after_ms: retryAfter } : {}),
    };
  }
  return { ok: false, code: "MCP_TOOL_FAILED", error: error instanceof Error ? error.message : String(error) };
}
