export type RunnerMode = "read_only" | "shadow" | "review" | "cloud";
export type SourceEngine = "postgres" | "mysql";
export type TrustedContextProvider = "static_dev" | "environment" | "http_claims" | "cloud_session";
export type CapabilityKind = "read" | "proposal";

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

const TOP_LEVEL_KEYS = new Set(["version", "mode", "storage", "sources", "trusted_context", "capabilities", "cloud", "strict"]);
const STORAGE_KEYS = new Set(["sqlite_path"]);
const CLOUD_KEYS = new Set(["base_url_env", "runner_token_env", "runner_id", "runner_version", "project_id", "adapter_id", "source_id", "engines", "capabilities", "session"]);
const SOURCE_KEYS = new Set([
  "engine",
  "read_url_env",
  "write_url_env",
  "statement_timeout_ms",
  "ssl",
]);
const TRUSTED_CONTEXT_KEYS = new Set(["provider", "values"]);
const CAPABILITY_KEYS = new Set([
  "name",
  "kind",
  "source",
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
  "conflict_guard",
  "approval",
  "single_tenant_dev_ack",
]);
const TARGET_KEYS = new Set(["schema", "table", "primary_key", "tenant_key", "single_tenant_dev"]);
const LOOKUP_KEYS = new Set(["id_from_arg"]);
const ARG_KEYS = new Set(["type", "required", "max_length", "minimum", "maximum", "enum"]);
const PATCH_BINDING_KEYS = new Set(["fixed", "from_arg"]);
const NUMERIC_BOUND_KEYS = new Set(["minimum", "maximum"]);
const TRANSITION_GUARD_KEYS = new Set(["from_column", "allowed"]);
const CONFLICT_GUARD_KEYS = new Set(["column", "weak_guard_ack"]);
const APPROVAL_KEYS = new Set(["mode", "required_role"]);

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
  if (!isRunnerMode(input.mode)) {
    errors.push({ path: "$.mode", code: "INVALID_MODE", message: "mode must be read_only, shadow, review, or cloud." });
  }
  validateStorage(input.storage, strict, errors);
  validateCloud(input.cloud, input.mode, strict, errors);
  validateSources(input.sources, input.mode, strict, errors, warnings);
  validateTrustedContext(input.trusted_context, strict, errors, warnings);
  validateCapabilities(input.capabilities, input.sources, input.mode, strict, errors, warnings);
  scanForForbiddenFields(input, "$", errors);

  return { ok: errors.length === 0, errors, warnings };
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
    if (source.write_url_env === undefined) {
      warnings.push({
        path: `${path}.write_url_env`,
        code: "WRITEBACK_DISABLED",
        message: "No write_url_env is configured; review-mode proposal execution cannot apply external DB changes.",
      });
    }
  }
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

function validateTrustedContext(
  value: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.trusted_context", code: "TRUSTED_CONTEXT_REQUIRED", message: "trusted_context is required." });
    return;
  }
  if (strict) checkUnknownKeys(value, TRUSTED_CONTEXT_KEYS, "$.trusted_context", errors);
  if (!isTrustedContextProvider(value.provider)) {
    errors.push({
      path: "$.trusted_context.provider",
      code: "INVALID_CONTEXT_PROVIDER",
      message: "provider must be static_dev, environment, http_claims, or cloud_session.",
    });
  }
  if (value.provider === "static_dev") {
    warnings.push({
      path: "$.trusted_context.provider",
      code: "STATIC_DEV_CONTEXT",
      message: "static_dev is for local demos only. Do not use it for shared or production deployments.",
    });
  }
}

function validateCapabilities(
  value: unknown,
  sources: unknown,
  mode: unknown,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  if (mode === "cloud" && value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.capabilities", code: "CAPABILITIES_REQUIRED", message: "At least one capability is required." });
    return;
  }
  const sourceNames = isRecord(sources) ? new Set(Object.keys(sources)) : new Set<string>();
  value.forEach((capability, index) => validateCapability(capability, index, sourceNames, strict, errors, warnings));
}

function validateCapability(
  value: unknown,
  index: number,
  sourceNames: Set<string>,
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
    errors.push({ path: `${path}.kind`, code: "INVALID_CAPABILITY_KIND", message: "kind must be read or proposal." });
  }
  if (!isNonEmptyString(value.source) || !sourceNames.has(value.source)) {
    errors.push({ path: `${path}.source`, code: "UNKNOWN_SOURCE", message: "Capability source must reference a configured source." });
  }
  validateTarget(value.target, `${path}.target`, strict, errors, warnings);
  validateArgs(value.args, `${path}.args`, strict, errors);
  validateLookup(value.lookup, `${path}.lookup`, strict, errors);
  validateVisibleColumns(value.visible_columns, `${path}.visible_columns`, errors);
  if (value.max_rows !== undefined && !isPositiveInteger(value.max_rows)) {
    errors.push({ path: `${path}.max_rows`, code: "INVALID_MAX_ROWS", message: "max_rows must be a positive integer." });
  }
  if (value.kind === "proposal") {
    validateProposalCapability(value, path, strict, errors);
  }
}

function validateTarget(
  value: unknown,
  path: string,
  strict: boolean,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
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
  const singleTenant = value.single_tenant_dev === true;
  if (!hasTenantKey && !singleTenant) {
    errors.push({
      path: `${path}.tenant_key`,
      code: "TENANT_GUARD_REQUIRED",
      message: "tenant_key is required unless target.single_tenant_dev is explicitly true for a local dev example.",
    });
  }
  if (singleTenant) {
    warnings.push({
      path: `${path}.single_tenant_dev`,
      code: "SINGLE_TENANT_DEV_EXCEPTION",
      message: "single_tenant_dev bypasses tenant-key enforcement and must not be used for shared tenant data.",
    });
  }
}

function validateArgs(value: unknown, path: string, strict: boolean, errors: ConfigIssue[]): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    errors.push({ path, code: "ARGS_REQUIRED", message: "args must define at least one model-facing business argument." });
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
    if (!["string", "number", "boolean"].includes(String(arg.type))) {
      errors.push({ path: `${argPath}.type`, code: "INVALID_ARG_TYPE", message: "Argument type must be string, number, or boolean." });
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
  if (!isRecord(capability.patch) || Object.keys(capability.patch).length === 0) {
    errors.push({ path: `${path}.patch`, code: "PATCH_REQUIRED", message: "Proposal capabilities must declare a fixed patch mapping." });
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
      if (hasFixed === hasFromArg) {
        errors.push({ path: bindingPath, code: "INVALID_PATCH_BINDING", message: "Patch binding must use exactly one of fixed or from_arg." });
      }
      if (hasFromArg && !isNonEmptyString(binding.from_arg)) {
        errors.push({ path: `${bindingPath}.from_arg`, code: "INVALID_PATCH_ARG", message: "from_arg must name a validated model-facing business arg." });
      }
    }
  }
  validateNumericBounds(capability, path, strict, errors);
  validateTransitionGuards(capability, path, strict, errors);
  if (!Array.isArray(capability.allowed_columns) || capability.allowed_columns.length === 0) {
    errors.push({ path: `${path}.allowed_columns`, code: "ALLOWED_COLUMNS_REQUIRED", message: "Proposal capabilities must list allowed_columns." });
  } else {
    for (const [index, column] of capability.allowed_columns.entries()) {
      if (!isSafeIdentifier(column)) {
        errors.push({ path: `${path}.allowed_columns[${index}]`, code: "INVALID_ALLOWED_COLUMN", message: "allowed_columns must be fixed safe identifiers." });
      }
    }
  }
  if (!isRecord(capability.conflict_guard)) {
    errors.push({
      path: `${path}.conflict_guard`,
      code: "CONFLICT_GUARD_REQUIRED",
      message: "Proposal capabilities must declare a row-version conflict guard unless a visible weak-guard exception is approved.",
    });
  } else {
    if (strict) checkUnknownKeys(capability.conflict_guard, CONFLICT_GUARD_KEYS, `${path}.conflict_guard`, errors);
    if (!isSafeIdentifier(capability.conflict_guard.column) && capability.conflict_guard.weak_guard_ack !== true) {
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
    } else if (strict) {
      checkUnknownKeys(capability.approval, APPROVAL_KEYS, `${path}.approval`, errors);
    }
  }
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
  return value === "static_dev" || value === "environment" || value === "http_claims" || value === "cloud_session";
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return value === "read" || value === "proposal";
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

function isQualifiedName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
