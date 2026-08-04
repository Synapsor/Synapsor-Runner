import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { createPostgresPool } from "@synapsor-runner/postgres";
import {
  ProposalStore,
  sharedPostgresRuntimeStoreMigration,
  type SharedLedgerEntry
} from "@synapsor-runner/proposal-store";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { cutoffFromOlderThan, formatStorePrune, formatStoreReset, formatStoreStats } from "./activity-formatting.js";
import { isRecord } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { operationalLog, safeOperationalErrorCode } from "./cli-logging.js";
import { assertKnownOptions, envValue, optionalArg, positiveIntOption, runtimeStoreBridgeFlag, waitFor } from "./cli-options.js";
import { openLocalStore, optionalRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { storePruneAllowedOptions, storeResetAllowedOptions, storeSharedPostgresAllowedOptions, storeStatsAllowedOptions, storeVacuumAllowedOptions } from "./ledger-options.js";
import { SharedPostgresLedgerMirror, sharedPostgresLedgerMirrorOptions, sharedPostgresLedgerTableCounts } from "./shared-ledger-domain.js";
import { quoteSqlIdentifier } from "./sql-identifiers.js";
import { assertNoActiveStoreLease, storeLeasePath } from "./store-lease.js";
import { renderTerminalSql, terminalSyntaxColorEnabled } from "./terminal-syntax.js";
import { hashReceipt } from "./writeback-domain.js";


export async function storeStats(args: string[]): Promise<number> {
  assertKnownOptions(args, storeStatsAllowedOptions, "store stats");
  const store = await openLocalStore(args);
  try {
    const stats = store.stats();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    else process.stdout.write(formatStoreStats(stats));
    return 0;
  } finally {
    store.close();
  }
}


export async function storeVacuum(args: string[]): Promise<number> {
  assertKnownOptions(args, storeVacuumAllowedOptions, "store vacuum");
  const store = await openLocalStore(args);
  try {
    const before = store.stats();
    store.vacuum();
    const after = store.stats();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ before, after }, null, 2)}\n`);
    else process.stdout.write(`vacuumed local store ${before.path}\napprox bytes: ${before.approx_bytes} -> ${after.approx_bytes}\n`);
    return 0;
  } finally {
    store.close();
  }
}


export async function storePrune(args: string[]): Promise<number> {
  assertKnownOptions(args, storePruneAllowedOptions, "store prune");
  const olderThan = optionalArg(args, "--older-than");
  if (!olderThan) throw new Error("store prune requires --older-than <duration>, for example --older-than 30d");
  if (args.includes("--yes") && args.includes("--dry-run")) throw new Error("store prune accepts either --dry-run or --yes, not both");
  const cutoff = cutoffFromOlderThan(olderThan);
  const dryRun = !args.includes("--yes");
  if (!dryRun) await assertNoActiveStoreLease(optionalArg(args, "--store"), args.includes("--force"), "store prune");
  const store = await openLocalStore(args);
  try {
    const result = store.pruneBefore(cutoff, { dryRun });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(formatStorePrune(result));
    return 0;
  } finally {
    store.close();
  }
}


export async function storeReset(args: string[]): Promise<number> {
  assertKnownOptions(args, storeResetAllowedOptions, "store reset");
  const storePath = resolvedLocalStorePath(args);
  if (storePath === ":memory:") throw new Error("store reset does not apply to :memory: stores");
  if (!args.includes("--yes")) {
    throw new Error("store reset is destructive for the local ledger. Rerun with --yes after backing up anything you need.");
  }
  await assertNoActiveStoreLease(storePath, args.includes("--force"), "store reset");
  const resolved = path.resolve(storePath);
  const candidates = [resolved, `${resolved}-wal`, `${resolved}-shm`, storeLeasePath(resolved)];
  const removed: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.rm(candidate, { force: true });
      removed.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const result = {
    ok: true,
    store: resolved,
    removed,
    source_database_changed: false,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(formatStoreReset(result));
  return 0;
}


export async function storeSharedPostgres(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "migration") return storeSharedPostgresMigration(rest);
  if (subcommand === "apply-migration") return storeSharedPostgresApplyMigration(rest);
  if (subcommand === "status") return storeSharedPostgresStatus(rest);
  if (subcommand === "sync") return storeSharedPostgresSync(rest);
  if (subcommand === "restore") return storeSharedPostgresRestore(rest);
  if (subcommand === "backup" || subcommand === "export") return storeSharedPostgresBackup(rest);
  if (subcommand === "verify-backup") return storeSharedPostgresVerifyBackup(rest);
  if (subcommand === "restore-backup") return storeSharedPostgresRestoreBackup(rest);
  if (subcommand === "retention") return storeSharedPostgresRetention(rest);
  usage(["store"]);
  return 2;
}


async function storeSharedPostgresMigration(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres migration");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const sql = sharedPostgresRuntimeStoreMigration(schema);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, engine: "postgres", schema, sql }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminalSql(sql, terminalSyntaxColorEnabled())}\n`);
  }
  return 0;
}


async function storeSharedPostgresApplyMigration(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres apply-migration");
  if (!args.includes("--yes")) throw new Error("store shared-postgres apply-migration requires --yes.");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(sharedPostgresRuntimeStoreMigration(schema));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, engine: "postgres", schema, url_env: urlEnv }, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger migration applied in schema ${schema} using ${urlEnv}\n`);
  } finally {
    await pool.end();
  }
  return 0;
}


async function storeSharedPostgresStatus(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres status");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    const counts = await sharedPostgresLedgerTableCounts(pool, schema);
    const ok = Object.values(counts).every((count) => typeof count === "number");
    const payload = { ok, engine: "postgres", schema, url_env: urlEnv, tables: counts };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(formatSharedPostgresStatus(payload));
  } finally {
    await pool.end();
  }
  return 0;
}


async function storeSharedPostgresSync(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres sync");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const storePath = resolvedLocalStorePath(args);
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--yes")) throw new Error("store shared-postgres sync requires --yes unless --dry-run is set.");

  const entries = localSharedLedgerEntries(storePath);

  if (dryRun) {
    const payload = { ok: true, dry_run: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger sync dry-run: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${storePath} into schema ${schema} using ${urlEnv}\n`);
    return 0;
  }

  const result = await syncLocalStoreToSharedPostgres({ storePath, schema, urlEnv });
  const payload = { ok: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger sync complete: ${result.entries} entr${result.entries === 1 ? "y" : "ies"} from ${storePath} into schema ${schema} using ${urlEnv}\n`);
  return 0;
}


async function storeSharedPostgresRestore(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres restore");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const storePath = resolvedLocalStorePath(args);
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--yes")) throw new Error("store shared-postgres restore requires --yes unless --dry-run is set.");
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema);
  if (dryRun) {
    const payload = { ok: true, dry_run: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger restore dry-run: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from schema ${schema} into ${storePath} using ${urlEnv}\n`);
    return 0;
  }
  const result = await restoreSharedPostgresToLocalStore({ storePath, schema, urlEnv, entries });
  const payload = { ok: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), ...result };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger restore complete: imported ${result.imported}, skipped ${result.skipped}, source entries ${entries.length}, store ${storePath}, url env ${urlEnv}\n`);
  return 0;
}


type SharedLedgerArchive = {
  schema_version: "synapsor.shared-ledger-archive.v1";
  created_at: string;
  source: { engine: "postgres"; schema: string };
  entries: SharedLedgerEntry[];
  manifest: { entries: number; digest: `sha256:${string}` };
};


async function storeSharedPostgresBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres backup");
  const output = optionalArg(args, "--output");
  if (!output) throw new Error("store shared-postgres backup requires --output <archive.json>");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const maxEntries = positiveIntOption(args, "--max-entries", 10_000, 100, 100_000);
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema, maxEntries);
  const archive = createSharedLedgerArchive(schema, entries);
  const resolved = path.resolve(output);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(resolved, 0o600);
  const payload = { ok: true, archive: resolved, entries: archive.manifest.entries, digest: archive.manifest.digest };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger backup written: ${resolved}\nentries: ${archive.manifest.entries}\ndigest: ${archive.manifest.digest}\n`);
  return 0;
}


async function storeSharedPostgresVerifyBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres verify-backup");
  const input = optionalArg(args, "--input");
  if (!input) throw new Error("store shared-postgres verify-backup requires --input <archive.json>");
  const archive = await readSharedLedgerArchive(input);
  const payload = { ok: true, archive: path.resolve(input), entries: archive.manifest.entries, digest: archive.manifest.digest };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared ledger backup verified: ${payload.archive}\nentries: ${payload.entries}\ndigest: ${payload.digest}\n`);
  return 0;
}


async function storeSharedPostgresRestoreBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres restore-backup");
  const input = optionalArg(args, "--input");
  if (!input) throw new Error("store shared-postgres restore-backup requires --input <archive.json>");
  if (!args.includes("--yes")) throw new Error("store shared-postgres restore-backup requires --yes and restores only into an empty ledger schema.");
  const archive = await readSharedLedgerArchive(input);
  const schema = optionalArg(args, "--schema") ?? archive.source.schema;
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(sharedPostgresRuntimeStoreMigration(schema));
    const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
    const existing = await pool.query(`SELECT COUNT(*)::int AS count FROM ${qualified}`);
    if (Number(existing.rows[0]?.count ?? 0) !== 0) throw new Error(`restore target ${schema}.ledger_entries is not empty`);
    await pool.query("BEGIN");
    try {
      await upsertSharedPostgresEntries(pool, schema, archive.entries);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const restored = await fetchSharedPostgresLedgerEntries(pool, schema, archive.entries.length + 1);
    const verified = createSharedLedgerArchive(schema, restored);
    if (verified.manifest.digest !== archive.manifest.digest || restored.length !== archive.entries.length) {
      throw new Error("restored shared ledger failed manifest verification");
    }
    const payload = { ok: true, schema, url_env: urlEnv, entries: restored.length, digest: archive.manifest.digest };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared ledger backup restored and verified in schema ${schema}\nentries: ${restored.length}\ndigest: ${archive.manifest.digest}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}


async function storeSharedPostgresRetention(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres retention");
  const olderThan = optionalArg(args, "--older-than");
  if (!olderThan) throw new Error("store shared-postgres retention requires --older-than <duration>");
  const dryRun = !args.includes("--yes");
  if (!dryRun && args.includes("--dry-run")) throw new Error("store shared-postgres retention accepts either --dry-run or --yes, not both");
  const output = optionalArg(args, "--output");
  if (!dryRun && !output) throw new Error("store shared-postgres retention requires --output <archive.json> before --yes deletion");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const maxEntries = positiveIntOption(args, "--max-entries", 10_000, 100, 100_000);
  const cutoff = cutoffFromOlderThan(olderThan);
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema, maxEntries);
  const store = new ProposalStore();
  let archivedEntries: SharedLedgerEntry[];
  let deleted: Record<string, number>;
  try {
    store.importSharedLedgerEntries(entries);
    const before = new Map(store.sharedLedgerEntries().map((entry) => [entry.entry_key, entry]));
    const result = store.pruneBefore(cutoff, { dryRun: false });
    deleted = result.deleted;
    const retained = new Set(store.sharedLedgerEntries().map((entry) => entry.entry_key));
    archivedEntries = [...before.values()].filter((entry) => !retained.has(entry.entry_key));
  } finally {
    store.close();
  }
  if (dryRun) {
    const payload = { ok: true, dry_run: true, schema, url_env: urlEnv, cutoff, archive_entries: archivedEntries.length, deleted };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared ledger retention dry-run\ncutoff: ${cutoff}\narchive entries: ${archivedEntries.length}\nno rows deleted\n`);
    return 0;
  }

  const archive = createSharedLedgerArchive(schema, archivedEntries);
  const archivePath = path.resolve(output!);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(archivePath, 0o600);
  await readSharedLedgerArchive(archivePath);

  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  try {
    await pool.query("BEGIN");
    try {
      if (archivedEntries.length > 0) {
        await pool.query(`DELETE FROM ${qualified} WHERE entry_key = ANY($1::text[])`, [archivedEntries.map((entry) => entry.entry_key)]);
      }
      const retentionEntry: SharedLedgerEntry = {
        entry_key: `retention:${crypto.randomUUID()}`,
        kind: "retention_event",
        payload: {
          cutoff,
          archive_digest: archive.manifest.digest,
          archived_entries: archivedEntries.length,
          deleted,
        },
        created_at: new Date().toISOString(),
      };
      await upsertSharedPostgresEntries(pool, schema, [retentionEntry]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await pool.end();
  }
  const payload = { ok: true, dry_run: false, schema, url_env: urlEnv, cutoff, archive: archivePath, archive_entries: archivedEntries.length, archive_digest: archive.manifest.digest, deleted };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared ledger retention complete\narchive: ${archivePath}\ndigest: ${archive.manifest.digest}\narchived entries: ${archivedEntries.length}\n`);
  return 0;
}


function createSharedLedgerArchive(schema: string, entries: SharedLedgerEntry[]): SharedLedgerArchive {
  const body = {
    schema_version: "synapsor.shared-ledger-archive.v1" as const,
    created_at: new Date().toISOString(),
    source: { engine: "postgres" as const, schema },
    entries,
  };
  return { ...body, manifest: { entries: entries.length, digest: hashReceipt({ schema_version: body.schema_version, entries }) } };
}


async function readSharedLedgerArchive(input: string): Promise<SharedLedgerArchive> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(input), "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== "synapsor.shared-ledger-archive.v1" || !isRecord(parsed.source)
    || parsed.source.engine !== "postgres" || typeof parsed.source.schema !== "string" || !Array.isArray(parsed.entries) || !isRecord(parsed.manifest)) {
    throw new Error("invalid shared ledger backup envelope");
  }
  const entries = parsed.entries as SharedLedgerEntry[];
  const digest = hashReceipt({ schema_version: parsed.schema_version, entries });
  if (parsed.manifest.entries !== entries.length || parsed.manifest.digest !== digest) throw new Error("shared ledger backup manifest digest mismatch");
  return parsed as SharedLedgerArchive;
}


function localSharedLedgerEntries(storePath: string): SharedLedgerEntry[] {
  const store = new ProposalStore(storePath);
  try {
    return store.sharedLedgerEntries();
  } finally {
    store.close();
  }
}


type SharedPostgresLedgerClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};


export function assertNoRuntimeStoreForLocalMutation(config: RuntimeConfig | undefined, command: string, args: string[] = []): void {
  if (config?.storage?.shared_postgres?.mode !== "runtime_store") return;
  if (args.includes(runtimeStoreBridgeFlag)) return;
  throw new Error(`${command} cannot run directly against the local SQLite path when storage.shared_postgres.mode=runtime_store. Use the built-in runtime-store bridge or switch to local SQLite/mirror mode.`);
}


export function assertLocalGovernanceMutationAllowed(config: RuntimeConfig | undefined, command: string): void {
  if (config?.governance?.mode !== "cloud_linked") return;
  throw new Error(`${command} is disabled for cloud_linked governance. Record human decisions through Synapsor Cloud; only a Cloud-approved leased job may reach the trusted Runner writeback path.`);
}


export function runtimeStoreBridgeRequired(args: string[], config: RuntimeConfig | undefined): boolean {
  return config?.storage?.shared_postgres?.mode === "runtime_store" && !args.includes(runtimeStoreBridgeFlag);
}


export function argsWithRuntimeStoreBridge(args: string[], storePath: string): string[] {
  const result: string[] = [];
  const flagsWithValues = new Set(["--shared-ledger-url-env", "--shared-ledger-schema", "--shared-ledger-lock-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === runtimeStoreBridgeFlag) continue;
    if (arg === "--shared-ledger-mirror" || arg === "--no-shared-ledger-mirror") continue;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--store") {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  result.push("--store", storePath, runtimeStoreBridgeFlag);
  return result;
}


export async function withSharedPostgresRuntimeStoreBridge<T>(
  args: string[],
  config: RuntimeConfig,
  command: string,
  callback: (storePath: string) => Promise<T>,
): Promise<T> {
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runtime-store-bridge-"));
  const storePath = path.join(tempDir, "local.db");
  try {
    return await withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
      const before = await restoreSharedPostgresToLocalStore({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
      operationalLog("info", "shared_runtime_store_restore", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: before.entries,
        imported: before.imported,
        skipped: before.skipped,
        source_database_changed: false,
      });
      let result: T | undefined;
      let originalError: unknown;
      try {
        result = await callback(storePath);
      } catch (error) {
        originalError = error;
      }

      try {
        const after = await syncLocalStoreToSharedPostgres({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
        operationalLog("info", "shared_runtime_store_sync", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          entries: after.entries,
          source_database_changed: false,
          command_failed: originalError !== undefined,
        });
      } catch (syncError) {
        operationalLog("error", "shared_runtime_store_sync_failed", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          error_code: safeOperationalErrorCode(syncError),
          source_database_changed: false,
          command_failed: originalError !== undefined,
        });
        if (originalError === undefined) throw syncError;
      }
      if (originalError !== undefined) throw originalError;
      return result as T;
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}


export async function withSharedPostgresRuntimeStoreReadBridge<T>(
  args: string[],
  config: RuntimeConfig,
  command: string,
  callback: (storePath: string) => Promise<T>,
): Promise<T> {
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runtime-store-read-"));
  const storePath = path.join(tempDir, "local.db");
  try {
    return await withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
      const restored = await restoreSharedPostgresToLocalStore({
        storePath,
        schema: mirror.schema,
        urlEnv: mirror.urlEnv,
        maxEntries: mirror.maxEntries,
      });
      operationalLog("info", "shared_runtime_store_read", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: restored.entries,
        imported: restored.imported,
        skipped: restored.skipped,
        source_database_changed: false,
      });
      return callback(storePath);
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}


export async function maybeSharedPostgresRuntimeStoreRead(
  args: string[],
  command: string,
  callback: (storePath: string) => Promise<number>,
): Promise<number | undefined> {
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (!config || !runtimeStoreBridgeRequired(args, config)) return undefined;
  return withSharedPostgresRuntimeStoreReadBridge(args, config, command, callback);
}


export function sharedPostgresLedgerMirrorRequested(args: string[], config?: RuntimeConfig): boolean {
  if (args.includes("--no-shared-ledger-mirror")) return false;
  return args.includes("--shared-ledger-mirror")
    || Boolean(optionalArg(args, "--shared-ledger-url-env"))
    || process.env.SYNAPSOR_SHARED_LEDGER_MIRROR === "true"
    || config?.storage?.shared_postgres?.mode === "mirror";
}


export function withoutSharedPostgresLedgerMirror(args: string[]): string[] {
  const result: string[] = [];
  const flagsWithValues = new Set(["--shared-ledger-url-env", "--shared-ledger-schema", "--shared-ledger-lock-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--shared-ledger-mirror" || arg === "--no-shared-ledger-mirror") continue;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  result.push("--no-shared-ledger-mirror");
  return result;
}


export async function withSharedPostgresLedgerMirror<T>(
  args: string[],
  storePath: string,
  command: string,
  callback: () => Promise<T>,
  config?: RuntimeConfig,
): Promise<T> {
  if (storePath === ":memory:") {
    throw new Error("shared Postgres ledger mirror requires a durable --store path, not :memory:");
  }
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  return withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
    const before = await restoreSharedPostgresToLocalStore({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
    operationalLog("info", "shared_ledger_mirror_restore", {
      command,
      schema: mirror.schema,
      url_env: mirror.urlEnv,
      entries: before.entries,
      imported: before.imported,
      skipped: before.skipped,
      source_database_changed: false,
    });
    let result: T | undefined;
    let originalError: unknown;
    try {
      result = await callback();
    } catch (error) {
      originalError = error;
    }

    try {
      const after = await syncLocalStoreToSharedPostgres({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
      operationalLog("info", "shared_ledger_mirror_sync", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: after.entries,
        source_database_changed: false,
        command_failed: originalError !== undefined,
      });
    } catch (syncError) {
      operationalLog("error", "shared_ledger_mirror_sync_failed", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        error_code: safeOperationalErrorCode(syncError),
        source_database_changed: false,
        command_failed: originalError !== undefined,
      });
      if (originalError === undefined) throw syncError;
    }
    if (originalError !== undefined) throw originalError;
    return result as T;
  });
}


async function withSharedPostgresLedgerMirrorLock<T>(
  mirror: SharedPostgresLedgerMirror,
  command: string,
  callback: () => Promise<T>,
): Promise<T> {
  const databaseUrl = envValue(mirror.urlEnv);
  if (!databaseUrl) throw new Error(`${mirror.urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  const client = await pool.connect();
  const lockKey = `synapsor-runner:${mirror.schema}:shared-ledger-mirror`;
  let locked = false;
  try {
    locked = await acquirePostgresAdvisoryLock(client, lockKey, mirror.lockTimeoutMs);
    if (!locked) {
      operationalLog("warn", "shared_ledger_mirror_lock_timeout", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        lock_timeout_ms: mirror.lockTimeoutMs,
        source_database_changed: false,
      });
      throw new Error(`shared Postgres ledger mirror lock is held for schema ${mirror.schema}; retry later or increase --shared-ledger-lock-timeout-ms`);
    }
    operationalLog("info", "shared_ledger_mirror_lock_acquired", {
      command,
      schema: mirror.schema,
      url_env: mirror.urlEnv,
      lock_timeout_ms: mirror.lockTimeoutMs,
      source_database_changed: false,
    });
    return await callback();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS unlocked", [lockKey]).catch((error: unknown) => {
        operationalLog("error", "shared_ledger_mirror_lock_release_failed", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          error_code: safeOperationalErrorCode(error),
          source_database_changed: false,
        });
      });
      operationalLog("info", "shared_ledger_mirror_lock_released", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        source_database_changed: false,
      });
    }
    client.release();
    await pool.end();
  }
}


async function acquirePostgresAdvisoryLock(
  client: SharedPostgresLedgerClient,
  lockKey: string,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await waitFor(Math.min(250, Math.max(25, timeoutMs - (Date.now() - started))));
  }
}


async function fetchSharedPostgresEntriesFromEnv(urlEnv: string, schema: string, maxEntries = 10_000): Promise<SharedLedgerEntry[]> {
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    return await fetchSharedPostgresLedgerEntries(pool, schema, maxEntries);
  } finally {
    await pool.end();
  }
}


async function syncLocalStoreToSharedPostgres(input: { storePath: string; schema: string; urlEnv: string; maxEntries?: number }): Promise<{ entries: number }> {
  const entries = localSharedLedgerEntries(input.storePath);
  const maxEntries = input.maxEntries ?? 10_000;
  if (entries.length > maxEntries) throw new Error(`shared Postgres ledger sync exceeds configured ${maxEntries}-entry safety bound`);
  const databaseUrl = envValue(input.urlEnv);
  if (!databaseUrl) throw new Error(`${input.urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query("BEGIN");
    await pool.query(sharedPostgresRuntimeStoreMigration(input.schema));
    await upsertSharedPostgresEntries(pool, input.schema, entries);
    await pool.query("COMMIT");
    return { entries: entries.length };
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}


async function restoreSharedPostgresToLocalStore(input: { storePath: string; schema: string; urlEnv: string; entries?: SharedLedgerEntry[]; maxEntries?: number }): Promise<{ entries: number; imported: number; skipped: number }> {
  if (input.storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(input.storePath)), { recursive: true });
  }
  const maxEntries = input.maxEntries ?? 10_000;
  const entries = input.entries ?? await fetchSharedPostgresEntriesFromEnv(input.urlEnv, input.schema, maxEntries);
  if (entries.length > maxEntries) throw new Error(`shared Postgres ledger restore exceeds configured ${maxEntries}-entry safety bound`);
  const store = new ProposalStore(input.storePath);
  try {
    const result = store.importSharedLedgerEntries(entries);
    return { entries: entries.length, imported: result.imported, skipped: result.skipped };
  } finally {
    store.close();
  }
}


async function fetchSharedPostgresLedgerEntries(pool: ReturnType<typeof createPostgresPool>, schema: string, maxEntries = 10_000): Promise<SharedLedgerEntry[]> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  const result = await pool.query(`
    SELECT entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at::text AS created_at
    FROM ${qualified}
    ORDER BY entry_id ASC
    LIMIT $1
  `, [maxEntries + 1]);
  if (result.rows.length > maxEntries) throw new Error(`shared Postgres ledger exceeds configured ${maxEntries}-entry safety bound`);
  return result.rows.map((row) => {
    const rawPayload = row.payload_json;
    let payload: Record<string, unknown>;
    if (isRecord(rawPayload)) payload = rawPayload;
    else {
      const parsed = JSON.parse(String(rawPayload ?? "{}")) as unknown;
      payload = isRecord(parsed) ? parsed : {};
    }
    return {
      entry_key: String(row.entry_key),
      kind: String(row.kind),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
      capability: row.capability == null ? undefined : String(row.capability),
      payload,
      created_at: String(row.created_at),
    };
  });
}


async function upsertSharedPostgresEntries(
  pool: Pick<ReturnType<typeof createPostgresPool>, "query">,
  schema: string,
  entries: SharedLedgerEntry[],
): Promise<void> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET
  kind = EXCLUDED.kind,
  proposal_id = EXCLUDED.proposal_id,
  tenant_id = EXCLUDED.tenant_id,
  capability = EXCLUDED.capability,
  payload_json = EXCLUDED.payload_json,
  created_at = EXCLUDED.created_at`,
      [entry.entry_key, entry.kind, entry.proposal_id ?? null, entry.tenant_id ?? null, entry.capability ?? null, JSON.stringify(entry.payload), entry.created_at],
    );
  }
}


function formatSharedPostgresStatus(payload: { ok: boolean; schema: string; url_env: string; tables: Record<string, number | null> }): string {
  const lines = [
    `Shared Postgres ledger: ${payload.ok ? "ready" : "not initialized"}`,
    `Schema: ${payload.schema}`,
    `URL env: ${payload.url_env}`,
  ];
  for (const [table, count] of Object.entries(payload.tables)) {
    lines.push(`- ${table}: ${count === null ? "missing" : count}`);
  }
  return `${lines.join("\n")}\n`;
}
