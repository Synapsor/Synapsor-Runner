import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const GATE_FILE = "runtime-admission.sqlite";
type Options = { waitMs?: number; signal?: AbortSignal };

export class RuntimeAdmissionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "RuntimeAdmissionError"; }
}

/** Drains cooperating local runtime operations before repository cutover. This
 * is not authorization, a cross-host lease, or a source/control transaction.
 * Never remove this inode while processes may use it; SQLite owns its locks. */
export function withProjectRuntimeAdmission<T>(projectRoot: string,
  operation: (canonicalRoot: string) => Promise<T>, options: Options = {}): Promise<T> {
  return withAdmission(projectRoot, "shared", operation, options);
}

/** Acquire BEFORE the authority writer mutex. Ordinary policy revisions must
 * not use this gate; it is exclusively for repository migration/cutover. */
export function withProjectRuntimeCutover<T>(projectRoot: string,
  operation: (canonicalRoot: string) => Promise<T>, options: Options = {}): Promise<T> {
  return withAdmission(projectRoot, "exclusive", operation, options);
}

async function withAdmission<T>(projectRoot: string, mode: "shared" | "exclusive",
  operation: (canonicalRoot: string) => Promise<T>, options: Options): Promise<T> {
  const waitMs = options.waitMs ?? 5_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error("Invalid runtime admission wait duration.");
  assertNotCancelled(options.signal);
  const root = await fs.realpath(projectRoot);
  const stateRoot = path.join(root, ".synapsor");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(stateRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw invalidPath();
  const gatePath = path.join(stateRoot, GATE_FILE);
  try { const file = await fs.open(gatePath, "wx", 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(gatePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalidPath();
  await fs.chmod(gatePath, 0o600);
  const db = new DatabaseSync(gatePath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const deadline = performance.now() + waitMs;
    for (;;) {
      assertNotCancelled(options.signal);
      try {
        // This read can itself be busy during another process's cutover.
        // WAL cannot provide shared-reader exclusion for this separate gate.
        if (db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") throw invalidPath();
        db.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN");
        if (mode === "shared") db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
        break;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR" || (error as { errcode?: number }).errcode !== 5) throw error;
        if (performance.now() >= deadline) {
          throw failure("POLICY_RUNTIME_BUSY", mode === "exclusive"
            ? "Runtime work is still in progress. Pause new requests and retry the migration; no cutover was performed."
            : "Policy-store maintenance is in progress. Retry this request after it finishes; no runtime work was started.");
        }
        try { await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal }); }
        catch (error) { assertNotCancelled(options.signal); throw error; }
      }
    }
    assertNotCancelled(options.signal);
    return await operation(root);
  } finally {
    try { if (db.isTransaction) db.exec("ROLLBACK"); }
    finally { db.close(); }
  }
}

/** Owns only operation lifetime, never a supplied store or executor. A close
 * waits for accepted work and rejects new work before releasing resources. */
export function projectRuntimeOperations(projectRoot: string) {
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let closed = false;
  return {
    run<T>(operation: (canonicalRoot: string) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(failure("POLICY_RUNTIME_CLOSED", "This runtime is closed. Start a new client session before continuing."));
      const work = withProjectRuntimeAdmission(projectRoot, operation);
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    close(cleanup: () => Promise<void>): Promise<void> {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        // Accepted work already held admission through its own cleanup. Releasing
        // idle owned resources must still succeed during repository maintenance.
        await cleanup();
      })();
      return closing;
    },
  };
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw failure("POLICY_RUNTIME_CANCELLED", "Runtime admission cancelled before starting work.");
}
function invalidPath() {
  return failure("POLICY_RUNTIME_GATE_INVALID", "Runtime admission requires a private regular rollback-journal lock file in a real .synapsor directory. Do not replace a live lock.");
}
function failure(code: string, message: string) { return new RuntimeAdmissionError(code, message); }
