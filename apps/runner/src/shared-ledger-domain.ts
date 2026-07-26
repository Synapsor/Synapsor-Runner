import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { createPostgresPool } from "@synapsor-runner/postgres";
import process from "node:process";
import { optionalArg, optionalNonNegativeIntegerArg, optionalNonNegativeIntegerEnv } from "./cli-options.js";
import { quoteSqlIdentifier } from "./sql-identifiers.js";


const sharedPostgresLedgerTables = ["ledger_entries", "proposal_locks", "worker_leases", "rate_limit_buckets"] as const;


export async function sharedPostgresLedgerTableCounts(
  pool: ReturnType<typeof createPostgresPool>,
  schema: string,
): Promise<Record<typeof sharedPostgresLedgerTables[number], number | null>> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.`;
  const counts: Record<typeof sharedPostgresLedgerTables[number], number | null> = {
    ledger_entries: null,
    proposal_locks: null,
    worker_leases: null,
    rate_limit_buckets: null,
  };
  for (const table of sharedPostgresLedgerTables) {
    try {
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${qualified}${quoteSqlIdentifier(table, "postgres")}`);
      counts[table] = Number(result.rows[0]?.count ?? 0);
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}


export type SharedPostgresLedgerMirror = {
  schema: string;
  urlEnv: string;
  lockTimeoutMs: number;
  maxEntries: number;
};


export function sharedPostgresLedgerMirrorOptions(args: string[], config?: RuntimeConfig): SharedPostgresLedgerMirror {
  const configured = config?.storage?.shared_postgres;
  return {
    schema: optionalArg(args, "--shared-ledger-schema")
      ?? process.env.SYNAPSOR_SHARED_LEDGER_SCHEMA
      ?? configured?.schema
      ?? "synapsor_runner",
    urlEnv: optionalArg(args, "--shared-ledger-url-env")
      ?? process.env.SYNAPSOR_SHARED_LEDGER_URL_ENV
      ?? configured?.url_env
      ?? "SYNAPSOR_LEDGER_DATABASE_URL",
    lockTimeoutMs: optionalNonNegativeIntegerArg(args, "--shared-ledger-lock-timeout-ms")
      ?? optionalNonNegativeIntegerEnv("SYNAPSOR_SHARED_LEDGER_LOCK_TIMEOUT_MS")
      ?? configured?.lock_timeout_ms
      ?? 10_000,
    maxEntries: configured?.max_entries ?? 10_000,
  };
}
