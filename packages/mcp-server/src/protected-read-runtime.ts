import crypto from "node:crypto";
import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import {
  applyReviewedAggregateTransforms,
  PrivacyBoundaryError,
  canonicalJsonDigest,
  shapePrivacySuppressedGroups,
  protocolVersions,
} from "@synapsor-runner/protocol";
import type {
  ProtectedReadAggregateSpec,
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
  projectAuthorityMetadataForModel,
  type ModelAuthorityMetadataMode,
} from "./model-output-policy.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  isRecord,
  scalar,
  stableId,
} from "./safe-values.js";

export function projectProtectedReadResultForModel(
  capability: RuntimeCapabilityConfig,
  result: Record<string, unknown>,
  authorityMetadata: ModelAuthorityMetadataMode = "semantic",
): {
  value: Record<string, unknown>;
  withheld: boolean;
  operator_metadata_withheld?: boolean;
} {
  const fields = new Set(capability.model_withheld_fields ?? []);
  if (fields.size === 0) {
    return finalizeModelProjection(result, false, authorityMetadata);
  }
  const projected = structuredClone(result);
  const data = isRecord(projected.data) ? projected.data : undefined;
  const nestedRows = data && Array.isArray(data.rows)
    ? data.rows
    : data && Array.isArray(data.groups)
      ? data.groups
      : [];
  const rows = nestedRows.length > 0
    ? nestedRows
    : data && capability.kind === "read"
      ? [data]
      : [];
  const fieldsPresent = rows.some((item) =>
    isRecord(item) && [...fields].some((field) => Object.hasOwn(item, field)));
  if (!fieldsPresent) {
    return finalizeModelProjection(projected, false, authorityMetadata);
  }
  const nonce = crypto.randomBytes(6).toString("hex");
  const tokens = new Map<string, string>();
  let nextToken = 1;
  const tokenFor = (value: unknown): string => {
    const key = JSON.stringify(value) ?? "undefined";
    let token = tokens.get(key);
    if (!token) {
      token = `[withheld:${nonce}:${nextToken}]`;
      nextToken += 1;
      tokens.set(key, token);
    }
    return token;
  };
  const projectedRows = rows.map((item) => {
    if (!isRecord(item)) return item;
    const row = { ...item };
    for (const field of fields) {
      if (Object.hasOwn(row, field)) row[field] = tokenFor(row[field]);
    }
    return row;
  });
  if (data && Array.isArray(data.rows)) data.rows = projectedRows;
  else if (data && Array.isArray(data.groups)) data.groups = projectedRows;
  else if (data && capability.kind === "read" && isRecord(projectedRows[0])) {
    projected.data = projectedRows[0];
  }
  projected.model_egress = {
    values_withheld: true,
    tokenized_columns: [...fields].sort(),
    token_scope: "this_tool_response_only",
  };
  return finalizeModelProjection(projected, true, authorityMetadata);
}

function finalizeModelProjection(
  result: Record<string, unknown>,
  valuesWithheld: boolean,
  authorityMetadata: ModelAuthorityMetadataMode,
): {
  value: Record<string, unknown>;
  withheld: boolean;
  operator_metadata_withheld?: boolean;
} {
  const authority = projectAuthorityMetadataForModel(result, authorityMetadata);
  return {
    value: authority.value,
    withheld: valuesWithheld,
    ...(authority.withheld ? { operator_metadata_withheld: true } : {}),
  };
}

export type ProtectedReadBudgetReservation = {
  reservation_id: string;
  estimated_response_cells: number;
};

export async function enforceProtectedReadBudget(
  store: ProposalRuntimeStore,
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
  args: Record<string, unknown>,
  privacySessionId: string,
): Promise<ProtectedReadBudgetReservation> {
  const protectedRead = capability.protected_read;
  if (!protectedRead) {
    throw new McpRuntimeError("PROTECTED_READ_REQUIRED", "Protected read authority is missing.");
  }
  if (!store.claimExploreBudgetReservation || !store.completeExploreBudgetReservation) {
    throw new McpRuntimeError(
      "PROTECTED_PRIVACY_LEDGER_REQUIRED",
      "Protected reads require atomic durable privacy-budget accounting.",
    );
  }
  const estimatedCells = protectedRead.mode === "rows"
    ? protectedRead.limits.max_rows * capability.visible_columns.length
    : protectedAggregateMaximumCells(protectedRead);
  const reservationId = `protected_budget_${crypto.randomBytes(16).toString("hex")}`;
  const now = new Date().toISOString();
  let decision;
  try {
    decision = await store.claimExploreBudgetReservation({
      reservation_id: reservationId,
      scope_fingerprint: protectedReadQueryFingerprint(capability, context),
      legacy_session_fingerprints: [
        protectedReadSessionFingerprint(capability, context, privacySessionId),
      ],
      resource_id: capability.name,
      variant_fingerprint: canonicalJsonDigest({
        argument_fingerprint: protectedReadArgumentFingerprint(args, privacySessionId),
      }),
      requires_differencing: protectedRead.mode === "aggregate"
        && (protectedRead.aggregate?.minimum_group_size ?? 1) > 1,
      estimated_response_cells: estimatedCells,
      limits: protectedRead.limits,
      now,
    });
  } catch (error) {
    throw new McpRuntimeError(
      "PROTECTED_PRIVACY_LEDGER_REQUIRED",
      "Runner could not atomically reserve the protected-read privacy budget.",
    );
  }
  if (!decision.allowed) {
    const code = {
      QUERY_BUDGET_EXHAUSTED: "PROTECTED_QUERY_BUDGET_EXHAUSTED",
      RATE_LIMIT_EXHAUSTED: "PROTECTED_QUERY_RATE_LIMITED",
      EXTRACTION_BUDGET_EXHAUSTED: "PROTECTED_EXTRACTION_BUDGET_EXHAUSTED",
      DIFFERENCING_BUDGET_EXHAUSTED: "PROTECTED_DIFFERENCING_BUDGET_EXHAUSTED",
    }[decision.code];
    throw new McpRuntimeError(code, decision.message);
  }
  return {
    reservation_id: reservationId,
    estimated_response_cells: estimatedCells,
  };
}

export async function releaseProtectedReadBudget(
  store: ProposalRuntimeStore,
  reservation: ProtectedReadBudgetReservation,
): Promise<void> {
  try {
    await store.completeExploreBudgetReservation?.({
      reservation_id: reservation.reservation_id,
      result_released: false,
      returned_cells: 0,
      completed_at: new Date().toISOString(),
    });
  } catch {
    // A pending reservation remains a conservative durable charge.
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
  budgetReservation: ProtectedReadBudgetReservation;
  reportingTimezone?: "UTC";
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
    const periodMover = aggregate.order_by?.kind === "comparison_change";
    const ranked = aggregate.order_by?.kind === "measure"
      || periodMover
      || hasProtectedPostAggregateTransform(aggregate);
    const outputFields = [
      ...(aggregate.dimensions ?? []).map((dimension) => dimension.name),
      ...(aggregate.time_bucket && !periodMover ? [aggregate.time_bucket.name] : []),
      ...aggregate.measures.map((measure) => measure.name),
      ...(aggregate.comparison ? ["__period"] : []),
    ];
    const minimumGroupSize = effectiveProtectedMinimumGroupSize(aggregate);
    const normalized = rows.map((row) => {
      const output: Record<string, unknown> = {};
      const rowCohort = finiteAggregateNumber(row.__cohort_size, "PROTECTED_COHORT_INVALID");
      const contributorCounts = aggregate.measures.flatMap((measure, index) =>
        ["sum", "avg", "stddev_samp", "stddev_pop", "var_samp", "var_pop", "reviewed_derived"].includes(measure.function)
          ? [finiteAggregateNumber(row[`__measure_cohort_${index}`], "PROTECTED_COHORT_INVALID")]
          : []);
      const effectiveCohort = contributorCounts.length
        ? Math.min(rowCohort, ...contributorCounts)
        : rowCohort;
      output.__cohort_size = effectiveCohort;
      for (const dimension of aggregate.dimensions ?? []) output[dimension.name] = scalar(row[dimension.name]);
      if (aggregate.time_bucket && !periodMover) output[aggregate.time_bucket.name] = scalar(row[aggregate.time_bucket.name]);
      for (const measure of aggregate.measures) {
        output[measure.name] = effectiveCohort < minimumGroupSize
          ? null
          : measure.function === "reviewed_derived"
            ? nullableFiniteAggregateNumber(row[measure.name], "PROTECTED_AGGREGATE_VALUE_INVALID")
            : finiteAggregateNumber(row[measure.name], "PROTECTED_AGGREGATE_VALUE_INVALID");
      }
      if (aggregate.comparison) output.__period = scalar(row.__period);
      return output;
    });
    let shaped;
    try {
      const underlyingGroupLimit = ranked
        ? protectedRead.limits.max_ranked_groups ?? protectedRead.limits.max_groups
        : protectedRead.limits.max_groups;
      shaped = shapePrivacySuppressedGroups({
        rows: normalized,
        output_fields: outputFields,
        cohort_field: "__cohort_size",
        minimum_cohort_size: minimumGroupSize,
        maximum_groups: underlyingGroupLimit,
        top_n: periodMover || (ranked && !aggregate.comparison)
          ? underlyingGroupLimit
          : aggregate.top_n,
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
    const releasedGroups = applyProtectedPostAggregateTransforms(shaped.groups, aggregate);
    const candidateGroups = periodMover
      ? shapeProtectedPeriodComparison(releasedGroups, aggregate)
      : releasedGroups.map((group) => {
        if (!aggregate.comparison) return group;
        const { __period, ...rest } = group;
        return { ...rest, period: __period };
      });
    const boundedGroups = periodMover || (ranked && !aggregate.comparison)
      ? sortProtectedAggregateGroups(candidateGroups, aggregate).slice(0, aggregate.top_n)
      : candidateGroups;
    returnedCount = boundedGroups.length;
    returnedCells = boundedGroups.reduce(
      (total, group) => total + Object.keys(group).length,
      0,
    );
    suppressedGroups = shaped.suppressed_groups;
    data = {
      groups: boundedGroups,
      suppression: {
        minimum_cohort_size: minimumGroupSize,
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
  const budgetCompleted = await input.store.completeExploreBudgetReservation?.({
    reservation_id: input.budgetReservation.reservation_id,
    result_released: true,
    returned_cells: returnedCells,
    completed_at: new Date().toISOString(),
  });
  if (!budgetCompleted?.completed) {
    throw new McpRuntimeError(
      "PROTECTED_PRIVACY_LEDGER_REQUIRED",
      "Runner could not finalize the protected-read privacy budget, so no result was returned.",
    );
  }
  const evidence = await recordProtectedReadEvidence({
    ...input,
    data,
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
      ...(protectedRead.organization_scope ? { organization_bound: true } : {}),
      principal_bound: protectedReadPrincipalBound(input.capability),
      provenance: input.context.provenance,
    },
    query_audit: {
      query_fingerprint: queryFingerprint,
      result_values_persisted: false,
      trusted_values_persisted: false,
      returned_rows_or_groups: returnedCount,
      returned_cells: returnedCells,
    },
    evidence_bundle_id: evidence.evidence_bundle_id,
    evidence_resource: `synapsor://evidence/${evidence.evidence_bundle_id}`,
    ...(input.reportingTimezone
      ? { reporting_timezone: input.reportingTimezone }
      : {}),
    source_database_changed: false,
    source_database_mutated: false,
  };
}

function effectiveProtectedMinimumGroupSize(aggregate: ProtectedReadAggregateSpec): number {
  return aggregate.measures.some((measure) =>
    ["stddev_samp", "stddev_pop", "var_samp", "var_pop", "reviewed_derived"].includes(measure.function))
    ? Math.max(aggregate.minimum_group_size, 5)
    : aggregate.minimum_group_size;
}

function hasProtectedPostAggregateTransform(aggregate: ProtectedReadAggregateSpec): boolean {
  return aggregate.measures.some((measure) =>
    measure.function === "reviewed_derived"
    && measure.derived !== undefined
    && "base_measure" in measure.derived);
}

function applyProtectedPostAggregateTransforms(
  groups: Array<Record<string, unknown>>,
  aggregate: ProtectedReadAggregateSpec,
): Array<Record<string, unknown>> {
  const transforms = aggregate.measures.flatMap((measure) => {
    if (measure.function !== "reviewed_derived"
      || !measure.derived
      || !("base_measure" in measure.derived)) return [];
    const definition = measure.derived;
    const sequential = definition.shape === "running_total"
      || definition.shape === "lag_absolute_change"
      || definition.shape === "lag_percentage_change"
      || definition.shape === "moving_average";
    return [{
      operation: definition.shape,
      input_field: measure.name,
      output_field: measure.name,
      partition_fields: sequential
        ? (aggregate.dimensions ?? []).map((dimension) => dimension.name)
        : [],
      ...(sequential && aggregate.time_bucket ? { time_field: aggregate.time_bucket.name } : {}),
      ...(definition.shape === "rank" ? { direction: definition.direction } : {}),
      ...(definition.shape === "moving_average" ? { window_size: definition.window_size } : {}),
    }];
  });
  return transforms.length
    ? applyReviewedAggregateTransforms({ groups, transforms })
    : groups;
}

function shapeProtectedPeriodComparison(
  groups: Array<Record<string, unknown>>,
  aggregate: ProtectedReadAggregateSpec,
): Array<Record<string, unknown>> {
  const dimensions = aggregate.dimensions ?? [];
  type PeriodPair = {
    values: unknown[];
    period_1?: Array<number | null>;
    period_2?: Array<number | null>;
  };
  const pairs = new Map<string, PeriodPair>();
  for (const group of groups) {
    const values = dimensions.map((dimension) => scalar(group[dimension.name]));
    const key = JSON.stringify(values);
    const pair: PeriodPair = pairs.get(key) ?? { values };
    const measures = aggregate.measures.map((measure) =>
      measure.function === "reviewed_derived"
        ? nullableFiniteAggregateNumber(group[measure.name], "PROTECTED_AGGREGATE_VALUE_INVALID")
        : finiteAggregateNumber(group[measure.name], "PROTECTED_AGGREGATE_VALUE_INVALID"));
    if (group.__period === "period_1") pair.period_1 = measures;
    if (group.__period === "period_2") pair.period_2 = measures;
    pairs.set(key, pair);
  }
  const result: Array<Record<string, unknown>> = [];
  for (const pair of pairs.values()) {
    if (!pair.period_1 || !pair.period_2) continue;
    const output: Record<string, unknown> = {};
    dimensions.forEach((dimension, index) => {
      output[dimension.name] = pair.values[index] ?? null;
    });
    aggregate.measures.forEach((measure, index) => {
      const earlier = pair.period_1![index]!;
      const later = pair.period_2![index]!;
      output[`${measure.name}_period_1`] = earlier;
      output[`${measure.name}_period_2`] = later;
      const change = earlier === null || later === null ? null : later - earlier;
      output[`${measure.name}_absolute_change`] = change;
      output[`${measure.name}_percentage_change`] = change === null || earlier === null || earlier === 0
        ? null
        : (change / Math.abs(earlier)) * 100;
    });
    result.push(output);
  }
  return result;
}

function sortProtectedAggregateGroups(
  groups: Array<Record<string, unknown>>,
  aggregate: ProtectedReadAggregateSpec,
): Array<Record<string, unknown>> {
  const stableKey = (group: Record<string, unknown>): string => JSON.stringify(
    (aggregate.dimensions ?? []).map((dimension) => group[dimension.name] ?? null),
  );
  return [...groups].sort((left, right) => {
    const order = aggregate.order_by;
    if (order?.kind === "measure" || order?.kind === "comparison_change") {
      const key = order.kind === "comparison_change"
        ? `${order.measure}_${order.change}_change`
        : aggregate.comparison
          ? `${order.measure}_period_2`
          : order.measure;
      const leftValue = typeof left[key] === "number" ? left[key] : null;
      const rightValue = typeof right[key] === "number" ? right[key] : null;
      if (leftValue !== rightValue) {
        if (leftValue === null) return 1;
        if (rightValue === null) return -1;
        const compared = leftValue - rightValue;
        if (compared !== 0) return order.direction === "asc" ? compared : -compared;
      }
    }
    if (order?.kind === "time_bucket" && aggregate.time_bucket) {
      const compared = String(left[aggregate.time_bucket.name] ?? "")
        .localeCompare(String(right[aggregate.time_bucket.name] ?? ""));
      if (compared !== 0) return order.direction === "asc" ? compared : -compared;
    }
    return stableKey(left).localeCompare(stableKey(right));
  });
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
  budgetReservation: ProtectedReadBudgetReservation;
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
    payload: protectedReadAuditPayload(input),
  });
}

async function recordProtectedReadEvidence(input: {
  capability: RuntimeCapabilityConfig;
  sourceName: string;
  context: TrustedContext;
  store: ProposalRuntimeStore;
  privacySessionId: string;
  args: Record<string, unknown>;
  budgetReservation: ProtectedReadBudgetReservation;
  data: Record<string, unknown>;
  returnedCount: number;
  returnedCells: number;
  suppressedGroups: number;
  status: string;
}): Promise<{ evidence_bundle_id: string }> {
  const protectedRead = input.capability.protected_read!;
  const createdAt = new Date().toISOString();
  const evidenceBundleId = stableId("ev", {
    capability: input.capability.name,
    contract: input.capability.contract_provenance?.digest,
    boundary: protectedRead.boundary_digest,
    invocation: crypto.randomBytes(16).toString("hex"),
    created_at: createdAt,
  });
  const queryFingerprint = protectedReadQueryFingerprint(input.capability, input.context);
  const keyedTenant = crypto.createHmac("sha256", input.privacySessionId)
    .update(input.context.tenant_id)
    .digest("hex");
  const resultFingerprint = crypto.createHmac("sha256", input.privacySessionId)
    .update(canonicalJsonDigest(input.data))
    .digest("hex");
  await input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    tenant_id: `keyed:${keyedTenant}`,
    payload: {
      schema_version: "synapsor.analytics-evidence.v1",
      capability: input.capability.name,
      source_id: input.sourceName,
      source_table: `${input.capability.target.schema}.${input.capability.target.table}`,
      query_fingerprint: queryFingerprint,
      contract_digest: input.capability.contract_provenance?.digest ?? null,
      boundary_digest: protectedRead.boundary_digest,
      generation_lock_fingerprint: protectedRead.generation_lock_fingerprint,
      protected_read_digest: canonicalJsonDigest(protectedRead),
      trusted_scope: {
        tenant_bound: Boolean(input.capability.target.tenant_key),
        organization_bound: Boolean(protectedRead.organization_scope),
        ...(protectedRead.organization_scope
          ? { organization_scope: protectedRead.organization_scope }
          : {}),
        principal_bound: protectedReadPrincipalBound(input.capability),
        provenance: input.context.provenance,
        values_persisted: false,
      },
      argument_fingerprint: protectedReadArgumentFingerprint(input.args, input.privacySessionId),
      budget_reservation_id: input.budgetReservation.reservation_id,
      budget_window: "rolling_24_hours",
      mode: protectedRead.mode,
      status: input.status,
      returned_rows_or_groups: input.returnedCount,
      returned_cells: input.returnedCells,
      suppressed_groups: input.suppressedGroups,
      result_fingerprint: `hmac-sha256:${resultFingerprint}`,
      result_values_persisted: false,
      raw_sql_included: false,
      source_database_changed: false,
      recorded_at: createdAt,
    },
    items: [],
    query_audit: [{
      source_id: input.sourceName,
      query_fingerprint: queryFingerprint,
      table_name: `${input.capability.target.schema}.${input.capability.target.table}`,
      row_count: input.returnedCount,
      payload: protectedReadAuditPayload(input),
    }],
  });
  return { evidence_bundle_id: evidenceBundleId };
}

function protectedReadAuditPayload(input: {
  capability: RuntimeCapabilityConfig;
  context: TrustedContext;
  privacySessionId: string;
  args: Record<string, unknown>;
  budgetReservation: ProtectedReadBudgetReservation;
  returnedCount: number;
  returnedCells: number;
  suppressedGroups: number;
  status: string;
}): Record<string, unknown> {
  const protectedRead = input.capability.protected_read!;
  return {
    protected_read_version: "synapsor.protected-read.v1",
    capability: input.capability.name,
    boundary_digest: protectedRead.boundary_digest,
    generation_lock_fingerprint: protectedRead.generation_lock_fingerprint,
    protected_read_digest: canonicalJsonDigest(protectedRead),
    tenant_bound: Boolean(input.capability.target.tenant_key),
    organization_bound: Boolean(protectedRead.organization_scope),
    ...(protectedRead.organization_scope
      ? { organization_scope: protectedRead.organization_scope }
      : {}),
    principal_bound: protectedReadPrincipalBound(input.capability),
    session_fingerprint: protectedReadSessionFingerprint(input.capability, input.context, input.privacySessionId),
    argument_fingerprint: protectedReadArgumentFingerprint(input.args, input.privacySessionId),
    budget_reservation_id: input.budgetReservation.reservation_id,
    budget_window: "rolling_24_hours",
    mode: protectedRead.mode,
    status: input.status,
    returned_rows_or_groups: input.returnedCount,
    returned_cells: input.returnedCells,
    suppressed_groups: input.suppressedGroups,
    result_values_persisted: false,
    trusted_scope_values_persisted: false,
    raw_sql_included: false,
    source_database_changed: false,
  };
}

function protectedReadPrincipalBound(capability: RuntimeCapabilityConfig): boolean {
  const protectedRead = capability.protected_read;
  return Boolean(
    capability.target.principal_scope_key
    || protectedRead?.relationship?.principal_scope_key
    || protectedRead?.relationships?.some((relationship) =>
      relationship.links.some((link) => Boolean(link.principal_scope_key))),
  );
}

export function protectedReadSessionFingerprint(
  capability: RuntimeCapabilityConfig,
  context: TrustedContext,
  privacySessionId: string,
): `sha256:${string}` {
  return canonicalJsonDigest({
    session: privacySessionId,
    capability: capability.name,
    ...(capability.contract_provenance?.digest
      ? { contract: capability.contract_provenance.digest }
      : {}),
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
  const periodMover = aggregate.order_by?.kind === "comparison_change";
  const columns = periodMover
    ? (aggregate.dimensions?.length ?? 0) + aggregate.measures.length * 4
    : (aggregate.dimensions?.length ?? 0)
      + (aggregate.time_bucket ? 1 : 0)
      + aggregate.measures.length
      + (aggregate.comparison ? 1 : 0);
  return aggregate.top_n * columns * (aggregate.comparison && !periodMover
    ? aggregate.comparison.ranges.length
    : 1);
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

function nullableFiniteAggregateNumber(value: unknown, code: string): number | null {
  return value === null || value === undefined ? null : finiteAggregateNumber(value, code);
}
