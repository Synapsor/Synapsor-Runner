import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Runs one disabled-action rehearsal against an isolated SQLite ledger and
 * removes every SQLite file before returning. A rehearsal proposal must never
 * enter the durable operator ledger or survive long enough to gain authority.
 */
export async function withDisposableActionPreviewLedger<T>(input: {
  projectRoot: string;
  run: (storePath: string) => Promise<T>;
}): Promise<T> {
  const storePath = path.join(
    path.resolve(input.projectRoot),
    ".synapsor",
    "action-preview-ledgers",
    `${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`,
  );
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  try {
    return await input.run(storePath);
  } finally {
    await Promise.all([
      fs.rm(storePath, { force: true }),
      fs.rm(`${storePath}-wal`, { force: true }),
      fs.rm(`${storePath}-shm`, { force: true }),
    ]);
  }
}
