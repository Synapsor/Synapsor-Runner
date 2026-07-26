import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";


type StoreLease = {
  pid: number;
  mode: string;
  transport: string;
  store_path: string;
  started_at: string;
};


export async function writeStoreLease(storePath: string | undefined, mode: string, transport: string, allowConcurrent: boolean): Promise<() => Promise<void>> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return async () => undefined;
  await assertNoActiveStoreLease(resolved, allowConcurrent, "serve");
  const leasePath = storeLeasePath(resolved);
  const lease: StoreLease = {
    pid: process.pid,
    mode,
    transport,
    store_path: resolved,
    started_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return async () => {
    const current = await readStoreLease(resolved);
    if (current?.pid === process.pid && current.transport === transport) {
      await fs.rm(leasePath, { force: true });
    }
  };
}


export async function assertNoActiveStoreLease(storePath: string | undefined, force: boolean, operation: string): Promise<void> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return;
  const lease = await readStoreLease(resolved);
  if (!lease) return;
  if (!pidIsActive(lease.pid)) {
    await fs.rm(storeLeasePath(resolved), { force: true });
    return;
  }
  const message = `Local store appears active for ${lease.mode}/${lease.transport} (pid ${lease.pid}, started ${lease.started_at}). Refusing ${operation}. Stop the server or rerun with --allow-concurrent-store/--force if you have verified it is safe.`;
  if (!force) throw new Error(message);
  process.stderr.write(`Warning: ${message}\n`);
}


function resolveStorePathForLease(storePath: string | undefined): string | undefined {
  const value = storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  if (value === ":memory:") return undefined;
  return path.resolve(value);
}


export function storeLeasePath(resolvedStorePath: string): string {
  return `${resolvedStorePath}.lease.json`;
}


async function readStoreLease(storePath: string | undefined): Promise<StoreLease | undefined> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(storeLeasePath(resolved), "utf8")) as Partial<StoreLease>;
    if (typeof parsed.pid !== "number" || typeof parsed.mode !== "string" || typeof parsed.transport !== "string" || typeof parsed.started_at !== "string") {
      return undefined;
    }
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      transport: parsed.transport,
      store_path: typeof parsed.store_path === "string" ? parsed.store_path : resolved,
      started_at: parsed.started_at,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}


function pidIsActive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
