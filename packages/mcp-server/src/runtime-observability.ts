import crypto from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  createPostgresPool,
  quotePostgresIdentifier,
} from "@synapsor-runner/postgres";
import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import mysql from "mysql2/promise";
import type {
  SourceEngine,
  RuntimeConfig,
  RuntimeRateLimitMetric,
  RuntimePoolMetric,
  ReadinessComponent,
  ReadinessReport,
  MetricsEndpointAccess,
} from "./runtime-types.js";
import {
  capabilityWritebackExecutor,
  capabilityWritebackMode,
} from "./capability-authority.js";
import {
  isLoopbackHost,
  validBearerToken,
  writeJson,
} from "./http-security.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  envValue,
  isRecord,
} from "./safe-values.js";

export function resolveMetricsEndpointAccess(config: RuntimeConfig, env: NodeJS.ProcessEnv, host: string): MetricsEndpointAccess {
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

export async function handleMetricsRequest(
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

export async function renderRuntimeMetrics(
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

export function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
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

export async function readinessComponent(
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

export async function withReadinessTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

export async function probeDatabase(engine: SourceEngine, databaseUrl: string, timeoutMs: number): Promise<void> {
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
