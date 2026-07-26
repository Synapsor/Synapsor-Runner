import crypto from "node:crypto";
import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import {
  PrivacyBoundaryError,
  canonicalJsonDigest,
  enforcePrivacyBudgets,
  shapePrivacySuppressedGroups,
  protocolVersions,
} from "@synapsor-runner/protocol";
import type {
  ProtectedReadSpec,
} from "@synapsor/spec";
import type {
  RunnerMode,
  RuntimeCapabilityConfig,
  TrustedContext,
} from "./runtime-types.js";
import {
  queryFingerprintFor,
} from "./read-planning.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  isRecord,
  scalar,
  stableId,
} from "./safe-values.js";

export async function enforceProtectedReadBudget(
  store: ProposalRuntimeStore,
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
  args: Record<string, unknown>,
  privacySessionId: string,
): Promise<void> {
  const protectedRead = capability.protected_read;
  if (!protectedRead) return;
  if (!store.listQueryAudit) {
    throw new McpRuntimeError("PROTECTED_PRIVACY_LEDGER_REQUIRED", "Protected reads require a durable query-audit store so extraction and differencing budgets fail closed.");
  }
  const sessionFingerprint = protectedReadSessionFingerprint(capability, context, privacySessionId);
  const records = await store.listQueryAudit({ capability: capability.name, limit: 10_000 });
  const matching = records.filter((record) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    return payload.protected_read_version === "synapsor.protected-read.v1"
      && payload.session_fingerprint === sessionFingerprint
      && payload.boundary_digest === protectedRead.boundary_digest;
  });
  const now = Date.now();
  const lastMinute = matching.filter((record) => {
    const timestamp = typeof record.created_at === "string" ? Date.parse(record.created_at) : Number.NaN;
    return Number.isFinite(timestamp) && timestamp >= now - 60_000;
  }).length;
  const extractedCells = matching.reduce((sum, record) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    return sum + (typeof payload.returned_cells === "number" ? payload.returned_cells : 0);
  }, 0);
  const estimatedCells = protectedRead.mode === "rows"
    ? protectedRead.limits.max_rows * capability.visible_columns.length
    : protectedAggregateMaximumCells(protectedRead);
  let differencingAttempts = 0;
  if (protectedRead.mode === "aggregate") {
    const currentArgs = protectedReadArgumentFingerprint(args, privacySessionId);
    const priorArgumentShapes = new Set(matching.flatMap((record) => {
      const payload = isRecord(record.payload) ? record.payload : {};
      return typeof payload.argument_fingerprint === "string" ? [payload.argument_fingerprint] : [];
    }));
    differencingAttempts = priorArgumentShapes.has(currentArgs) ? 0 : priorArgumentShapes.size;
  }
  try {
    enforcePrivacyBudgets({
      limits: protectedRead.limits,
      snapshot: {
        query_count: matching.length,
        queries_last_minute: lastMinute,
        extracted_cells: extractedCells,
        differencing_attempts: differencingAttempts,
      },
      estimated_response_cells: estimatedCells,
      aggregate: protectedRead.mode === "aggregate",
    });
  } catch (error) {
    if (error instanceof PrivacyBoundaryError) {
      const code = {
        QUERY_BUDGET_EXHAUSTED: "PROTECTED_QUERY_BUDGET_EXHAUSTED",
        RATE_LIMIT_EXHAUSTED: "PROTECTED_QUERY_RATE_LIMITED",
        EXTRACTION_BUDGET_EXHAUSTED: "PROTECTED_EXTRACTION_BUDGET_EXHAUSTED",
        DIFFERENCING_BUDGET_EXHAUSTED: "PROTECTED_DIFFERENCING_BUDGET_EXHAUSTED",
        GROUP_LIMIT_EXCEEDED: "PROTECTED_RESPONSE_TOO_LARGE",
        INVALID_COHORT_SIZE: "PROTECTED_COHORT_INVALID",
      }[error.code];
      throw new McpRuntimeError(code, error.message);
    }
    throw error;
  }
}

export async function recordProtectedRead(input: {
  capability: RuntimeCapabilityConfig;
  sourceName: string;
  context: TrustedContext;
  current: { row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number };
  store: ProposalRuntimeStore;
  mode: RunnerMode;
  privacySessionId: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const protectedRead = input.capability.protected_read;
  if (!protectedRead) throw new McpRuntimeError("PROTECTED_READ_REQUIRED", "Protected read authority is missing.");
  const rows = input.current.rows ?? (input.current.rowCount ? [input.current.row] : []);
  let data: Record<string, unknown>;
  let returnedCount = 0;
  let returnedCells = 0;
  let suppressedGroups = 0;

  if (protectedRead.mode === "rows") {
    if (rows.length > protectedRead.limits.max_rows) {
      throw new McpRuntimeError("PROTECTED_RESPONSE_TOO_LARGE", "Protected row result exceeded its immutable row limit.");
    }
    const visibleRows = rows.map((row) =>
      Object.fromEntries(input.capability.visible_columns.map((column) => [column, scalar(row[column])])));
    returnedCount = visibleRows.length;
    returnedCells = visibleRows.length * input.capability.visible_columns.length;
    data = { rows: visibleRows };
  } else {
    const aggregate = protectedRead.aggregate;
    if (!aggregate) throw new McpRuntimeError("PROTECTED_AGGREGATE_REQUIRED", "Protected aggregate authority is missing.");
    const outputFields = [
      ...(aggregate.dimensions ?? []).map((dimension) => dimension.name),
      ...(aggregate.time_bucket ? [aggregate.time_bucket.name] : []),
      ...aggregate.measures.map((measure) => measure.name),
      ...(aggregate.comparison ? ["__period"] : []),
    ];
    const normalized = rows.map((row) => {
      const output: Record<string, unknown> = {};
      output.__cohort_size = row.__cohort_size;
      for (const dimension of aggregate.dimensions ?? []) output[dimension.name] = scalar(row[dimension.name]);
      if (aggregate.time_bucket) output[aggregate.time_bucket.name] = scalar(row[aggregate.time_bucket.name]);
      for (const measure of aggregate.measures) output[measure.name] = finiteAggregateNumber(row[measure.name], "PROTECTED_AGGREGATE_VALUE_INVALID");
      if (aggregate.comparison) output.__period = scalar(row.__period);
      return output;
    });
    let shaped;
    try {
      shaped = shapePrivacySuppressedGroups({
        rows: normalized,
        output_fields: outputFields,
        cohort_field: "__cohort_size",
        minimum_cohort_size: aggregate.minimum_group_size,
        maximum_groups: protectedRead.limits.max_groups,
        top_n: aggregate.top_n,
        ...(aggregate.comparison
          ? { period_field: "__period", periods: ["period_1", "period_2"] }
          : {}),
      });
    } catch (error) {
      if (error instanceof PrivacyBoundaryError) {
        throw new McpRuntimeError(
          error.code === "GROUP_LIMIT_EXCEEDED" ? "PROTECTED_RESPONSE_TOO_LARGE" : "PROTECTED_COHORT_INVALID",
          error.message,
        );
      }
      throw error;
    }
    const boundedGroups = shaped.groups.map((group) => {
      if (!aggregate.comparison) return group;
      const { __period, ...rest } = group;
      return { ...rest, period: __period };
    });
    returnedCount = boundedGroups.length;
    returnedCells = shaped.returned_cells;
    suppressedGroups = shaped.suppressed_groups;
    data = {
      groups: boundedGroups,
      suppression: {
        minimum_cohort_size: aggregate.minimum_group_size,
        suppressed_groups: suppressedGroups,
        totals_returned: false,
      },
    };
  }

  const responseBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (returnedCells > protectedRead.limits.max_response_cells || responseBytes > protectedRead.limits.max_response_bytes) {
    await recordProtectedReadAudit({
      ...input,
      returnedCount: 0,
      returnedCells: 0,
      suppressedGroups,
      status: "refused_response_budget",
    });
    throw new McpRuntimeError("PROTECTED_RESPONSE_TOO_LARGE", "Protected result exceeded its immutable cell or byte limit.");
  }
  await recordProtectedReadAudit({
    ...input,
    returnedCount,
    returnedCells,
    suppressedGroups,
    status: "returned",
  });
  const queryFingerprint = protectedReadQueryFingerprint(input.capability, input.context);
  return {
    status: "ok",
    action: input.capability.name,
    mode: input.mode,
    business_object: {
      type: protectedRead.mode === "aggregate" ? `${input.capability.target.table}_analysis` : `${input.capability.target.table}_protected_rows`,
      id: queryFingerprint,
    },
    data,
    trusted_context: {
      tenant_bound: Boolean(input.capability.target.tenant_key),
      principal_bound: Boolean(input.capability.target.principal_scope_key),
      provenance: input.context.provenance,
    },
    query_audit: {
      query_fingerprint: queryFingerprint,
      result_values_persisted: false,
      trusted_values_persisted: false,
      returned_rows_or_groups: returnedCount,
      returned_cells: returnedCells,
    },
    source_database_changed: false,
    source_database_mutated: false,
  };
}

export async function recordProtectedReadAudit(input: {
  capability: RuntimeCapabilityConfig;
  sourceName: string;
  context: TrustedContext;
  current: { row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number };
  store: ProposalRuntimeStore;
  mode: RunnerMode;
  privacySessionId: string;
  args: Record<string, unknown>;
  returnedCount: number;
  returnedCells: number;
  suppressedGroups: number;
  status: string;
}): Promise<void> {
  const protectedRead = input.capability.protected_read!;
  await input.store.recordQueryAudit({
    capability: input.capability.name,
    source_id: input.sourceName,
    query_fingerprint: protectedReadQueryFingerprint(input.capability, input.context),
    table_name: `${input.capability.target.schema}.${input.capability.target.table}`,
    row_count: input.returnedCount,
    payload: {
      protected_read_version: "synapsor.protected-read.v1",
      capability: input.capability.name,
      boundary_digest: protectedRead.boundary_digest,
      generation_lock_fingerprint: protectedRead.generation_lock_fingerprint,
      protected_read_digest: canonicalJsonDigest(protectedRead),
      session_fingerprint: protectedReadSessionFingerprint(input.capability, input.context, input.privacySessionId),
      argument_fingerprint: protectedReadArgumentFingerprint(input.args, input.privacySessionId),
      mode: protectedRead.mode,
      status: input.status,
      returned_rows_or_groups: input.returnedCount,
      returned_cells: input.returnedCells,
      suppressed_groups: input.suppressedGroups,
      result_values_persisted: false,
      trusted_scope_values_persisted: false,
      raw_sql_included: false,
      source_database_changed: false,
    },
  });
}

export function protectedReadSessionFingerprint(
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
  privacySessionId: string,
): `sha256:${string}` {
  return canonicalJsonDigest({
    session: privacySessionId,
    capability: capability.name,
    contract: capability.contract_provenance?.digest,
    tenant: context.tenant_id,
    principal: context.principal,
  });
}

export function protectedReadArgumentFingerprint(args: Record<string, unknown>, privacySessionId: string): string {
  return `hmac-sha256:${crypto.createHmac("sha256", privacySessionId).update(canonicalJsonDigest(args)).digest("hex")}`;
}

export function protectedReadQueryFingerprint(capability: RuntimeCapabilityConfig, context: TrustedContext): `sha256:${string}` {
  const target = {
    schema: capability.target.schema,
    table: capability.target.table,
    primary_key: capability.target.primary_key,
    ...(capability.target.tenant_key ? { tenant_key: capability.target.tenant_key } : {}),
    ...(capability.target.principal_scope_key
      ? { principal_scope_key: capability.target.principal_scope_key }
      : {}),
    ...(capability.target.single_tenant_dev === undefined
      ? {}
      : { single_tenant_dev: capability.target.single_tenant_dev }),
  };
  return canonicalJsonDigest({
    source: capability.source,
    target,
    protected_read_digest: canonicalJsonDigest(capability.protected_read),
    tenant_fingerprint: canonicalJsonDigest({ tenant: context.tenant_id }),
    principal_fingerprint: canonicalJsonDigest({ principal: context.principal }),
  });
}

export function protectedAggregateMaximumCells(protectedRead: ProtectedReadSpec): number {
  const aggregate = protectedRead.aggregate;
  if (!aggregate) return 0;
  const columns = (aggregate.dimensions?.length ?? 0)
    + (aggregate.time_bucket ? 1 : 0)
    + aggregate.measures.length
    + (aggregate.comparison ? 1 : 0);
  const periods = aggregate.comparison ? aggregate.comparison.ranges.length : 1;
  return aggregate.top_n * periods * columns;
}

export async function recordAggregateRead(input: {
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
        binding_provenance: input.context.provenance,
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

export function finiteAggregateNumber(value: unknown, code: string): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new McpRuntimeError(code, "Aggregate adapter returned a non-finite scalar.");
  return number;
}
