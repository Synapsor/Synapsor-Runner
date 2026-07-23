import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import runnerPackage from "../package.json" with { type: "json" };

const markerVersion = "synapsor.cursor-project.v1" as const;
const serverName = "synapsor";

type JsonRecord = Record<string, unknown>;

export type CursorProjectPaths = {
  projectRoot: string;
  destination: string;
  marker: string;
  configArgument: string;
  storeArgument: string;
};

export type CursorProjectStatus = {
  state: "not_installed" | "installed" | "unowned" | "tampered";
  paths: CursorProjectPaths;
  entry?: JsonRecord;
  message: string;
};

export type CursorProjectPreview = CursorProjectStatus & {
  action: "install" | "update" | "unchanged";
  merged: JsonRecord;
};

type CursorInstallMarker = {
  schema_version: typeof markerVersion;
  server_name: typeof serverName;
  destination: ".cursor/mcp.json";
  entry_digest: `sha256:${string}`;
  config_path: string;
  store_path: string;
  installed_at: string;
};

export async function previewCursorProjectInstall(input: {
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
} = {}): Promise<CursorProjectPreview> {
  const paths = await resolveInstallPaths(input);
  const existing = await readOptionalJson(paths.destination);
  const marker = await readMarker(paths.marker);
  const entry = cursorEntry(paths.configArgument, paths.storeArgument, input.packageSpec, input.authoring === true);
  assertSecretFree(entry);
  if (existing?.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
    throw new Error(`${displayPath(paths.projectRoot, paths.destination)} must contain an object at mcpServers.`);
  }
  const existingServers = isRecord(existing?.mcpServers) ? existing.mcpServers : {};
  const existingEntry = isRecord(existingServers[serverName]) ? existingServers[serverName] : undefined;

  if (marker && !existingEntry) {
    throw new Error(`Runner ownership marker exists, but the Cursor ${serverName} MCP entry is missing. Review the files manually.`);
  }
  if (existingEntry && !marker) {
    if (!deepEqual(existingEntry, entry)) {
      throw new Error(`Cursor project already has an unowned ${serverName} MCP entry at ${displayPath(paths.projectRoot, paths.destination)}. Rename it or remove it explicitly before installing.`);
    }
    throw new Error(`Cursor project has a matching but unowned ${serverName} MCP entry. Remove it explicitly or restore ${displayPath(paths.projectRoot, paths.marker)} before Runner manages it.`);
  }
  if (existingEntry && marker && digest(existingEntry) !== marker.entry_digest) {
    throw new Error(`Cursor ${serverName} MCP entry changed after Runner installed it. Refusing to overwrite user edits; review ${displayPath(paths.projectRoot, paths.destination)}.`);
  }

  const merged = {
    ...(existing ?? {}),
    mcpServers: { ...existingServers, [serverName]: entry },
  };
  const unchanged = Boolean(existingEntry && marker && deepEqual(existingEntry, entry));
  return {
    state: unchanged ? "installed" : existingEntry ? "installed" : "not_installed",
    paths,
    entry,
    message: unchanged ? "Cursor project MCP entry already matches the reviewed Runner wiring." : "Cursor project MCP entry is ready to install.",
    action: unchanged ? "unchanged" : existingEntry ? "update" : "install",
    merged,
  };
}

export async function installCursorProject(input: {
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
  now?: string;
} = {}): Promise<CursorProjectPreview & { backup?: string }> {
  const preview = await previewCursorProjectInstall(input);
  if (preview.action === "unchanged") return preview;
  const hadDestination = await pathExists(preview.paths.destination);
  const backup = hadDestination ? await backupFile(preview.paths.destination, input.now) : undefined;
  const marker: CursorInstallMarker = {
    schema_version: markerVersion,
    server_name: serverName,
    destination: ".cursor/mcp.json",
    entry_digest: digest(preview.entry),
    config_path: preview.paths.configArgument,
    store_path: preview.paths.storeArgument,
    installed_at: input.now ?? new Date().toISOString(),
  };
  await writeJsonAtomic(preview.paths.destination, preview.merged);
  try {
    await writeJsonAtomic(preview.paths.marker, marker);
  } catch (error) {
    if (backup) await fs.copyFile(backup, preview.paths.destination);
    else await fs.rm(preview.paths.destination, { force: true });
    throw error;
  }
  return { ...preview, state: "installed", ...(backup ? { backup } : {}) };
}

export async function uninstallCursorProject(input: {
  projectRoot?: string;
  now?: string;
} = {}): Promise<{ changed: boolean; paths: CursorProjectPaths; backup?: string }> {
  const base = await resolveBasePaths(input.projectRoot);
  const existing = await readOptionalJson(base.destination);
  const marker = await readMarker(base.marker);
  const paths = marker ? await pathsFromMarker(base, marker) : defaultPaths(base);
  if (!existing && !marker) return { changed: false, paths };
  if (!marker) throw new Error(`Refusing to uninstall an unowned Cursor ${serverName} entry without ${displayPath(paths.projectRoot, paths.marker)}.`);
  if (existing?.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
    throw new Error(`${displayPath(paths.projectRoot, paths.destination)} must contain an object at mcpServers.`);
  }
  const servers = isRecord(existing?.mcpServers) ? existing.mcpServers : {};
  const entry = isRecord(servers[serverName]) ? servers[serverName] : undefined;
  if (!entry) throw new Error(`Runner ownership marker exists, but Cursor ${serverName} entry is missing. Review the files manually.`);
  if (digest(entry) !== marker.entry_digest) {
    throw new Error(`Cursor ${serverName} entry changed after installation. Refusing to remove user edits.`);
  }
  const remainingServers = { ...servers };
  delete remainingServers[serverName];
  const updated: JsonRecord = { ...existing, mcpServers: remainingServers };
  const backup = await backupFile(paths.destination, input.now);
  await writeJsonAtomic(paths.destination, updated);
  await fs.rm(paths.marker, { force: true });
  return { changed: true, paths, backup };
}

export async function cursorProjectStatus(projectRoot = process.cwd()): Promise<CursorProjectStatus> {
  const base = await resolveBasePaths(projectRoot);
  const existing = await readOptionalJson(base.destination);
  const marker = await readMarker(base.marker);
  const paths = marker ? await pathsFromMarker(base, marker) : defaultPaths(base);
  if (existing?.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
    return { state: "tampered", paths, message: "Cursor mcpServers is not a JSON object." };
  }
  const servers = isRecord(existing?.mcpServers) ? existing.mcpServers : {};
  const entry = isRecord(servers[serverName]) ? servers[serverName] : undefined;
  if (!entry && !marker) return { state: "not_installed", paths, message: "No Runner-owned Cursor project entry is installed." };
  if (!entry || !marker) return { state: "unowned", paths, ...(entry ? { entry } : {}), message: "Cursor entry and Runner ownership marker do not agree." };
  if (digest(entry) !== marker.entry_digest) return { state: "tampered", paths, entry, message: "Cursor entry changed after Runner installation." };
  return { state: "installed", paths, entry, message: "Runner-owned Cursor project entry is intact." };
}

type CursorBasePaths = Pick<CursorProjectPaths, "projectRoot" | "destination" | "marker">;

async function resolveInstallPaths(input: {
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  authoring?: boolean;
}): Promise<CursorProjectPaths> {
  const base = await resolveBasePaths(input.projectRoot);
  const config = resolveContained(base.projectRoot, input.configPath ?? "./synapsor.runner.json", "Runner config");
  const store = resolveContained(base.projectRoot, input.storePath ?? "./.synapsor/local.db", "Runner store");
  await rejectSymlinkChain(base.projectRoot, config, "Runner config");
  await rejectSymlinkChain(base.projectRoot, store, "Runner store");
  if (!input.authoring) await requireRegularFile(config, "Runner config");
  return {
    ...base,
    configArgument: projectArgument(base.projectRoot, config),
    storeArgument: projectArgument(base.projectRoot, store),
  };
}

async function resolveBasePaths(projectRootInput?: string): Promise<CursorBasePaths> {
  const projectRoot = path.resolve(projectRootInput ?? process.cwd());
  await requireRealDirectory(projectRoot, "Cursor project root");
  const destination = path.join(projectRoot, ".cursor/mcp.json");
  const marker = path.join(projectRoot, ".synapsor/cursor-project.json");
  await rejectSymlinkChain(projectRoot, destination, "Cursor project config");
  await rejectSymlinkChain(projectRoot, marker, "Cursor ownership marker");
  return { projectRoot, destination, marker };
}

function defaultPaths(base: CursorBasePaths): CursorProjectPaths {
  return {
    ...base,
    configArgument: "./synapsor.runner.json",
    storeArgument: "./.synapsor/local.db",
  };
}

async function pathsFromMarker(base: CursorBasePaths, marker: CursorInstallMarker): Promise<CursorProjectPaths> {
  const config = resolveContained(base.projectRoot, marker.config_path, "Recorded Runner config");
  const store = resolveContained(base.projectRoot, marker.store_path, "Recorded Runner store");
  await rejectSymlinkChain(base.projectRoot, config, "Recorded Runner config");
  await rejectSymlinkChain(base.projectRoot, store, "Recorded Runner store");
  return {
    ...base,
    configArgument: projectArgument(base.projectRoot, config),
    storeArgument: projectArgument(base.projectRoot, store),
  };
}

function cursorEntry(
  configPath: string,
  storePath: string,
  packageSpec: string | undefined,
  authoring: boolean,
): JsonRecord {
  const resolvedPackage = packageSpec ?? `@synapsor/runner@${runnerPackage.version}`;
  if (!resolvedPackage.trim() || resolvedPackage.length > 2_048 || /[\u0000-\u001f\u007f]/.test(resolvedPackage)) {
    throw new Error("Cursor Runner package spec must be a non-empty package reference without control characters");
  }
  return {
    type: "stdio",
    command: "npx",
    args: authoring
      ? ["-y", "-p", resolvedPackage, "synapsor-runner", "mcp", "serve", "--authoring", "--project-root", "."]
      : ["-y", "-p", resolvedPackage, "synapsor-runner", "mcp", "serve", "--config", configPath, "--store", storePath],
  };
}

function resolveContained(root: string, value: string, label: string): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} must stay inside the project for project-scoped Cursor installation: ${value}`);
}

function projectArgument(root: string, value: string): string {
  const relative = path.relative(root, value).split(path.sep).join("/");
  return `./${relative}`;
}

async function requireRealDirectory(value: string, label: string): Promise<void> {
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${value}`);
}

async function requireRegularFile(value: string, label: string): Promise<void> {
  const stat = await fs.lstat(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${value}`);
}

async function rejectSymlinkChain(root: string, value: string, label: string): Promise<void> {
  const relative = path.relative(root, value);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readOptionalJson(value: string): Promise<JsonRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(value, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${value} must contain a JSON object`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readMarker(value: string): Promise<CursorInstallMarker | undefined> {
  const parsed = await readOptionalJson(value);
  if (!parsed) return undefined;
  if (
    parsed.schema_version !== markerVersion
    || parsed.server_name !== serverName
    || parsed.destination !== ".cursor/mcp.json"
    || typeof parsed.entry_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.entry_digest)
    || typeof parsed.config_path !== "string"
    || typeof parsed.store_path !== "string"
    || typeof parsed.installed_at !== "string"
  ) {
    throw new Error(`Invalid Cursor ownership marker: ${value}`);
  }
  return {
    schema_version: markerVersion,
    server_name: serverName,
    destination: ".cursor/mcp.json",
    entry_digest: parsed.entry_digest as `sha256:${string}`,
    config_path: parsed.config_path,
    store_path: parsed.store_path,
    installed_at: parsed.installed_at,
  };
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function backupFile(value: string, now = new Date().toISOString()): Promise<string> {
  const stem = `${value}.bak.${now.replace(/[:.]/g, "-")}`;
  let backup = stem;
  let counter = 1;
  while (await pathExists(backup)) backup = `${stem}.${counter++}`;
  await fs.copyFile(value, backup);
  return backup;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function assertSecretFree(value: unknown): void {
  const text = JSON.stringify(value);
  if (/postgres(?:ql)?:\/\/|mysql:\/\/|password|bearer\s+[a-z0-9._~+/=-]+|syn_wbr_|api[_-]?key/i.test(text)) {
    throw new Error("Cursor MCP configuration must contain command paths only, never credentials or database URLs");
  }
}

function displayPath(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/") || ".";
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
