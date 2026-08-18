import { validateContract } from "@synapsor/spec";

export type RunnerMode = "read_only" | "shadow" | "review" | "cloud";
export type SourceEngine = "postgres" | "mysql";
export type TrustedContextProvider = "static_dev" | "environment" | "http_claims" | "cloud_session" | "reviewed_organization";
export type CapabilityKind = "read" | "aggregate_read" | "proposal";
export type ExecutorType = "sql_update" | "http_handler" | "command_handler";

export type ConfigIssue = {
  path: string;
  code: string;
  message: string;
};

export type ConfigValidationResult = {
  ok: boolean;
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
};

type JsonRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = new Set(["version", "mode", "storage", "sources", "trusted_context", "contexts", "executors", "capabilities", "contracts", "policies", "approvals", "proposal_freshness", "operator_identity", "session_auth", "http_security", "rate_limits", "metrics", "graduated_trust", "cloud", "governance", "generated_authority", "supervised_worker", "notifications", "production_explore", "strict", "result_format"]);
const STORAGE_KEYS = new Set(["sqlite_path", "shared_postgres"]);
const SHARED_POSTGRES_STORAGE_KEYS = new Set(["mode", "url_env", "schema", "lock_timeout_ms", "max_entries"]);
const APPROVALS_KEYS = new Set(["disable_auto_approval"]);
const PROPOSAL_FRESHNESS_KEYS = new Set(["approval", "dependencies"]);
const FRESHNESS_DEPENDENCY_KEYS = new Set(["id", "capability", "identity_from_arg", "version_column"]);
const METRICS_KEYS = new Set(["enabled", "token_env"]);
const GRADUATED_TRUST_KEYS = new Set(["enabled", "kill_switch", "workspace_id", "project_id", "criteria"]);
const GRADUATED_TRUST_CRITERION_KEYS = new Set([
  "capability", "policy", "field", "minimum_human_reviews", "window_days",
  "maximum_rejection_rate", "maximum_conflict_rate", "maximum_failure_rate", "maximum_revert_rate",
  "maximum_threshold_increase", "absolute_ceiling",
]);
const OPERATOR_IDENTITY_KEYS = new Set([
  "provider", "actor_env", "roles_env", "apply_roles", "operators", "token_env", "token_file_env", "token_stdin", "roles_claim",
  "subject_claim", "attestation_secret_env", "algorithms", "jwks_url_env", "public_key_env", "public_key_path",
  "issuer", "audience", "clock_skew_seconds", "jwks_cache_seconds", "jwks_cooldown_seconds", "fetch_timeout_ms",
  "max_response_bytes",
]);
const OPERATOR_KEYS = new Set(["public_key_path", "roles"]);
const SESSION_AUTH_KEYS = new Set([
  "provider", "secret_env", "previous_secret_env", "algorithms", "jwks_url_env", "public_key_env", "public_key_path",
  "issuer", "audience", "tenant_claim", "principal_claim", "clock_skew_seconds", "jwks_cache_seconds",
  "jwks_cooldown_seconds", "fetch_timeout_ms", "max_response_bytes",
]);
const HTTP_SECURITY_KEYS = new Set(["deployment", "channel", "static_token", "oauth_resource", "allowed_origins", "allowed_hosts", "limits"]);
const HTTP_STATIC_TOKEN_KEYS = new Set(["active_env", "previous_env"]);
const HTTP_OAUTH_RESOURCE_KEYS = new Set([
  "resource", "authorization_servers", "scopes_supported", "required_scopes", "resource_name", "resource_documentation",
]);
const HTTP_LIMIT_KEYS = new Set([
  "max_request_bytes", "max_header_bytes", "max_sessions", "session_idle_timeout_seconds",
  "request_timeout_ms", "headers_timeout_ms", "keep_alive_timeout_ms", "max_connections",
]);
const RATE_LIMITS_KEYS = new Set(["enabled", "default", "capabilities"]);
const RATE_LIMIT_RULE_KEYS = new Set(["requests", "window_seconds"]);
const PRODUCTION_EXPLORE_KEYS = new Set([
  "enabled", "project_root", "required_oauth_scope", "budget_hmac_key_env", "accounting_namespace", "tenant_limits",
  "source_max_connections", "max_sessions_per_principal", "single_organization_id",
]);
const PRODUCTION_EXPLORE_TENANT_LIMIT_KEYS = new Set([
  "max_queries_per_rolling_24_hours",
  "max_extracted_cells_per_rolling_24_hours",
  "max_differencing_queries_per_rolling_24_hours",
  "requests_per_minute",
  "max_response_cells_per_response",
]);
const CLOUD_KEYS = new Set(["base_url_env", "runner_token_env", "runner_id", "runner_version", "project_id", "adapter_id", "source_id", "engines", "capabilities", "session"]);
const GOVERNANCE_KEYS = new Set(["mode", "connection_file", "evidence_residency", "queue_when_unavailable", "sync_interval_ms", "max_attempts", "outbox_retention_days"]);
const GENERATED_AUTHORITY_KEYS = new Set([
  "generation_lock_path",
  "enforcement",
  "reporting_timezone",
  "minimum_cohort_overrides",
]);
const MINIMUM_COHORT_OVERRIDE_KEYS = new Set([
  "contract_digest",
  "minimum_cohort_size",
  "review_digest",
]);
const SUPERVISED_WORKER_KEYS = new Set(["enabled", "profile", "capabilities"]);
const SUPERVISED_WORKER_CAPABILITY_KEYS = new Set([
  "capability",
  "contract_digest",
  "mode",
  "concurrency",
  "queue_limit",
  "lease_seconds",
  "max_attempts",
  "proposal_ttl_seconds",
  "rate_limit",
  "write_url_env",
  "require_least_privilege_writer",
  "writer_posture_fingerprint",
  "worker_identity",
  "control_role",
  "required_attention_sinks",
]);
const SUPERVISED_WORKER_RATE_LIMIT_KEYS = new Set(["executions", "window_seconds"]);
const NOTIFICATION_KEYS = new Set(["enabled", "workbench_url_env", "sinks"]);
const NOTIFICATION_SINK_KEYS = new Set([
  "id",
  "type",
  "enabled",
  "url_env",
  "signing_secret_env",
  "destination",
  "minimum_severity",
  "events",
  "capabilities",
  "environments",
  "delivery",
  "max_attempts",
  "timeout_ms",
  "max_response_bytes",
  "replay_window_seconds",
  "allow_private_destinations",
  "private_host_allowlist",
  "recovery_notifications",
  "budgets",
  "quiet_hours",
]);
const NOTIFICATION_BUDGET_KEYS = new Set([
  "per_minute",
  "per_hour",
  "immediate_informational_per_hour",
  "aggregation_window_seconds",
  "cooldown_seconds",
  "max_unresolved_reminders",
  "digest_cadence_minutes",
  "escalation_delay_seconds",
  "retry_attempt_threshold",
  "degraded_duration_seconds",
  "queue_depth_threshold",
  "queue_age_seconds",
]);
const NOTIFICATION_QUIET_HOURS_KEYS = new Set(["start_utc_hour", "end_utc_hour"]);
const NOTIFICATION_EVENT_TYPES = new Set([
  "proposal.created",
  "proposal.review_required",
  "proposal.auto_approved",
  "proposal.approved",
  "proposal.queued",
  "proposal.expiring",
  "proposal.expired",
  "proposal.cancelled",
  "proposal.applied",
  "proposal.conflict",
  "proposal.refused",
  "worker.started",
  "worker.paused",
  "worker.unhealthy",
  "worker.recovered",
  "worker.queue_backlog",
  "worker.retry_scheduled",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "capability.review_required",
  "capability.activated",
  "capability.revoked",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_near",
  "policy.limit_exceeded",
  "sensitive_override_activated",
  "notification.replayed",
]);
const SOURCE_KEYS = new Set([
  "engine",
  "read_url_env",
  "write_url_env",
  "read_only",
  "statement_timeout_ms",
  "ssl",
  "pool",
  "receipts",
  "database_scope",
  "credential_scope",
]);
const SOURCE_POOL_KEYS = new Set(["max_connections", "connection_timeout_ms", "idle_timeout_ms", "queue_timeout_ms", "queue_limit"]);
const SOURCE_RECEIPT_KEYS = new Set(["authority", "provisioning", "schema", "table"]);
const SOURCE_DATABASE_SCOPE_KEYS = new Set(["mode", "tenant_setting", "principal_setting"]);
const SOURCE_CREDENTIAL_SCOPE_KEYS = new Set(["mode", "resolver"]);
const TRUSTED_CONTEXT_KEYS = new Set(["provider", "values", "tenant_binding", "principal_binding"]);
const CONTEXT_KEYS = TRUSTED_CONTEXT_KEYS;
const EXECUTOR_KEYS = new Set(["type", "url_env", "method", "auth", "signing_secret_env", "timeout_ms", "command_env"]);
const EXECUTOR_AUTH_KEYS = new Set(["type", "token_env"]);
const CAPABILITY_KEYS = new Set([
  "name",
  "kind",
  "description",
  "returns_hint",
  "source",
  "context",
  "executor",
  "target",
  "args",
  "lookup",
  "visible_columns",
  "evidence",
  "max_rows",
  "patch",
  "allowed_columns",
  "numeric_bounds",
  "transition_guards",
  "reversibility",
  "conflict_guard",
  "approval",
  "execution",
  "writeback",
  "operation",
  "single_tenant_dev_ack",
  "aggregate",
  "protected_read",
  "kept_out_fields",
  "model_withheld_fields",
  "contract_provenance",
]);
const CONTRACT_PROVENANCE_KEYS = new Set(["digest", "version"]);
const TARGET_KEYS = new Set(["schema", "table", "primary_key", "tenant_key", "principal_scope_key", "single_tenant_dev"]);
const LOOKUP_KEYS = new Set(["id_from_arg"]);
const ARG_KEYS = new Set(["type", "description", "required", "max_length", "minimum", "maximum", "enum", "max_items", "fields"]);
const PATCH_BINDING_KEYS = new Set(["fixed", "from_arg", "from_item"]);
const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);
const TRANSITION_GUARD_KEYS = new Set(["from_column", "allowed"]);
const REVERSIBILITY_KEYS = new Set(["mode"]);
const CONFLICT_GUARD_KEYS = new Set(["column", "weak_guard_ack"]);
const APPROVAL_KEYS = new Set(["mode", "required_role", "required_approvals", "policy"]);
const EXECUTION_KEYS = new Set(["supervised_worker"]);
const POLICY_KEYS = new Set(["name", "kind", "mode", "rules", "limits"]);
const APPROVAL_POLICY_RULE_KEYS = new Set(["field", "max"]);
const APPROVAL_POLICY_LIMIT_KEYS = new Set(["kind", "max", "period", "field", "scope"]);
const WRITEBACK_KEYS = new Set(["mode", "executor"]);
const WRITEBACK_MODES = new Set(["direct_sql", "app_handler", "cloud_worker", "none"]);
const OPERATION_KEYS = new Set(["kind", "cardinality", "selection", "max_rows", "aggregate_bounds", "batch", "deduplication", "version_advance"]);
const SELECTION_KEYS = new Set(["all"]);
const PREDICATE_TERM_KEYS = new Set(["column", "operator", "value"]);
const AGGREGATE_BOUND_KEYS = new Set(["column", "measure", "maximum"]);
const BATCH_KEYS = new Set(["items_from_arg"]);
const DEDUPLICATION_KEYS = new Set(["components"]);
const DEDUPLICATION_COMPONENT_KEYS = new Set(["column", "source", "fixed", "item_field"]);
const VERSION_ADVANCE_KEYS = new Set(["column", "strategy"]);
const AGGREGATE_READ_KEYS = new Set(["function", "count_mode", "column", "selection", "minimum_group_size"]);

const MODEL_CONTROLLED_TRUST_FIELDS = new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "principalId",
  "project_id",
  "projectId",
  "source_id",
  "sourceId",
  "allowed_columns",
  "allowedColumns",
  "row_version",
  "rowVersion",
  "current_version",
  "currentVersion",
  "expected_version",
  "expectedVersion",
  "approval_identity",
  "approvalIdentity",
]);

const MODEL_CONTROLLED_IDENTIFIER_FIELDS = new Set([
  "table",
  "table_name",
  "tableName",
  "schema",
  "schema_name",
  "schemaName",
  "column",
  "columns",
  "column_name",
  "columnName",
  "database",
  "database_name",
  "databaseName",
]);

const INLINE_SECRET_URL_KEYS = new Set([
  "url",
  "database_url",
  "databaseUrl",
  "read_url",
  "readUrl",
  "write_url",
  "writeUrl",
  "connection_string",
  "connectionString",
]);

const SQL_TEXT_KEYS = new Set(["sql", "raw_sql", "rawSql", "statement", "query_sql", "querySql"]);

export function validateRunnerCapabilityConfig(input: unknown): ConfigValidationResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "CONFIG_NOT_OBJECT", message: "Config must be a JSON object." }],
      warnings,
    };
  }

  const strict = input.strict !== false;
  if (strict) checkUnknownKeys(input, TOP_LEVEL_KEYS, "$", errors);
  if (input.version !== 1) {
    errors.push({ path: "$.version", code: "UNSUPPORTED_CONFIG_VERSION", message: "Runner config version must be 1." });
  }
  if (input.result_format !== undefined && input.result_format !== 1 && input.result_format !== 2) {
    errors.push({ path: "$.result_format", code: "INVALID_RESULT_FORMAT", message: "result_format must be 1 or 2." });
  }
  if (!isRunnerMode(input.mode)) {
    errors.push({ path: "$.mode", code: "INVALID_MODE", message: "mode must be read_only, shadow, review, or cloud." });
  }
  validateStorage(input.storage, strict, errors);
  validateApprovals(input.approvals, strict, errors);
  const hasContracts = validateContracts(input.contracts, errors);
  validateCloud(input.cloud, input.mode, strict, errors);
  validateGovernance(input.governance, strict, errors);
  validateGeneratedAuthority(input.generated_authority, strict, errors);
  validateSources(input.sources, input.mode, strict, errors, warnings);
  validateReceiptTopology(input.sources, input.storage, errors);
  validateContexts(input.contexts, strict, errors, warnings);
  validateTrustedContext(input.trusted_context, input.contexts, input.capabilities, input.mode, strict, errors, warnings, hasContracts);
  validateExecutors(input.executors, input.mode, strict, errors);
  validatePolicies(input.policies, strict, errors);
  validateOperatorIdentity(input.operator_identity, strict, errors);
  validateSessionAuth(input.session_auth, input.trusted_context, input.contexts, strict, errors);
  validateHttpSecurity(input.http_security, input.session_auth, input.trusted_context, input.contexts, strict, errors, warnings);
  validateProductionExplore(input.production_explore, input, strict, errors);
  validateRateLimits(input.rate_limits, strict, errors);
  validateMetrics(input.metrics, strict, errors);
  validateGraduatedTrust(input.graduated_trust, strict, errors);
  validateCapabilities(
    input.capabilities,
    input.sources,
    input.contexts,
    input.executors,
    input.mode,
    strict,
    errors,
    warnings,
    hasContracts,
    input.generated_authority,
    input.production_explore,
  );
  validateNotifications(input.notifications, strict, errors);
  validateSupervisedWorker(input.supervised_worker, input, strict, errors);
  validateProposalFreshness(input.proposal_freshness, input.capabilities, strict, errors, hasContracts);
  validateEffectiveContextCompatibility(input.trusted_context, input.contexts, input.capabilities, errors);
  validateApprovalPolicyReferences(input.capabilities, input.policies, errors);
  validateWritebackReadiness(input.sources, input.capabilities, input.mode, errors, warnings);
  scanForForbiddenFields(input, "$", errors);

  return { ok: errors.length === 0, errors, warnings };
}

function validateProductionExplore(
  value: unknown,
  config: JsonRecord,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.production_explore", code: "PRODUCTION_EXPLORE_NOT_OBJECT", message: "production_explore must be an explicit secured HTTP deployment configuration." });
    return;
  }
  if (strict) checkUnknownKeys(value, PRODUCTION_EXPLORE_KEYS, "$.production_explore", errors);
  if (config.mode !== "read_only") {
    errors.push({ path: "$.mode", code: "PRODUCTION_EXPLORE_READ_ONLY_REQUIRED", message: "production Explore requires mode = read_only; it exposes no proposal, approval, apply, or write surface." });
  }
  if (value.enabled !== true) {
    errors.push({ path: "$.production_explore.enabled", code: "PRODUCTION_EXPLORE_EXPLICIT_OPT_IN_REQUIRED", message: "production Explore is available only when enabled is explicitly true." });
  }
  if (!isNonEmptyString(value.project_root)
    || value.project_root.includes("://")
    || /[\u0000-\u001f\u007f]/.test(value.project_root)) {
    errors.push({ path: "$.production_explore.project_root", code: "PRODUCTION_EXPLORE_PROJECT_ROOT_REQUIRED", message: "production Explore requires a local project_root containing the separately reviewed production boundary." });
  }
  if (!isOAuthScope(value.required_oauth_scope)) {
    errors.push({ path: "$.production_explore.required_oauth_scope", code: "PRODUCTION_EXPLORE_OAUTH_SCOPE_REQUIRED", message: "production Explore requires one explicit OAuth scope, for example synapsor.explore." });
  }
  if (!isEnvName(value.budget_hmac_key_env)) {
    errors.push({ path: "$.production_explore.budget_hmac_key_env", code: "PRODUCTION_EXPLORE_HMAC_KEY_ENV_REQUIRED", message: "production Explore requires an environment-variable name containing one shared 32-byte-or-longer budget HMAC key." });
  }
  if (!isNonEmptyString(value.accounting_namespace)
    || value.accounting_namespace.length > 128
    || !/^[a-z][a-z0-9_.:-]*$/.test(value.accounting_namespace)) {
    errors.push({ path: "$.production_explore.accounting_namespace", code: "PRODUCTION_EXPLORE_ACCOUNTING_NAMESPACE_REQUIRED", message: "production Explore requires a stable lower-case accounting namespace shared by every replica, for example acme.analytics.production." });
  }
  const singleOrganizationId = value.single_organization_id;
  if (singleOrganizationId !== undefined
    && (typeof singleOrganizationId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(singleOrganizationId))) {
    errors.push({
      path: "$.production_explore.single_organization_id",
      code: "PRODUCTION_EXPLORE_SINGLE_ORGANIZATION_ID_INVALID",
      message: "single_organization_id must be a stable 1-128 character organization label using letters, numbers, dots, colons, underscores, or dashes.",
    });
  }
  for (const [key, maximum] of [
    ["source_max_connections", 100],
    ["max_sessions_per_principal", 100],
  ] as const) {
    const configured = value[key];
    if (configured !== undefined
      && (!Number.isSafeInteger(configured) || Number(configured) < 1 || Number(configured) > maximum)) {
      errors.push({
        path: `$.production_explore.${key}`,
        code: "INVALID_PRODUCTION_EXPLORE_AVAILABILITY_LIMIT",
        message: `${key} must be an integer from 1 through ${maximum}.`,
      });
    }
  }
  if (!isRecord(value.tenant_limits)) {
    errors.push({ path: "$.production_explore.tenant_limits", code: "PRODUCTION_EXPLORE_TENANT_LIMITS_REQUIRED", message: "production Explore requires explicit tenant-wide safety ceilings in addition to per-principal boundary budgets." });
  } else {
    if (strict) checkUnknownKeys(value.tenant_limits, PRODUCTION_EXPLORE_TENANT_LIMIT_KEYS, "$.production_explore.tenant_limits", errors);
    for (const [key, maximum] of [
      ["max_queries_per_rolling_24_hours", 10_000_000],
      ["max_extracted_cells_per_rolling_24_hours", 1_000_000_000],
      ["max_differencing_queries_per_rolling_24_hours", 10_000_000],
      ["requests_per_minute", 1_000_000],
    ] as const) {
      const configured = value.tenant_limits[key];
      if (!Number.isSafeInteger(configured) || Number(configured) < 1 || Number(configured) > maximum) {
        errors.push({ path: `$.production_explore.tenant_limits.${key}`, code: "INVALID_PRODUCTION_EXPLORE_TENANT_LIMIT", message: `${key} must be an integer from 1 through ${maximum}.` });
      }
    }
    if (value.tenant_limits.max_response_cells_per_response !== undefined
      && (!Number.isSafeInteger(value.tenant_limits.max_response_cells_per_response)
        || Number(value.tenant_limits.max_response_cells_per_response) < 1
        || Number(value.tenant_limits.max_response_cells_per_response) > 1_000_000_000)) {
      errors.push({
        path: "$.production_explore.tenant_limits.max_response_cells_per_response",
        code: "INVALID_PRODUCTION_EXPLORE_TENANT_LIMIT",
        message: "max_response_cells_per_response must be an integer from 1 through 1000000000.",
      });
    }
  }

  const storage = isRecord(config.storage) ? config.storage : undefined;
  const sharedPostgres = storage && isRecord(storage.shared_postgres) ? storage.shared_postgres : undefined;
  if (sharedPostgres?.mode !== "runtime_store") {
    errors.push({ path: "$.storage.shared_postgres.mode", code: "PRODUCTION_EXPLORE_SHARED_STORE_REQUIRED", message: "production Explore requires shared_postgres.mode = runtime_store for durable cross-process privacy accounting." });
  }
  const trustedContext = isRecord(config.trusted_context) ? config.trusted_context : undefined;
  if (trustedContext?.provider !== "http_claims") {
    errors.push({ path: "$.trusted_context.provider", code: "PRODUCTION_EXPLORE_HTTP_CLAIMS_REQUIRED", message: "production Explore requires tenant and principal scope from verified HTTP claims." });
  }
  const sessionAuth = isRecord(config.session_auth) ? config.session_auth : undefined;
  if (sessionAuth?.provider !== "jwt_asymmetric") {
    errors.push({ path: "$.session_auth.provider", code: "PRODUCTION_EXPLORE_ASYMMETRIC_JWT_REQUIRED", message: "production Explore requires asymmetric JWT verification with RS256 or ES256." });
  }
  if (!isNonEmptyString(sessionAuth?.issuer)) {
    errors.push({ path: "$.session_auth.issuer", code: "PRODUCTION_EXPLORE_ISSUER_REQUIRED", message: "production Explore requires an exact JWT issuer." });
  }
  if (!isNonEmptyString(sessionAuth?.audience)) {
    errors.push({ path: "$.session_auth.audience", code: "PRODUCTION_EXPLORE_AUDIENCE_REQUIRED", message: "production Explore requires an exact JWT audience." });
  }
  if (singleOrganizationId === undefined && !isSafeIdentifier(sessionAuth?.tenant_claim)) {
    errors.push({ path: "$.session_auth.tenant_claim", code: "PRODUCTION_EXPLORE_TENANT_CLAIM_REQUIRED", message: "Multi-tenant production Explore requires an explicit safe tenant_claim." });
  }
  if (singleOrganizationId !== undefined && sessionAuth?.tenant_claim !== undefined) {
    errors.push({
      path: "$.session_auth.tenant_claim",
      code: "PRODUCTION_EXPLORE_SINGLE_ORGANIZATION_TENANT_CLAIM_FORBIDDEN",
      message: "Single-organization production Explore uses production_explore.single_organization_id and must not accept a tenant claim from the request.",
    });
  }
  if (!isSafeIdentifier(sessionAuth?.principal_claim)) {
    errors.push({ path: "$.session_auth.principal_claim", code: "PRODUCTION_EXPLORE_PRINCIPAL_CLAIM_REQUIRED", message: "production Explore requires an explicit safe principal_claim." });
  }
  const httpSecurity = isRecord(config.http_security) ? config.http_security : undefined;
  if (httpSecurity?.deployment !== "shared") {
    errors.push({ path: "$.http_security.deployment", code: "PRODUCTION_EXPLORE_SHARED_HTTP_REQUIRED", message: "production Explore requires the shared secured HTTP deployment posture." });
  }
  if (httpSecurity?.channel !== "direct_tls" && httpSecurity?.channel !== "trusted_tls_proxy") {
    errors.push({ path: "$.http_security.channel", code: "PRODUCTION_EXPLORE_SECURE_CHANNEL_REQUIRED", message: "production Explore requires direct TLS or an explicitly trusted TLS proxy." });
  }
  if (isRecord(httpSecurity?.static_token)) {
    errors.push({ path: "$.http_security.static_token", code: "PRODUCTION_EXPLORE_STATIC_TOKEN_FORBIDDEN", message: "production Explore cannot use an opaque static token as an authentication substitute." });
  }
  const oauth = httpSecurity && isRecord(httpSecurity.oauth_resource) ? httpSecurity.oauth_resource : undefined;
  const requiredScopes = Array.isArray(oauth?.required_scopes) ? oauth.required_scopes : [];
  if (!isOAuthScope(value.required_oauth_scope) || !requiredScopes.includes(value.required_oauth_scope)) {
    errors.push({ path: "$.http_security.oauth_resource.required_scopes", code: "PRODUCTION_EXPLORE_SCOPE_NOT_REQUIRED", message: "The production Explore OAuth scope must be listed in http_security.oauth_resource.required_scopes." });
  }
}

function validateGeneratedAuthority(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.generated_authority", code: "GENERATED_AUTHORITY_NOT_OBJECT", message: "generated_authority must identify the reviewed generation lock for generated protected capabilities." });
    return;
  }
  if (strict) checkUnknownKeys(value, GENERATED_AUTHORITY_KEYS, "$.generated_authority", errors);
  if (!isNonEmptyString(value.generation_lock_path)
    || value.generation_lock_path.includes("://")
    || /[\u0000-\u001f\u007f]/.test(value.generation_lock_path)) {
    errors.push({ path: "$.generated_authority.generation_lock_path", code: "INVALID_GENERATION_LOCK_PATH", message: "generation_lock_path must be a non-empty local file path, not a URL or credential." });
  }
  if (value.enforcement !== "required") {
    errors.push({ path: "$.generated_authority.enforcement", code: "INVALID_GENERATION_LOCK_ENFORCEMENT", message: "generated authority must use required lock enforcement." });
  }
  if (value.reporting_timezone !== undefined && value.reporting_timezone !== "UTC") {
    errors.push({ path: "$.generated_authority.reporting_timezone", code: "INVALID_REPORTING_TIMEZONE", message: "generated analytical authority currently supports only the reviewed UTC reporting timezone." });
  }
  if (value.minimum_cohort_overrides !== undefined) {
    if (!isRecord(value.minimum_cohort_overrides)) {
      errors.push({
        path: "$.generated_authority.minimum_cohort_overrides",
        code: "INVALID_MINIMUM_COHORT_OVERRIDES",
        message: "minimum_cohort_overrides must map fixed capability names to exact reviewed override metadata.",
      });
    } else {
      for (const [capability, rawOverride] of Object.entries(value.minimum_cohort_overrides)) {
        const path = `$.generated_authority.minimum_cohort_overrides.${capability}`;
        if (!isQualifiedName(capability) || !isRecord(rawOverride)) {
          errors.push({
            path,
            code: "INVALID_MINIMUM_COHORT_OVERRIDE",
            message: "each minimum cohort override must use a qualified capability name and bounded metadata object.",
          });
          continue;
        }
        if (strict) checkUnknownKeys(rawOverride, MINIMUM_COHORT_OVERRIDE_KEYS, path, errors);
        if (typeof rawOverride.contract_digest !== "string"
          || !/^sha256:[a-f0-9]{64}$/.test(rawOverride.contract_digest)) {
          errors.push({
            path: `${path}.contract_digest`,
            code: "INVALID_MINIMUM_COHORT_OVERRIDE_DIGEST",
            message: "minimum cohort override must bind the exact protected contract digest.",
          });
        }
        if (!Number.isSafeInteger(rawOverride.minimum_cohort_size)
          || Number(rawOverride.minimum_cohort_size) < 1
          || Number(rawOverride.minimum_cohort_size) >= 5) {
          errors.push({
            path: `${path}.minimum_cohort_size`,
            code: "INVALID_MINIMUM_COHORT_OVERRIDE_VALUE",
            message: "minimum cohort override must be an integer from 1 through 4.",
          });
        }
        if (typeof rawOverride.review_digest !== "string"
          || !/^sha256:[a-f0-9]{64}$/.test(rawOverride.review_digest)) {
          errors.push({
            path: `${path}.review_digest`,
            code: "INVALID_MINIMUM_COHORT_REVIEW_DIGEST",
            message: "minimum cohort override must bind an exact non-secret review digest.",
          });
        }
      }
    }
  }
}

function validateNotifications(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.notifications", code: "NOTIFICATIONS_NOT_OBJECT", message: "notifications must be an operator-owned configuration object." });
    return;
  }
  if (strict) checkUnknownKeys(value, NOTIFICATION_KEYS, "$.notifications", errors);
  if (typeof value.enabled !== "boolean") {
    errors.push({ path: "$.notifications.enabled", code: "NOTIFICATIONS_ENABLED_REQUIRED", message: "notifications.enabled must be an explicit boolean." });
  }
  if (value.workbench_url_env !== undefined && !isEnvName(value.workbench_url_env)) {
    errors.push({ path: "$.notifications.workbench_url_env", code: "INVALID_WORKBENCH_URL_ENV", message: "workbench_url_env must name an environment variable, not contain a URL." });
  }
  if (!Array.isArray(value.sinks)) {
    errors.push({ path: "$.notifications.sinks", code: "NOTIFICATION_SINKS_REQUIRED", message: "notifications.sinks must be an explicit array." });
    return;
  }
  if (value.sinks.length > 32) {
    errors.push({ path: "$.notifications.sinks", code: "TOO_MANY_NOTIFICATION_SINKS", message: "notifications supports at most 32 operator-owned sinks." });
  }
  if (value.enabled === true && value.sinks.filter(isRecord).every((sink) => sink.enabled === false)) {
    errors.push({ path: "$.notifications.sinks", code: "ENABLED_NOTIFICATION_SINK_REQUIRED", message: "enabled notifications require at least one sink that is not disabled." });
  }
  const seen = new Set<string>();
  for (const [index, rawSink] of value.sinks.entries()) {
    const path = `$.notifications.sinks[${index}]`;
    if (!isRecord(rawSink)) {
      errors.push({ path, code: "NOTIFICATION_SINK_NOT_OBJECT", message: "each notification sink must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(rawSink, NOTIFICATION_SINK_KEYS, path, errors);
    if (!isSafeName(rawSink.id)) {
      errors.push({ path: `${path}.id`, code: "INVALID_NOTIFICATION_SINK_ID", message: "notification sink id must be a fixed safe name." });
    } else if (seen.has(rawSink.id)) {
      errors.push({ path: `${path}.id`, code: "DUPLICATE_NOTIFICATION_SINK_ID", message: "notification sink ids must be unique." });
    } else seen.add(rawSink.id);
    if (rawSink.type !== "webhook" && rawSink.type !== "jsonl") {
      errors.push({ path: `${path}.type`, code: "INVALID_NOTIFICATION_SINK_TYPE", message: "notification sink type must be webhook or jsonl." });
    }
    if (rawSink.enabled !== undefined && typeof rawSink.enabled !== "boolean") {
      errors.push({ path: `${path}.enabled`, code: "INVALID_NOTIFICATION_SINK_ENABLED", message: "notification sink enabled must be boolean." });
    }
    if (rawSink.type === "webhook") {
      if (!isEnvName(rawSink.url_env)) {
        errors.push({ path: `${path}.url_env`, code: "NOTIFICATION_WEBHOOK_URL_ENV_REQUIRED", message: "webhook url_env must name an environment variable." });
      }
      if (!isEnvName(rawSink.signing_secret_env)) {
        errors.push({ path: `${path}.signing_secret_env`, code: "NOTIFICATION_SIGNING_SECRET_ENV_REQUIRED", message: "webhook signing_secret_env must name an environment variable." });
      }
      if (rawSink.destination !== undefined) {
        errors.push({ path: `${path}.destination`, code: "WEBHOOK_DESTINATION_UNSUPPORTED", message: "webhook destinations come only from url_env." });
      }
    }
    if (rawSink.type === "jsonl") {
      if (rawSink.destination !== "stdout") {
        errors.push({ path: `${path}.destination`, code: "JSONL_STDOUT_REQUIRED", message: "the built-in JSONL development sink writes only to stdout." });
      }
      if (rawSink.url_env !== undefined || rawSink.signing_secret_env !== undefined) {
        errors.push({ path, code: "JSONL_WEBHOOK_FIELDS_FORBIDDEN", message: "JSONL sinks do not accept webhook URL or signing-secret fields." });
      }
    }
    if (rawSink.minimum_severity !== undefined && !["informational", "warning", "critical"].includes(String(rawSink.minimum_severity))) {
      errors.push({ path: `${path}.minimum_severity`, code: "INVALID_NOTIFICATION_SEVERITY", message: "minimum_severity must be informational, warning, or critical." });
    }
    if (rawSink.delivery !== undefined && !["immediate", "digest", "all"].includes(String(rawSink.delivery))) {
      errors.push({ path: `${path}.delivery`, code: "INVALID_NOTIFICATION_DELIVERY_MODE", message: "delivery must be immediate, digest, or all." });
    }
    if (rawSink.events !== undefined) {
      if (!Array.isArray(rawSink.events) || rawSink.events.length > 64 || rawSink.events.some((event) => typeof event !== "string" || !NOTIFICATION_EVENT_TYPES.has(event))) {
        errors.push({ path: `${path}.events`, code: "INVALID_NOTIFICATION_EVENT_FILTER", message: "events must contain only supported fixed attention event names." });
      }
    }
    if (rawSink.capabilities !== undefined && (!Array.isArray(rawSink.capabilities) || rawSink.capabilities.length > 256 || rawSink.capabilities.some((item) => !isQualifiedName(item)))) {
      errors.push({ path: `${path}.capabilities`, code: "INVALID_NOTIFICATION_CAPABILITY_FILTER", message: "capabilities must contain fixed qualified capability names." });
    }
    if (rawSink.environments !== undefined && (!Array.isArray(rawSink.environments) || rawSink.environments.length > 4 || rawSink.environments.some((item) => !["development", "staging", "production", "unknown"].includes(String(item))))) {
      errors.push({ path: `${path}.environments`, code: "INVALID_NOTIFICATION_ENVIRONMENT_FILTER", message: "environments must contain development, staging, production, or unknown." });
    }
    for (const [key, minimum, maximum] of [
      ["max_attempts", 1, 100],
      ["timeout_ms", 100, 30_000],
      ["max_response_bytes", 0, 65_536],
      ["replay_window_seconds", 30, 3_600],
    ] as const) {
      if (rawSink[key] !== undefined && (!Number.isSafeInteger(rawSink[key]) || Number(rawSink[key]) < minimum || Number(rawSink[key]) > maximum)) {
        errors.push({ path: `${path}.${key}`, code: "INVALID_NOTIFICATION_BOUND", message: `${key} must be an integer from ${minimum} through ${maximum}.` });
      }
    }
    if (rawSink.allow_private_destinations !== undefined && typeof rawSink.allow_private_destinations !== "boolean") {
      errors.push({ path: `${path}.allow_private_destinations`, code: "INVALID_PRIVATE_DESTINATION_POLICY", message: "allow_private_destinations must be boolean." });
    }
    if (rawSink.recovery_notifications !== undefined && typeof rawSink.recovery_notifications !== "boolean") {
      errors.push({ path: `${path}.recovery_notifications`, code: "INVALID_RECOVERY_NOTIFICATION_POLICY", message: "recovery_notifications must be boolean." });
    }
    if (rawSink.private_host_allowlist !== undefined) {
      if (!Array.isArray(rawSink.private_host_allowlist) || rawSink.private_host_allowlist.length > 32 || rawSink.private_host_allowlist.some((host) => !isSafeNotificationHost(host))) {
        errors.push({ path: `${path}.private_host_allowlist`, code: "INVALID_PRIVATE_HOST_ALLOWLIST", message: "private_host_allowlist must contain at most 32 fixed DNS hostnames or IP literals." });
      }
      if (rawSink.allow_private_destinations !== true && Array.isArray(rawSink.private_host_allowlist) && rawSink.private_host_allowlist.length > 0) {
        errors.push({ path: `${path}.allow_private_destinations`, code: "PRIVATE_DESTINATION_OPT_IN_REQUIRED", message: "private host exceptions require allow_private_destinations=true." });
      }
    }
    validateNotificationBudgets(rawSink.budgets, `${path}.budgets`, strict, errors);
    validateNotificationQuietHours(rawSink.quiet_hours, `${path}.quiet_hours`, strict, errors);
  }
}

function validateNotificationBudgets(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "NOTIFICATION_BUDGETS_NOT_OBJECT", message: "notification budgets must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, NOTIFICATION_BUDGET_KEYS, path, errors);
  for (const [key, minimum, maximum] of [
    ["per_minute", 1, 10_000],
    ["per_hour", 1, 100_000],
    ["immediate_informational_per_hour", 0, 10_000],
    ["aggregation_window_seconds", 1, 86_400],
    ["cooldown_seconds", 0, 604_800],
    ["max_unresolved_reminders", 0, 100],
    ["digest_cadence_minutes", 1, 10_080],
    ["escalation_delay_seconds", 0, 604_800],
    ["retry_attempt_threshold", 1, 100],
    ["degraded_duration_seconds", 1, 86_400],
    ["queue_depth_threshold", 1, 1_000_000],
    ["queue_age_seconds", 1, 604_800],
  ] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum)) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_NOTIFICATION_BUDGET", message: `${key} must be an integer from ${minimum} through ${maximum}.` });
    }
  }
}

function validateNotificationQuietHours(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "NOTIFICATION_QUIET_HOURS_NOT_OBJECT", message: "quiet_hours must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, NOTIFICATION_QUIET_HOURS_KEYS, path, errors);
  for (const key of ["start_utc_hour", "end_utc_hour"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 23) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_NOTIFICATION_QUIET_HOUR", message: `${key} must be an integer from 0 through 23.` });
    }
  }
}

function validateSupervisedWorker(
  value: unknown,
  config: JsonRecord,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.supervised_worker", code: "SUPERVISED_WORKER_NOT_OBJECT", message: "supervised_worker must be an explicit deployment policy object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SUPERVISED_WORKER_KEYS, "$.supervised_worker", errors);
  if (typeof value.enabled !== "boolean") {
    errors.push({ path: "$.supervised_worker.enabled", code: "SUPERVISED_WORKER_ENABLED_REQUIRED", message: "supervised_worker.enabled must be an explicit boolean." });
  }
  if (value.profile !== "development" && value.profile !== "staging" && value.profile !== "production") {
    errors.push({ path: "$.supervised_worker.profile", code: "SUPERVISED_WORKER_PROFILE_REQUIRED", message: "supervised_worker.profile must be development, staging, or production." });
  }
  if (!Array.isArray(value.capabilities)) {
    errors.push({ path: "$.supervised_worker.capabilities", code: "SUPERVISED_WORKER_CAPABILITIES_REQUIRED", message: "supervised_worker.capabilities must be an explicit exact-digest allowlist." });
    return;
  }
  if (value.enabled === true && value.capabilities.length === 0) {
    errors.push({ path: "$.supervised_worker.capabilities", code: "SUPERVISED_WORKER_ALLOWLIST_REQUIRED", message: "enabled supervised-worker execution requires at least one exact capability/digest allowlist entry." });
  }
  if (config.mode !== "review" && value.enabled === true) {
    errors.push({ path: "$.mode", code: "SUPERVISED_WORKER_REVIEW_MODE_REQUIRED", message: "supervised-worker execution requires Runner review mode." });
  }
  if (isRecord(config.governance) && config.governance.mode === "cloud_linked" && value.enabled === true) {
    errors.push({ path: "$.governance.mode", code: "SUPERVISED_WORKER_LOCAL_AUTHORITY_REQUIRED", message: "Cloud-linked governance does not permit the local supervised worker to become execution authority." });
  }
  if (value.profile === "production" && value.enabled === true) {
    const operator = isRecord(config.operator_identity) ? config.operator_identity : undefined;
    if (!operator || (operator.provider !== "signed_key" && operator.provider !== "jwt_oidc")) {
      errors.push({ path: "$.operator_identity.provider", code: "SUPERVISED_WORKER_VERIFIED_OPERATOR_REQUIRED", message: "production supervised-worker controls require signed_key or jwt_oidc operator identity." });
    }
  }

  const runtimeCapabilities = Array.isArray(config.capabilities)
    ? config.capabilities.filter(isRecord)
    : [];
  const byName = new Map(runtimeCapabilities.flatMap((capability) =>
    isQualifiedName(capability.name) ? [[String(capability.name), capability] as const] : []));
  const sources = isRecord(config.sources) ? config.sources : {};
  const notifications = isRecord(config.notifications) ? config.notifications : undefined;
  const notificationSinks = new Map(
    Array.isArray(notifications?.sinks)
      ? notifications.sinks
        .filter(isRecord)
        .filter((sink) => isSafeName(sink.id))
        .map((sink) => [String(sink.id), sink] as const)
      : [],
  );
  const seen = new Set<string>();
  for (const [index, rawEntry] of value.capabilities.entries()) {
    const path = `$.supervised_worker.capabilities[${index}]`;
    if (!isRecord(rawEntry)) {
      errors.push({ path, code: "SUPERVISED_WORKER_CAPABILITY_NOT_OBJECT", message: "each supervised-worker allowlist entry must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(rawEntry, SUPERVISED_WORKER_CAPABILITY_KEYS, path, errors);
    if (!isQualifiedName(rawEntry.capability)) {
      errors.push({ path: `${path}.capability`, code: "INVALID_SUPERVISED_WORKER_CAPABILITY", message: "capability must be a fixed qualified capability name." });
    }
    if (typeof rawEntry.contract_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(rawEntry.contract_digest)) {
      errors.push({ path: `${path}.contract_digest`, code: "INVALID_SUPERVISED_WORKER_DIGEST", message: "contract_digest must be the exact canonical sha256 digest." });
    }
    if (rawEntry.mode !== "supervised_worker") {
      errors.push({ path: `${path}.mode`, code: "INVALID_SUPERVISED_WORKER_MODE", message: "mode must be supervised_worker." });
    }
    for (const [key, minimum, maximum] of [
      ["concurrency", 1, 32],
      ["queue_limit", 1, 10000],
      ["lease_seconds", 15, 3600],
      ["max_attempts", 1, 100],
      ["proposal_ttl_seconds", 60, 2_592_000],
    ] as const) {
      if (!Number.isSafeInteger(rawEntry[key]) || Number(rawEntry[key]) < minimum || Number(rawEntry[key]) > maximum) {
        errors.push({ path: `${path}.${key}`, code: "INVALID_SUPERVISED_WORKER_BOUND", message: `${key} must be an integer from ${minimum} through ${maximum}.` });
      }
    }
    if (!isEnvName(rawEntry.write_url_env)) {
      errors.push({ path: `${path}.write_url_env`, code: "SUPERVISED_WORKER_WRITE_ENV_REQUIRED", message: "write_url_env must name the separately configured writer credential environment variable." });
    }
    if (
      rawEntry.require_least_privilege_writer !== undefined
      && typeof rawEntry.require_least_privilege_writer !== "boolean"
    ) {
      errors.push({ path: `${path}.require_least_privilege_writer`, code: "INVALID_SUPERVISED_WORKER_POSTURE_MODE", message: "require_least_privilege_writer must be an explicit boolean when present." });
    }
    if (
      rawEntry.writer_posture_fingerprint !== undefined
      && (
        typeof rawEntry.writer_posture_fingerprint !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(rawEntry.writer_posture_fingerprint)
      )
    ) {
      errors.push({ path: `${path}.writer_posture_fingerprint`, code: "INVALID_SUPERVISED_WORKER_POSTURE_FINGERPRINT", message: "writer_posture_fingerprint must be the reviewed non-secret sha256 posture digest." });
    }
    if (
      rawEntry.require_least_privilege_writer === true
      && rawEntry.writer_posture_fingerprint === undefined
    ) {
      errors.push({ path: `${path}.writer_posture_fingerprint`, code: "SUPERVISED_WORKER_POSTURE_FINGERPRINT_REQUIRED", message: "hardened writer posture requires an exact reviewed posture fingerprint." });
    }
    if (
      value.enabled === true
      && value.profile === "production"
      && (
        rawEntry.require_least_privilege_writer !== true
        || rawEntry.writer_posture_fingerprint === undefined
      )
    ) {
      errors.push({ path, code: "SUPERVISED_WORKER_PRODUCTION_POSTURE_REQUIRED", message: "production supervised execution requires live least-privilege writer verification bound to an exact reviewed posture fingerprint." });
    }
    if (rawEntry.worker_identity !== undefined && !isSafeName(rawEntry.worker_identity)) {
      errors.push({ path: `${path}.worker_identity`, code: "INVALID_SUPERVISED_WORKER_IDENTITY", message: "worker_identity must be a fixed safe operator identity." });
    }
    if (rawEntry.control_role !== undefined && !isSafeName(rawEntry.control_role)) {
      errors.push({ path: `${path}.control_role`, code: "INVALID_SUPERVISED_WORKER_CONTROL_ROLE", message: "control_role must be a fixed safe operator role." });
    }
    if (rawEntry.required_attention_sinks !== undefined) {
      if (
        !Array.isArray(rawEntry.required_attention_sinks)
        || rawEntry.required_attention_sinks.length < 1
        || rawEntry.required_attention_sinks.length > 8
        || rawEntry.required_attention_sinks.some((sink) => !isSafeName(sink))
      ) {
        errors.push({ path: `${path}.required_attention_sinks`, code: "INVALID_REQUIRED_ATTENTION_SINKS", message: "required_attention_sinks must contain 1 through 8 fixed sink ids." });
      } else {
        if (notifications?.enabled !== true) {
          errors.push({ path: "$.notifications.enabled", code: "HEALTH_GATE_NOTIFICATIONS_REQUIRED", message: "required attention sinks need notifications.enabled=true." });
        }
        for (const [sinkIndex, sinkId] of rawEntry.required_attention_sinks.entries()) {
          const sink = notificationSinks.get(String(sinkId));
          if (!sink || sink.enabled === false) {
            errors.push({ path: `${path}.required_attention_sinks[${sinkIndex}]`, code: "REQUIRED_ATTENTION_SINK_UNAVAILABLE", message: `required attention sink ${String(sinkId)} must name an enabled configured sink.` });
          }
        }
      }
    }
    if (!isRecord(rawEntry.rate_limit)) {
      errors.push({ path: `${path}.rate_limit`, code: "SUPERVISED_WORKER_RATE_LIMIT_REQUIRED", message: "rate_limit must define a bounded execution window." });
    } else {
      if (strict) checkUnknownKeys(rawEntry.rate_limit, SUPERVISED_WORKER_RATE_LIMIT_KEYS, `${path}.rate_limit`, errors);
      if (!Number.isSafeInteger(rawEntry.rate_limit.executions) || Number(rawEntry.rate_limit.executions) < 1 || Number(rawEntry.rate_limit.executions) > 100000) {
        errors.push({ path: `${path}.rate_limit.executions`, code: "INVALID_SUPERVISED_WORKER_RATE", message: "rate_limit.executions must be an integer from 1 through 100000." });
      }
      if (!Number.isSafeInteger(rawEntry.rate_limit.window_seconds) || Number(rawEntry.rate_limit.window_seconds) < 1 || Number(rawEntry.rate_limit.window_seconds) > 86400) {
        errors.push({ path: `${path}.rate_limit.window_seconds`, code: "INVALID_SUPERVISED_WORKER_WINDOW", message: "rate_limit.window_seconds must be an integer from 1 through 86400." });
      }
    }

    const key = `${String(rawEntry.capability)}:${String(rawEntry.contract_digest)}`;
    if (seen.has(key)) {
      errors.push({ path, code: "DUPLICATE_SUPERVISED_WORKER_ALLOWLIST", message: "each capability/digest may appear only once." });
    }
    seen.add(key);

    const capability = byName.get(String(rawEntry.capability));
    if (!capability) {
      if (runtimeCapabilities.length > 0 || !Array.isArray(config.contracts)) {
        errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_CAPABILITY_UNKNOWN", message: "allowlist capability must resolve from the active Runner contract catalog." });
      }
      continue;
    }
    const provenance = isRecord(capability.contract_provenance) ? capability.contract_provenance : undefined;
    if (!provenance || provenance.digest !== rawEntry.contract_digest) {
      errors.push({ path: `${path}.contract_digest`, code: "SUPERVISED_WORKER_DIGEST_MISMATCH", message: "allowlist digest must exactly match the active capability contract digest." });
    }
    if (!isRecord(capability.execution) || capability.execution.supervised_worker !== "allowed") {
      errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_CONTRACT_PERMISSION_REQUIRED", message: "the active capability contract does not permit supervised-worker execution." });
    }
    const source = isNonEmptyString(capability.source) && isRecord(sources[capability.source])
      ? sources[capability.source] as JsonRecord
      : undefined;
    if (!source || source.write_url_env !== rawEntry.write_url_env || source.read_only === true) {
      errors.push({ path: `${path}.write_url_env`, code: "SUPERVISED_WORKER_WRITER_MISMATCH", message: "allowlist write_url_env must match the selected writable source without embedding a credential." });
    }
    if (!source || !isRecord(source.receipts)) {
      errors.push({ path: `$.sources.${String(capability.source)}.receipts`, code: "SUPERVISED_WORKER_RECEIPT_AUTHORITY_REQUIRED", message: "supervised-worker execution requires explicit source_db or runner_ledger receipt authority." });
    }
    if (
      rawEntry.require_least_privilege_writer === true
      && source
      && isRecord(source.receipts)
      && source.receipts.authority === "source_db"
      && (
        source.receipts.provisioning !== "precreated"
        || !isSafeIdentifier(source.receipts.schema)
        || !isSafeIdentifier(source.receipts.table)
      )
    ) {
      errors.push({
        path: `$.sources.${String(capability.source)}.receipts`,
        code: "SUPERVISED_WORKER_PRECREATED_RECEIPT_REQUIRED",
        message: "hardened supervised execution with source_db receipts requires an explicitly named precreated receipt table; the runtime writer must not retain schema-creation authority.",
      });
    }
    if (!isRecord(capability.target) || !isSafeIdentifier(capability.target.tenant_key)) {
      errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_TENANT_SCOPE_REQUIRED", message: "supervised-worker execution requires a trusted tenant-scoped target." });
    }
    const operation = isRecord(capability.operation) ? capability.operation : { kind: "update" };
    const operationKind = operation.kind ?? "update";
    if (operation.cardinality === "set"
      || operationKind === "delete"
      || capability.reversibility !== undefined
      || !isRecord(capability.writeback)
      || capability.writeback.mode !== "direct_sql") {
      errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_SHAPE_INELIGIBLE", message: "the first supervised-worker release permits only native single-row direct_sql UPDATE/INSERT without compensation." });
    }
    if (operationKind === "update"
      && (!isRecord(capability.conflict_guard)
        || !isSafeIdentifier(capability.conflict_guard.column)
        || capability.conflict_guard.weak_guard_ack === true)) {
      errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_EXACT_GUARD_REQUIRED", message: "supervised-worker UPDATE requires an exact version/conflict guard." });
    }
    if (operationKind === "insert" && !isRecord(operation.deduplication)) {
      errors.push({ path: `${path}.capability`, code: "SUPERVISED_WORKER_INSERT_DEDUP_REQUIRED", message: "supervised-worker INSERT requires reviewed deterministic source deduplication." });
    }
  }
}

function validateHttpSecurity(
  value: unknown,
  sessionAuth: unknown,
  trustedContext: unknown,
  contexts: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.http_security", code: "HTTP_SECURITY_NOT_OBJECT", message: "http_security must be a Runner deployment configuration object." });
    return;
  }
  if (strict) checkUnknownKeys(value, HTTP_SECURITY_KEYS, "$.http_security", errors);
  const deployment = value.deployment;
  if (deployment !== undefined && deployment !== "loopback" && deployment !== "single_tenant" && deployment !== "shared") {
    errors.push({ path: "$.http_security.deployment", code: "INVALID_HTTP_DEPLOYMENT", message: "http_security.deployment must be loopback, single_tenant, or shared." });
  }
  const channel = value.channel;
  if (channel !== undefined && channel !== "direct_tls" && channel !== "trusted_tls_proxy" && channel !== "insecure_http_break_glass") {
    errors.push({ path: "$.http_security.channel", code: "INVALID_HTTP_CHANNEL", message: "http_security.channel must be direct_tls, trusted_tls_proxy, or insecure_http_break_glass." });
  }
  validateHttpStaticToken(value.static_token, strict, errors);
  validateHttpOauthResource(value.oauth_resource, strict, errors);
  validateExactOrigins(value.allowed_origins, errors);
  validateAllowedHosts(value.allowed_hosts, errors);
  validateHttpLimits(value.limits, strict, errors);

  const contextsUseClaims = (isRecord(trustedContext) && trustedContext.provider === "http_claims")
    || (isRecord(contexts) && Object.values(contexts).some((context) => isRecord(context) && context.provider === "http_claims"));
  if (deployment === "shared") {
    if (!contextsUseClaims) {
      errors.push({ path: "$.http_security.deployment", code: "SHARED_HTTP_CLAIMS_REQUIRED", message: "shared HTTP deployment requires http_claims trusted context so tenant and principal come from verified per-session identity." });
    }
    if (!isRecord(sessionAuth)) {
      errors.push({ path: "$.session_auth", code: "SHARED_HTTP_SESSION_AUTH_REQUIRED", message: "shared HTTP deployment requires signed session_auth." });
    } else {
      if (!isNonEmptyString(sessionAuth.issuer)) errors.push({ path: "$.session_auth.issuer", code: "SHARED_HTTP_ISSUER_REQUIRED", message: "shared HTTP deployment requires an exact JWT issuer." });
      if (!isNonEmptyString(sessionAuth.audience)) errors.push({ path: "$.session_auth.audience", code: "SHARED_HTTP_AUDIENCE_REQUIRED", message: "shared HTTP deployment requires an exact JWT audience/resource." });
      if (sessionAuth.provider === "jwt_hs256") {
        warnings.push({ path: "$.session_auth.provider", code: "SHARED_HTTP_HS256_WARNING", message: "Shared HTTP uses a symmetric JWT verification key. Prefer jwt_asymmetric with RS256/ES256 and JWKS for production." });
      }
    }
    if (!isRecord(value.oauth_resource)) {
      errors.push({ path: "$.http_security.oauth_resource", code: "SHARED_HTTP_OAUTH_RESOURCE_REQUIRED", message: "shared HTTP deployment requires RFC 9728 protected-resource metadata for an external authorization server." });
    } else if (isRecord(sessionAuth) && isNonEmptyString(sessionAuth.audience) && value.oauth_resource.resource !== sessionAuth.audience) {
      errors.push({ path: "$.http_security.oauth_resource.resource", code: "HTTP_RESOURCE_AUDIENCE_MISMATCH", message: "oauth_resource.resource must exactly match session_auth.audience so tokens are bound to this Runner resource." });
    }
  }
  if (deployment !== "shared" && value.oauth_resource !== undefined && !contextsUseClaims) {
    errors.push({ path: "$.http_security.oauth_resource", code: "HTTP_OAUTH_CLAIMS_REQUIRED", message: "OAuth protected-resource metadata requires signed http_claims session identity." });
  }
}

function validateHttpStaticToken(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.http_security.static_token", code: "HTTP_STATIC_TOKEN_NOT_OBJECT", message: "http_security.static_token must contain environment-variable names only." });
    return;
  }
  if (strict) checkUnknownKeys(value, HTTP_STATIC_TOKEN_KEYS, "$.http_security.static_token", errors);
  if (value.active_env !== undefined && !isEnvName(value.active_env)) {
    errors.push({ path: "$.http_security.static_token.active_env", code: "INVALID_HTTP_TOKEN_ENV", message: "active_env must name the environment variable containing the opaque endpoint token." });
  }
  if (value.previous_env !== undefined && !isEnvName(value.previous_env)) {
    errors.push({ path: "$.http_security.static_token.previous_env", code: "INVALID_HTTP_PREVIOUS_TOKEN_ENV", message: "previous_env must name the one previous token accepted during an operator-controlled rotation window." });
  }
  if (value.active_env !== undefined && value.active_env === value.previous_env) {
    errors.push({ path: "$.http_security.static_token.previous_env", code: "HTTP_TOKEN_ENV_REUSED", message: "active_env and previous_env must be different environment variables." });
  }
}

function validateHttpOauthResource(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.http_security.oauth_resource", code: "HTTP_OAUTH_RESOURCE_NOT_OBJECT", message: "oauth_resource must describe this Runner protected resource and its external authorization server." });
    return;
  }
  if (strict) checkUnknownKeys(value, HTTP_OAUTH_RESOURCE_KEYS, "$.http_security.oauth_resource", errors);
  if (!isHttpsUrl(value.resource)) {
    errors.push({ path: "$.http_security.oauth_resource.resource", code: "INVALID_HTTP_OAUTH_RESOURCE", message: "oauth_resource.resource must be an HTTPS URL for the exact public MCP endpoint." });
  }
  if (!Array.isArray(value.authorization_servers) || value.authorization_servers.length < 1 || value.authorization_servers.length > 8) {
    errors.push({ path: "$.http_security.oauth_resource.authorization_servers", code: "HTTP_AUTHORIZATION_SERVERS_REQUIRED", message: "oauth_resource.authorization_servers must contain 1 through 8 external authorization-server HTTPS issuer URLs." });
  } else {
    value.authorization_servers.forEach((server, index) => {
      if (!isHttpsUrl(server)) errors.push({ path: `$.http_security.oauth_resource.authorization_servers[${index}]`, code: "INVALID_HTTP_AUTHORIZATION_SERVER", message: "authorization server URLs must use HTTPS and contain no credentials, query, or fragment." });
    });
  }
  for (const key of ["scopes_supported", "required_scopes"] as const) {
    const scopes = value[key];
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 64 || scopes.some((scope) => !isOAuthScope(scope)))) {
      errors.push({ path: `$.http_security.oauth_resource.${key}`, code: "INVALID_HTTP_OAUTH_SCOPES", message: `${key} must contain 1 through 64 unique, visible OAuth scope strings.` });
    } else if (Array.isArray(scopes) && new Set(scopes).size !== scopes.length) {
      errors.push({ path: `$.http_security.oauth_resource.${key}`, code: "DUPLICATE_HTTP_OAUTH_SCOPE", message: `${key} must not contain duplicate scopes.` });
    }
  }
  if (Array.isArray(value.required_scopes) && Array.isArray(value.scopes_supported)) {
    for (const scope of value.required_scopes) {
      if (!value.scopes_supported.includes(scope)) errors.push({ path: "$.http_security.oauth_resource.required_scopes", code: "UNSUPPORTED_HTTP_OAUTH_SCOPE", message: `Required scope ${String(scope)} is not listed in scopes_supported.` });
    }
  }
  if (value.resource_name !== undefined && (!isNonEmptyString(value.resource_name) || value.resource_name.trim().length > 128)) {
    errors.push({ path: "$.http_security.oauth_resource.resource_name", code: "INVALID_HTTP_RESOURCE_NAME", message: "resource_name must be 1 through 128 characters." });
  }
  if (value.resource_documentation !== undefined && !isHttpsUrl(value.resource_documentation)) {
    errors.push({ path: "$.http_security.oauth_resource.resource_documentation", code: "INVALID_HTTP_RESOURCE_DOCUMENTATION", message: "resource_documentation must be an HTTPS URL without credentials, query, or fragment." });
  }
}

function validateExactOrigins(value: unknown, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    errors.push({ path: "$.http_security.allowed_origins", code: "INVALID_HTTP_ALLOWED_ORIGINS", message: "allowed_origins must be an array of at most 32 exact origins." });
    return;
  }
  value.forEach((origin, index) => {
    if (!isExactHttpOrigin(origin)) errors.push({ path: `$.http_security.allowed_origins[${index}]`, code: "INVALID_HTTP_ALLOWED_ORIGIN", message: "Each allowed origin must be an exact HTTP(S) origin; wildcards, credentials, paths, query strings, and fragments are forbidden." });
  });
  if (new Set(value).size !== value.length) errors.push({ path: "$.http_security.allowed_origins", code: "DUPLICATE_HTTP_ALLOWED_ORIGIN", message: "allowed_origins must not contain duplicates." });
}

function validateAllowedHosts(value: unknown, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((host) => !isAllowedHost(host))) {
    errors.push({ path: "$.http_security.allowed_hosts", code: "INVALID_HTTP_ALLOWED_HOSTS", message: "allowed_hosts must contain 1 through 32 exact host or host:port authorities; wildcards and forwarded-host syntax are forbidden." });
  } else if (new Set(value.map((host) => String(host).toLowerCase())).size !== value.length) {
    errors.push({ path: "$.http_security.allowed_hosts", code: "DUPLICATE_HTTP_ALLOWED_HOST", message: "allowed_hosts must not contain duplicates." });
  }
}

function validateHttpLimits(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.http_security.limits", code: "HTTP_LIMITS_NOT_OBJECT", message: "http_security.limits must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, HTTP_LIMIT_KEYS, "$.http_security.limits", errors);
  for (const [key, minimum, maximum] of [
    ["max_request_bytes", 1024, 16 * 1024 * 1024],
    ["max_header_bytes", 4096, 64 * 1024],
    ["max_sessions", 1, 100_000],
    ["session_idle_timeout_seconds", 10, 86_400],
    ["request_timeout_ms", 1000, 300_000],
    ["headers_timeout_ms", 1000, 120_000],
    ["keep_alive_timeout_ms", 1000, 120_000],
    ["max_connections", 1, 100_000],
  ] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum)) {
      errors.push({ path: `$.http_security.limits.${key}`, code: "INVALID_HTTP_LIMIT", message: `${key} must be an integer from ${minimum} through ${maximum}.` });
    }
  }
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isExactHttpOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value === "*" || value === "null") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      && url.origin === value;
  } catch {
    return false;
  }
}

function isAllowedHost(value: unknown): boolean {
  return typeof value === "string" && value.length <= 255 && value === value.trim()
    && !/[\s,/*\\?#]/.test(value) && !value.includes("://")
    && /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(value);
}

function isOAuthScope(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

function validateGovernance(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.governance", code: "GOVERNANCE_NOT_OBJECT", message: "governance must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, GOVERNANCE_KEYS, "$.governance", errors);
  if (value.mode !== "local_only" && value.mode !== "cloud_linked") {
    errors.push({ path: "$.governance.mode", code: "INVALID_GOVERNANCE_MODE", message: "governance.mode must be local_only or cloud_linked." });
  }
  if (value.mode === "cloud_linked" && !isNonEmptyString(value.connection_file)) {
    errors.push({ path: "$.governance.connection_file", code: "CLOUD_LINKED_CONNECTION_REQUIRED", message: "cloud_linked governance requires a reviewed Cloud connection file." });
  }
  if (value.connection_file !== undefined && !isNonEmptyString(value.connection_file)) {
    errors.push({ path: "$.governance.connection_file", code: "INVALID_GOVERNANCE_CONNECTION_FILE", message: "governance.connection_file must be a non-empty path." });
  }
  if (value.evidence_residency !== undefined && value.evidence_residency !== "metadata_only") {
    errors.push({ path: "$.governance.evidence_residency", code: "UNSUPPORTED_EVIDENCE_RESIDENCY", message: "Only metadata_only Cloud evidence residency is supported; full evidence remains local." });
  }
  if (value.queue_when_unavailable !== undefined && typeof value.queue_when_unavailable !== "boolean") {
    errors.push({ path: "$.governance.queue_when_unavailable", code: "INVALID_GOVERNANCE_QUEUE_POLICY", message: "queue_when_unavailable must be true or false." });
  }
  for (const [key, min, max] of [["sync_interval_ms", 250, 300_000], ["max_attempts", 1, 100], ["outbox_retention_days", 1, 3650]] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > max)) {
      errors.push({ path: `$.governance.${key}`, code: "INVALID_GOVERNANCE_LIMIT", message: `${key} must be an integer from ${min} through ${max}.` });
    }
  }
}

function validateMetrics(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.metrics", code: "METRICS_NOT_OBJECT", message: "metrics must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, METRICS_KEYS, "$.metrics", errors);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push({ path: "$.metrics.enabled", code: "INVALID_METRICS_ENABLED", message: "metrics.enabled must be true or false." });
  }
  if (value.token_env !== undefined && !isEnvName(value.token_env)) {
    errors.push({ path: "$.metrics.token_env", code: "INVALID_METRICS_TOKEN_ENV", message: "metrics.token_env must name the environment variable containing the separate metrics bearer token." });
  }
}

function validateGraduatedTrust(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.graduated_trust", code: "GRADUATED_TRUST_NOT_OBJECT", message: "graduated_trust must be an operator configuration object." });
    return;
  }
  if (strict) checkUnknownKeys(value, GRADUATED_TRUST_KEYS, "$.graduated_trust", errors);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") errors.push({ path: "$.graduated_trust.enabled", code: "INVALID_GRADUATED_TRUST_ENABLED", message: "enabled must be true or false." });
  if (value.kill_switch !== undefined && typeof value.kill_switch !== "boolean") errors.push({ path: "$.graduated_trust.kill_switch", code: "INVALID_GRADUATED_TRUST_KILL_SWITCH", message: "kill_switch must be true or false." });
  for (const key of ["workspace_id", "project_id"] as const) if (value[key] !== undefined && !isNonEmptyString(value[key])) errors.push({ path: `$.graduated_trust.${key}`, code: "INVALID_GRADUATED_TRUST_SCOPE", message: `${key} must be a non-empty identifier when provided.` });
  if (value.criteria === undefined && value.enabled !== true) return;
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 100) {
    errors.push({ path: "$.graduated_trust.criteria", code: "GRADUATED_TRUST_CRITERIA_REQUIRED", message: "graduated trust requires 1 through 100 reviewed criteria entries." });
    return;
  }
  const seen = new Set<string>();
  value.criteria.forEach((criterion, index) => {
    const path = `$.graduated_trust.criteria[${index}]`;
    if (!isRecord(criterion)) {
      errors.push({ path, code: "GRADUATED_TRUST_CRITERION_NOT_OBJECT", message: "criterion must be an object." });
      return;
    }
    if (strict) checkUnknownKeys(criterion, GRADUATED_TRUST_CRITERION_KEYS, path, errors);
    for (const key of ["capability", "policy", "field"] as const) if (!isNonEmptyString(criterion[key])) errors.push({ path: `${path}.${key}`, code: "INVALID_GRADUATED_TRUST_REFERENCE", message: `${key} must be a non-empty reviewed name.` });
    const identity = `${String(criterion.capability)}\u0000${String(criterion.policy)}\u0000${String(criterion.field)}`;
    if (seen.has(identity)) errors.push({ path, code: "DUPLICATE_GRADUATED_TRUST_CRITERION", message: "capability/policy/field criteria must be unique." });
    seen.add(identity);
    if (!Number.isSafeInteger(criterion.minimum_human_reviews) || Number(criterion.minimum_human_reviews) < 10 || Number(criterion.minimum_human_reviews) > 10000) errors.push({ path: `${path}.minimum_human_reviews`, code: "INVALID_GRADUATED_TRUST_SAMPLE", message: "minimum_human_reviews must be an integer from 10 through 10000." });
    if (!Number.isSafeInteger(criterion.window_days) || Number(criterion.window_days) < 1 || Number(criterion.window_days) > 365) errors.push({ path: `${path}.window_days`, code: "INVALID_GRADUATED_TRUST_WINDOW", message: "window_days must be an integer from 1 through 365." });
    for (const key of ["maximum_rejection_rate", "maximum_conflict_rate", "maximum_failure_rate", "maximum_revert_rate"] as const) {
      if (typeof criterion[key] !== "number" || !Number.isFinite(criterion[key]) || criterion[key] < 0 || criterion[key] > 1) errors.push({ path: `${path}.${key}`, code: "INVALID_GRADUATED_TRUST_RATE", message: `${key} must be a finite rate from 0 through 1.` });
    }
    if (typeof criterion.maximum_threshold_increase !== "number" || !Number.isFinite(criterion.maximum_threshold_increase) || criterion.maximum_threshold_increase <= 0) errors.push({ path: `${path}.maximum_threshold_increase`, code: "INVALID_GRADUATED_TRUST_INCREMENT", message: "maximum_threshold_increase must be a finite positive number." });
    if (typeof criterion.absolute_ceiling !== "number" || !Number.isFinite(criterion.absolute_ceiling) || criterion.absolute_ceiling <= 0) errors.push({ path: `${path}.absolute_ceiling`, code: "INVALID_GRADUATED_TRUST_CEILING", message: "absolute_ceiling must be a finite positive number." });
  });
}

function validateRateLimits(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.rate_limits", code: "RATE_LIMITS_NOT_OBJECT", message: "rate_limits must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, RATE_LIMITS_KEYS, "$.rate_limits", errors);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push({ path: "$.rate_limits.enabled", code: "INVALID_RATE_LIMITS_ENABLED", message: "enabled must be true or false." });
  }
  validateRateLimitRule(value.default, "$.rate_limits.default", strict, errors);
  if (value.capabilities !== undefined) {
    if (!isRecord(value.capabilities)) {
      errors.push({ path: "$.rate_limits.capabilities", code: "RATE_LIMIT_CAPABILITIES_NOT_OBJECT", message: "capabilities must map reviewed capability names to rate-limit rules." });
    } else {
      for (const [name, rule] of Object.entries(value.capabilities)) {
        if (!isQualifiedName(name)) errors.push({ path: `$.rate_limits.capabilities.${name}`, code: "INVALID_RATE_LIMIT_CAPABILITY", message: "rate-limit capability keys must be qualified capability names." });
        validateRateLimitRule(rule, `$.rate_limits.capabilities.${name}`, strict, errors);
      }
    }
  }
  if (value.default === undefined && value.capabilities === undefined && value.enabled !== false) {
    errors.push({ path: "$.rate_limits", code: "RATE_LIMIT_RULE_REQUIRED", message: "enabled rate_limits requires default and/or capability rules." });
  }
}

function validateRateLimitRule(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "RATE_LIMIT_RULE_NOT_OBJECT", message: "rate-limit rule must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, RATE_LIMIT_RULE_KEYS, path, errors);
  if (!Number.isSafeInteger(value.requests) || Number(value.requests) < 1 || Number(value.requests) > 1_000_000) {
    errors.push({ path: `${path}.requests`, code: "INVALID_RATE_LIMIT_REQUESTS", message: "requests must be an integer from 1 to 1000000." });
  }
  if (!Number.isSafeInteger(value.window_seconds) || Number(value.window_seconds) < 1 || Number(value.window_seconds) > 86400) {
    errors.push({ path: `${path}.window_seconds`, code: "INVALID_RATE_LIMIT_WINDOW", message: "window_seconds must be an integer from 1 to 86400." });
  }
}

function validateEffectiveContextCompatibility(
  trustedContext: unknown,
  contexts: unknown,
  capabilities: unknown,
  errors: ConfigIssue[],
): void {
  const globalContext = isRecord(trustedContext) ? trustedContext : undefined;
  const namedContexts = isRecord(contexts) ? contexts : undefined;
  const usesHttpClaims = globalContext?.provider === "http_claims"
    || Boolean(namedContexts && Object.values(namedContexts).some((context) => isRecord(context) && context.provider === "http_claims"));
  if (!usesHttpClaims || !Array.isArray(capabilities)) return;

  capabilities.forEach((capability, index) => {
    if (!isRecord(capability) || !isNonEmptyString(capability.name)) return;
    const contextName = isNonEmptyString(capability.context) ? capability.context : undefined;
    const namedContext = contextName && namedContexts && isRecord(namedContexts[contextName])
      ? namedContexts[contextName]
      : undefined;
    const effectiveContext = namedContext ?? globalContext;
    if (!effectiveContext || effectiveContext.provider === "http_claims") return;
    const effectiveName = contextName ?? "trusted_context";
    const provider = typeof effectiveContext.provider === "string" ? effectiveContext.provider : "unknown";
    errors.push({
      path: contextName ? `$.contexts.${contextName}.provider` : "$.trusted_context.provider",
      code: "TRUSTED_CONTEXT_PROVIDER_CONFLICT",
      message: `Capability ${capability.name} resolves context ${effectiveName} from ${provider} while this catalog enables http_claims sessions. Bind tenant and principal with HTTP_CLAIM tenant_id and HTTP_CLAIM sub, or serve this capability from a separate non-claims Runner.`,
    });
  });
}

function validateApprovalPolicyReferences(capabilities: unknown, policies: unknown, errors: ConfigIssue[]): void {
  if (!Array.isArray(capabilities)) return;
  const policyByName = new Map<string, JsonRecord>();
  if (Array.isArray(policies)) {
    policies.forEach((policy) => {
      if (isRecord(policy) && typeof policy.name === "string") policyByName.set(policy.name, policy);
    });
  }
  capabilities.forEach((capability, index) => {
    if (!isRecord(capability) || capability.kind !== "proposal" || !isRecord(capability.approval)) return;
    const approval = capability.approval;
    const path = `$.capabilities[${index}].approval`;
    if (approval.mode === "policy") {
      if (!isNonEmptyString(approval.required_role)) {
        errors.push({ path: `${path}.required_role`, code: "APPROVAL_POLICY_ROLE_REQUIRED", message: "policy approval still requires required_role for human fallback." });
      }
      if (!isSafeName(approval.policy)) {
        errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_REQUIRED", message: "approval.mode policy requires approval.policy." });
        return;
      }
      const policy = policyByName.get(String(approval.policy));
      if (!policy || policy.kind !== "approval") {
        errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_UNRESOLVED", message: "approval.policy must reference a top-level approval policy." });
      }
    } else if (approval.policy !== undefined) {
      errors.push({ path: `${path}.policy`, code: "APPROVAL_POLICY_MODE_REQUIRED", message: "approval.policy can only be set when approval.mode is policy." });
    }
  });
}

function validateApprovals(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.approvals", code: "APPROVALS_NOT_OBJECT", message: "approvals must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, APPROVALS_KEYS, "$.approvals", errors);
  if (value.disable_auto_approval !== undefined && typeof value.disable_auto_approval !== "boolean") {
    errors.push({ path: "$.approvals.disable_auto_approval", code: "INVALID_DISABLE_AUTO_APPROVAL", message: "disable_auto_approval must be true or false." });
  }
}

function validateContracts(value: unknown, errors: ConfigIssue[]): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.contracts", code: "INVALID_CONTRACT_REFERENCES", message: "contracts must be a non-empty array of contract file paths." });
    return false;
  }
  value.forEach((contractPath, index) => {
    if (!isNonEmptyString(contractPath)) {
      errors.push({ path: `$.contracts[${index}]`, code: "INVALID_CONTRACT_REFERENCE", message: "contract references must be non-empty file paths." });
    }
    if (typeof contractPath === "string" && /(postgres(?:ql)?:\/\/|mysql:\/\/|password|secret|token)/i.test(contractPath)) {
      errors.push({ path: `$.contracts[${index}]`, code: "CONTRACT_REFERENCE_LOOKS_SECRET", message: "contracts must reference local contract files, not URLs or secrets." });
    }
  });
  return errors.every((error) => !error.path.startsWith("$.contracts"));
}

export function assertValidRunnerCapabilityConfig(input: unknown): asserts input is JsonRecord {
  const result = validateRunnerCapabilityConfig(input);
  if (!result.ok) {
    const details = result.errors.map((error) => `${error.path} ${error.code}: ${error.message}`).join("\n");
    throw new Error(`Invalid Synapsor runner config:\n${details}`);
  }
}

function validateStorage(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.storage", code: "STORAGE_NOT_OBJECT", message: "storage must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, STORAGE_KEYS, "$.storage", errors);
  if (value.sqlite_path !== undefined && !isNonEmptyString(value.sqlite_path)) {
    errors.push({ path: "$.storage.sqlite_path", code: "INVALID_SQLITE_PATH", message: "sqlite_path must be a non-empty string." });
  }
  validateSharedPostgresStorage(value.shared_postgres, strict, errors);
}

function validateSharedPostgresStorage(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.storage.shared_postgres", code: "SHARED_POSTGRES_STORAGE_NOT_OBJECT", message: "storage.shared_postgres must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SHARED_POSTGRES_STORAGE_KEYS, "$.storage.shared_postgres", errors);
  if (value.mode !== "mirror" && value.mode !== "runtime_store" && value.mode !== "disabled") {
    errors.push({ path: "$.storage.shared_postgres.mode", code: "INVALID_SHARED_POSTGRES_MODE", message: "storage.shared_postgres.mode must be mirror, runtime_store, or disabled." });
  }
  if (!isEnvName(value.url_env)) {
    errors.push({ path: "$.storage.shared_postgres.url_env", code: "SHARED_POSTGRES_URL_ENV_REQUIRED", message: "storage.shared_postgres.url_env must name the environment variable containing the shared ledger Postgres URL." });
  }
  if (value.schema !== undefined && !isSafeIdentifier(value.schema)) {
    errors.push({ path: "$.storage.shared_postgres.schema", code: "INVALID_SHARED_POSTGRES_SCHEMA", message: "storage.shared_postgres.schema must be a safe Postgres schema name." });
  }
  const lockTimeoutMs = value.lock_timeout_ms;
  if (lockTimeoutMs !== undefined && (typeof lockTimeoutMs !== "number" || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0)) {
    errors.push({ path: "$.storage.shared_postgres.lock_timeout_ms", code: "INVALID_SHARED_POSTGRES_LOCK_TIMEOUT", message: "storage.shared_postgres.lock_timeout_ms must be a non-negative integer." });
  }
  const maxEntries = value.max_entries;
  if (maxEntries !== undefined && (typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) || maxEntries < 100 || maxEntries > 100_000)) {
    errors.push({ path: "$.storage.shared_postgres.max_entries", code: "INVALID_SHARED_POSTGRES_MAX_ENTRIES", message: "storage.shared_postgres.max_entries must be a safe integer from 100 through 100000." });
  }
}

function validateSources(
  value: unknown,
  mode: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (mode === "cloud" && value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    errors.push({ path: "$.sources", code: "SOURCES_REQUIRED", message: "At least one source is required." });
    return;
  }
  for (const [sourceName, source] of Object.entries(value)) {
    const path = `$.sources.${sourceName}`;
    if (!isSafeIdentifier(sourceName)) {
      errors.push({ path, code: "UNSAFE_SOURCE_NAME", message: "Source names must use letters, numbers, underscores, dots, or dashes." });
    }
    if (!isRecord(source)) {
      errors.push({ path, code: "SOURCE_NOT_OBJECT", message: "Source config must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(source, SOURCE_KEYS, path, errors);
    if (!isSourceEngine(source.engine)) {
      errors.push({ path: `${path}.engine`, code: "INVALID_SOURCE_ENGINE", message: "engine must be postgres or mysql." });
    }
    if (!isEnvName(source.read_url_env)) {
      errors.push({
        path: `${path}.read_url_env`,
        code: "READ_URL_ENV_REQUIRED",
        message: "read_url_env must name an environment variable. Do not store database URLs in config.",
      });
    }
    if (source.write_url_env !== undefined && !isEnvName(source.write_url_env)) {
      errors.push({
        path: `${path}.write_url_env`,
        code: "INVALID_WRITE_URL_ENV",
        message: "write_url_env must name an environment variable when writeback is enabled.",
      });
    }
    if (source.statement_timeout_ms !== undefined && !isPositiveInteger(source.statement_timeout_ms)) {
      errors.push({ path: `${path}.statement_timeout_ms`, code: "INVALID_TIMEOUT", message: "statement_timeout_ms must be a positive integer." });
    }
    if (source.read_only !== undefined && typeof source.read_only !== "boolean") {
      errors.push({ path: `${path}.read_only`, code: "INVALID_SOURCE_READ_ONLY", message: "read_only must be true or false when provided." });
    }
    validateSourcePool(source.pool, `${path}.pool`, strict, errors);
    validateSourceReceipts(source.receipts, `${path}.receipts`, strict, errors);
    validateSourceDatabaseScope(source.database_scope, source.engine, `${path}.database_scope`, strict, errors);
    validateSourceCredentialScope(source.credential_scope, `${path}.credential_scope`, strict, errors);
  }
}

function validateSourceDatabaseScope(
  value: unknown,
  engine: unknown,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "SOURCE_DATABASE_SCOPE_NOT_OBJECT", message: "database_scope must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SOURCE_DATABASE_SCOPE_KEYS, path, errors);
  if (value.mode !== "application" && value.mode !== "postgres_rls") {
    errors.push({ path: `${path}.mode`, code: "INVALID_DATABASE_SCOPE_MODE", message: "database_scope.mode must be application or postgres_rls." });
    return;
  }
  if (value.mode === "application") {
    if (value.tenant_setting !== undefined || value.principal_setting !== undefined) {
      errors.push({ path, code: "APPLICATION_SCOPE_HAS_DATABASE_SETTINGS", message: "application database scope must not declare PostgreSQL session settings." });
    }
    return;
  }
  if (engine !== "postgres") {
    errors.push({ path: `${path}.mode`, code: "POSTGRES_RLS_ENGINE_REQUIRED", message: "postgres_rls database scope is supported only for PostgreSQL." });
  }
  if (!isPostgresSettingName(value.tenant_setting)) {
    errors.push({ path: `${path}.tenant_setting`, code: "INVALID_RLS_TENANT_SETTING", message: "tenant_setting must be a fixed qualified PostgreSQL custom setting name such as app.tenant_id." });
  }
  if (value.principal_setting !== undefined && !isPostgresSettingName(value.principal_setting)) {
    errors.push({ path: `${path}.principal_setting`, code: "INVALID_RLS_PRINCIPAL_SETTING", message: "principal_setting must be a fixed qualified PostgreSQL custom setting name such as app.principal_id." });
  }
  if (value.tenant_setting === value.principal_setting && value.tenant_setting !== undefined) {
    errors.push({ path, code: "RLS_SETTINGS_MUST_DIFFER", message: "tenant_setting and principal_setting must be different." });
  }
}

function validateSourceCredentialScope(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "SOURCE_CREDENTIAL_SCOPE_NOT_OBJECT", message: "credential_scope must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SOURCE_CREDENTIAL_SCOPE_KEYS, path, errors);
  if (value.mode !== "shared" && value.mode !== "tenant_resolver") {
    errors.push({ path: `${path}.mode`, code: "INVALID_CREDENTIAL_SCOPE_MODE", message: "credential_scope.mode must be shared or tenant_resolver." });
    return;
  }
  if (value.mode === "tenant_resolver" && !isSafeIdentifier(value.resolver)) {
    errors.push({ path: `${path}.resolver`, code: "TENANT_CREDENTIAL_RESOLVER_REQUIRED", message: "tenant_resolver mode requires a fixed resolver identifier; credentials remain outside this config." });
  }
  if (value.mode === "shared" && value.resolver !== undefined) {
    errors.push({ path: `${path}.resolver`, code: "SHARED_CREDENTIAL_RESOLVER_FORBIDDEN", message: "shared credential mode must not declare a resolver." });
  }
}

function isPostgresSettingName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/i.test(value);
}

function validateSourceReceipts(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "SOURCE_RECEIPTS_NOT_OBJECT", message: "source.receipts must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SOURCE_RECEIPT_KEYS, path, errors);
  if (value.authority !== "source_db" && value.authority !== "runner_ledger") {
    errors.push({ path: `${path}.authority`, code: "INVALID_RECEIPT_AUTHORITY", message: "receipts.authority must be source_db or runner_ledger." });
  }
  if (value.authority === "source_db") {
    if (value.provisioning !== "precreated" && value.provisioning !== "auto_migrate") {
      errors.push({ path: `${path}.provisioning`, code: "INVALID_RECEIPT_PROVISIONING", message: "source_db receipts require provisioning precreated or auto_migrate." });
    }
  } else if (value.provisioning !== undefined || value.schema !== undefined || value.table !== undefined) {
    errors.push({ path, code: "RUNNER_LEDGER_SOURCE_RECEIPT_FIELDS", message: "runner_ledger does not use source receipt provisioning, schema, or table." });
  }
  if (value.schema !== undefined && !isSafeIdentifier(value.schema)) errors.push({ path: `${path}.schema`, code: "INVALID_RECEIPT_SCHEMA", message: "receipt schema must be a fixed safe identifier." });
  if (value.table !== undefined && !isSafeIdentifier(value.table)) errors.push({ path: `${path}.table`, code: "INVALID_RECEIPT_TABLE", message: "receipt table must be a fixed safe identifier." });
}

function validateReceiptTopology(sources: unknown, storage: unknown, errors: ConfigIssue[]): void {
  if (!isRecord(sources)) return;
  const runnerLedgerSources = Object.entries(sources).filter(([, source]) => isRecord(source) && isRecord(source.receipts) && source.receipts.authority === "runner_ledger");
  if (runnerLedgerSources.length === 0) return;
  if (!isRecord(storage)) {
    errors.push({ path: "$.storage", code: "RUNNER_LEDGER_REQUIRES_AUTHORITATIVE_STORE", message: "runner_ledger requires local SQLite for one process or shared_postgres.mode runtime_store for a fleet." });
    return;
  }
  const shared = isRecord(storage.shared_postgres) ? storage.shared_postgres : undefined;
  if (shared && shared.mode !== "runtime_store") {
    errors.push({ path: "$.storage.shared_postgres.mode", code: "RUNNER_LEDGER_REQUIRES_RUNTIME_STORE", message: "runner_ledger cannot use mirror mode because intent durability must be authoritative before source mutation; use runtime_store." });
  } else if (!shared && storage.sqlite_path === undefined) {
    errors.push({ path: "$.storage.shared_postgres.mode", code: "RUNNER_LEDGER_REQUIRES_AUTHORITATIVE_STORE", message: "runner_ledger requires local SQLite for one process or shared_postgres.mode runtime_store for a fleet." });
  }
}

function validateSourcePool(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "SOURCE_POOL_NOT_OBJECT", message: "pool must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SOURCE_POOL_KEYS, path, errors);
  for (const [key, minimum, maximum] of [
    ["max_connections", 1, 1000],
    ["connection_timeout_ms", 100, 300000],
    ["idle_timeout_ms", 100, 3600000],
    ["queue_timeout_ms", 100, 300000],
    ["queue_limit", 0, 100000],
  ] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum)) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_SOURCE_POOL_BOUND", message: `${key} must be an integer from ${minimum} to ${maximum}.` });
    }
  }
}

function validateWritebackReadiness(
  sources: unknown,
  capabilities: unknown,
  mode: unknown,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (mode !== "review" || !isRecord(sources) || !Array.isArray(capabilities)) return;
  capabilities.forEach((capability, index) => {
    if (!isRecord(capability) || capability.kind !== "proposal") return;
    const sourceName = isNonEmptyString(capability.source) ? capability.source : undefined;
    const source = sourceName ? sources[sourceName] : undefined;
    if (!sourceName || !isRecord(source)) return;
    if (capabilityWritebackMode(capability) !== "direct_sql") return;
    if (source.read_only === true) {
      errors.push({
        path: `$.capabilities[${index}].executor`,
        code: "READ_ONLY_SOURCE_DIRECT_WRITEBACK",
        message: `Proposal capability ${String(capability.name ?? index)} uses direct SQL writeback, but source ${sourceName} is marked read_only.`,
      });
      return;
    }
    if (source.write_url_env === undefined) {
      warnings.push({
        path: `$.sources.${sourceName}.write_url_env`,
        code: "WRITEBACK_DISABLED",
        message: "No write_url_env is configured; direct SQL review-mode proposal execution cannot apply external DB changes.",
      });
    }
    const operation = isRecord(capability.operation) && typeof capability.operation.kind === "string"
      ? capability.operation.kind
      : "update";
    const receipts = isRecord(source.receipts) ? source.receipts : undefined;
    if (receipts?.authority === "runner_ledger") {
      if (operation === "update") {
        const conflictGuard = isRecord(capability.conflict_guard) ? capability.conflict_guard : undefined;
        const versionAdvance = isRecord(capability.operation) && isRecord(capability.operation.version_advance)
          ? capability.operation.version_advance
          : undefined;
        if (!conflictGuard || !isSafeIdentifier(conflictGuard.column) || conflictGuard.weak_guard_ack === true) {
          errors.push({
            path: `$.capabilities[${index}].conflict_guard`,
            code: "RUNNER_LEDGER_EXACT_VERSION_GUARD_REQUIRED",
            message: "runner_ledger UPDATE requires an exact source version column; a weak guard cannot prevent duplicate effects across the ledger/source crash window.",
          });
        }
        if (!versionAdvance) {
          errors.push({
            path: `$.capabilities[${index}].operation.version_advance`,
            code: "RUNNER_LEDGER_VERSION_ADVANCE_REQUIRED",
            message: "runner_ledger UPDATE must advance its exact version guard in the same source transaction.",
          });
        }
      }
      if (operation === "insert" && (!isRecord(capability.operation) || !isRecord(capability.operation.deduplication))) {
        errors.push({
          path: `$.capabilities[${index}].operation.deduplication`,
          code: "RUNNER_LEDGER_INSERT_SOURCE_DEDUP_REQUIRED",
          message: "runner_ledger INSERT requires a reviewed source-enforced dedup identity.",
        });
      }
      if (operation === "delete") {
        const conflictGuard = isRecord(capability.conflict_guard) ? capability.conflict_guard : undefined;
        if (!conflictGuard || !isSafeIdentifier(conflictGuard.column)) {
          errors.push({
            path: `$.capabilities[${index}].conflict_guard`,
            code: "RUNNER_LEDGER_DELETE_VERSION_GUARD_REQUIRED",
            message: "runner_ledger DELETE requires an exact source version guard.",
          });
        }
      }
    }
  });
}

function capabilityWritebackMode(capability: JsonRecord): string {
  if (isRecord(capability.writeback) && typeof capability.writeback.mode === "string" && WRITEBACK_MODES.has(capability.writeback.mode)) {
    return capability.writeback.mode;
  }
  if (isNonEmptyString(capability.executor) && capability.executor !== "sql_update") return "app_handler";
  return "direct_sql";
}

function validateCloud(value: unknown, mode: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (mode !== "cloud") {
    if (value !== undefined) {
      errors.push({
        path: "$.cloud",
        code: "CLOUD_CONFIG_ONLY_FOR_CLOUD_MODE",
        message: "cloud config is only valid when mode is cloud.",
      });
    }
    return;
  }
  if (!isRecord(value)) {
    errors.push({
      path: "$.cloud",
      code: "CLOUD_CONFIG_REQUIRED",
      message: "cloud mode requires base_url_env, runner_token_env, and adapter_id.",
    });
    return;
  }
  if (strict) checkUnknownKeys(value, CLOUD_KEYS, "$.cloud", errors);
  if (!isEnvName(value.base_url_env)) {
    errors.push({
      path: "$.cloud.base_url_env",
      code: "CLOUD_BASE_URL_ENV_REQUIRED",
      message: "cloud.base_url_env must name the environment variable containing the Synapsor Cloud base URL.",
    });
  }
  if (!isEnvName(value.runner_token_env)) {
    errors.push({
      path: "$.cloud.runner_token_env",
      code: "CLOUD_RUNNER_TOKEN_ENV_REQUIRED",
      message: "cloud.runner_token_env must name the environment variable containing the scoped runner token.",
    });
  }
  if (!isNonEmptyString(value.adapter_id)) {
    errors.push({
      path: "$.cloud.adapter_id",
      code: "CLOUD_ADAPTER_ID_REQUIRED",
      message: "cloud.adapter_id must name the approved Synapsor Cloud agent adapter.",
    });
  }
  if (value.source_id !== undefined && !isNonEmptyString(value.source_id)) {
    errors.push({
      path: "$.cloud.source_id",
      code: "INVALID_CLOUD_SOURCE_ID",
      message: "cloud.source_id must be a non-empty string when provided.",
    });
  }
  if (value.runner_id !== undefined && !isNonEmptyString(value.runner_id)) {
    errors.push({
      path: "$.cloud.runner_id",
      code: "INVALID_CLOUD_RUNNER_ID",
      message: "cloud.runner_id must be a non-empty string when provided.",
    });
  }
  if (value.runner_version !== undefined && !isNonEmptyString(value.runner_version)) {
    errors.push({
      path: "$.cloud.runner_version",
      code: "INVALID_CLOUD_RUNNER_VERSION",
      message: "cloud.runner_version must be a non-empty string when provided.",
    });
  }
  if (value.project_id !== undefined && !isNonEmptyString(value.project_id)) {
    errors.push({
      path: "$.cloud.project_id",
      code: "INVALID_CLOUD_PROJECT_ID",
      message: "cloud.project_id must be a non-empty string when provided.",
    });
  }
  if (value.engines !== undefined) {
    if (!Array.isArray(value.engines) || value.engines.length === 0 || value.engines.some((engine) => !isSourceEngine(engine))) {
      errors.push({
        path: "$.cloud.engines",
        code: "INVALID_CLOUD_ENGINES",
        message: "cloud.engines must contain postgres and/or mysql when provided.",
      });
    }
  }
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.some((capability) => !isNonEmptyString(capability))) {
      errors.push({
        path: "$.cloud.capabilities",
        code: "INVALID_CLOUD_CAPABILITIES",
        message: "cloud.capabilities must contain non-empty permission strings when provided.",
      });
    }
  }
  if (value.session !== undefined && !isRecord(value.session)) {
    errors.push({
      path: "$.cloud.session",
      code: "INVALID_CLOUD_SESSION",
      message: "cloud.session must be an object when provided.",
    });
  }
}

function validateContexts(
  value: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    errors.push({ path: "$.contexts", code: "CONTEXTS_NOT_OBJECT", message: "contexts must map context names to trusted context bindings." });
    return;
  }
  for (const [contextName, context] of Object.entries(value)) {
    const path = `$.contexts.${contextName}`;
    if (!isSafeName(contextName)) {
      errors.push({ path, code: "INVALID_CONTEXT_NAME", message: "Context names must use letters, numbers, underscores, dots, or dashes." });
    }
    validateContextObject(context, path, strict, errors, warnings);
  }
}

function validateTrustedContext(
  value: unknown,
  contexts: unknown,
  capabilities: unknown,
  mode: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
  hasContracts = false,
): void {
  if (value === undefined) {
    if (hasContracts) return;
    if (mode === "cloud") return;
    const allCapabilitiesHaveContext = Array.isArray(capabilities) &&
      capabilities.length > 0 &&
      capabilities.every((capability) => isRecord(capability) && isNonEmptyString(capability.context));
    if (isRecord(contexts) && allCapabilitiesHaveContext) return;
    errors.push({ path: "$.trusted_context", code: "TRUSTED_CONTEXT_REQUIRED", message: "trusted_context is required unless every local capability references a named context." });
    return;
  }
  validateContextObject(value, "$.trusted_context", strict, errors, warnings);
}

function validateContextObject(
  value: unknown,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "TRUSTED_CONTEXT_NOT_OBJECT", message: "Trusted context config must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, path === "$.trusted_context" ? TRUSTED_CONTEXT_KEYS : CONTEXT_KEYS, path, errors);
  if (!isTrustedContextProvider(value.provider)) {
    errors.push({
      path: `${path}.provider`,
      code: "INVALID_CONTEXT_PROVIDER",
      message: "provider must be static_dev, environment, http_claims, cloud_session, or reviewed_organization.",
    });
  }
  if (value.provider === "static_dev") {
    warnings.push({
      path: `${path}.provider`,
      code: "STATIC_DEV_CONTEXT",
      message: "static_dev is for local demos only. Do not use it for shared or production deployments.",
    });
  }
}

function validateExecutors(value: unknown, mode: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    errors.push({ path: "$.executors", code: "EXECUTORS_NOT_OBJECT", message: "executors must map executor names to executor config objects." });
    return;
  }
  for (const [executorName, executor] of Object.entries(value)) {
    const path = `$.executors.${executorName}`;
    if (!isSafeName(executorName)) {
      errors.push({ path, code: "INVALID_EXECUTOR_NAME", message: "Executor names must use letters, numbers, underscores, dots, or dashes." });
    }
    if (!isRecord(executor)) {
      errors.push({ path, code: "EXECUTOR_NOT_OBJECT", message: "Executor config must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(executor, EXECUTOR_KEYS, path, errors);
    if (!isExecutorType(executor.type)) {
      errors.push({ path: `${path}.type`, code: "INVALID_EXECUTOR_TYPE", message: "executor type must be sql_update, http_handler, or command_handler." });
      continue;
    }
    if (executor.type === "sql_update") {
      continue;
    }
    if (executor.type === "http_handler") {
      if (!isEnvName(executor.url_env)) {
        errors.push({ path: `${path}.url_env`, code: "HANDLER_URL_ENV_REQUIRED", message: "http_handler.url_env must name the environment variable containing the handler URL." });
      }
      if (executor.method !== undefined && !["POST", "PUT", "PATCH"].includes(String(executor.method))) {
        errors.push({ path: `${path}.method`, code: "INVALID_HANDLER_METHOD", message: "http_handler.method must be POST, PUT, or PATCH." });
      }
      validateExecutorAuth(executor.auth, `${path}.auth`, strict, errors);
      if (executor.signing_secret_env !== undefined && !isEnvName(executor.signing_secret_env)) {
        errors.push({ path: `${path}.signing_secret_env`, code: "HANDLER_SIGNING_SECRET_ENV_INVALID", message: "http_handler.signing_secret_env must name an environment variable containing the HMAC signing secret." });
      }
      if (executor.timeout_ms !== undefined && !isPositiveInteger(executor.timeout_ms)) {
        errors.push({ path: `${path}.timeout_ms`, code: "INVALID_HANDLER_TIMEOUT", message: "http_handler.timeout_ms must be a positive integer." });
      }
    }
    if (executor.type === "command_handler") {
      if (!isEnvName(executor.command_env)) {
        errors.push({ path: `${path}.command_env`, code: "COMMAND_ENV_REQUIRED", message: "command_handler.command_env must name the environment variable containing the executable path." });
      }
      if (executor.timeout_ms !== undefined && !isPositiveInteger(executor.timeout_ms)) {
        errors.push({ path: `${path}.timeout_ms`, code: "INVALID_HANDLER_TIMEOUT", message: "command_handler.timeout_ms must be a positive integer." });
      }
    }
    if (mode === "read_only") {
      errors.push({ path, code: "EXECUTOR_INVALID_IN_READ_ONLY", message: "writeback executors are only meaningful outside read_only mode." });
    }
  }
}

function validatePolicies(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.policies", code: "POLICIES_NOT_ARRAY", message: "policies must be an array." });
    return;
  }
  const names = new Set<string>();
  value.forEach((policy, index) => {
    const path = `$.policies[${index}]`;
    if (!isRecord(policy)) {
      errors.push({ path, code: "POLICY_NOT_OBJECT", message: "policy must be an object." });
      return;
    }
    if (strict) checkUnknownKeys(policy, POLICY_KEYS, path, errors);
    if (!isSafeName(policy.name)) errors.push({ path: `${path}.name`, code: "INVALID_POLICY_NAME", message: "policy name must be a safe or qualified identifier." });
    else if (names.has(String(policy.name))) errors.push({ path: `${path}.name`, code: "DUPLICATE_POLICY_NAME", message: `Duplicate policy name: ${String(policy.name)}` });
    else names.add(String(policy.name));
    if (!["approval", "settlement", "scope", "custom"].includes(String(policy.kind))) {
      errors.push({ path: `${path}.kind`, code: "INVALID_POLICY_KIND", message: "policy.kind must be approval, settlement, scope, or custom." });
    }
    if (policy.rules !== undefined) {
      if (!Array.isArray(policy.rules)) {
        errors.push({ path: `${path}.rules`, code: "POLICY_RULES_NOT_ARRAY", message: "policy.rules must be an array." });
      } else if (policy.kind === "approval") {
        policy.rules.forEach((rule, ruleIndex) => validateApprovalPolicyRule(rule, `${path}.rules[${ruleIndex}]`, strict, errors));
      }
    }
    if (policy.limits !== undefined) {
      if (!Array.isArray(policy.limits) || policy.limits.length === 0) {
        errors.push({ path: `${path}.limits`, code: "APPROVAL_POLICY_LIMITS_NOT_ARRAY", message: "approval policy limits must be a non-empty array." });
      } else if (policy.kind !== "approval") {
        errors.push({ path: `${path}.limits`, code: "APPROVAL_POLICY_LIMITS_KIND_REQUIRED", message: "aggregate limits are supported only for approval policies." });
      } else {
        policy.limits.forEach((limit, limitIndex) => validateApprovalPolicyLimit(limit, `${path}.limits[${limitIndex}]`, strict, errors));
      }
    }
  });
}

function validateApprovalPolicyLimit(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "APPROVAL_POLICY_LIMIT_NOT_OBJECT", message: "approval policy limits must be objects." });
    return;
  }
  if (strict) checkUnknownKeys(value, APPROVAL_POLICY_LIMIT_KEYS, path, errors);
  if (value.kind !== "count" && value.kind !== "total") errors.push({ path: `${path}.kind`, code: "INVALID_APPROVAL_POLICY_LIMIT_KIND", message: "limit kind must be count or total." });
  if (!Number.isSafeInteger(value.max) || Number(value.max) < 0) errors.push({ path: `${path}.max`, code: "INVALID_APPROVAL_POLICY_LIMIT_MAX", message: "limit max must be a safe non-negative integer." });
  if (value.period !== "day") errors.push({ path: `${path}.period`, code: "INVALID_APPROVAL_POLICY_LIMIT_PERIOD", message: "limit period must be day." });
  if (value.scope !== undefined && value.scope !== "tenant_policy" && value.scope !== "tenant_policy_object") errors.push({ path: `${path}.scope`, code: "INVALID_APPROVAL_POLICY_LIMIT_SCOPE", message: "limit scope must be tenant_policy or tenant_policy_object." });
  if (value.kind === "total" && !isSafeIdentifier(value.field)) errors.push({ path: `${path}.field`, code: "APPROVAL_POLICY_TOTAL_FIELD_REQUIRED", message: "total limits require a numeric field." });
  if (value.kind === "count" && value.field !== undefined) errors.push({ path: `${path}.field`, code: "APPROVAL_POLICY_COUNT_FIELD_FORBIDDEN", message: "count limits must not declare a field." });
}

function validateOperatorIdentity(value: unknown, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: "$.operator_identity", code: "OPERATOR_IDENTITY_NOT_OBJECT", message: "operator_identity must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, OPERATOR_IDENTITY_KEYS, "$.operator_identity", errors);
  if (value.provider !== "dev_env" && value.provider !== "signed_key" && value.provider !== "jwt_oidc") {
    errors.push({ path: "$.operator_identity.provider", code: "INVALID_OPERATOR_IDENTITY_PROVIDER", message: "operator_identity.provider must be dev_env, signed_key, or jwt_oidc." });
  }
  for (const key of ["actor_env", "roles_env"] as const) {
    if (value[key] !== undefined && !isEnvName(value[key])) {
      errors.push({ path: `$.operator_identity.${key}`, code: "INVALID_OPERATOR_IDENTITY_ENV", message: `${key} must name an environment variable.` });
    }
  }
  if (value.apply_roles !== undefined && (!Array.isArray(value.apply_roles) || value.apply_roles.length === 0 || value.apply_roles.some((role) => !isSafeName(role)))) {
    errors.push({ path: "$.operator_identity.apply_roles", code: "INVALID_OPERATOR_APPLY_ROLES", message: "apply_roles must contain one or more safe role names." });
  }
  if (value.provider === "signed_key") {
    if (!isRecord(value.operators) || Object.keys(value.operators).length === 0) {
      errors.push({ path: "$.operator_identity.operators", code: "SIGNED_OPERATORS_REQUIRED", message: "signed_key identity requires a non-empty operators map." });
      return;
    }
    for (const [operatorName, operator] of Object.entries(value.operators)) {
      const path = `$.operator_identity.operators.${operatorName}`;
      if (!isSafeName(operatorName)) errors.push({ path, code: "INVALID_OPERATOR_NAME", message: "operator names must be safe identifiers." });
      if (!isRecord(operator)) {
        errors.push({ path, code: "OPERATOR_NOT_OBJECT", message: "operator entry must be an object." });
        continue;
      }
      if (strict) checkUnknownKeys(operator, OPERATOR_KEYS, path, errors);
      if (!isNonEmptyString(operator.public_key_path)) errors.push({ path: `${path}.public_key_path`, code: "OPERATOR_PUBLIC_KEY_REQUIRED", message: "operator public_key_path is required." });
      if (!Array.isArray(operator.roles) || operator.roles.length === 0 || operator.roles.some((role) => !isSafeName(role))) {
        errors.push({ path: `${path}.roles`, code: "OPERATOR_ROLES_REQUIRED", message: "operator roles must contain one or more safe role names." });
      }
    }
  }
  if (value.provider === "jwt_oidc") {
    if (!Array.isArray(value.algorithms) || value.algorithms.length === 0 || value.algorithms.some((algorithm) => algorithm !== "RS256" && algorithm !== "ES256")) {
      errors.push({ path: "$.operator_identity.algorithms", code: "INVALID_OPERATOR_IDENTITY_ALGORITHMS", message: "jwt_oidc requires an explicit non-empty algorithms allowlist containing only RS256 and/or ES256." });
    }
    const keySources = [value.jwks_url_env, value.public_key_env, value.public_key_path].filter((source) => source !== undefined);
    if (keySources.length !== 1) {
      errors.push({ path: "$.operator_identity", code: "OPERATOR_PUBLIC_KEY_SOURCE_REQUIRED", message: "jwt_oidc requires exactly one of jwks_url_env, public_key_env, or public_key_path." });
    }
    if (value.token_stdin !== undefined && typeof value.token_stdin !== "boolean") {
      errors.push({ path: "$.operator_identity.token_stdin", code: "INVALID_OPERATOR_TOKEN_STDIN", message: "token_stdin must be a boolean." });
    }
    const tokenSources = [value.token_env !== undefined, value.token_file_env !== undefined, value.token_stdin === true].filter(Boolean).length;
    if (tokenSources > 1) {
      errors.push({ path: "$.operator_identity", code: "OPERATOR_TOKEN_SOURCE_CONFLICT", message: "jwt_oidc must read the token from exactly one configured env, token-file env, or stdin source." });
    }
    for (const key of ["token_env", "token_file_env", "attestation_secret_env", "jwks_url_env", "public_key_env"] as const) {
      if (value[key] !== undefined && !isEnvName(value[key])) errors.push({ path: `$.operator_identity.${key}`, code: "INVALID_OPERATOR_IDENTITY_ENV", message: `${key} must name an environment variable.` });
    }
    for (const key of ["roles_claim", "subject_claim"] as const) {
      if (value[key] !== undefined && !isSafeIdentifier(value[key])) errors.push({ path: `$.operator_identity.${key}`, code: "INVALID_OPERATOR_IDENTITY_CLAIM", message: `${key} must be a safe top-level JWT claim name.` });
    }
    if (value.public_key_path !== undefined && !isNonEmptyString(value.public_key_path)) {
      errors.push({ path: "$.operator_identity.public_key_path", code: "INVALID_OPERATOR_PUBLIC_KEY_PATH", message: "public_key_path must be a non-empty path." });
    }
    if (!isNonEmptyString(value.issuer)) {
      errors.push({
        path: "$.operator_identity.issuer",
        code: "OPERATOR_JWT_ISSUER_REQUIRED",
        message: "jwt_oidc operator identity requires the exact token issuer.",
      });
    }
    if (!isNonEmptyString(value.audience)) {
      errors.push({
        path: "$.operator_identity.audience",
        code: "OPERATOR_JWT_AUDIENCE_REQUIRED",
        message: "jwt_oidc operator identity requires the exact token audience/resource.",
      });
    }
    for (const [key, minimum, maximum] of [
      ["clock_skew_seconds", 0, 300],
      ["jwks_cache_seconds", 1, 86400],
      ["jwks_cooldown_seconds", 1, 3600],
      ["fetch_timeout_ms", 100, 30000],
      ["max_response_bytes", 1024, 10 * 1024 * 1024],
    ] as const) {
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum)) {
        errors.push({ path: `$.operator_identity.${key}`, code: "INVALID_OPERATOR_IDENTITY_BOUND", message: `${key} must be an integer from ${minimum} to ${maximum}.` });
      }
    }
  }
}

function validateSessionAuth(
  value: unknown,
  trustedContext: unknown,
  contexts: unknown,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  const needsSessionAuth = (isRecord(trustedContext) && trustedContext.provider === "http_claims")
    || (isRecord(contexts) && Object.values(contexts).some((context) => isRecord(context) && context.provider === "http_claims"));
  if (value === undefined) {
    if (needsSessionAuth) errors.push({ path: "$.session_auth", code: "SESSION_AUTH_REQUIRED", message: "http_claims trusted context requires session_auth." });
    return;
  }
  if (!isRecord(value)) {
    errors.push({ path: "$.session_auth", code: "SESSION_AUTH_NOT_OBJECT", message: "session_auth must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, SESSION_AUTH_KEYS, "$.session_auth", errors);
  if (value.provider !== "jwt_hs256" && value.provider !== "jwt_asymmetric") {
    errors.push({ path: "$.session_auth.provider", code: "INVALID_SESSION_AUTH_PROVIDER", message: "session_auth.provider must be jwt_hs256 or jwt_asymmetric." });
  }
  if (value.provider === "jwt_hs256") {
    if (!isEnvName(value.secret_env)) errors.push({ path: "$.session_auth.secret_env", code: "SESSION_AUTH_SECRET_ENV_REQUIRED", message: "jwt_hs256 requires secret_env naming an environment variable containing a 32-byte-or-longer HMAC secret." });
    if (value.previous_secret_env !== undefined && !isEnvName(value.previous_secret_env)) {
      errors.push({ path: "$.session_auth.previous_secret_env", code: "SESSION_AUTH_PREVIOUS_SECRET_ENV_INVALID", message: "previous_secret_env must name the previous HMAC secret during token rotation." });
    }
    if (value.algorithms !== undefined && (!Array.isArray(value.algorithms) || value.algorithms.length !== 1 || value.algorithms[0] !== "HS256")) {
      errors.push({ path: "$.session_auth.algorithms", code: "INVALID_SESSION_AUTH_ALGORITHMS", message: "jwt_hs256 algorithms, when present, must be [\"HS256\"]." });
    }
    for (const forbidden of ["jwks_url_env", "public_key_env", "public_key_path"] as const) {
      if (value[forbidden] !== undefined) errors.push({ path: `$.session_auth.${forbidden}`, code: "SESSION_AUTH_KEY_SOURCE_CONFLICT", message: `${forbidden} is only valid for jwt_asymmetric.` });
    }
  }
  if (value.provider === "jwt_asymmetric") {
    if (value.secret_env !== undefined || value.previous_secret_env !== undefined) {
      errors.push({ path: "$.session_auth", code: "SESSION_AUTH_KEY_SOURCE_CONFLICT", message: "jwt_asymmetric must use public verification material, not HMAC secret_env fields." });
    }
    if (!Array.isArray(value.algorithms) || value.algorithms.length === 0 || value.algorithms.some((algorithm) => algorithm !== "RS256" && algorithm !== "ES256")) {
      errors.push({ path: "$.session_auth.algorithms", code: "INVALID_SESSION_AUTH_ALGORITHMS", message: "jwt_asymmetric requires an explicit non-empty algorithms allowlist containing only RS256 and/or ES256." });
    }
    const sources = [value.jwks_url_env, value.public_key_env, value.public_key_path].filter((source) => source !== undefined);
    if (sources.length !== 1) {
      errors.push({ path: "$.session_auth", code: "SESSION_AUTH_PUBLIC_KEY_SOURCE_REQUIRED", message: "jwt_asymmetric requires exactly one of jwks_url_env, public_key_env, or public_key_path." });
    }
    for (const key of ["jwks_url_env", "public_key_env"] as const) {
      if (value[key] !== undefined && !isEnvName(value[key])) errors.push({ path: `$.session_auth.${key}`, code: "INVALID_SESSION_AUTH_ENV", message: `${key} must name an environment variable.` });
    }
    if (value.public_key_path !== undefined && !isNonEmptyString(value.public_key_path)) {
      errors.push({ path: "$.session_auth.public_key_path", code: "INVALID_SESSION_AUTH_PUBLIC_KEY_PATH", message: "public_key_path must be a non-empty path." });
    }
  }
  for (const key of ["issuer", "audience"] as const) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) errors.push({ path: `$.session_auth.${key}`, code: "INVALID_SESSION_AUTH_VALUE", message: `${key} must be a non-empty string.` });
  }
  for (const key of ["tenant_claim", "principal_claim"] as const) {
    if (value[key] !== undefined && !isSafeIdentifier(value[key])) errors.push({ path: `$.session_auth.${key}`, code: "INVALID_SESSION_AUTH_CLAIM", message: `${key} must be a safe top-level JWT claim name.` });
  }
  if (value.clock_skew_seconds !== undefined && (!Number.isSafeInteger(value.clock_skew_seconds) || Number(value.clock_skew_seconds) < 0 || Number(value.clock_skew_seconds) > 300)) {
    errors.push({ path: "$.session_auth.clock_skew_seconds", code: "INVALID_SESSION_AUTH_CLOCK_SKEW", message: "clock_skew_seconds must be an integer from 0 to 300." });
  }
  for (const [key, minimum, maximum] of [
    ["jwks_cache_seconds", 1, 86400],
    ["jwks_cooldown_seconds", 1, 3600],
    ["fetch_timeout_ms", 100, 30000],
    ["max_response_bytes", 1024, 10 * 1024 * 1024],
  ] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum || Number(value[key]) > maximum)) {
      errors.push({ path: `$.session_auth.${key}`, code: "INVALID_SESSION_AUTH_BOUND", message: `${key} must be an integer from ${minimum} to ${maximum}.` });
    }
  }
}

function validateApprovalPolicyRule(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "APPROVAL_POLICY_RULE_NOT_OBJECT", message: "approval policy rules must be objects." });
    return;
  }
  if (strict) checkUnknownKeys(value, APPROVAL_POLICY_RULE_KEYS, path, errors);
  if (!isSafeIdentifier(value.field)) errors.push({ path: `${path}.field`, code: "INVALID_APPROVAL_POLICY_FIELD", message: "approval policy rule field must be a safe identifier." });
  if (!Number.isInteger(value.max) || Number(value.max) < 0) errors.push({ path: `${path}.max`, code: "INVALID_APPROVAL_POLICY_MAX", message: "approval policy rule max must be a non-negative integer." });
}

function validateExecutorAuth(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path, code: "EXECUTOR_AUTH_NOT_OBJECT", message: "executor auth must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, EXECUTOR_AUTH_KEYS, path, errors);
  if (value.type !== "bearer_env") {
    errors.push({ path: `${path}.type`, code: "INVALID_EXECUTOR_AUTH", message: "Only bearer_env executor auth is supported in v0.2." });
  }
  if (!isEnvName(value.token_env)) {
    errors.push({ path: `${path}.token_env`, code: "EXECUTOR_TOKEN_ENV_REQUIRED", message: "bearer_env auth requires token_env." });
  }
}

function validateCapabilities(
  value: unknown,
  sources: unknown,
  contexts: unknown,
  executors: unknown,
  mode: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
  hasContracts = false,
  generatedAuthority?: unknown,
  productionExplore?: unknown,
): void {
  if (mode === "cloud" && value === undefined) return;
  if (hasContracts && value === undefined) return;
  if (hasContracts && Array.isArray(value) && value.length === 0) return;
  const productionExploreSurface = isRecord(productionExplore)
    && productionExplore.enabled === true
    && (value === undefined || (Array.isArray(value) && value.length === 0));
  if (productionExploreSurface) return;
  const emptyReadOnlyShell = mode === "read_only"
    && Array.isArray(value)
    && value.length === 0;
  if (emptyReadOnlyShell) {
    const lockBound = isRecord(generatedAuthority) && generatedAuthority.enforcement === "required";
    warnings.push({
      path: "$.capabilities",
      code: lockBound ? "AUTHORING_PROJECT_HAS_NO_ACTIVE_CAPABILITIES" : "READ_ONLY_CONFIG_HAS_NO_ACTIVE_CAPABILITIES",
      message: lockBound
        ? "This generated authoring project exposes no named runtime capabilities until an exact reviewed digest is activated."
        : "This read-only configuration exposes no model-facing capabilities.",
    });
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.capabilities", code: "CAPABILITIES_REQUIRED", message: "At least one capability is required." });
    return;
  }
  const sourceNames = isRecord(sources) ? new Set(Object.keys(sources)) : new Set<string>();
  const contextNames = isRecord(contexts) ? new Set(Object.keys(contexts)) : new Set<string>();
  const executorNames = isRecord(executors) ? new Set(Object.keys(executors)) : new Set<string>();
  const capabilityNames = new Map<string, number>();
  value.forEach((capability, index) => validateCapability(capability, index, sourceNames, contextNames, executorNames, strict, errors, warnings));
  value.forEach((capability, index) => {
    if (!isRecord(capability) || !isRecord(capability.target) || !isNonEmptyString(capability.target.principal_scope_key)) return;
    const source = isRecord(sources) && isNonEmptyString(capability.source) ? sources[capability.source] : undefined;
    if (isRecord(source)
      && isRecord(source.database_scope)
      && source.database_scope.mode === "postgres_rls"
      && !isPostgresSettingName(source.database_scope.principal_setting)) {
      errors.push({
        path: `$.sources.${capability.source}.database_scope.principal_setting`,
        code: "RLS_PRINCIPAL_SETTING_REQUIRED",
        message: `Capability ${capability.name} declares principal scope, so its hardened PostgreSQL source requires principal_setting.`,
      });
    }
  });
  value.forEach((capability, index) => {
    if (!isRecord(capability) || !isQualifiedName(capability.name)) return;
    const previous = capabilityNames.get(capability.name);
    if (previous !== undefined) {
      errors.push({
        path: `$.capabilities[${index}].name`,
        code: "DUPLICATE_CAPABILITY_NAME",
        message: `Capability ${capability.name} is already defined at $.capabilities[${previous}]. Capability names must be unique.`,
      });
      return;
    }
    capabilityNames.set(capability.name, index);
  });
}

function validateProposalFreshness(
  value: unknown,
  capabilitiesValue: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  hasContracts = false,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({
      path: "$.proposal_freshness",
      code: "PROPOSAL_FRESHNESS_NOT_OBJECT",
      message: "proposal_freshness must map reviewed proposal capability names to freshness policy.",
    });
    return;
  }
  const capabilities = Array.isArray(capabilitiesValue)
    ? capabilitiesValue.filter(isRecord)
    : [];
  const byName = new Map(capabilities.flatMap((capability) =>
    isQualifiedName(capability.name) ? [[String(capability.name), capability] as const] : []));
  for (const [proposalName, rawPolicy] of Object.entries(value)) {
    const path = `$.proposal_freshness.${proposalName}`;
    if (!isQualifiedName(proposalName)) {
      errors.push({ path, code: "INVALID_FRESHNESS_CAPABILITY_NAME", message: "Freshness policy keys must be existing qualified proposal capability names." });
      continue;
    }
    if (!isRecord(rawPolicy)) {
      errors.push({ path, code: "FRESHNESS_POLICY_NOT_OBJECT", message: "Freshness policy must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(rawPolicy, PROPOSAL_FRESHNESS_KEYS, path, errors);
    if (rawPolicy.approval !== "required") {
      errors.push({ path: `${path}.approval`, code: "FRESHNESS_APPROVAL_REQUIRED", message: "Freshness-enabled proposals must set approval to required." });
    }
    const proposal = byName.get(proposalName);
    if (!proposal) {
      if (!hasContracts) {
        errors.push({ path, code: "FRESHNESS_PROPOSAL_UNKNOWN", message: `Freshness policy references unknown proposal capability ${proposalName}.` });
      }
      continue;
    }
    if (proposal.kind !== "proposal") {
      errors.push({ path, code: "FRESHNESS_PROPOSAL_REQUIRED", message: `${proposalName} must be a proposal capability.` });
    }
    const writeback = isRecord(proposal.writeback) ? proposal.writeback : undefined;
    if (writeback?.mode !== "direct_sql") {
      errors.push({
        path,
        code: "FRESHNESS_DIRECT_SQL_REQUIRED",
        message: "Strict proposal freshness currently requires same-database direct_sql writeback; app-owned and cross-source handlers must enforce their own transaction preconditions.",
      });
    }
    const operation = isRecord(proposal.operation) ? proposal.operation : undefined;
    if ((operation?.kind ?? "update") !== "insert") {
      const guard = isRecord(proposal.conflict_guard) ? proposal.conflict_guard : undefined;
      if (!isSafeIdentifier(guard?.column)) {
        errors.push({ path, code: "FRESHNESS_EXACT_TARGET_GUARD_REQUIRED", message: "Freshness-required UPDATE/DELETE needs an exact conflict_guard.column; weak row hashes are not sufficient." });
      }
    }
    if (rawPolicy.dependencies !== undefined && !Array.isArray(rawPolicy.dependencies)) {
      errors.push({ path: `${path}.dependencies`, code: "FRESHNESS_DEPENDENCIES_NOT_ARRAY", message: "dependencies must be an array of reviewed single-row read references." });
      continue;
    }
    const dependencies = Array.isArray(rawPolicy.dependencies) ? rawPolicy.dependencies : [];
    if (dependencies.length > 16) {
      errors.push({ path: `${path}.dependencies`, code: "FRESHNESS_DEPENDENCY_LIMIT", message: "A proposal may declare at most 16 supporting freshness dependencies." });
    }
    const ids = new Set<string>();
    for (const [index, rawDependency] of dependencies.entries()) {
      const dependencyPath = `${path}.dependencies[${index}]`;
      if (!isRecord(rawDependency)) {
        errors.push({ path: dependencyPath, code: "FRESHNESS_DEPENDENCY_NOT_OBJECT", message: "Freshness dependency must be an object." });
        continue;
      }
      if (strict) checkUnknownKeys(rawDependency, FRESHNESS_DEPENDENCY_KEYS, dependencyPath, errors);
      if (!isSafeIdentifier(rawDependency.id)) {
        errors.push({ path: `${dependencyPath}.id`, code: "INVALID_FRESHNESS_DEPENDENCY_ID", message: "Dependency id must be a fixed safe identifier." });
      } else if (ids.has(String(rawDependency.id))) {
        errors.push({ path: `${dependencyPath}.id`, code: "DUPLICATE_FRESHNESS_DEPENDENCY_ID", message: "Dependency ids must be unique within a proposal." });
      } else {
        ids.add(String(rawDependency.id));
      }
      if (!isQualifiedName(rawDependency.capability)) {
        errors.push({ path: `${dependencyPath}.capability`, code: "INVALID_FRESHNESS_DEPENDENCY_CAPABILITY", message: "Dependency capability must be a reviewed qualified capability name." });
        continue;
      }
      const dependency = byName.get(String(rawDependency.capability));
      if (!dependency) {
        if (!hasContracts) {
          errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_DEPENDENCY_UNKNOWN", message: `Unknown supporting capability ${String(rawDependency.capability)}.` });
        }
        continue;
      }
      if (dependency.kind !== "read" || dependency.protected_read !== undefined || dependency.aggregate !== undefined) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_SINGLE_ROW_READ_REQUIRED", message: "Supporting freshness dependencies must reference reviewed single-row read capabilities." });
      }
      if (dependency.name === proposalName) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_DEPENDENCY_CYCLE", message: "A proposal cannot depend on itself." });
      }
      if (dependency.source !== proposal.source) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_CROSS_SOURCE_UNSUPPORTED", message: "Strict atomic freshness requires the proposal and supporting dependency to use the same source." });
      }
      if ((dependency.context ?? null) !== (proposal.context ?? null)) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_CONTEXT_MISMATCH", message: "Supporting freshness dependencies must use the same reviewed trusted context as the proposal." });
      }
      const target = isRecord(dependency.target) ? dependency.target : undefined;
      if (!isSafeIdentifier(target?.tenant_key) && target?.single_tenant_dev !== true) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_TENANT_SCOPE_REQUIRED", message: "Supporting dependencies require a trusted tenant key or an existing explicit single-tenant-dev boundary." });
      }
      const proposalTarget = isRecord(proposal.target) ? proposal.target : undefined;
      if (isSafeIdentifier(target?.principal_scope_key) && !isSafeIdentifier(proposalTarget?.principal_scope_key)) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_PRINCIPAL_SCOPE_UNAVAILABLE", message: "A principal-scoped dependency cannot introduce a trusted principal value absent from the proposal authority." });
      }
      if (!isSafeIdentifier(rawDependency.identity_from_arg) || !isRecord(proposal.args) || !(String(rawDependency.identity_from_arg) in proposal.args)) {
        errors.push({ path: `${dependencyPath}.identity_from_arg`, code: "FRESHNESS_IDENTITY_ARG_UNKNOWN", message: "identity_from_arg must name an existing scalar proposal argument." });
      } else {
        const proposalArg = isRecord(proposal.args[String(rawDependency.identity_from_arg)])
          ? proposal.args[String(rawDependency.identity_from_arg)] as JsonRecord
          : undefined;
        if (!proposalArg || proposalArg.type === "object_array") {
          errors.push({ path: `${dependencyPath}.identity_from_arg`, code: "FRESHNESS_IDENTITY_ARG_NOT_SCALAR", message: "identity_from_arg must reference one bounded scalar proposal argument." });
        }
      }
      const lookup = isRecord(dependency.lookup) ? dependency.lookup : undefined;
      if (!isSafeIdentifier(lookup?.id_from_arg) || !isRecord(dependency.args) || !(String(lookup?.id_from_arg) in dependency.args)) {
        errors.push({ path: `${dependencyPath}.capability`, code: "FRESHNESS_DEPENDENCY_LOOKUP_INVALID", message: "Supporting capability must have one fixed reviewed lookup argument." });
      }
      if (!isSafeIdentifier(rawDependency.version_column)) {
        errors.push({ path: `${dependencyPath}.version_column`, code: "FRESHNESS_VERSION_COLUMN_REQUIRED", message: "version_column must be an exact fixed safe identifier." });
      }
    }
  }
}

function validateCapability(
  value: unknown,
  index: number,
  sourceNames: Set<string>,
  contextNames: Set<string>,
  executorNames: Set<string>,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  const path = `$.capabilities[${index}]`;
  if (!isRecord(value)) {
    errors.push({ path, code: "CAPABILITY_NOT_OBJECT", message: "Capability config must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, CAPABILITY_KEYS, path, errors);
  if (!isQualifiedName(value.name)) {
    errors.push({ path: `${path}.name`, code: "INVALID_CAPABILITY_NAME", message: "Capability name must be namespace.name." });
  }
  if (!isCapabilityKind(value.kind)) {
    errors.push({ path: `${path}.kind`, code: "INVALID_CAPABILITY_KIND", message: "kind must be read, aggregate_read, or proposal." });
  }
  if (value.description !== undefined && !isNonEmptyString(value.description)) {
    errors.push({ path: `${path}.description`, code: "INVALID_CAPABILITY_DESCRIPTION", message: "description must be a non-empty string when provided." });
  }
  if (value.returns_hint !== undefined && !isNonEmptyString(value.returns_hint)) {
    errors.push({ path: `${path}.returns_hint`, code: "INVALID_RETURNS_HINT", message: "returns_hint must be a non-empty string when provided." });
  }
  if (value.contract_provenance !== undefined) {
    if (!isRecord(value.contract_provenance)) {
      errors.push({ path: `${path}.contract_provenance`, code: "INVALID_CONTRACT_PROVENANCE", message: "contract_provenance must be a generated digest/version object." });
    } else {
      if (strict) checkUnknownKeys(value.contract_provenance, CONTRACT_PROVENANCE_KEYS, `${path}.contract_provenance`, errors);
      if (typeof value.contract_provenance.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contract_provenance.digest)) errors.push({ path: `${path}.contract_provenance.digest`, code: "INVALID_CONTRACT_DIGEST", message: "contract provenance requires a canonical SHA-256 digest." });
      if (!isNonEmptyString(value.contract_provenance.version)) errors.push({ path: `${path}.contract_provenance.version`, code: "INVALID_CONTRACT_VERSION", message: "contract provenance requires a non-empty version." });
    }
  }
  if (!isNonEmptyString(value.source) || !sourceNames.has(value.source)) {
    errors.push({ path: `${path}.source`, code: "UNKNOWN_SOURCE", message: "Capability source must reference a configured source." });
  }
  if (value.context !== undefined && (!isNonEmptyString(value.context) || !contextNames.has(value.context))) {
    errors.push({ path: `${path}.context`, code: "UNKNOWN_CONTEXT", message: "Capability context must reference a configured named context." });
  }
  if (value.executor !== undefined) {
    if (!isNonEmptyString(value.executor)) {
      errors.push({ path: `${path}.executor`, code: "INVALID_EXECUTOR_REFERENCE", message: "executor must name a configured executor." });
    } else if (value.executor !== "sql_update" && !executorNames.has(value.executor)) {
      errors.push({ path: `${path}.executor`, code: "UNKNOWN_EXECUTOR", message: "Capability executor must be sql_update or reference a configured executor." });
    }
  }
  validateCapabilityWriteback(value, path, executorNames, strict, errors);
  validateCapabilityReversibility(value, path, strict, errors);
  const protectedRead = value.protected_read !== undefined;
  const reviewedOrganization = isRecord(value.protected_read)
    && isRecord(value.protected_read.organization_scope)
    && value.protected_read.organization_scope.mode === "single_organization"
    && typeof value.protected_read.organization_scope.organization_id === "string";
  validateTarget(value.target, `${path}.target`, strict, errors, warnings, reviewedOrganization);
  if (protectedRead) {
    validateArgs(value.args, `${path}.args`, strict, errors, true);
    if (value.kind === "read") validateVisibleColumns(value.visible_columns, `${path}.visible_columns`, errors);
    else if (value.kind === "aggregate_read") {
      if (!Array.isArray(value.visible_columns) || value.visible_columns.length !== 0) {
        errors.push({ path: `${path}.visible_columns`, code: "PROTECTED_AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "protected aggregate reads cannot expose source row columns." });
      }
    }
    validateProtectedRuntimeCapability(value, path, errors);
  } else if (value.kind === "aggregate_read") validateAggregateReadCapability(value, path, strict, errors);
  else {
    validateArgs(value.args, `${path}.args`, strict, errors);
    validateLookup(value.lookup, `${path}.lookup`, strict, errors);
    validateVisibleColumns(value.visible_columns, `${path}.visible_columns`, errors);
  }
  if (value.max_rows !== undefined && !isPositiveInteger(value.max_rows)) {
    errors.push({ path: `${path}.max_rows`, code: "INVALID_MAX_ROWS", message: "max_rows must be a positive integer." });
  }
  if (value.kind === "proposal") {
    validateProposalCapability(value, path, strict, errors);
  } else if (value.writeback !== undefined) {
    errors.push({ path: `${path}.writeback`, code: "WRITEBACK_ONLY_FOR_PROPOSAL", message: "writeback is only valid on proposal capabilities." });
  }
}

function validateAggregateReadCapability(value: JsonRecord, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value.args) || Object.keys(value.args).length !== 0) errors.push({ path: `${path}.args`, code: "AGGREGATE_MODEL_ARGS_FORBIDDEN", message: "aggregate reads cannot accept model-controlled predicate arguments." });
  if (!Array.isArray(value.visible_columns) || value.visible_columns.length !== 0) errors.push({ path: `${path}.visible_columns`, code: "AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "aggregate reads cannot expose source row columns." });
  if (!isRecord(value.aggregate)) { errors.push({ path: `${path}.aggregate`, code: "AGGREGATE_READ_REQUIRED", message: "aggregate_read requires a reviewed aggregate definition." }); return; }
  if (strict) checkUnknownKeys(value.aggregate, AGGREGATE_READ_KEYS, `${path}.aggregate`, errors);
  if (!["count", "sum", "avg"].includes(String(value.aggregate.function))) errors.push({ path: `${path}.aggregate.function`, code: "INVALID_AGGREGATE_FUNCTION", message: "aggregate function must be count, sum, or avg." });
  if (!Number.isSafeInteger(value.aggregate.minimum_group_size) || Number(value.aggregate.minimum_group_size) < 1) errors.push({ path: `${path}.aggregate.minimum_group_size`, code: "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", message: "minimum_group_size must be at least 1." });
  if (value.aggregate.function === "count") {
    if (value.aggregate.count_mode !== "rows" && value.aggregate.count_mode !== "non_null") errors.push({ path: `${path}.aggregate.count_mode`, code: "COUNT_MODE_REQUIRED", message: "COUNT requires rows or non_null mode." });
  } else if (!isSafeIdentifier(value.aggregate.column)) errors.push({ path: `${path}.aggregate.column`, code: "AGGREGATE_NUMERIC_COLUMN_REQUIRED", message: "SUM/AVG require a fixed aggregate column." });
  if (value.aggregate.selection !== undefined) validateSelection(value.aggregate.selection, `${path}.aggregate.selection`, strict, errors);
}

function validateProtectedRuntimeCapability(value: JsonRecord, path: string, errors: ConfigIssue[]): void {
  const organizationId = isRecord(value.protected_read)
    && isRecord(value.protected_read.organization_scope)
    && typeof value.protected_read.organization_scope.organization_id === "string"
    ? value.protected_read.organization_scope.organization_id
    : undefined;
  const result = validateContract({
    spec_version: "0.1",
    kind: "SynapsorContract",
    contexts: [{
      name: "runtime_context",
      bindings: [
        organizationId
          ? { name: "tenant_id", source: "reviewed_organization", key: organizationId, required: true }
          : { name: "tenant_id", source: "static_dev", key: "runtime_tenant", required: true },
        { name: "principal", source: "static_dev", key: "runtime_principal", required: true },
      ],
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    }],
    capabilities: [{
      name: value.name,
      ...(value.description === undefined ? {} : { description: value.description }),
      ...(value.returns_hint === undefined ? {} : { returns_hint: value.returns_hint }),
      kind: value.kind,
      context: "runtime_context",
      source: value.source,
      subject: value.target,
      args: value.args,
      visible_fields: value.visible_columns,
      ...(value.kept_out_fields === undefined ? {} : { kept_out_fields: value.kept_out_fields }),
      ...(value.model_withheld_fields === undefined
        ? {}
        : { model_withheld_fields: value.model_withheld_fields }),
      evidence: { required: true, query_audit: true },
      ...(value.max_rows === undefined ? {} : { max_rows: value.max_rows }),
      protected_read: value.protected_read,
    }],
  });
  for (const issue of result.errors) {
    errors.push({
      path: issue.path.replace("$.capabilities[0]", path),
      code: issue.code,
      message: issue.message,
    });
  }
}

function validateSelection(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value)) { errors.push({ path, code: "FIXED_SELECTION_REQUIRED", message: "selection must be a reviewed object." }); return; }
  if (strict) checkUnknownKeys(value, SELECTION_KEYS, path, errors);
  if (!Array.isArray(value.all) || value.all.length < 1 || value.all.length > 8) { errors.push({ path: `${path}.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed terms." }); return; }
  value.all.forEach((term, index) => {
    const termPath = `${path}.all[${index}]`;
    if (!isRecord(term)) { errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." }); return; }
    if (strict) checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column) || term.operator !== "eq" || !("value" in term) || !isScalar(term.value)) errors.push({ path: termPath, code: "INVALID_FIXED_PREDICATE", message: "predicate must use a fixed identifier, eq operator, and literal scalar." });
  });
}

function validateCapabilityReversibility(value: JsonRecord, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (value.reversibility === undefined) return;
  if (!isRecord(value.reversibility)) {
    errors.push({ path: `${path}.reversibility`, code: "REVERSIBILITY_NOT_OBJECT", message: "reversibility must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value.reversibility, REVERSIBILITY_KEYS, `${path}.reversibility`, errors);
  if (value.reversibility.mode !== "reviewed_inverse") errors.push({ path: `${path}.reversibility.mode`, code: "INVALID_REVERSIBILITY_MODE", message: "reversibility.mode must be reviewed_inverse." });
  const writebackMode = isRecord(value.writeback) ? value.writeback.mode : undefined;
  if (writebackMode !== "direct_sql") errors.push({ path: `${path}.writeback.mode`, code: "REVERSIBILITY_DIRECT_SQL_REQUIRED", message: "reviewed inverse capture requires direct_sql writeback." });
  const approvalMode = isRecord(value.approval) ? value.approval.mode : undefined;
  if (approvalMode !== "human" && approvalMode !== "operator") errors.push({ path: `${path}.approval.mode`, code: "REVERSIBILITY_HUMAN_APPROVAL_REQUIRED", message: "reversible writes require human/operator approval." });
  const operation = isRecord(value.operation) ? value.operation : undefined;
  const kind = operation?.kind ?? "update";
  if (kind === "update") {
    const conflict = isRecord(value.conflict_guard) ? value.conflict_guard : undefined;
    const advance = operation && isRecord(operation.version_advance) ? operation.version_advance : undefined;
    if (!isSafeIdentifier(conflict?.column)) errors.push({ path: `${path}.conflict_guard.column`, code: "REVERSIBILITY_CONFLICT_GUARD_REQUIRED", message: "reversible UPDATE requires an exact conflict guard." });
    if (advance?.strategy !== "integer_increment" || advance.column !== conflict?.column) errors.push({ path: `${path}.operation.version_advance`, code: "REVERSIBILITY_INTEGER_VERSION_REQUIRED", message: "reversible UPDATE requires matching integer_increment version advancement." });
  }
  if (kind === "insert") {
    const target = isRecord(value.target) ? value.target : undefined;
    const dedup = operation && isRecord(operation.deduplication) && Array.isArray(operation.deduplication.components) ? operation.deduplication.components : [];
    if (!isSafeIdentifier(target?.primary_key) || !dedup.some((component) => isRecord(component) && component.column === target?.primary_key)) errors.push({ path: `${path}.operation.deduplication.components`, code: "REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED", message: "reversible INSERT requires deterministic primary-key deduplication." });
  }
}

function validateCapabilityWriteback(
  capability: JsonRecord,
  path: string,
  executorNames: Set<string>,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (capability.writeback === undefined) return;
  if (!isRecord(capability.writeback)) {
    errors.push({ path: `${path}.writeback`, code: "WRITEBACK_NOT_OBJECT", message: "writeback must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(capability.writeback, WRITEBACK_KEYS, `${path}.writeback`, errors);
  if (!WRITEBACK_MODES.has(String(capability.writeback.mode))) {
    errors.push({ path: `${path}.writeback.mode`, code: "INVALID_WRITEBACK_MODE", message: "writeback.mode must be direct_sql, app_handler, cloud_worker, or none." });
    return;
  }
  const mode = String(capability.writeback.mode);
  const executor = isNonEmptyString(capability.writeback.executor)
    ? capability.writeback.executor
    : isNonEmptyString(capability.executor) ? capability.executor : undefined;
  if (mode === "direct_sql") {
    if (executor !== undefined && executor !== "sql_update") {
      errors.push({ path: `${path}.writeback.executor`, code: "WRITEBACK_EXECUTOR_MISMATCH", message: "direct_sql writeback cannot name an app-owned executor." });
    }
    return;
  }
  if (mode === "none") {
    if (executor !== undefined) {
      errors.push({ path: `${path}.writeback.executor`, code: "WRITEBACK_EXECUTOR_MISMATCH", message: "WRITEBACK NONE must not name an executor." });
    }
    return;
  }
  if (mode === "cloud_worker") return;
  if (!executor || executor === "sql_update") {
    errors.push({ path: `${path}.writeback.executor`, code: "WRITEBACK_EXECUTOR_REQUIRED", message: "app_handler writeback must name a configured executor." });
  } else if (!executorNames.has(executor)) {
    errors.push({ path: `${path}.writeback.executor`, code: "UNKNOWN_EXECUTOR", message: "app_handler writeback executor must reference a configured executor." });
  }
}

function validateTarget(
  value: unknown,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
  reviewedOrganization = false,
): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "TARGET_REQUIRED", message: "target must be an object." });
    return;
  }
  if (strict) checkUnknownKeys(value, TARGET_KEYS, path, errors);
  for (const key of ["schema", "table", "primary_key"]) {
    if (!isSafeIdentifier(value[key])) {
      errors.push({ path: `${path}.${key}`, code: "INVALID_TARGET_IDENTIFIER", message: `${key} must be a fixed safe identifier.` });
    }
  }
  const hasTenantKey = isSafeIdentifier(value.tenant_key);
  const hasPrincipalScopeKey = isSafeIdentifier(value.principal_scope_key);
  const singleTenant = value.single_tenant_dev === true;
  if (!hasTenantKey && !singleTenant && !reviewedOrganization) {
    errors.push({
      path: `${path}.tenant_key`,
      code: "TENANT_GUARD_REQUIRED",
      message: "tenant_key is required unless target.single_tenant_dev is explicitly true for a local dev example or protected_read freezes one reviewed organization.",
    });
  }
  if (value.principal_scope_key !== undefined && !hasPrincipalScopeKey) {
    errors.push({ path: `${path}.principal_scope_key`, code: "INVALID_PRINCIPAL_SCOPE_KEY", message: "principal_scope_key must be a fixed safe identifier." });
  }
  if (hasPrincipalScopeKey && !hasTenantKey && !reviewedOrganization) {
    errors.push({ path: `${path}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key requires a tenant_key or protected single-organization authority." });
  }
  if (singleTenant) {
    warnings.push({
      path: `${path}.single_tenant_dev`,
      code: "SINGLE_TENANT_DEV_EXCEPTION",
      message: "single_tenant_dev bypasses tenant-key enforcement and must not be used for shared tenant data.",
    });
  }
}

function validateArgs(value: unknown, path: string, strict: boolean, errors: ConfigIssue[], allowEmpty = false): void {
  if (!isRecord(value) || (!allowEmpty && Object.keys(value).length === 0)) {
    errors.push({ path, code: "ARGS_REQUIRED", message: allowEmpty ? "args must be an object." : "args must define at least one model-facing business argument." });
    return;
  }
  for (const [name, arg] of Object.entries(value)) {
    const argPath = `${path}.${name}`;
    if (MODEL_CONTROLLED_TRUST_FIELDS.has(name) || MODEL_CONTROLLED_IDENTIFIER_FIELDS.has(name)) {
      errors.push({
        path: argPath,
        code: "MODEL_CONTROLLED_RESERVED_ARG",
        message: "Model-facing args cannot include trust scope or dynamic identifier fields.",
      });
    }
    if (!isRecord(arg)) {
      errors.push({ path: argPath, code: "ARG_NOT_OBJECT", message: "Argument definition must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(arg, ARG_KEYS, argPath, errors);
    if (!["string", "number", "boolean", "object_array"].includes(String(arg.type))) {
      errors.push({ path: `${argPath}.type`, code: "INVALID_ARG_TYPE", message: "Argument type must be string, number, boolean, or object_array." });
    }
    if (arg.description !== undefined && !isNonEmptyString(arg.description)) {
      errors.push({ path: `${argPath}.description`, code: "INVALID_ARG_DESCRIPTION", message: "Argument description must be a non-empty string when provided." });
    }
    if (arg.type === "object_array") {
      if (!Number.isSafeInteger(arg.max_items) || Number(arg.max_items) < 1 || Number(arg.max_items) > 100) errors.push({ path: `${argPath}.max_items`, code: "INVALID_OBJECT_ARRAY_MAX_ITEMS", message: "object_array max_items must be 1 through 100." });
      validateArgs(arg.fields, `${argPath}.fields`, strict, errors);
      if (isRecord(arg.fields)) for (const [fieldName, field] of Object.entries(arg.fields)) if (isRecord(field) && field.type === "object_array") errors.push({ path: `${argPath}.fields.${fieldName}`, code: "NESTED_OBJECT_ARRAY_FORBIDDEN", message: "object_array fields must be scalar." });
      continue;
    }
    if (arg.max_length !== undefined && !isPositiveInteger(arg.max_length)) {
      errors.push({ path: `${argPath}.max_length`, code: "INVALID_MAX_LENGTH", message: "max_length must be a positive integer." });
    }
    if ((arg.minimum !== undefined || arg.maximum !== undefined) && arg.type !== "number") {
      errors.push({ path: argPath, code: "NUMERIC_BOUNDS_REQUIRE_NUMBER", message: "minimum/maximum can only be used with number arguments." });
    }
    if (arg.minimum !== undefined && !isFiniteNumber(arg.minimum)) {
      errors.push({ path: `${argPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    }
    if (arg.maximum !== undefined && !isFiniteNumber(arg.maximum)) {
      errors.push({ path: `${argPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    }
    if (isFiniteNumber(arg.minimum) && isFiniteNumber(arg.maximum) && Number(arg.minimum) > Number(arg.maximum)) {
      errors.push({ path: argPath, code: "INVALID_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    }
  }
}

function validateLookup(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "LOOKUP_REQUIRED", message: "lookup must bind the business object primary key from a validated arg." });
    return;
  }
  if (strict) checkUnknownKeys(value, LOOKUP_KEYS, path, errors);
  if (!isNonEmptyString(value.id_from_arg)) {
    errors.push({ path: `${path}.id_from_arg`, code: "LOOKUP_ARG_REQUIRED", message: "lookup.id_from_arg must name a model-facing business arg." });
  }
}

function validateVisibleColumns(value: unknown, path: string, errors: ConfigIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, code: "VISIBLE_COLUMNS_REQUIRED", message: "visible_columns must list at least one fixed column." });
    return;
  }
  for (const [index, column] of value.entries()) {
    if (!isSafeIdentifier(column)) {
      errors.push({ path: `${path}[${index}]`, code: "INVALID_VISIBLE_COLUMN", message: "visible columns must be fixed safe identifiers." });
    }
  }
}

function validateProposalCapability(
  capability: JsonRecord,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  const operation = validateCapabilityOperation(capability, path, strict, errors);
  if (!isRecord(capability.patch) || (operation !== "delete" && Object.keys(capability.patch).length === 0)) {
    errors.push({ path: `${path}.patch`, code: "PATCH_REQUIRED", message: "UPDATE and INSERT capabilities must declare a fixed patch mapping." });
  } else if (operation === "delete" && Object.keys(capability.patch).length > 0) {
    errors.push({ path: `${path}.patch`, code: "DELETE_PATCH_FORBIDDEN", message: "DELETE capabilities must not declare patch values." });
  } else {
    for (const [column, binding] of Object.entries(capability.patch)) {
      const bindingPath = `${path}.patch.${column}`;
      if (!isSafeIdentifier(column)) {
        errors.push({ path: bindingPath, code: "INVALID_PATCH_COLUMN", message: "Patch columns must be fixed safe identifiers." });
      }
      if (!isRecord(binding)) {
        errors.push({ path: bindingPath, code: "PATCH_BINDING_NOT_OBJECT", message: "Patch binding must be an object." });
        continue;
      }
      if (strict) checkUnknownKeys(binding, PATCH_BINDING_KEYS, bindingPath, errors);
      const hasFixed = binding.fixed !== undefined;
      const hasFromArg = binding.from_arg !== undefined;
      const hasFromItem = binding.from_item !== undefined;
      if ([hasFixed, hasFromArg, hasFromItem].filter(Boolean).length !== 1) {
        errors.push({ path: bindingPath, code: "INVALID_PATCH_BINDING", message: "Patch binding must use exactly one of fixed, from_arg, or from_item." });
      }
      if (hasFromArg && !isNonEmptyString(binding.from_arg)) {
        errors.push({ path: `${bindingPath}.from_arg`, code: "INVALID_PATCH_ARG", message: "from_arg must name a validated model-facing business arg." });
      }
      if (hasFromItem && !isNonEmptyString(binding.from_item)) errors.push({ path: `${bindingPath}.from_item`, code: "INVALID_PATCH_ITEM_FIELD", message: "from_item must name a reviewed batch item field." });
    }
  }
  validateNumericBounds(capability, path, strict, errors);
  validateTransitionGuards(capability, path, strict, errors);
  if (!Array.isArray(capability.allowed_columns) || (operation !== "delete" && capability.allowed_columns.length === 0)) {
    errors.push({ path: `${path}.allowed_columns`, code: "ALLOWED_COLUMNS_REQUIRED", message: "Proposal capabilities must list allowed_columns." });
  } else {
    for (const [index, column] of capability.allowed_columns.entries()) {
      if (!isSafeIdentifier(column)) {
        errors.push({ path: `${path}.allowed_columns[${index}]`, code: "INVALID_ALLOWED_COLUMN", message: "allowed_columns must be fixed safe identifiers." });
      }
    }
  }
  if (operation !== "insert" && !isRecord(capability.conflict_guard)) {
    errors.push({
      path: `${path}.conflict_guard`,
      code: "CONFLICT_GUARD_REQUIRED",
      message: "Proposal capabilities must declare a row-version conflict guard unless a visible weak-guard exception is approved.",
    });
  } else {
    if (isRecord(capability.conflict_guard) && strict) checkUnknownKeys(capability.conflict_guard, CONFLICT_GUARD_KEYS, `${path}.conflict_guard`, errors);
    if (isRecord(capability.conflict_guard) && !isSafeIdentifier(capability.conflict_guard.column) && (operation === "delete" || capability.conflict_guard.weak_guard_ack !== true)) {
      errors.push({
        path: `${path}.conflict_guard.column`,
        code: "CONFLICT_GUARD_COLUMN_REQUIRED",
        message: "conflict_guard.column must be a fixed safe identifier, or weak_guard_ack must be explicitly true.",
      });
    }
  }
  if (capability.approval !== undefined) {
    if (!isRecord(capability.approval)) {
      errors.push({ path: `${path}.approval`, code: "APPROVAL_NOT_OBJECT", message: "approval must be an object." });
    } else {
      if (strict) checkUnknownKeys(capability.approval, APPROVAL_KEYS, `${path}.approval`, errors);
      if (capability.approval.mode !== undefined && capability.approval.mode !== "human" && capability.approval.mode !== "operator" && capability.approval.mode !== "policy") {
        errors.push({ path: `${path}.approval.mode`, code: "INVALID_APPROVAL_MODE", message: "approval.mode must be human, operator, or policy." });
      }
      if (capability.approval.required_approvals !== undefined
        && (!Number.isSafeInteger(capability.approval.required_approvals)
          || Number(capability.approval.required_approvals) < 1
          || Number(capability.approval.required_approvals) > 10)) {
        errors.push({
          path: `${path}.approval.required_approvals`,
          code: "INVALID_REQUIRED_APPROVALS",
          message: "approval.required_approvals must be a safe integer from 1 through 10.",
        });
      }
    }
  }
  if (capability.execution !== undefined) {
    if (!isRecord(capability.execution)) {
      errors.push({ path: `${path}.execution`, code: "EXECUTION_NOT_OBJECT", message: "execution must be an explicit reviewed permission object." });
    } else {
      if (strict) checkUnknownKeys(capability.execution, EXECUTION_KEYS, `${path}.execution`, errors);
      if (capability.execution.supervised_worker !== "allowed") {
        errors.push({ path: `${path}.execution.supervised_worker`, code: "INVALID_SUPERVISED_WORKER_PERMISSION", message: "execution.supervised_worker must be allowed when present." });
      }
    }
  }
  if (operation === "delete" && capabilityWritebackMode(capability) === "direct_sql") {
    const approval = isRecord(capability.approval) ? capability.approval : undefined;
    if (!approval || (approval.mode !== "human" && approval.mode !== "operator")) {
      errors.push({
        path: `${path}.approval.mode`,
        code: "HARD_DELETE_HUMAN_APPROVAL_REQUIRED",
        message: "Direct hard DELETE must require human/operator approval and cannot use policy auto-approval.",
      });
    }
  }
}

function validateCapabilityOperation(capability: JsonRecord, path: string, strict: boolean, errors: ConfigIssue[]): "update" | "insert" | "delete" {
  if (capability.operation === undefined) return "update";
  if (!isRecord(capability.operation)) {
    errors.push({ path: `${path}.operation`, code: "OPERATION_NOT_OBJECT", message: "operation must be an object." });
    return "update";
  }
  const operation = capability.operation;
  if (strict) checkUnknownKeys(operation, OPERATION_KEYS, `${path}.operation`, errors);
  const kind = operation.kind;
  if (kind !== "update" && kind !== "insert" && kind !== "delete") {
    errors.push({ path: `${path}.operation.kind`, code: "INVALID_OPERATION_KIND", message: "operation.kind must be update, insert, or delete." });
    return "update";
  }
  const cardinality = operation.cardinality ?? "single";
  if (cardinality !== "single" && cardinality !== "set") errors.push({ path: `${path}.operation.cardinality`, code: "INVALID_OPERATION_CARDINALITY", message: "operation.cardinality must be single or set." });
  if (cardinality === "set") validateSetOperationConfig(capability, operation, kind, path, strict, errors);
  else for (const key of ["selection", "max_rows", "aggregate_bounds", "batch"]) if (operation[key] !== undefined) errors.push({ path: `${path}.operation.${key}`, code: "SET_FIELD_REQUIRES_SET_CARDINALITY", message: `${key} requires set cardinality.` });
  if (operation.version_advance !== undefined) {
    if (!isRecord(operation.version_advance)) errors.push({ path: `${path}.operation.version_advance`, code: "VERSION_ADVANCE_NOT_OBJECT", message: "version_advance must be an object." });
    else {
      if (strict) checkUnknownKeys(operation.version_advance, VERSION_ADVANCE_KEYS, `${path}.operation.version_advance`, errors);
      if (!isSafeIdentifier(operation.version_advance.column)) errors.push({ path: `${path}.operation.version_advance.column`, code: "INVALID_VERSION_ADVANCE_COLUMN", message: "version advance column must be a fixed safe identifier." });
      if (operation.version_advance.strategy !== "integer_increment" && operation.version_advance.strategy !== "database_generated") errors.push({ path: `${path}.operation.version_advance.strategy`, code: "INVALID_VERSION_ADVANCE_STRATEGY", message: "version advance strategy must be integer_increment or database_generated." });
      if (isRecord(capability.conflict_guard) && operation.version_advance.column !== capability.conflict_guard.column) errors.push({ path: `${path}.operation.version_advance.column`, code: "VERSION_ADVANCE_GUARD_MISMATCH", message: "version advance column must match conflict_guard.column." });
    }
    if (kind !== "update") errors.push({ path: `${path}.operation.version_advance`, code: "VERSION_ADVANCE_UPDATE_ONLY", message: "version advancement is valid only for UPDATE." });
  }
  if (kind === "insert") validateCapabilityDeduplication(capability, operation.deduplication, path, strict, errors, cardinality === "set");
  else if (operation.deduplication !== undefined) errors.push({ path: `${path}.operation.deduplication`, code: "DEDUPLICATION_INSERT_ONLY", message: "deduplication is valid only for INSERT." });
  if (kind === "delete" && (!isRecord(capability.conflict_guard) || !isSafeIdentifier(capability.conflict_guard.column))) errors.push({ path: `${path}.conflict_guard.column`, code: "DELETE_CONFLICT_GUARD_REQUIRED", message: "DELETE requires an exact conflict guard column." });
  return kind;
}

function validateSetOperationConfig(capability: JsonRecord, operation: JsonRecord, kind: "update" | "insert" | "delete", path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!Number.isSafeInteger(operation.max_rows) || Number(operation.max_rows) < 1 || Number(operation.max_rows) > 100) errors.push({ path: `${path}.operation.max_rows`, code: "SET_MAX_ROWS_REQUIRED", message: "bounded set writes require max_rows from 1 through 100." });
  if (!Array.isArray(operation.aggregate_bounds) || operation.aggregate_bounds.length < 1 || operation.aggregate_bounds.length > 8) errors.push({ path: `${path}.operation.aggregate_bounds`, code: "SET_AGGREGATE_BOUND_REQUIRED", message: "bounded set writes require 1 through 8 aggregate bounds." });
  else operation.aggregate_bounds.forEach((bound, index) => {
    const boundPath = `${path}.operation.aggregate_bounds[${index}]`;
    if (!isRecord(bound)) return errors.push({ path: boundPath, code: "AGGREGATE_BOUND_NOT_OBJECT", message: "aggregate bound must be an object." });
    if (strict) checkUnknownKeys(bound, AGGREGATE_BOUND_KEYS, boundPath, errors);
    if (!isSafeIdentifier(bound.column) || !["before", "after", "absolute_delta"].includes(String(bound.measure)) || !isFiniteNumber(bound.maximum) || Number(bound.maximum) < 0) errors.push({ path: boundPath, code: "INVALID_AGGREGATE_BOUND", message: "aggregate bound needs a fixed column, before/after/absolute_delta measure, and non-negative maximum." });
  });
  const approval = isRecord(capability.approval) ? capability.approval : undefined;
  if (!approval || (approval.mode !== "human" && approval.mode !== "operator")) errors.push({ path: `${path}.approval.mode`, code: "SET_WRITE_HUMAN_APPROVAL_REQUIRED", message: "bounded set writes require human/operator approval." });
  const writeback = isRecord(capability.writeback) ? capability.writeback : undefined;
  if (!writeback || writeback.mode !== "direct_sql") errors.push({ path: `${path}.writeback.mode`, code: "SET_WRITE_DIRECT_SQL_REQUIRED", message: "bounded set writes require Runner-owned direct_sql writeback." });
  if (kind === "update" && (!isRecord(operation.version_advance) || operation.version_advance.strategy !== "integer_increment")) errors.push({ path: `${path}.operation.version_advance`, code: "SET_INTEGER_VERSION_REQUIRED", message: "bounded set UPDATE requires integer_increment version advancement." });
  const visible = new Set(Array.isArray(capability.visible_columns) ? capability.visible_columns.filter((column): column is string => typeof column === "string") : []);
  const requiredReadColumns = [
    ...(Array.isArray(operation.aggregate_bounds) ? operation.aggregate_bounds.filter(isRecord).map((bound) => bound.column) : []),
    ...(isRecord(operation.selection) && Array.isArray(operation.selection.all) ? operation.selection.all.filter(isRecord).map((term) => term.column) : []),
    ...(isRecord(capability.conflict_guard) ? [capability.conflict_guard.column] : []),
  ].filter(isSafeIdentifier);
  for (const column of requiredReadColumns) if (!visible.has(column)) errors.push({ path: `${path}.visible_columns`, code: "SET_REVIEW_COLUMN_NOT_VISIBLE", message: `bounded set review requires visible column ${column}.` });
  if (kind === "insert") {
    if (!isRecord(operation.batch)) errors.push({ path: `${path}.operation.batch`, code: "BATCH_ITEMS_ARG_REQUIRED", message: "batch INSERT requires batch.items_from_arg." });
    else {
      if (strict) checkUnknownKeys(operation.batch, BATCH_KEYS, `${path}.operation.batch`, errors);
      const name = operation.batch.items_from_arg;
      const arg = isRecord(capability.args) && isSafeIdentifier(name) ? capability.args[name] : undefined;
      if (!isRecord(arg) || arg.type !== "object_array") errors.push({ path: `${path}.operation.batch.items_from_arg`, code: "BATCH_ITEMS_ARG_NOT_OBJECT_ARRAY", message: "batch.items_from_arg must reference an object_array argument." });
      else if (Number(arg.max_items) > Number(operation.max_rows)) errors.push({ path: `${path}.args.${String(name)}.max_items`, code: "BATCH_ITEMS_EXCEED_MAX_ROWS", message: "batch argument max_items must not exceed operation.max_rows." });
    }
    const target = isRecord(capability.target) ? capability.target : {};
    const dedup = isRecord(operation.deduplication) && Array.isArray(operation.deduplication.components) ? operation.deduplication.components : [];
    if (isSafeIdentifier(target.primary_key) && !dedup.some((component) => isRecord(component) && component.source === "item_field" && component.column === target.primary_key)) errors.push({ path: `${path}.operation.deduplication.components`, code: "BATCH_PRIMARY_KEY_REQUIRED", message: `batch INSERT must derive primary key ${String(target.primary_key)} from a typed item field.` });
    return;
  }
  if (!isRecord(operation.selection)) {
    errors.push({ path: `${path}.operation.selection`, code: "SET_FIXED_SELECTION_REQUIRED", message: "set UPDATE/DELETE requires fixed selection." });
    return;
  }
  if (strict) checkUnknownKeys(operation.selection, SELECTION_KEYS, `${path}.operation.selection`, errors);
  if (!Array.isArray(operation.selection.all) || operation.selection.all.length < 1 || operation.selection.all.length > 8) {
    errors.push({ path: `${path}.operation.selection.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed terms." });
    return;
  }
  operation.selection.all.forEach((term, index) => {
    const termPath = `${path}.operation.selection.all[${index}]`;
    if (!isRecord(term)) return errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." });
    if (strict) checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column) || term.operator !== "eq" || !("value" in term) || !isScalar(term.value)) errors.push({ path: termPath, code: "INVALID_FIXED_PREDICATE", message: "predicate must be a fixed identifier, eq operator, and literal scalar." });
  });
}

function validateCapabilityDeduplication(capability: JsonRecord, value: unknown, path: string, strict: boolean, errors: ConfigIssue[], batch = false): void {
  const dedupPath = `${path}.operation.deduplication`;
  if (!isRecord(value)) {
    errors.push({ path: dedupPath, code: "INSERT_DEDUPLICATION_REQUIRED", message: "INSERT requires source-enforced deduplication components." });
    return;
  }
  if (strict) checkUnknownKeys(value, DEDUPLICATION_KEYS, dedupPath, errors);
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 8) {
    errors.push({ path: `${dedupPath}.components`, code: "INVALID_DEDUPLICATION_COMPONENTS", message: "deduplication must contain 1 through 8 components." });
    return;
  }
  const patch = isRecord(capability.patch) ? capability.patch : {};
  const target = isRecord(capability.target) ? capability.target : {};
  const seen = new Set<string>();
  let proposalId = false;
  let itemField = false;
  value.components.forEach((component, index) => {
    const componentPath = `${dedupPath}.components[${index}]`;
    if (!isRecord(component)) {
      errors.push({ path: componentPath, code: "DEDUPLICATION_COMPONENT_NOT_OBJECT", message: "deduplication component must be an object." });
      return;
    }
    if (strict) checkUnknownKeys(component, DEDUPLICATION_COMPONENT_KEYS, componentPath, errors);
    if (!isSafeIdentifier(component.column)) errors.push({ path: `${componentPath}.column`, code: "INVALID_DEDUPLICATION_COLUMN", message: "deduplication column must be a fixed safe identifier." });
    else if (seen.has(component.column)) errors.push({ path: `${componentPath}.column`, code: "DUPLICATE_DEDUPLICATION_COLUMN", message: "deduplication columns must be unique." });
    else seen.add(component.column);
    if (Object.prototype.hasOwnProperty.call(patch, String(component.column))) errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_COLUMN_MODEL_CONTROLLED", message: "Runner-supplied deduplication columns must not be patch fields." });
    if (component.source === "proposal_id") proposalId = true;
    else if (component.source === "trusted_tenant") {
      if (component.column !== target.tenant_key) errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_TENANT_MISMATCH", message: "trusted_tenant must map to target.tenant_key." });
    } else if (component.source === "fixed") {
      if (component.fixed === undefined) errors.push({ path: `${componentPath}.fixed`, code: "DEDUPLICATION_FIXED_VALUE_REQUIRED", message: "fixed deduplication source requires fixed." });
    } else if (component.source === "item_field") {
      itemField = true;
      if (!isSafeIdentifier(component.item_field)) errors.push({ path: `${componentPath}.item_field`, code: "DEDUPLICATION_ITEM_FIELD_REQUIRED", message: "item_field deduplication requires a fixed batch item field." });
    } else errors.push({ path: `${componentPath}.source`, code: "INVALID_DEDUPLICATION_SOURCE", message: "deduplication source must be proposal_id, trusted_tenant, fixed, or item_field." });
  });
  if (batch ? !itemField : !proposalId) errors.push({ path: `${dedupPath}.components`, code: batch ? "ITEM_DEDUPLICATION_REQUIRED" : "PROPOSAL_DEDUPLICATION_REQUIRED", message: batch ? "batch INSERT deduplication must include item_field." : "INSERT deduplication must include proposal_id." });
}

function validateNumericBounds(
  capability: JsonRecord,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (capability.numeric_bounds === undefined) return;
  if (!isRecord(capability.numeric_bounds)) {
    errors.push({ path: `${path}.numeric_bounds`, code: "NUMERIC_BOUNDS_NOT_OBJECT", message: "numeric_bounds must map patch columns to reviewed numeric ranges." });
    return;
  }
  const patchColumns = isRecord(capability.patch) ? new Set(Object.keys(capability.patch)) : new Set<string>();
  for (const [column, bounds] of Object.entries(capability.numeric_bounds)) {
    const boundPath = `${path}.numeric_bounds.${column}`;
    if (!isSafeIdentifier(column)) {
      errors.push({ path: boundPath, code: "INVALID_NUMERIC_BOUND_COLUMN", message: "numeric_bounds keys must be fixed safe patch columns." });
    }
    if (!patchColumns.has(column)) {
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_PATCH_COLUMN_REQUIRED", message: "numeric_bounds can only constrain columns in the proposal patch." });
    }
    if (!isRecord(bounds)) {
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_NOT_OBJECT", message: "numeric bound must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(bounds, NUMERIC_BOUND_KEYS, boundPath, errors);
    const hasMinimum = bounds.minimum !== undefined;
    const hasMaximum = bounds.maximum !== undefined;
    if (!hasMinimum && !hasMaximum) {
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_EMPTY", message: "numeric bound must define minimum, maximum, or both." });
    }
    if (hasMinimum && !isFiniteNumber(bounds.minimum)) {
      errors.push({ path: `${boundPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    }
    if (hasMaximum && !isFiniteNumber(bounds.maximum)) {
      errors.push({ path: `${boundPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    }
    if (isFiniteNumber(bounds.minimum) && isFiniteNumber(bounds.maximum) && Number(bounds.minimum) > Number(bounds.maximum)) {
      errors.push({ path: boundPath, code: "INVALID_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    }
  }
}

function validateTransitionGuards(
  capability: JsonRecord,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
): void {
  if (capability.transition_guards === undefined) return;
  if (!isRecord(capability.transition_guards)) {
    errors.push({ path: `${path}.transition_guards`, code: "TRANSITION_GUARDS_NOT_OBJECT", message: "transition_guards must map patch columns to reviewed state transitions." });
    return;
  }
  const patchColumns = isRecord(capability.patch) ? new Set(Object.keys(capability.patch)) : new Set<string>();
  const visibleColumns = Array.isArray(capability.visible_columns) ? new Set(capability.visible_columns.filter((value): value is string => typeof value === "string")) : new Set<string>();
  const target = isRecord(capability.target) ? capability.target : {};
  for (const [column, guard] of Object.entries(capability.transition_guards)) {
    const guardPath = `${path}.transition_guards.${column}`;
    if (!isSafeIdentifier(column)) {
      errors.push({ path: guardPath, code: "INVALID_TRANSITION_GUARD_COLUMN", message: "transition_guards keys must be fixed safe patch columns." });
    }
    if (!patchColumns.has(column)) {
      errors.push({ path: guardPath, code: "TRANSITION_PATCH_COLUMN_REQUIRED", message: "transition_guards can only constrain columns in the proposal patch." });
    }
    if (!isRecord(guard)) {
      errors.push({ path: guardPath, code: "TRANSITION_GUARD_NOT_OBJECT", message: "transition guard must be an object." });
      continue;
    }
    if (strict) checkUnknownKeys(guard, TRANSITION_GUARD_KEYS, guardPath, errors);
    if (guard.from_column !== undefined) {
      if (!isSafeIdentifier(guard.from_column)) {
        errors.push({ path: `${guardPath}.from_column`, code: "INVALID_TRANSITION_FROM_COLUMN", message: "from_column must be a fixed safe identifier." });
      }
      const canReadFromColumn =
        visibleColumns.has(String(guard.from_column)) ||
        guard.from_column === target.primary_key ||
        guard.from_column === target.tenant_key ||
        guard.from_column === (isRecord(capability.conflict_guard) ? capability.conflict_guard.column : undefined);
      if (!canReadFromColumn) {
        errors.push({ path: `${guardPath}.from_column`, code: "TRANSITION_FROM_COLUMN_NOT_VISIBLE", message: "from_column must be visible or otherwise read by the capability." });
      }
    }
    if (!isRecord(guard.allowed) || Object.keys(guard.allowed).length === 0) {
      errors.push({ path: `${guardPath}.allowed`, code: "TRANSITION_ALLOWED_REQUIRED", message: "transition guard must define at least one allowed transition." });
      continue;
    }
    for (const [from, toValues] of Object.entries(guard.allowed)) {
      const allowedPath = `${guardPath}.allowed.${from}`;
      if (!isNonEmptyString(from)) {
        errors.push({ path: allowedPath, code: "TRANSITION_FROM_REQUIRED", message: "transition source state must be a non-empty string." });
      }
      if (!Array.isArray(toValues) || toValues.length === 0 || toValues.some((value) => !isNonEmptyString(value))) {
        errors.push({ path: allowedPath, code: "TRANSITION_TO_VALUES_REQUIRED", message: "transition target states must be non-empty strings." });
      }
    }
  }
}

function scanForForbiddenFields(value: unknown, path: string, errors: ConfigIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForForbiddenFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (INLINE_SECRET_URL_KEYS.has(key)) {
      errors.push({
        path: childPath,
        code: "INLINE_DATABASE_URL_FORBIDDEN",
        message: "Database URLs must be referenced by environment variable name, not stored inline.",
      });
    }
    if (SQL_TEXT_KEYS.has(key)) {
      errors.push({
        path: childPath,
        code: "ARBITRARY_SQL_FORBIDDEN",
        message: "Runner config cannot include raw SQL or model-provided SQL statement fields.",
      });
    }
    scanForForbiddenFields(child, childPath, errors);
  }
}

function checkUnknownKeys(value: JsonRecord, allowed: Set<string>, path: string, errors: ConfigIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}.${key}`, code: "UNKNOWN_FIELD", message: `Unknown field ${key}.` });
    }
  }
}

function isRunnerMode(value: unknown): value is RunnerMode {
  return value === "read_only" || value === "shadow" || value === "review" || value === "cloud";
}

function isSourceEngine(value: unknown): value is SourceEngine {
  return value === "postgres" || value === "mysql";
}

function isTrustedContextProvider(value: unknown): value is TrustedContextProvider {
  return value === "static_dev" || value === "environment" || value === "http_claims" || value === "cloud_session" || value === "reviewed_organization";
}

function isExecutorType(value: unknown): value is ExecutorType {
  return value === "sql_update" || value === "http_handler" || value === "command_handler";
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return value === "read" || value === "aggregate_read" || value === "proposal";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isSafeName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function isSafeNotificationHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || /[\s/@?#]/.test(value)) return false;
  return /^[A-Za-z0-9.-]+$/.test(value) || /^[0-9A-Fa-f:]+$/.test(value);
}

function isQualifiedName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
