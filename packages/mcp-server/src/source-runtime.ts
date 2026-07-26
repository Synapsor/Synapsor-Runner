import crypto from "node:crypto";
import {
  assertValidRunnerCapabilityConfig,
} from "@synapsor-runner/config";
import {
  assertPostgresRlsTarget,
  createPostgresPool,
  quotePostgresIdentifier,
} from "@synapsor-runner/postgres";
import {
  migrateSharedPostgresRuntimeStore,
} from "@synapsor-runner/proposal-store";
import mysql from "mysql2/promise";
import type {
  PoolClient,
} from "pg";
import type {
  SourceEngine,
  RuntimeDatabaseScopeConfig,
  RuntimeConfig,
  TrustedContext,
  DbRowReader,
  TenantCredentialResolver,
  McpRuntimeSharedResources,
  RuntimeRateLimitMetric,
  RuntimePoolMetric,
} from "./runtime-types.js";
import {
  localCapabilities,
} from "./capability-authority.js";
import {
  protectedReadTargets,
  protectedStatementTimeout,
  runtimeReadQuery,
} from "./read-planning.js";
import {
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  envValue,
  scalar,
} from "./safe-values.js";
import {
  configUsesHttpClaims,
  resolveRuntimeSourceCredential,
  resolveTrustedContext,
} from "./trusted-context.js";

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

export class RuntimeRateLimiter {
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

export class RuntimeDatabasePools {
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
          const query = runtimeReadQuery(input.capability, "$", input.args, input.context);
          await client.query(input.capability.protected_read || input.transaction_mode === "read_only" ? "BEGIN READ ONLY" : "BEGIN");
          const timeoutMs = protectedStatementTimeout(input.capability, input.source.statement_timeout_ms);
          if (timeoutMs) await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
          if (input.source.database_scope?.mode === "postgres_rls") {
            for (const target of protectedReadTargets(input.capability)) {
              const preflightKey = `${poolKey}\u0000${target.schema}\u0000${target.table}\u0000SELECT\u0000${target.principalScoped ? "tenant+principal" : "tenant"}`;
              if (!this.postgresRlsPreflight.has(preflightKey)) {
                await assertPostgresRlsTarget(client, {
                  schema: target.schema,
                  table: target.table,
                  scope: {
                    tenantSetting: input.source.database_scope.tenant_setting,
                    ...(target.principalScoped && input.source.database_scope.principal_setting
                      ? { principalSetting: input.source.database_scope.principal_setting }
                      : {}),
                  },
                  operations: ["SELECT"],
                });
                this.postgresRlsPreflight.add(preflightKey);
              }
            }
          }
          await bindPostgresTrustedScope(client, input.source.database_scope, input.context);
          const result = await client.query(query.sql, query.values);
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
        const timeoutMs = protectedStatementTimeout(input.capability, input.source.statement_timeout_ms);
        if (timeoutMs) await connection.query("SET SESSION max_execution_time = ?", [timeoutMs]).catch(() => undefined);
        const query = runtimeReadQuery(input.capability, "?", input.args, input.context);
        const readOnlyTransaction = Boolean(input.capability.protected_read || input.transaction_mode === "read_only");
        if (readOnlyTransaction) await connection.query("START TRANSACTION READ ONLY");
        try {
          const [rows] = await connection.execute(query.sql, query.values.map(scalar));
          const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
          if (readOnlyTransaction) await connection.query("COMMIT");
          return { row: list[0] ?? {}, rows: list, rowCount: list.length };
        } catch (error) {
          if (readOnlyTransaction) await connection.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
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
  if (scope.principal_setting) {
    await client.query(
      "SELECT set_config($1, $2, true), set_config($3, $4, true)",
      [scope.tenant_setting, context.tenant_id, scope.principal_setting, context.principal],
    );
    return;
  }
  await client.query("SELECT set_config($1, $2, true)", [scope.tenant_setting, context.tenant_id]);
}

export async function withPoolAcquireTimeout<T>(
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

export async function readPostgresRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }> {
  const connectionString = envValue(input.env, input.source.read_url_env);
  if (!connectionString) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
  const pool = createPostgresPool(connectionString);
  const client = await pool.connect();
  try {
    const query = runtimeReadQuery(input.capability, "$", input.args, input.context);
    await client.query(input.capability.protected_read || input.transaction_mode === "read_only" ? "BEGIN READ ONLY" : "BEGIN");
    const timeoutMs = protectedStatementTimeout(input.capability, input.source.statement_timeout_ms);
    if (timeoutMs) {
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    }
    if (input.source.database_scope?.mode === "postgres_rls") {
      for (const target of protectedReadTargets(input.capability)) {
        await assertPostgresRlsTarget(client, {
          schema: target.schema,
          table: target.table,
          scope: {
            tenantSetting: input.source.database_scope.tenant_setting,
            ...(target.principalScoped && input.source.database_scope.principal_setting
              ? { principalSetting: input.source.database_scope.principal_setting }
              : {}),
          },
          operations: ["SELECT"],
        });
      }
    }
    await bindPostgresTrustedScope(client, input.source.database_scope, input.context);
    const result = await client.query(query.sql, query.values);
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

export async function readMysqlRow(input: Parameters<DbRowReader>[0]): Promise<{ row: Record<string, unknown>; rows?: Record<string, unknown>[]; rowCount: number }> {
  const uri = envValue(input.env, input.source.read_url_env);
  if (!uri) throw new McpRuntimeError("SOURCE_CREDENTIAL_MISSING", `${input.source.read_url_env} is not set.`);
  const connection = await mysql.createConnection({ uri, dateStrings: true });
  try {
    const timeoutMs = protectedStatementTimeout(input.capability, input.source.statement_timeout_ms);
    if (timeoutMs) {
      await connection.query("SET SESSION max_execution_time = ?", [timeoutMs]).catch(() => undefined);
    }
    const query = runtimeReadQuery(input.capability, "?", input.args, input.context);
    const readOnlyTransaction = Boolean(input.capability.protected_read || input.transaction_mode === "read_only");
    if (readOnlyTransaction) await connection.query("START TRANSACTION READ ONLY");
    try {
      const [rows] = await connection.execute(query.sql, query.values.map(scalar));
      const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
      if (readOnlyTransaction) await connection.query("COMMIT");
      return { row: list[0] ?? {}, rows: list, rowCount: list.length };
    } catch (error) {
      if (readOnlyTransaction) await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end();
  }
}
