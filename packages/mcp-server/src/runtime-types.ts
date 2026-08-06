import type {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  ControlPlaneClient,
} from "@synapsor-runner/control-plane-client";
import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import type {
  FreshnessAuthorityV1,
  FreshnessProofV1,
} from "@synapsor-runner/protocol";
import type {
  InspectOptions,
  SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import type {
  AggregateReadSpec,
  PolicySpec,
  ProposalActionSpec,
  ProtectedReadSpec,
} from "@synapsor/spec";
import type mysql from "mysql2/promise";
import type {
  JwtAlgorithm,
} from "./jwt-auth.js";

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
    principal_setting?: string;
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
  kept_out_fields?: string[];
  model_withheld_fields?: string[];
  evidence?: "required" | "optional" | string;
  max_rows?: number;
  aggregate?: AggregateReadSpec;
  protected_read?: ProtectedReadSpec;
  patch?: Record<string, { fixed?: Scalar; from_arg?: string; from_item?: string }>;
  allowed_columns?: string[];
  numeric_bounds?: Record<string, RuntimeNumericBoundConfig>;
  transition_guards?: Record<string, RuntimeTransitionGuardConfig>;
  reversibility?: { mode: "reviewed_inverse" };
  operation?: NonNullable<ProposalActionSpec["operation"]>;
  conflict_guard?: { column?: string; weak_guard_ack?: boolean };
  approval?: { mode?: "human" | "operator" | "policy" | string; required_role?: string; required_approvals?: number; policy?: string };
  execution?: { supervised_worker: "allowed" };
  writeback?: { mode: RuntimeWritebackMode; executor?: string };
};

export type RuntimeSupervisedWorkerCapabilityPolicy = {
  capability: string;
  contract_digest: `sha256:${string}`;
  mode: "supervised_worker";
  concurrency: number;
  queue_limit: number;
  lease_seconds: number;
  max_attempts: number;
  proposal_ttl_seconds: number;
  rate_limit: {
    executions: number;
    window_seconds: number;
  };
  write_url_env: string;
  require_least_privilege_writer?: boolean;
  writer_posture_fingerprint?: `sha256:${string}`;
  worker_identity?: string;
  control_role?: string;
  required_attention_sinks?: string[];
};

export type RuntimeSupervisedWorkerConfig = {
  enabled: boolean;
  profile: "development" | "staging" | "production";
  capabilities: RuntimeSupervisedWorkerCapabilityPolicy[];
};

export type SupervisedWorkerEligibility = {
  eligible: boolean;
  code: string;
  reasons: string[];
  capability: string;
  contract_digest?: `sha256:${string}`;
  profile?: RuntimeSupervisedWorkerConfig["profile"];
  policy?: RuntimeSupervisedWorkerCapabilityPolicy;
};

export type RuntimeProposalFreshnessDependencyConfig = {
  id: string;
  capability: string;
  identity_from_arg: string;
  version_column: string;
};

export type RuntimeProposalFreshnessConfig = {
  approval: "required";
  dependencies?: RuntimeProposalFreshnessDependencyConfig[];
};

export type RuntimeNotificationBudgetConfig = {
  per_minute?: number;
  per_hour?: number;
  immediate_informational_per_hour?: number;
  aggregation_window_seconds?: number;
  cooldown_seconds?: number;
  max_unresolved_reminders?: number;
  digest_cadence_minutes?: number;
  escalation_delay_seconds?: number;
  retry_attempt_threshold?: number;
  degraded_duration_seconds?: number;
  queue_depth_threshold?: number;
  queue_age_seconds?: number;
};

export type RuntimeNotificationSinkConfig = {
  id: string;
  type: "webhook" | "jsonl";
  enabled?: boolean;
  url_env?: string;
  signing_secret_env?: string;
  destination?: "stdout";
  minimum_severity?: "informational" | "warning" | "critical";
  events?: string[];
  capabilities?: string[];
  environments?: Array<"development" | "staging" | "production" | "unknown">;
  delivery?: "immediate" | "digest" | "all";
  max_attempts?: number;
  timeout_ms?: number;
  max_response_bytes?: number;
  replay_window_seconds?: number;
  allow_private_destinations?: boolean;
  private_host_allowlist?: string[];
  recovery_notifications?: boolean;
  budgets?: RuntimeNotificationBudgetConfig;
  quiet_hours?: {
    start_utc_hour: number;
    end_utc_hour: number;
  };
};

export type RuntimeNotificationsConfig = {
  enabled: boolean;
  workbench_url_env?: string;
  sinks: RuntimeNotificationSinkConfig[];
};

export type ProductionExploreTenantLimits = {
  max_queries_per_rolling_24_hours: number;
  max_extracted_cells_per_rolling_24_hours: number;
  max_differencing_queries_per_rolling_24_hours: number;
  requests_per_minute: number;
  max_response_cells_per_response?: number;
};

export type RuntimeProductionExploreConfig = {
  enabled: boolean;
  project_root: string;
  required_oauth_scope: string;
  budget_hmac_key_env: string;
  accounting_namespace: string;
  /** Fixed audit/accounting identity for an explicitly reviewed one-organization source. */
  single_organization_id?: string;
  tenant_limits: ProductionExploreTenantLimits;
  source_max_connections?: number;
  max_sessions_per_principal?: number;
};

export type RuntimeConfig = {
  version: 1;
  mode: RunnerMode;
  result_format?: ResultFormat;
  contracts?: string[];
  policies?: PolicySpec[];
  approvals?: { disable_auto_approval?: boolean };
  proposal_freshness?: Record<string, RuntimeProposalFreshnessConfig>;
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
  http_security?: {
    deployment?: "loopback" | "single_tenant" | "shared";
    channel?: "direct_tls" | "trusted_tls_proxy" | "insecure_http_break_glass";
    static_token?: {
      active_env?: string;
      previous_env?: string;
    };
    oauth_resource?: {
      resource: string;
      authorization_servers: string[];
      scopes_supported?: string[];
      required_scopes?: string[];
      resource_name?: string;
      resource_documentation?: string;
    };
    allowed_origins?: string[];
    allowed_hosts?: string[];
    limits?: {
      max_request_bytes?: number;
      max_header_bytes?: number;
      max_sessions?: number;
      session_idle_timeout_seconds?: number;
      request_timeout_ms?: number;
      headers_timeout_ms?: number;
      keep_alive_timeout_ms?: number;
      max_connections?: number;
    };
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
  generated_authority?: {
    generation_lock_path: string;
    enforcement: "required";
    reporting_timezone?: "UTC";
    minimum_cohort_overrides?: Record<string, {
      contract_digest: `sha256:${string}`;
      minimum_cohort_size: number;
      review_digest: `sha256:${string}`;
    }>;
  };
  supervised_worker?: RuntimeSupervisedWorkerConfig;
  notifications?: RuntimeNotificationsConfig;
  production_explore?: RuntimeProductionExploreConfig;
};

export type IsolationAssuranceMode = "application_scope" | "postgres_rls" | "tenant_bound";
export type TrustedContextBindingMode =
  | "process_bound"
  | "verified_http_session"
  | "verified_external_session"
  | "mixed"
  | "missing";

export type SourceIsolationAssurance = {
  source: string;
  engine: SourceEngine;
  mode: IsolationAssuranceMode;
  database_scope: "application" | "postgres_rls";
  credential_scope: "shared" | "tenant_resolver";
  trusted_context: {
    providers: ContextProvider[];
    request_binding: TrustedContextBindingMode;
  };
  controls: string[];
  protects_against: string[];
  does_not_protect_against: string[];
  remaining_trust_boundary: string;
  warning?: string;
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
  transaction_mode?: "read_only";
  reporting_timezone?: "UTC";
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
  generatedAuthorityInspector?: (input: InspectOptions) => Promise<SchemaInspection>;
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
  previousAuthTokenEnv?: string;
  devNoAuth?: boolean;
  corsOrigin?: string;
  trustedTlsProxy?: boolean;
  unsafeAllowCleartextHttp?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: false | { write(chunk: string): unknown };
  resultFormat?: ResultFormat;
  readRow?: DbRowReader;
  credentialResolver?: TenantCredentialResolver;
  tls?: StreamableHttpTlsOptions;
  readinessCheck?: () => Promise<ReadinessReport>;
  streamableSessionFactory?: StreamableHttpSessionFactory;
};

export type StreamableHttpSessionRuntime = {
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  close(): Promise<void>;
};

export type StreamableHttpSessionFactory = ((input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalRuntimeStore;
  trustedContext: TrustedContext;
  toolNameStyle?: ToolNameStyle;
  resultFormat?: ResultFormat;
}) => Promise<StreamableHttpSessionRuntime>) & {
  maxSessionsPerPrincipal?: number;
  close?(): Promise<void>;
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
  resultFormat?: ResultFormat;
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

export type StreamableHttpSession = {
  transport: StreamableHTTPServerTransport;
  runtime: StreamableHttpSessionRuntime;
  sessionId?: string;
  authFingerprint: string;
  principalSessionKey?: string;
  lastSeenAt: number;
  closed?: boolean;
  closePromise?: Promise<void>;
};

export type HttpDeployment = "loopback" | "single_tenant" | "shared";
export type HttpChannel = "loopback_cleartext" | "direct_tls" | "trusted_tls_proxy" | "insecure_http_break_glass";

export type ResolvedHttpLimits = {
  maxRequestBytes: number;
  maxHeaderBytes: number;
  maxSessions: number;
  sessionIdleTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConnections: number;
};

export type ResolvedOauthResource = {
  metadata: Record<string, unknown>;
  metadataUrl: string;
  metadataPath: string;
  requiredScopes: string[];
};

export type ResolvedHttpSecurity = {
  deployment: HttpDeployment;
  channel: HttpChannel;
  activeToken?: string;
  previousToken?: string;
  activeTokenEnv: string;
  previousTokenEnv?: string;
  weakStaticToken: boolean;
  allowedOrigins: Set<string>;
  allowedHosts: string[];
  limits: ResolvedHttpLimits;
  oauth?: ResolvedOauthResource;
};

export type StreamableAuthenticationResult =
  | { ok: true; authentication: StreamableAuthentication }
  | { ok: false; status: 401 | 403; error: "unauthorized" | "insufficient_scope" };

export type MetricsEndpointAccess = {
  enabled: boolean;
  token?: string;
};

export type CloudAdapterClient = Pick<ControlPlaneClient, "adapterTools" | "callAdapterTool">;

export type GeneratedAuthorityLock = {
  schema_version: "synapsor.generation-lock.v1";
  compiler_version: string;
  spec_version: string;
  engine: SourceEngine;
  source_env: string;
  inspected_schema?: string;
  schema_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  evidence_fingerprint: `sha256:${string}`;
  generated_contract_digest: `sha256:${string}`;
  reviewed_overrides_digest: `sha256:${string}`;
  protected_authority: string[];
  reporting_timezone?: "UTC";
  authority_dependencies?: {
    schema_version: "synapsor.authority-dependencies.v1";
    credential_posture_fingerprint: `sha256:${string}`;
    resources: Record<string, {
      schema: string;
      table: string;
      fields: string[];
      fingerprint: `sha256:${string}`;
    }>;
    relationships: Record<string, {
      root_resource: string;
      relationship_id: string;
      links: Array<{
        constraint_name: string;
        source_resource: string;
        target_resource: string;
        source_columns: string[];
        target_columns: string[];
        target_uniqueness: {
          kind: "primary_key" | "unique_constraint" | "unique_index";
          name: string;
          columns: string[];
        };
        nullable: boolean;
        cardinality: "many_to_one";
        max_fan_out: 1;
      }>;
      proof_digest: `sha256:${string}`;
    }>;
  };
};

export type GeneratedAuthorityDependencies = NonNullable<GeneratedAuthorityLock["authority_dependencies"]>;
export type GeneratedRelationshipDependency = GeneratedAuthorityDependencies["relationships"][string];

export type StreamableAuthentication = {
  fingerprint: string;
  context?: TrustedContext;
};

export type CapturedFreshnessEvidence = {
  dependency_id: string;
  bundle_id: string;
  query_fingerprint: string;
  capability: RuntimeCapabilityConfig;
  primary_key: { column: string; value: Scalar };
  version_column: string;
};

export type CapturedFreshnessAuthority = {
  authority: FreshnessAuthorityV1;
  evidence: CapturedFreshnessEvidence[];
};

export type ProposalFreshnessEvaluation =
  | {
    required: false;
    status: "not_required";
    safe_code: "FRESHNESS_NOT_REQUIRED";
    target_count: 0;
    supporting_count: 0;
  }
  | {
    required: true;
    status: FreshnessProofV1["result"];
    safe_code: string;
    target_count: number;
    supporting_count: number;
    proof: FreshnessProofV1;
  };

export type FreshnessProofCheck = FreshnessProofV1["checks"][number];
