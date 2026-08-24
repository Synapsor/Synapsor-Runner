import type {
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  protocolVersions,
  type ChangeSet,
  type ChangeSetV1,
  type ChangeSetV2,
  type ChangeSetV3,
  type FreshnessAuthorityV1,
} from "@synapsor-runner/protocol";
import type {
  Scalar,
  RuntimeSourceConfig,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
} from "./runtime-types.js";
import {
  capabilityWritebackExecutor,
  capabilityWritebackMode,
  isSetCapability,
} from "./capability-authority.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  conflictGuardScalar,
  hashJson,
  isRecord,
  scalar,
  scalarRecord,
  visibleScalarRecord,
} from "./safe-values.js";
import {
  readMysqlRow,
  readPostgresRow,
} from "./source-runtime.js";
import {
  effectivePrincipalScope,
} from "./trusted-context.js";

export function buildChangeSet(input: {
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
  freshness?: FreshnessAuthorityV1;
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
      ...(input.freshness ? { freshness: input.freshness } : {}),
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
    ...(input.freshness ? { freshness: input.freshness } : {}),
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

export function buildBoundedSetChangeSet(input: {
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
  freshness?: FreshnessAuthorityV1;
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
    ...(input.freshness ? { freshness: input.freshness } : {}),
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

export function resolveBatchDeduplication(
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

export function aggregateValue(
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

export function numericAggregateValue(value: Scalar | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new McpRuntimeError("SET_AGGREGATE_VALUE_INVALID", `Aggregate column ${column} must contain finite reviewed numbers.`);
  return value;
}

export function expectedVersionGuard(capability: RuntimeCapabilityConfig, row: Record<string, Scalar>): { column: string; value: Scalar } {
  const column = capability.conflict_guard?.column;
  if (column && row[column] !== undefined) return { column, value: conflictGuardScalar(row[column]) };
  if (capability.conflict_guard?.weak_guard_ack === true) {
    return { column: "__row_hash", value: hashJson(row) };
  }
  throw new McpRuntimeError("CONFLICT_GUARD_MISSING", "Proposal capability must read a configured conflict guard column.");
}

export async function readCurrentRow(input: {
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

export function buildPatch(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): Record<string, Scalar> {
  if (!capability.patch) throw new McpRuntimeError("PATCH_REQUIRED", "Proposal capability has no patch mapping.");
  const patch: Record<string, Scalar> = {};
  for (const [column, binding] of Object.entries(capability.patch)) {
    if (binding.from_arg) patch[column] = scalar(args[binding.from_arg]);
    else patch[column] = scalar(binding.fixed ?? null);
  }
  return patch;
}

export function batchItemsFromArgs(capability: RuntimeCapabilityConfig, args: Record<string, unknown>): Record<string, unknown>[] {
  const argumentName = capability.operation?.batch?.items_from_arg;
  const value = argumentName ? args[argumentName] : undefined;
  if (!argumentName || !Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new McpRuntimeError("BATCH_ITEMS_REQUIRED", `Bounded INSERT capability ${capability.name} requires its reviewed object-array argument.`);
  }
  return value as Record<string, unknown>[];
}

export function buildItemPatch(
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

export function boundedSetEvidenceItems(
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

export function resolveDeduplication(
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

export function enforcePatchGuards(
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

export function diffFromChangeSet(changeSet: ChangeSet): Record<string, { before: Scalar; proposed: Scalar }> {
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

export function proposalAlreadyExists(existing: StoredProposal): McpRuntimeError {
  return new McpRuntimeError(
    "PROPOSAL_ALREADY_EXISTS",
    `Active proposal ${existing.proposal_id} is already ${existing.state} for this object. Inspect or resolve it before proposing again.`,
    { proposal_id: existing.proposal_id },
  );
}
