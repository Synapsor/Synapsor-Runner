import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { activeProjectResolutionState, runnerConfigPath, resolvedRuntimeStorePath, resolvedLocalStorePath } from "./cli-project.js";
import { normalizeCliArgv, optionalArg } from "./cli-options.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { inspectProjectControlPolicyTargets } from "./control-policy-store.js";

type Destination = { role: string; kind: "sqlite"; path: string }
  | { role: string; kind: "postgres"; url_env: string; schema: string };
export type QualificationStorageInspection = {
  config_path: string;
  project_roots: string[];
  destinations: Destination[];
};

/** Test-only preflight, never an authority/migration API. Uses the same CLI
 * selection and immutable migration parser, without opening a database. */
export async function inspectQualificationStorage(args: string[]): Promise<QualificationStorageInspection> {
  if (args.includes("--secrets-provider")) throw refused("Resolve managed secrets before entering the isolated test environment.");
  const previous = activeProjectResolutionState.current;
  try {
    const [command, subcommand] = normalizeCliArgv(args);
    // Fresh setup does not inherit cli.ts's runtime project discovery. Looking
    // up a parent here can falsely reject an otherwise isolated empty project.
    const freshSetup = command === "start" || (command === "onboard" && subcommand === "db");
    activeProjectResolutionState.current = optionalArg(args, "--config") || freshSetup ? undefined
      : await resolveSynapsorProject(process.cwd(), process.env);
    const configPath = path.resolve(runnerConfigPath(args));
    let config: RuntimeConfig = {} as RuntimeConfig;
    try { config = resolveRuntimeConfig(JSON.parse(await fs.readFile(configPath, "utf8")), path.dirname(configPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const roots = [...new Set([
      path.resolve(optionalArg(args, "--project-root") ?? activeProjectResolutionState.current?.project_root ?? process.cwd()),
      config.action_rules?.project_root, config.production_explore?.project_root,
    ].filter((value): value is string => Boolean(value)).map(value => path.resolve(value)))];
    const storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
    const directStore = resolvedLocalStorePath(args);
    const destinations: Destination[] = [{ role: "direct CLI ledger", kind: "sqlite", path: directStore === ":memory:" ? directStore : path.resolve(directStore) }];
    for (const projectRoot of roots) {
      const targets = await inspectProjectControlPolicyTargets({ projectRoot, config, storePath });
      destinations.push({ role: `selected runtime at ${projectRoot}`, ...targets.selected });
      if (targets.bound) destinations.push({ role: `governed authoring at ${projectRoot}`, ...targets.bound });
    }
    const shared = config.storage?.shared_postgres;
    if (shared && shared.mode !== "disabled") {
      destinations.push({ role: `shared ${shared.mode}`, kind: "postgres", url_env: shared.url_env, schema: shared.schema ?? "synapsor_runner" });
    }
    return { config_path: configPath, project_roots: roots, destinations };
  } finally { activeProjectResolutionState.current = previous; }
}

export type QualificationOwnedMount = { logical: string; physical: string };

/** Verify inside the mount namespace: equal device/inode proves the logical
 * project resolves to the owned physical copy, not just a matching path string. */
export async function assertQualificationStorageOwned(input: {
  inspection: QualificationStorageInspection;
  mounts: QualificationOwnedMount[];
  ownedPostgresUrls?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!input.mounts.length) throw refused("No owned writable mount was declared.");
  const mounts = await Promise.all(input.mounts.map(async mount => {
    const logical = await fs.realpath(mount.logical), physical = await fs.realpath(mount.physical);
    const left = await fs.stat(logical), right = await fs.stat(physical);
    if (!left.isDirectory() || !right.isDirectory() || left.dev !== right.dev || left.ino !== right.ino) {
      throw refused("The logical project is not mounted from its owned test copy.");
    }
    return { logical, physical };
  }));
  const contained = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  async function checkPath(file: string): Promise<void> {
    if (file === ":memory:") throw refused("Qualification requires an owned persistent ledger.");
    const absolute = path.resolve(file);
    let existing = absolute;
    let suffix = "";
    while (true) {
      try {
        const canonical = path.join(await fs.realpath(existing), suffix);
        const mount = mounts.find(value => contained(value.logical, canonical));
        if (!mount) throw refused("A writable destination escapes the declared owned mounts.");
        const stat = await fs.stat(existing);
        if (stat.isFile() && stat.nlink !== 1) throw refused("A writable destination has shared hard links.");
        const physical = path.join(mount.physical, path.relative(mount.logical, await fs.realpath(existing)));
        const owner = await fs.stat(physical);
        if (stat.dev !== owner.dev || stat.ino !== owner.ino) throw refused("A destination does not resolve to its owned physical copy.");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const unresolved = await fs.lstat(existing).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined;
          throw cause;
        });
        if (unresolved?.isSymbolicLink()) throw refused("A writable destination has an unresolved symbolic link.");
        const parent = path.dirname(existing);
        if (parent === existing) throw refused("A destination has no verifiable owned parent.");
        suffix = path.join(path.basename(existing), suffix);
        existing = parent;
      }
    }
  }
  for (const file of [input.inspection.config_path, ...input.inspection.project_roots]) await checkPath(file);
  for (const destination of input.inspection.destinations) {
    if (destination.kind === "sqlite") {
      await checkPath(destination.path);
      for (const suffix of ["-wal", "-shm", "-journal", ".lease.json"]) await checkPath(destination.path + suffix);
    } else {
      const url = (input.env ?? process.env)[destination.url_env];
      // Exact test-owned credentials/endpoint, not hostname similarity or URL-env name.
      if (!url || !input.ownedPostgresUrls?.includes(url)) throw refused("A shared store does not select an explicitly owned test database.");
    }
  }
}

function refused(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
}
