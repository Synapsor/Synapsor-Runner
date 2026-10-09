import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const MUTEX_FILE = "authority-write-lock.sqlite";
declare const permitBrand: unique symbol;
export type ProjectAuthorityMutationPermit = Readonly<{ projectRoot: string; [permitBrand]: true }>;
type PermitState = { active: boolean; child?: Promise<void> };
const permits = new WeakMap<ProjectAuthorityMutationPermit, PermitState>();
// Detection only: no permit is stored in or recoverable from this async context.
// `live` includes draining after the callback returns and its permit expires.
type OwnedScope = { root: string; live: boolean };
const ownedScopes = new AsyncLocalStorage<readonly OwnedScope[]>();

/** Required explicit access to an already-held project scope. This function
 * never opens/acquires SQLite, including when JavaScript omits the permit. */
export async function withHeldProjectAuthorityAccess<T>(
  projectRoot: string,
  permit: ProjectAuthorityMutationPermit,
  operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const root = await fs.realpath(projectRoot);
  assertNotCancelled(options.signal);
  const parent = permits.get(permit);
  if (!parent?.active || permit.projectRoot !== root || parent.child) {
    throw failure("POLICY_MUTATION_PERMIT_INVALID", "Explicit live access to this project's protected operation is required; the held-access callback did not run.");
  }
  let finished!: () => void;
  parent.child = new Promise<void>((resolve) => { finished = resolve; });
  try { return await runScope(root, operation); }
  finally { parent.child = undefined; finished(); }
}

/** Cooperative local-file exclusion, not policy authority or a runtime lease.
 * The persistent SQLite inode must never be removed or replaced. This assumes
 * a trusted local filesystem with working SQLite locks, not cross-host NFS. */
export async function withProjectAuthorityMutation<T>(
  projectRoot: string,
  operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>,
  options: { permit?: ProjectAuthorityMutationPermit; waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const root = await fs.realpath(projectRoot);
  const waitMs = options.waitMs ?? 5_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error("Invalid authority mutation wait duration.");
  assertNotCancelled(options.signal);
  if (options.permit !== undefined) {
    return withHeldProjectAuthorityAccess(root, options.permit, operation, { signal: options.signal });
  }
  if (ownedScopes.getStore()?.some(scope => scope.live && scope.root === root)) {
    throw failure("POLICY_MUTATION_PERMIT_REQUIRED", "This call chain already holds the project's authority access. Pass its explicit live permit to the held-access reader; this acquisition callback did not run.");
  }
  const mutexPath = await prepareMutex(root);
  let db: DatabaseSync | undefined;
  let acquired = false;
  try {
    db = new DatabaseSync(mutexPath);
    db.exec("PRAGMA busy_timeout = 0");
    const deadline = performance.now() + waitMs;
    while (!acquired) {
      assertNotCancelled(options.signal);
      try { db.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR" || (error as { errcode?: number }).errcode !== 5) {
          throw failure("POLICY_MUTATION_LOCK_UNAVAILABLE", "The authority writer lock cannot be opened. Inspect the local state directory; do not delete a lock used by a running process.", error);
        }
        if (performance.now() >= deadline) {
          throw failure("POLICY_MUTATION_BUSY", "The project authority mutex is occupied. Wait for that operation to finish, then retry; this acquisition callback did not run.");
        }
        try { await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal }); }
        catch (error) { assertNotCancelled(options.signal); throw error; }
      }
    }
    assertNotCancelled(options.signal);
    const legacy = await fs.lstat(path.join(root, ".synapsor/exploration-boundaries.active.lock")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (legacy) throw failure("POLICY_LEGACY_MUTATION_LOCK_PRESENT", "An older Runner activation lock is present. Stop older writers and inspect their recovery state before retrying; this request changed no authority.");
    return await runScope(root, operation);
  } finally {
    // No SQL data is written. Closing also releases the OS lock after a failed
    // rollback; process death releases it without age- or PID-based reclamation.
    if (db) {
      try { if (acquired) db.exec("ROLLBACK"); }
      finally { db.close(); }
    }
  }
}

async function runScope<T>(root: string, operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T> {
  const permit = Object.freeze({ projectRoot: root }) as ProjectAuthorityMutationPermit;
  const state: PermitState = { active: true };
  permits.set(permit, state);
  const detection: OwnedScope = { root, live: true };
  try { return await ownedScopes.run([...(ownedScopes.getStore() ?? []), detection], () => operation(permit)); }
  finally {
    state.active = false;
    // An already-entered child must drain even if its parent forgot to await it.
    try { await state.child; }
    finally { detection.live = false; permits.delete(permit); }
  }
}

async function prepareMutex(root: string): Promise<string> {
  const stateRoot = path.join(root, ".synapsor");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(stateRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw invalidPath();
  const mutexPath = path.join(stateRoot, MUTEX_FILE);
  try { const handle = await fs.open(mutexPath, "wx", 0o600); await handle.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(mutexPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalidPath();
  await fs.chmod(mutexPath, 0o600);
  return mutexPath;
}

function invalidPath(): Error {
  return failure("POLICY_MUTATION_PATH_INVALID", "The authority lock requires a private regular file in a real .synapsor directory. Restore the directory without replacing a live lock.");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure("POLICY_MUTATION_CANCELLED", "Authority acquisition was cancelled before its callback ran. Earlier work in this request, if any, is not rolled back.");
}

function failure(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
