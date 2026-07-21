import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const markerName = ".synapsor-try-state.json";
const lockName = ".synapsor-try.lock";
const customManagedChild = ".synapsor-try";
const markerSchema = "synapsor.try-state.v1";
const lockSchema = "synapsor.try-lock.v1";

const knownStateFiles = new Set([
  "source.json",
  "synapsor.runner.json",
  "ledger.db",
  "ledger.db-journal",
  "ledger.db-shm",
  "ledger.db-wal",
]);

const knownTemporaryFile = /^(?:source\.json|synapsor\.runner\.json)\.\d+\.[0-9a-f]{12}\.tmp$/;

type PathFlavor = "native" | "posix" | "win32";

type TryStatePathContext = {
  cwd: string;
  home: string;
  repository_root?: string;
};

export type TryStateLocation = {
  container: string;
  root: string;
  custom: boolean;
};

export type PreparedTryState = TryStateLocation & {
  release: () => Promise<void>;
};

export function resolveTryStateLocation(rootDir?: string, cwd = process.cwd()): TryStateLocation {
  const custom = rootDir !== undefined;
  const container = custom
    ? path.resolve(cwd, rootDir!)
    : path.resolve(cwd, ".synapsor");
  return {
    container,
    root: custom ? path.join(container, customManagedChild) : path.join(container, "try"),
    custom,
  };
}

export function classifyUnsafeTryStateContainer(
  candidate: string,
  context: TryStatePathContext,
  flavor: PathFlavor = "native",
): string | undefined {
  const value = candidate.trim();
  if (!value) return "the state path is empty";
  if (value === "." || value === "..") return "the state path is the working directory or its parent";
  if (value.replaceAll("\\", "/").split("/").includes("..")) {
    return "the state path contains parent traversal";
  }

  const api = flavor === "win32" ? path.win32 : flavor === "posix" ? path.posix : path;
  const caseInsensitive = flavor === "win32" || (flavor === "native" && process.platform === "win32");
  const cwd = api.resolve(context.cwd);
  const resolved = api.resolve(cwd, value);
  const filesystemRoot = api.parse(resolved).root;
  if (samePath(resolved, filesystemRoot, caseInsensitive)) return "the state path is a filesystem root";

  const protectedPaths: Array<[string, string]> = [
    [context.home, "the user's home directory"],
    [context.cwd, "the current working directory"],
    ...(context.repository_root ? [[context.repository_root, "the repository root"] as [string, string]] : []),
  ];
  for (const [protectedPath, label] of protectedPaths) {
    const target = api.resolve(protectedPath);
    if (samePath(resolved, target, caseInsensitive)) return `the state path is ${label}`;
  }
  for (const [protectedPath] of protectedPaths) {
    const target = api.resolve(protectedPath);
    if (isSameOrAncestor(resolved, target, api, caseInsensitive)) {
      return "the state path is an ancestor of a protected working or repository path";
    }
  }
  return undefined;
}

export async function prepareTryState(rootDir?: string): Promise<PreparedTryState> {
  const cwd = process.cwd();
  const location = resolveTryStateLocation(rootDir, cwd);
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (rootDir !== undefined) {
    const unsafe = classifyUnsafeTryStateContainer(rootDir, {
      cwd,
      home: os.homedir(),
      ...(repositoryRoot ? { repository_root: repositoryRoot } : {}),
    });
    if (unsafe) throw unsafePath(rootDir, unsafe);
  }

  await assertNoSymlinkComponents(location.container);
  await fs.mkdir(location.container, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(location.container);
  await assertNotRepositoryRoot(location.container, rootDir ?? location.container);
  await ensureManagedRoot(location.root, !location.custom);
  const release = await acquireStateLease(location.root);
  try {
    await assertManagedRoot(location.root);
    await removeKnownStateFiles(location.root);
  } catch (error) {
    await release();
    throw error;
  }
  return { ...location, release };
}

export async function resolveReadableTryStateRoot(rootDir?: string): Promise<string> {
  const cwd = process.cwd();
  const location = resolveTryStateLocation(rootDir, cwd);
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (rootDir !== undefined) {
    const unsafe = classifyUnsafeTryStateContainer(rootDir, {
      cwd,
      home: os.homedir(),
      ...(repositoryRoot ? { repository_root: repositoryRoot } : {}),
    });
    if (unsafe) throw unsafePath(rootDir, unsafe);
  }
  await assertNoSymlinkComponents(location.container);
  await assertNotRepositoryRoot(location.container, rootDir ?? location.container);
  await assertManagedRoot(location.root, !location.custom);
  return location.root;
}

async function assertNotRepositoryRoot(container: string, input: string): Promise<void> {
  try {
    await fs.lstat(path.join(container, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw unsafePath(input, "the state path is a Git repository root");
}

async function ensureManagedRoot(root: string, allowLegacyDefault: boolean): Promise<void> {
  await assertNoSymlinkComponents(path.dirname(root));
  let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!stat) {
    try {
      await fs.mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertManagedDirectory(root);
    await writeMarker(root);
    return;
  }

  await assertManagedDirectory(root);
  try {
    await assertMarker(root);
  } catch (error) {
    if (!(error instanceof TryStateError) || error.code !== "TRY_STATE_UNOWNED") throw error;
    if (await isEmptyDirectory(root)) {
      await writeMarker(root);
      return;
    }
    if (!allowLegacyDefault || !(await isAdoptableLegacyDefault(root))) throw error;
    await writeMarker(root);
  }
}

async function assertManagedRoot(root: string, allowLegacyDefault = false): Promise<void> {
  await assertNoSymlinkComponents(root);
  await assertManagedDirectory(root);
  try {
    await assertMarker(root);
  } catch (error) {
    if (!(error instanceof TryStateError) || error.code !== "TRY_STATE_UNOWNED") throw error;
    if (!allowLegacyDefault || !(await isAdoptableLegacyDefault(root))) throw error;
  }
}

async function assertManagedDirectory(root: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TryStateError("TRY_STATE_NOT_FOUND", `Synapsor try state does not exist at ${root}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw unsafePath(root, "the managed state directory is a symbolic link");
  if (!stat.isDirectory()) throw unsafePath(root, "the managed state path is not a directory");
  const real = await fs.realpath(root);
  if (!samePath(path.resolve(root), path.resolve(real), process.platform === "win32")) {
    throw unsafePath(root, "the managed state directory resolves outside its reviewed path");
  }
}

async function writeMarker(root: string): Promise<void> {
  const markerPath = path.join(root, markerName);
  try {
    await fs.writeFile(markerPath, `${JSON.stringify({
      schema_version: markerSchema,
      managed_by: "@synapsor/runner",
      purpose: "embedded_try_state",
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertMarker(root);
  }
}

async function assertMarker(root: string): Promise<void> {
  const markerPath = path.join(root, markerName);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TryStateError(
        "TRY_STATE_UNOWNED",
        `Refusing to clean unowned Synapsor try state at ${root}; the ownership marker is missing`,
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw unsafePath(markerPath, "the ownership marker is not a regular file");
  }
  let marker: { schema_version?: unknown; managed_by?: unknown; purpose?: unknown };
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as typeof marker;
  } catch {
    throw new TryStateError("TRY_STATE_UNOWNED", `Refusing to clean try state with an invalid ownership marker at ${markerPath}`);
  }
  if (marker.schema_version !== markerSchema
    || marker.managed_by !== "@synapsor/runner"
    || marker.purpose !== "embedded_try_state") {
    throw new TryStateError("TRY_STATE_UNOWNED", `Refusing to clean try state with an unknown ownership marker at ${markerPath}`);
  }
}

async function isAdoptableLegacyDefault(root: string): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!knownStateFiles.has(entry.name) && !knownTemporaryFile.test(entry.name)) return false;
    if (!entry.isFile()) return false;
    const stat = await fs.lstat(path.join(root, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
  }
  return true;
}

async function isEmptyDirectory(root: string): Promise<boolean> {
  return (await fs.readdir(root)).length === 0;
}

async function removeKnownStateFiles(root: string): Promise<void> {
  await assertManagedRoot(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!knownStateFiles.has(entry.name) && !knownTemporaryFile.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    await assertManagedRoot(root);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw unsafePath(candidate, "a managed state file was replaced by a link or non-file entry");
    }
    await fs.rm(candidate, { force: true });
  }
}

async function acquireStateLease(root: string): Promise<() => Promise<void>> {
  const lockPath = path.join(root, lockName);
  const token = crypto.randomBytes(16).toString("hex");
  const payload = {
    schema_version: lockSchema,
    pid: process.pid,
    token,
    created_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => releaseStateLease(lockPath, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readLock(lockPath);
      if (processIsAlive(prior.pid)) {
        throw new TryStateError(
          "TRY_STATE_BUSY",
          `Synapsor try state is already active (pid ${prior.pid}); wait for it to finish or choose another --state-dir`,
        );
      }
      await removeStaleLock(lockPath, prior.token);
    }
  }
  throw new TryStateError("TRY_STATE_BUSY", `Could not acquire Synapsor try state at ${root}`);
}

async function readLock(lockPath: string): Promise<{ pid: number; token: string }> {
  const stat = await fs.lstat(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw unsafePath(lockPath, "the state lease is not a regular file");
  let value: { schema_version?: unknown; pid?: unknown; token?: unknown };
  try {
    value = JSON.parse(await fs.readFile(lockPath, "utf8")) as typeof value;
  } catch {
    throw new TryStateError("TRY_STATE_BUSY", `Refusing to replace an invalid state lease at ${lockPath}`);
  }
  if (value.schema_version !== lockSchema
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.token !== "string"
    || !/^[0-9a-f]{32}$/.test(value.token)) {
    throw new TryStateError("TRY_STATE_BUSY", `Refusing to replace an unknown state lease at ${lockPath}`);
  }
  return { pid: Number(value.pid), token: value.token };
}

async function removeStaleLock(lockPath: string, expectedToken: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current.token !== expectedToken) {
    throw new TryStateError("TRY_STATE_BUSY", `Synapsor try state lease changed while checking ${lockPath}`);
  }
  await fs.rm(lockPath, { force: true });
}

async function releaseStateLease(lockPath: string, expectedToken: string): Promise<void> {
  try {
    const current = await readLock(lockPath);
    if (current.token !== expectedToken) return;
    await fs.rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertNoSymlinkComponents(resolvedPath: string): Promise<void> {
  const absolute = path.resolve(resolvedPath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw unsafePath(current, "a state path component is a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isSameOrAncestor(
  candidate: string,
  target: string,
  api: typeof path.posix | typeof path.win32,
  caseInsensitive: boolean,
): boolean {
  const normalizedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normalizedTarget = caseInsensitive ? target.toLowerCase() : target;
  if (normalizedCandidate === normalizedTarget) return true;
  const relative = api.relative(normalizedCandidate, normalizedTarget);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}

function samePath(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function unsafePath(input: string, reason: string): TryStateError {
  return new TryStateError("UNSAFE_TRY_STATE_PATH", `Refusing unsafe Synapsor try state path '${input}': ${reason}`);
}

export class TryStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TryStateError";
  }
}
