import { ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { parseWritebackJob, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";

export * from "./mcp-audit.js";

export type RunnerConfig = {
  controlPlaneUrl: string;
  runnerToken: string;
  runnerId: string;
  sourceId: string;
  databaseUrl: string;
  engine: "postgres" | "mysql";
  pollIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  dryRun: boolean;
  stateDir: string;
  receipts?: {
    authority: "source_db" | "runner_ledger";
    provisioning?: "precreated" | "auto_migrate";
    schema?: string;
    table?: string;
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
  operation: "single_row_update" | "single_row_insert" | "single_row_delete";
  classification: ReconciliationClassification;
  target_identity: Array<{ column: string; value: string | number | boolean | null }>;
  expected: Record<string, string | number | boolean | null>;
  observed: Record<string, string | number | boolean | null>;
  observed_digest: `sha256:${string}`;
};

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
    databaseUrl: env.SYNAPSOR_DATABASE_URL || "",
    engine,
    pollIntervalMs: Number(env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    logLevel: (env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun: String(env.SYNAPSOR_DRY_RUN || "false").toLowerCase() === "true",
    stateDir: env.SYNAPSOR_STATE_DIR || "./state"
  };
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
  const client = new ControlPlaneClient({ baseUrl: config.controlPlaneUrl, runnerToken: config.runnerToken, sourceId: config.sourceId });
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

export async function runOnce(config: RunnerConfig, adapters: Record<RunnerConfig["engine"], ApplyAdapter>): Promise<number> {
  const logger = createLogger(config);
  const client = new ControlPlaneClient({ baseUrl: config.controlPlaneUrl, runnerToken: config.runnerToken, sourceId: config.sourceId });
  const jobs = await client.claim({ sourceId: config.sourceId, limit: 1 });
  if (jobs.length === 0) {
    logger.info("no approved writeback jobs available", { source_id: config.sourceId });
    return 0;
  }
  let completed = 0;
  for (const job of jobs) {
    if (job.engine !== config.engine) {
      await client.result({
        protocol_version: "1.0",
        job_id: job.job_id,
        runner_id: config.runnerId,
        status: "failed",
        error_code: "DATABASE_UNAVAILABLE"
      });
      continue;
    }
    await client.heartbeat(job.job_id);
    const result = await adapters[config.engine].apply(job, config);
    await client.result(result);
    completed += 1;
  }
  return completed;
}

export async function startPolling(config: RunnerConfig, adapters: Record<RunnerConfig["engine"], ApplyAdapter>, signal?: AbortSignal): Promise<void> {
  const logger = createLogger(config);
  while (!signal?.aborted) {
    try {
      await runOnce(config, adapters);
    } catch (error) {
      logger.error("runner loop failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
