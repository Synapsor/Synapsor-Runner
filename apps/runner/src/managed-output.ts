import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function assertSafeManagedOutputPath(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const repositoryRoot = await findRepositoryRoot(process.cwd());
  const protectedPaths = [
    path.parse(resolved).root,
    os.homedir(),
    process.cwd(),
    ...(repositoryRoot ? [repositoryRoot] : []),
  ].map((candidate) => path.resolve(candidate));

  for (const protectedPath of protectedPaths) {
    if (samePath(resolved, protectedPath)) {
      throw new Error(`refusing unsafe generated output path: ${resolved}`);
    }
    const relative = path.relative(resolved, protectedPath);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error(`refusing generated output path that contains a protected path: ${resolved}`);
    }
  }

  const symlink = await firstSymlinkComponent(resolved);
  if (symlink) throw new Error(`refusing generated output through symbolic link: ${symlink}`);
  if (await pathExists(path.join(resolved, ".git"))) {
    throw new Error(`refusing generated output at a Git repository root: ${resolved}`);
  }
  return resolved;
}

export async function readManagedOutputMarker(
  directory: string,
  markerName: string,
): Promise<Record<string, unknown>> {
  const resolved = await assertSafeManagedOutputPath(directory);
  const directoryStat = await fs.lstat(resolved);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`generated output is not a regular directory: ${resolved}`);
  }
  const real = await fs.realpath(resolved);
  if (!samePath(resolved, real)) {
    throw new Error(`generated output resolves outside its reviewed path: ${resolved}`);
  }

  const markerPath = path.join(resolved, markerName);
  const markerStat = await fs.lstat(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error(`generated output marker is not a regular file: ${markerPath}`);
  }
  return JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
}

async function firstSymlinkComponent(resolvedPath: string): Promise<string | undefined> {
  const parsed = path.parse(resolvedPath);
  const components = resolvedPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return undefined;
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
