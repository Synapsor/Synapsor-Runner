import crypto from "node:crypto";
import { ControlPlaneClient, type ClaimedWritebackJob } from "@synapsor-runner/control-plane-client";
import { canonicalJsonDigest, parseWritebackJob, protocolVersions, type InverseDescriptorV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";

export * from "./mcp-audit.js";

export type RunnerConfig = {
  controlPlaneUrl: string;
  runnerToken: string;
  runnerId: string;
  sourceId: string;
  databaseUrl: string;
  engine: "postgres" | "mysql";
  pollIntervalMs: number;
  /** Operator-controlled upper bound for source write statements and lock waits. */
  statementTimeoutMs?: number;
  logLevel: "debug" | "info" | "warn" | "error";
  dryRun: boolean;
  stateDir: string;
  receipts?: {
    authority: "source_db" | "runner_ledger";
    provisioning?: "precreated" | "auto_migrate";
    schema?: string;
    table?: string;
  };
  /**
   * Verified execution context for PostgreSQL row-level security.
   *
   * Callers derive these values from the approved proposal or another
   * trusted authority. Database adapters never accept them from model input.
   */
  databaseScope?: {
    mode: "postgres_rls";
    tenantSetting: string;
    principalSetting: string;
    tenantId: string;
    principal: string;
  };
  writebackIntentStore?: WritebackIntentStore;
  /** Test-only crash injection. Production config loaders must never expose this. */
  testFailpoint?: (name: WritebackFailpoint) => void | Promise<void>;
};

export type WritebackIntentStatus =
  | "intent_recorded"
  | "applying"
  | "applied"
  | "already_applied"
  | "conflict"
  | "failed"
  | "reconciliation_required";

export type WritebackIntentClaim =
  | { decision: "proceed"; intent_id: string }
  | { decision: "existing_result"; intent_id: string; result: WritebackResult }
  | { decision: "reconciliation_required"; intent_id: string; reason: string };

export type WritebackIntentStore = {
  claimWritebackIntent(job: WritebackJob, runnerId: string): Promise<WritebackIntentClaim> | WritebackIntentClaim;
  markWritebackIntentApplying(intentId: string, runnerId: string): Promise<void> | void;
  completeWritebackIntent(intentId: string, result: WritebackResult): Promise<void> | void;
  requireWritebackReconciliation(intentId: string, reason: string): Promise<void> | void;
};

export type ReconciliationClassification =
  | "matches_reviewed_before"
  | "matches_proposed"
  | "not_observed"
  | "target_absent"
  | "drifted";

export type ReconciliationObservation = {
  operation: "single_row_update" | "single_row_insert" | "single_row_delete" | "set_update" | "set_delete" | "batch_insert" | "restore_update" | "remove_insert" | "restore_insert";
  classification: ReconciliationClassification;
  target_identity: Array<{ column: string; value: string | number | boolean | null }>;
  expected: Record<string, string | number | boolean | null>;
  observed: Record<string, string | number | boolean | null>;
  observed_digest: `sha256:${string}`;
  member_observations?: Array<{
    primary_key: { column: string; value: string | number | boolean | null };
    classification: ReconciliationClassification;
    observed: Record<string, string | number | boolean | null>;
    observed_digest: `sha256:${string}`;
  }>;
};

export type WritebackAuthorityVerifier = (job: WritebackJob) => Promise<void> | void;
export type WritebackResultReporter = (input: {
  job: WritebackJob;
  result: WritebackResult;
  leaseId: string;
}) => Promise<void> | void;

type SetWritebackJob = Extract<WritebackJob, { protocol_version: "3.0" }>;
export type CompensationWritebackJob = Extract<WritebackJob, { protocol_version: "4.0" }>;
type Scalar = string | number | boolean | null;

export function assertCompensationJobIntegrity(job: CompensationWritebackJob): void {
  const descriptor = job.compensation;
  if (descriptor.availability !== "available") throw new Error("COMPENSATION_UNAVAILABLE");
  if (descriptor.operation !== job.operation) throw new Error("COMPENSATION_OPERATION_MISMATCH");
  if (descriptor.target.source_id !== job.source_id
    || descriptor.target.schema !== job.target.schema
    || descriptor.target.table !== job.target.table
    || descriptor.target.primary_key_column !== job.target.primary_key.column) throw new Error("COMPENSATION_TARGET_MISMATCH");
  if (descriptor.tenant_guard.column !== job.target.tenant_guard.column
    || descriptor.tenant_guard.value !== job.target.tenant_guard.value) throw new Error("COMPENSATION_TENANT_MISMATCH");
  if (JSON.stringify(descriptor.principal_scope) !== JSON.stringify(job.target.principal_scope)) throw new Error("COMPENSATION_PRINCIPAL_SCOPE_MISMATCH");
  if (descriptor.members.length < 1 || descriptor.members.length > descriptor.max_rows || descriptor.max_rows > 100) throw new Error("COMPENSATION_ROW_CAP_EXCEEDED");
  const identities = descriptor.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) throw new Error("COMPENSATION_IDENTITY_NOT_UNIQUE");
  if (identities.some((identity, index) => index > 0 && identities[index - 1]!.localeCompare(identity) > 0)) throw new Error("COMPENSATION_IDENTITY_ORDER_INVALID");
  const allowed = new Set(job.allowed_columns);
  if (descriptor.allowed_columns.length !== allowed.size || descriptor.allowed_columns.some((column) => !allowed.has(column))) throw new Error("COMPENSATION_ALLOWLIST_MISMATCH");
  for (const member of descriptor.members) {
    if (member.primary_key.column !== job.target.primary_key.column) throw new Error("COMPENSATION_PRIMARY_KEY_MISMATCH");
    if (job.operation === "restore_update") {
      if (!descriptor.version_advance || descriptor.version_advance.strategy !== "integer_increment") throw new Error("COMPENSATION_VERSION_GUARD_REQUIRED");
      const expectedVersion = member.expected_state[descriptor.version_advance.column];
      if (typeof expectedVersion !== "number") throw new Error("COMPENSATION_VERSION_GUARD_REQUIRED");
      if (!member.restore_values || Object.keys(member.restore_values).length === 0) throw new Error("COMPENSATION_RESTORE_VALUES_REQUIRED");
      for (const column of Object.keys(member.restore_values)) if (!allowed.has(column)) throw new Error("COMPENSATION_COLUMN_NOT_ALLOWED");
    } else if (job.operation === "remove_insert") {
      if (Object.keys(member.expected_state).length === 0 || member.restore_values) throw new Error("COMPENSATION_EXPECTED_STATE_REQUIRED");
    } else if (Object.keys(member.expected_state).length !== 0 || !member.restore_values || Object.keys(member.restore_values).length === 0) {
      throw new Error("COMPENSATION_RESTORE_VALUES_REQUIRED");
    }
  }
}

/** Build the reviewed inverse of a successful compensation without reading new columns. */
export function compensationInverseFromJob(job: CompensationWritebackJob): InverseDescriptorV1 {
  assertCompensationJobIntegrity(job);
  const descriptor = job.compensation;
  const depthExhausted = descriptor.lineage.depth >= 16;
  const lineage = depthExhausted
    ? descriptor.lineage
    : {
      root_proposal_id: descriptor.lineage.root_proposal_id,
      parent_proposal_id: job.proposal_id,
      reverts_proposal_id: job.proposal_id,
      depth: descriptor.lineage.depth + 1,
    };
  const common = {
    schema_version: protocolVersions.inverseDescriptor,
    availability: depthExhausted ? "best_effort_unavailable" as const : "available" as const,
    reason_codes: depthExhausted ? ["REVERSAL_CHAIN_DEPTH_EXHAUSTED"] : [],
    cardinality: descriptor.cardinality,
    forward_proposal_id: job.proposal_id,
    forward_writeback_job_id: job.job_id,
    target: descriptor.target,
    tenant_guard: descriptor.tenant_guard,
    allowed_columns: descriptor.allowed_columns,
    max_rows: descriptor.max_rows,
    aggregate_bounds: descriptor.aggregate_bounds,
    lineage,
  };
  if (job.operation === "restore_update") {
    const version = descriptor.version_advance!;
    return {
      ...common,
      operation: "restore_update",
      members: descriptor.members.map((member) => {
        const expectedVersion = member.expected_state[version.column];
        const nextVersion = Number(expectedVersion) + 1;
        return {
          primary_key: member.primary_key,
          expected_state: { ...member.restore_values!, [version.column]: nextVersion },
          restore_values: Object.fromEntries(Object.entries(member.expected_state).filter(([column]) => descriptor.allowed_columns.includes(column))),
        };
      }),
      version_advance: version,
    };
  }
  if (job.operation === "remove_insert") {
    return {
      ...common,
      operation: "restore_insert",
      members: descriptor.members.map((member) => ({ primary_key: member.primary_key, expected_state: {}, restore_values: member.expected_state })),
    };
  }
  return {
    ...common,
    operation: "remove_insert",
    members: descriptor.members.map((member) => ({ primary_key: member.primary_key, expected_state: member.restore_values! })),
  };
}

export function classifyFrozenSetReconciliation(
  job: SetWritebackJob,
  rows: Record<string, unknown>[],
  valuesEqual: (actual: unknown, expected: unknown) => boolean = (actual, expected) => actual === expected,
): ReconciliationObservation {
  const primaryKey = job.target.primary_key.column;
  const observedByIdentity = new Map<string, Record<string, unknown>>();
  let duplicateIdentity = false;
  for (const row of rows) {
    const key = JSON.stringify(asScalar(row[primaryKey]));
    if (observedByIdentity.has(key)) duplicateIdentity = true;
    observedByIdentity.set(key, row);
  }
  const memberObservations = job.frozen_set.members.map((member) => {
    const row = observedByIdentity.get(JSON.stringify(member.primary_key.value));
    const observed = row
      ? Object.fromEntries(Object.keys({ ...member.before, ...member.after }).map((column) => [column, asScalar(row[column])]))
      : {};
    const beforeMatches = row !== undefined && recordValuesMatch(row, member.before, valuesEqual);
    const afterMatches = row !== undefined && recordValuesMatch(row, member.after, valuesEqual);
    const classification: ReconciliationClassification = !row
      ? job.operation === "set_delete" ? "target_absent" : "not_observed"
      : job.operation === "set_delete"
        ? beforeMatches ? "matches_reviewed_before" : "drifted"
        : afterMatches
          ? "matches_proposed"
          : beforeMatches ? "matches_reviewed_before" : "drifted";
    return {
      primary_key: member.primary_key,
      classification,
      observed,
      observed_digest: reconciliationDigest(observed),
    };
  });
  const expectedIdentities = new Set(job.frozen_set.members.map((member) => JSON.stringify(member.primary_key.value)));
  const unexpectedIdentity = [...observedByIdentity.keys()].some((identity) => !expectedIdentities.has(identity));
  const classifications = memberObservations.map((member) => member.classification);
  let classification: ReconciliationClassification;
  if (duplicateIdentity || unexpectedIdentity) classification = "drifted";
  else if (job.operation === "set_delete") {
    if (classifications.every((item) => item === "target_absent")) classification = "target_absent";
    else if (classifications.every((item) => item === "matches_reviewed_before")) classification = "matches_reviewed_before";
    else classification = "drifted";
  } else if (classifications.every((item) => item === "matches_proposed")) classification = "matches_proposed";
  else if (job.operation === "set_update" && classifications.every((item) => item === "matches_reviewed_before")) classification = "matches_reviewed_before";
  else if (job.operation === "batch_insert" && classifications.every((item) => item === "not_observed")) classification = "not_observed";
  else classification = "drifted";
  const observed = {
    row_count: rows.length,
    set_digest: reconciliationDigest(memberObservations.map((member) => ({ primary_key: member.primary_key, observed: member.observed }))),
  };
  return {
    operation: job.operation,
    classification,
    target_identity: job.frozen_set.members.map((member) => member.primary_key),
    expected: {
      row_count: job.frozen_set.row_count,
      max_rows: job.frozen_set.max_rows,
      set_digest: job.frozen_set.set_digest,
    },
    observed,
    observed_digest: reconciliationDigest(observed),
    member_observations: memberObservations,
  };
}

export function assertFrozenSetJobIntegrity(job: SetWritebackJob): void {
  const set = job.frozen_set;
  if (set.row_count !== set.members.length || set.row_count < 1 || set.row_count > set.max_rows || set.max_rows > 100) throw new Error("SET_ROW_CAP_EXCEEDED");
  const identities = set.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) throw new Error("SET_IDENTITY_NOT_UNIQUE");
  if (identities.some((identity, index) => index > 0 && identities[index - 1]!.localeCompare(identity) > 0)) throw new Error("SET_IDENTITY_ORDER_INVALID");
  for (const member of set.members) {
    if (member.primary_key.column !== job.target.primary_key.column) throw new Error("SET_PRIMARY_KEY_MISMATCH");
    if (job.operation === "set_update") {
      if (!job.version_advance || job.version_advance.strategy !== "integer_increment" || !member.expected_version || member.expected_version.column !== job.version_advance.column) throw new Error("SET_VERSION_GUARD_REQUIRED");
      if (typeof member.expected_version.value !== "number" || member.before[job.version_advance.column] !== member.expected_version.value) throw new Error("SET_VERSION_GUARD_MISMATCH");
      if (member.before[job.target.tenant_guard.column] !== job.target.tenant_guard.value) throw new Error("SET_TENANT_GUARD_MISMATCH");
      if (job.target.principal_scope && member.before[job.target.principal_scope.column] !== job.target.principal_scope.value) throw new Error("SET_PRINCIPAL_SCOPE_MISMATCH");
      const expectedAfter = { ...member.before, ...job.patch, [job.version_advance.column]: member.expected_version.value + 1 };
      if (!recordsEqual(member.after, expectedAfter)) throw new Error("SET_AFTER_STATE_MISMATCH");
      if (!reviewedDigestMatches(member.before_digest, { primary_key: member.primary_key.value, before: member.before })) throw new Error("SET_BEFORE_DIGEST_MISMATCH");
      if (!reviewedDigestMatches(member.after_digest, { primary_key: member.primary_key.value, after: member.after })) throw new Error("SET_AFTER_DIGEST_MISMATCH");
    } else if (job.operation === "set_delete") {
      if (!member.expected_version || member.before[member.expected_version.column] !== member.expected_version.value) throw new Error("SET_VERSION_GUARD_MISMATCH");
      if (member.before[job.target.tenant_guard.column] !== job.target.tenant_guard.value) throw new Error("SET_TENANT_GUARD_MISMATCH");
      if (job.target.principal_scope && member.before[job.target.principal_scope.column] !== job.target.principal_scope.value) throw new Error("SET_PRINCIPAL_SCOPE_MISMATCH");
      if (Object.keys(member.after).length !== 0) throw new Error("SET_DELETE_PATCH_FORBIDDEN");
      if (!reviewedDigestMatches(member.before_digest, { primary_key: member.primary_key.value, before: member.before })) throw new Error("SET_BEFORE_DIGEST_MISMATCH");
      if (!reviewedDigestMatches(member.tombstone_digest, { primary_key: member.primary_key.value, expected_version: member.expected_version })) throw new Error("SET_TOMBSTONE_DIGEST_MISMATCH");
    } else {
      const components = member.deduplication?.components ?? [];
      const primary = components.find((component) => component.column === job.target.primary_key.column);
      const tenant = components.find((component) => component.column === job.target.tenant_guard.column);
      if (!primary || primary.value !== member.primary_key.value || !tenant || tenant.source !== "trusted_tenant" || tenant.value !== job.target.tenant_guard.value) throw new Error("BATCH_DEDUP_REQUIRED");
      if (member.after[job.target.primary_key.column] !== member.primary_key.value || member.after[job.target.tenant_guard.column] !== job.target.tenant_guard.value) throw new Error("BATCH_IDENTITY_MISMATCH");
      if (job.target.principal_scope && member.after[job.target.principal_scope.column] !== job.target.principal_scope.value) throw new Error("BATCH_PRINCIPAL_SCOPE_MISMATCH");
      if (!reviewedDigestMatches(member.after_digest, { primary_key: member.primary_key.value, after: member.after })) throw new Error("SET_AFTER_DIGEST_MISMATCH");
    }
  }
  for (const bound of set.aggregate_bounds) {
    const actual = set.members.reduce((total, member) => {
      if (bound.measure === "before") return total + Math.abs(finiteNumber(member.before[bound.column], bound.column));
      if (bound.measure === "after") return total + Math.abs(finiteNumber(member.after[bound.column], bound.column));
      return total + Math.abs(finiteNumber(member.after[bound.column], bound.column) - finiteNumber(member.before[bound.column], bound.column));
    }, 0);
    if (actual !== bound.actual || actual > bound.maximum) throw new Error("SET_AGGREGATE_BOUND_MISMATCH");
  }
  const setMaterial = { operation: job.operation, members: set.members, aggregate_bounds: set.aggregate_bounds };
  // Runner 1.4.0 hashed normalized contract bounds before protocol parsing
  // restored schema field order. Reconstruct only that complete legacy shape.
  const legacyContractMaterial = {
    operation: job.operation,
    members: set.members,
    aggregate_bounds: set.aggregate_bounds.map((bound) => ({
      column: bound.column,
      maximum: bound.maximum,
      measure: bound.measure,
      actual: bound.actual,
    })),
  };
  if (!reviewedDigestMatches(set.set_digest, setMaterial, legacyContractMaterial)) throw new Error("SET_DIGEST_MISMATCH");
}

function reviewedDigestMatches(actual: string | undefined, current: unknown, legacyContract?: unknown): boolean {
  if (!actual) return false;
  const expected = new Set([canonicalJsonDigest(current), reconciliationDigest(current)]);
  if (legacyContract) expected.add(reconciliationDigest(legacyContract));
  return expected.has(actual as `sha256:${string}`);
}

function recordValuesMatch(
  actual: Record<string, unknown>,
  expected: Record<string, Scalar>,
  valuesEqual: (actual: unknown, expected: unknown) => boolean,
): boolean {
  return Object.entries(expected).every(([column, value]) => valuesEqual(actual[column], value));
}

function recordsEqual(left: Record<string, Scalar>, right: Record<string, Scalar>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function finiteNumber(value: Scalar | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`SET_AGGREGATE_VALUE_INVALID:${column}`);
  return value;
}

function asScalar(value: unknown): Scalar {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value as Scalar : String(value);
}

function reconciliationDigest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export type WritebackFailpoint =
  | "after_intent_recorded"
  | "after_intent_applying"
  | "after_source_begin"
  | "after_source_mutation"
  | "before_source_commit"
  | "after_source_commit"
  | "after_intent_completed";

export type ApplyAdapter = {
  doctor(config: RunnerConfig): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  apply(job: WritebackJob, config: RunnerConfig): Promise<WritebackResult>;
};

export type DoctorReport = {
  ok: boolean;
  control_plane: {
    ok: boolean;
    authenticated: boolean;
    status: number;
    details?: Record<string, unknown>;
  };
  database: {
    ok: boolean;
    details: Record<string, unknown>;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const engine = (env.SYNAPSOR_ENGINE || "postgres").toLowerCase();
  if (engine !== "postgres" && engine !== "mysql") {
    throw new Error("SYNAPSOR_ENGINE must be postgres or mysql");
  }
  return {
    controlPlaneUrl: requireEnv(env, "SYNAPSOR_CONTROL_PLANE_URL"),
    runnerToken: requireEnv(env, "SYNAPSOR_RUNNER_TOKEN"),
    runnerId: env.SYNAPSOR_RUNNER_ID || "synapsor-runner-local",
    sourceId: requireEnv(env, "SYNAPSOR_SOURCE_ID"),
    databaseUrl: env.SYNAPSOR_DATABASE_WRITE_URL || env.SYNAPSOR_DATABASE_URL || "",
    engine,
    pollIntervalMs: Number(env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    statementTimeoutMs: optionalPositiveInteger(env.SYNAPSOR_WRITEBACK_TIMEOUT_MS, "SYNAPSOR_WRITEBACK_TIMEOUT_MS"),
    logLevel: (env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun: String(env.SYNAPSOR_DRY_RUN || "false").toLowerCase() === "true",
    stateDir: env.SYNAPSOR_STATE_DIR || "./state"
  };
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function redact(value: unknown): string {
  return String(value ?? "")
    .replace(/(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
    .replace(/(mysql:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/syn_wbr_[A-Za-z0-9._~+/=-]+/g, "syn_wbr_<redacted>");
}

export function createLogger(config: Pick<RunnerConfig, "logLevel"> = { logLevel: "info" }) {
  const levels = ["debug", "info", "warn", "error"];
  const active = levels.indexOf(config.logLevel);
  return {
    debug: (message: string, meta?: unknown) => log("debug", message, meta),
    info: (message: string, meta?: unknown) => log("info", message, meta),
    warn: (message: string, meta?: unknown) => log("warn", message, meta),
    error: (message: string, meta?: unknown) => log("error", message, meta)
  };

  function log(level: string, message: string, meta?: unknown) {
    if (levels.indexOf(level) < active) return;
    const payload = {
      level,
      message,
      meta: typeof meta === "undefined" ? undefined : JSON.parse(redact(JSON.stringify(meta)))
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
}

export function validateJob(input: unknown): WritebackJob {
  return parseWritebackJob(input);
}

export async function doctorChecks(config: RunnerConfig, adapter: ApplyAdapter): Promise<DoctorReport> {
  const client = new ControlPlaneClient({ baseUrl: config.controlPlaneUrl, runnerToken: config.runnerToken, sourceId: config.sourceId, runnerId: config.runnerId });
  const [controlPlane, database] = await Promise.all([
    client.doctor(),
    adapter.doctor(config)
  ]);
  return {
    ok: controlPlane.ok && controlPlane.authenticated && database.ok,
    control_plane: {
      ok: controlPlane.ok,
      authenticated: controlPlane.authenticated,
      status: controlPlane.status,
      details: controlPlane.details
    },
    database
  };
}

export function failedWritebackResult(job: WritebackJob, runnerId: string, errorCode: string): WritebackResult {
  const common = {
    protocol_version: job.protocol_version,
    job_id: job.job_id,
    runner_id: runnerId,
    status: "failed" as const,
    affected_rows: 0,
    completed_at: new Date().toISOString(),
    error_code: errorCode,
  };
  let result: Record<string, unknown>;
  if (job.protocol_version === protocolVersions.legacyWritebackJob) {
    result = common;
  } else if (job.protocol_version === protocolVersions.normalizedWritebackJobV2) {
    const primaryKey = job.target.primary_key;
    result = {
      ...common,
      operation: job.operation,
      receipt_authority: "runner_ledger",
      target_identity: [{ column: primaryKey.column, value: primaryKey.value ?? job.patch[primaryKey.column] ?? null }],
    };
  } else if (job.protocol_version === protocolVersions.normalizedWritebackJobV3) {
    result = {
      ...common,
      operation: job.operation,
      receipt_authority: "runner_ledger",
      target_identities: job.frozen_set.members.map((member) => member.primary_key),
      set_digest: job.frozen_set.set_digest,
      member_effects: [],
    };
  } else {
    result = {
      ...common,
      operation: job.operation,
      receipt_authority: "runner_ledger",
      target_identities: job.compensation.members.map((member) => member.primary_key),
      member_effects: [],
    };
  }
  return { ...result, result_hash: canonicalJsonDigest(result) } as WritebackResult;
}

export async function runOnce(
  config: RunnerConfig,
  adapters: Record<RunnerConfig["engine"], ApplyAdapter>,
  verifyAuthority?: WritebackAuthorityVerifier,
  reportResult?: WritebackResultReporter,
): Promise<number> {
  const logger = createLogger(config);
  const client = new ControlPlaneClient({ baseUrl: config.controlPlaneUrl, runnerToken: config.runnerToken, sourceId: config.sourceId, runnerId: config.runnerId });
  const jobs = await client.claim({ sourceId: config.sourceId, runnerId: config.runnerId, limit: 1 });
  if (jobs.length === 0) {
    logger.info("no approved writeback jobs available", { source_id: config.sourceId });
    return 0;
  }
  let completed = 0;
  const report = async (job: ClaimedWritebackJob, result: WritebackResult) => {
    if (reportResult) await reportResult({ job, result, leaseId: job.cloud_lease.leaseId });
    else await client.result(result, job.cloud_lease.leaseId);
  };
  for (const job of jobs) {
    if (job.engine !== config.engine) {
      await report(job, failedWritebackResult(job, config.runnerId, "DATABASE_UNAVAILABLE"));
      continue;
    }
    if (verifyAuthority) {
      try {
        await verifyAuthority(job);
      } catch {
        logger.warn("Cloud-approved job rejected by local reviewed authority", { job_id: job.job_id, error_code: "LOCAL_AUTHORITY_REJECTED" });
        await report(job, failedWritebackResult(job, config.runnerId, "LOCAL_AUTHORITY_REJECTED"));
        continue;
      }
    }
    await client.heartbeat(job.job_id, job.cloud_lease.leaseId, config.runnerId);
    const result = await adapters[config.engine].apply(job, config);
    await report(job, result);
    completed += 1;
  }
  return completed;
}

export async function startPolling(
  config: RunnerConfig,
  adapters: Record<RunnerConfig["engine"], ApplyAdapter>,
  signal?: AbortSignal,
  verifyAuthority?: WritebackAuthorityVerifier,
  reportResult?: WritebackResultReporter,
): Promise<void> {
  const logger = createLogger(config);
  while (!signal?.aborted) {
    try {
      await runOnce(config, adapters, verifyAuthority, reportResult);
    } catch (error) {
      logger.error("runner loop failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
