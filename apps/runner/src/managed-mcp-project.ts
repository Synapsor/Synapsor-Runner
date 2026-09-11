import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import runnerPackage from "../package.json" with { type: "json" };

const managedServerNames = {
  explore: "synapsor",
  actions: "synapsor-actions",
} as const;

export type ManagedMcpProjectEntryKind = keyof typeof managedServerNames;
type ManagedMcpProjectServerName = typeof managedServerNames[ManagedMcpProjectEntryKind];

type JsonRecord = Record<string, unknown>;

export type ManagedMcpProjectClient = "cursor" | "claude-code" | "vscode";

type ManagedMcpProjectDefinition = {
  client: ManagedMcpProjectClient;
  displayName: string;
  destination: string;
  marker: string;
  markerVersion: string;
  serversKey: "mcpServers" | "servers";
  reloadInstruction: string;
};

const managedClients: Record<ManagedMcpProjectClient, ManagedMcpProjectDefinition> = {
  cursor: {
    client: "cursor",
    displayName: "Cursor",
    destination: ".cursor/mcp.json",
    marker: ".synapsor/cursor-project.json",
    markerVersion: "synapsor.cursor-project.v1",
    serversKey: "mcpServers",
    reloadInstruction: "Restart or reload Cursor",
  },
  "claude-code": {
    client: "claude-code",
    displayName: "Claude Code",
    destination: ".mcp.json",
    marker: ".synapsor/claude-code-project.json",
    markerVersion: "synapsor.claude-code-project.v1",
    serversKey: "mcpServers",
    reloadInstruction: "Restart Claude Code or begin a new project session, then approve the project MCP server when Claude Code prompts",
  },
  vscode: {
    client: "vscode",
    displayName: "VS Code",
    destination: ".vscode/mcp.json",
    marker: ".synapsor/vscode-project.json",
    markerVersion: "synapsor.vscode-project.v1",
    serversKey: "servers",
    reloadInstruction: "Reload the VS Code window and start the Synapsor MCP server",
  },
};

const managedClientCommands: Record<ManagedMcpProjectClient, string[]> = {
  cursor: ["cursor"],
  "claude-code": ["claude"],
  vscode: ["code", "code-insiders"],
};

export type ManagedMcpProjectPaths = {
  client: ManagedMcpProjectClient;
  entryKind: ManagedMcpProjectEntryKind;
  serverName: ManagedMcpProjectServerName;
  projectRoot: string;
  destination: string;
  marker: string;
  configArgument: string;
  storeArgument: string;
};

export type ManagedMcpProjectStatus = {
  state: "not_installed" | "installed" | "unowned" | "tampered";
  paths: ManagedMcpProjectPaths;
  entry?: JsonRecord;
  message: string;
};

export type ManagedMcpProjectPreview = ManagedMcpProjectStatus & {
  action: "install" | "update" | "unchanged";
  merged: JsonRecord;
  updatedDocument: string;
};

type ManagedInstallMarker = {
  schema_version: string;
  server_name: ManagedMcpProjectServerName;
  destination: string;
  entry_digest: `sha256:${string}`;
  config_path: string;
  store_path: string;
  installed_at: string;
};

type JsonDocument = {
  value: JsonRecord;
  text: string;
};

export function parseManagedMcpProjectClient(value: string | undefined): ManagedMcpProjectClient {
  if (value === "cursor") return "cursor";
  if (value === "claude-code" || value === "claude") return "claude-code";
  if (value === "vscode" || value === "vs-code") return "vscode";
  throw new Error("managed MCP project client must be cursor, claude-code, or vscode");
}

export function managedMcpProjectDefinition(client: ManagedMcpProjectClient): Readonly<ManagedMcpProjectDefinition> {
  return managedClients[client];
}

export async function detectManagedMcpClientCommand(
  client: ManagedMcpProjectClient,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const directories = pathValue.split(platform === "win32" ? ";" : path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const command of managedClientCommands[client]) {
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${command}${extension}`);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) return command;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return undefined;
}

export async function previewManagedMcpProjectInstall(input: {
  client: ManagedMcpProjectClient;
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
  entryKind?: ManagedMcpProjectEntryKind;
}): Promise<ManagedMcpProjectPreview> {
  const definition = managedClients[input.client];
  const paths = await resolveInstallPaths(input, definition);
  const existing = await readOptionalJsonDocument(paths.destination);
  const marker = await readMarker(paths.marker, definition, paths.serverName);
  const entry = await managedEntry(paths.configArgument, paths.storeArgument, input.packageSpec, input.authoring === true);
  assertSecretFree(entry, definition);
  const existingServersValue = existing?.value[definition.serversKey];
  if (existingServersValue !== undefined && !isRecord(existingServersValue)) {
    throw new Error(`${displayPath(paths.projectRoot, paths.destination)} must contain an object at ${definition.serversKey}.`);
  }
  const existingServers = isRecord(existingServersValue) ? existingServersValue : {};
  const existingEntryValue = existingServers[paths.serverName];
  const existingEntry = isRecord(existingEntryValue) ? existingEntryValue : undefined;

  if (marker && !existingEntry) {
    throw new Error(`Runner ownership marker exists, but the ${definition.displayName} ${paths.serverName} MCP entry is missing. Review the files manually.`);
  }
  if (existingEntry && !marker) {
    if (!deepEqual(existingEntry, entry)) {
      throw new Error(`${definition.displayName} project already has an unowned ${paths.serverName} MCP entry at ${displayPath(paths.projectRoot, paths.destination)}. Rename it or remove it explicitly before installing.`);
    }
    throw new Error(`${definition.displayName} project has a matching but unowned ${paths.serverName} MCP entry. Remove it explicitly or restore ${displayPath(paths.projectRoot, paths.marker)} before Runner manages it.`);
  }
  if (existingEntry && marker && digest(existingEntry) !== marker.entry_digest) {
    throw new Error(`${definition.displayName} ${paths.serverName} MCP entry changed after Runner installed it. Refusing to overwrite user edits; review ${displayPath(paths.projectRoot, paths.destination)}.`);
  }

  const merged = {
    ...(existing?.value ?? {}),
    [definition.serversKey]: { ...existingServers, [paths.serverName]: entry },
  };
  const unchanged = Boolean(existingEntry && marker && deepEqual(existingEntry, entry));
  return {
    state: unchanged ? "installed" : existingEntry ? "installed" : "not_installed",
    paths,
    entry,
    message: unchanged
      ? `${definition.displayName} project MCP entry already matches the reviewed Runner wiring.`
      : `${definition.displayName} project MCP entry is ready to install.`,
    action: unchanged ? "unchanged" : existingEntry ? "update" : "install",
    merged,
    updatedDocument: setManagedEntry(existing?.text, definition, paths.serverName, entry),
  };
}

export async function installManagedMcpProject(input: {
  client: ManagedMcpProjectClient;
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
  entryKind?: ManagedMcpProjectEntryKind;
  now?: string;
}): Promise<ManagedMcpProjectPreview & { backup?: string }> {
  const definition = managedClients[input.client];
  const preview = await previewManagedMcpProjectInstall(input);
  if (preview.action === "unchanged") return preview;
  const hadDestination = await pathExists(preview.paths.destination);
  const backup = hadDestination ? await backupFile(preview.paths.destination, input.now) : undefined;
  const marker: ManagedInstallMarker = {
    schema_version: definition.markerVersion,
    server_name: preview.paths.serverName,
    destination: definition.destination,
    entry_digest: digest(preview.entry),
    config_path: preview.paths.configArgument,
    store_path: preview.paths.storeArgument,
    installed_at: input.now ?? new Date().toISOString(),
  };
  await writeTextAtomic(preview.paths.destination, preview.updatedDocument);
  try {
    await writeJsonAtomic(preview.paths.marker, marker);
  } catch (error) {
    if (backup) await fs.copyFile(backup, preview.paths.destination);
    else await fs.rm(preview.paths.destination, { force: true });
    throw error;
  }
  return { ...preview, state: "installed", ...(backup ? { backup } : {}) };
}

export async function installManagedMcpProjectSet(input: {
  client: ManagedMcpProjectClient;
  projectRoot?: string;
  entries: Array<{
    configPath?: string;
    storePath?: string;
    packageSpec?: string;
    authoring?: boolean;
    entryKind: ManagedMcpProjectEntryKind;
  }>;
  now?: string;
  removeEntryKinds?: ManagedMcpProjectEntryKind[];
}): Promise<{ previews: ManagedMcpProjectPreview[]; backup?: string }> {
  if (input.entries.length === 0) throw new Error("Managed MCP project install set requires at least one entry");
  const entryKinds = input.entries.map((entry) => entry.entryKind);
  if (new Set(entryKinds).size !== entryKinds.length) {
    throw new Error("Managed MCP project install set contains a duplicate entry kind");
  }
  const definition = managedClients[input.client];
  const previews = [];
  for (const entry of input.entries) {
    previews.push(await previewManagedMcpProjectInstall({
      client: input.client,
      projectRoot: input.projectRoot,
      ...entry,
    }));
  }
  const destination = previews[0]!.paths.destination;
  if (previews.some((preview) => preview.paths.destination !== destination)) {
    throw new Error("Managed MCP project entries must share one project client configuration");
  }
  const changed = previews.filter((preview) => preview.action !== "unchanged");
  const removals: ManagedMcpProjectStatus[] = [];
  for (const kind of input.removeEntryKinds ?? []) {
    if (entryKinds.includes(kind)) throw new Error("Cannot install and remove the same managed entry.");
    const status = await managedMcpProjectStatus(input.client, input.projectRoot, kind);
    if (status.state === "not_installed") continue;
    if (status.state !== "installed") throw new Error("Refusing to replace an unowned or changed companion MCP entry.");
    removals.push(status);
  }
  if (changed.length === 0 && removals.length === 0) return { previews };

  const existing = await readOptionalJsonDocument(destination);
  let updatedDocument = existing?.text ?? "{}\n";
  for (const removal of removals) {
    updatedDocument = applyEdits(updatedDocument, modify(updatedDocument,
      [definition.serversKey, removal.paths.serverName], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  for (const preview of changed) {
    updatedDocument = setManagedEntry(
      updatedDocument,
      definition,
      preview.paths.serverName,
      preview.entry!,
    );
  }
  const backup = existing ? await backupFile(destination, input.now) : undefined;
  const priorMarkers = new Map<string, string | undefined>();
  for (const preview of [...changed, ...removals]) {
    priorMarkers.set(preview.paths.marker, await readOptionalText(preview.paths.marker));
  }
  try {
    await writeTextAtomic(destination, updatedDocument);
    for (const removal of removals) await fs.rm(removal.paths.marker, { force: true });
    for (const preview of changed) {
      const marker: ManagedInstallMarker = {
        schema_version: definition.markerVersion,
        server_name: preview.paths.serverName,
        destination: definition.destination,
        entry_digest: digest(preview.entry),
        config_path: preview.paths.configArgument,
        store_path: preview.paths.storeArgument,
        installed_at: input.now ?? new Date().toISOString(),
      };
      await writeJsonAtomic(preview.paths.marker, marker);
    }
  } catch (error) {
    if (backup) await fs.copyFile(backup, destination);
    else await fs.rm(destination, { force: true });
    for (const [markerPath, previous] of priorMarkers) {
      if (previous === undefined) await fs.rm(markerPath, { force: true });
      else await writeTextAtomic(markerPath, previous);
    }
    throw error;
  }
  return {
    previews: previews.map((preview) => ({ ...preview, state: "installed" })),
    ...(backup ? { backup } : {}),
  };
}

export async function uninstallManagedMcpProject(input: {
  client: ManagedMcpProjectClient;
  projectRoot?: string;
  entryKind?: ManagedMcpProjectEntryKind;
  now?: string;
}): Promise<{ changed: boolean; paths: ManagedMcpProjectPaths; backup?: string }> {
  const definition = managedClients[input.client];
  const base = await resolveBasePaths(input.projectRoot, definition, input.entryKind);
  const existing = await readOptionalJsonDocument(base.destination);
  const marker = await readMarker(base.marker, definition, base.serverName);
  const paths = marker ? await pathsFromMarker(base, marker, definition) : defaultPaths(base);
  if (!existing && !marker) return { changed: false, paths };
  if (!marker) {
    throw new Error(`Refusing to uninstall an unowned ${definition.displayName} ${paths.serverName} entry without ${displayPath(paths.projectRoot, paths.marker)}.`);
  }
  const serversValue = existing?.value[definition.serversKey];
  if (serversValue !== undefined && !isRecord(serversValue)) {
    throw new Error(`${displayPath(paths.projectRoot, paths.destination)} must contain an object at ${definition.serversKey}.`);
  }
  const servers = isRecord(serversValue) ? serversValue : {};
  const entryValue = servers[paths.serverName];
  const entry = isRecord(entryValue) ? entryValue : undefined;
  if (!entry) {
    throw new Error(`Runner ownership marker exists, but ${definition.displayName} ${paths.serverName} entry is missing. Review the files manually.`);
  }
  if (digest(entry) !== marker.entry_digest) {
    throw new Error(`${definition.displayName} ${paths.serverName} entry changed after installation. Refusing to remove user edits.`);
  }
  const backup = await backupFile(paths.destination, input.now);
  const updatedDocument = removeManagedEntry(existing?.text ?? "{}\n", definition, paths.serverName);
  await writeTextAtomic(paths.destination, updatedDocument);
  await fs.rm(paths.marker, { force: true });
  return { changed: true, paths, backup };
}

export async function managedMcpProjectStatus(
  client: ManagedMcpProjectClient,
  projectRoot = process.cwd(),
  entryKind: ManagedMcpProjectEntryKind = "explore",
): Promise<ManagedMcpProjectStatus> {
  const definition = managedClients[client];
  const base = await resolveBasePaths(projectRoot, definition, entryKind);
  const existing = await readOptionalJsonDocument(base.destination);
  const marker = await readMarker(base.marker, definition, base.serverName);
  const paths = marker ? await pathsFromMarker(base, marker, definition) : defaultPaths(base);
  const serversValue = existing?.value[definition.serversKey];
  if (serversValue !== undefined && !isRecord(serversValue)) {
    return { state: "tampered", paths, message: `${definition.displayName} ${definition.serversKey} is not a JSON object.` };
  }
  const servers = isRecord(serversValue) ? serversValue : {};
  const entryValue = servers[paths.serverName];
  const entry = isRecord(entryValue) ? entryValue : undefined;
  if (!entry && !marker) {
    return { state: "not_installed", paths, message: `No Runner-owned ${definition.displayName} project entry is installed.` };
  }
  if (!entry || !marker) {
    return {
      state: "unowned",
      paths,
      ...(entry ? { entry } : {}),
      message: `${definition.displayName} entry and Runner ownership marker do not agree.`,
    };
  }
  if (digest(entry) !== marker.entry_digest) {
    return {
      state: "tampered",
      paths,
      entry,
      message: `${definition.displayName} entry changed after Runner installation.`,
    };
  }
  return {
    state: "installed",
    paths,
    entry,
    message: `Runner-owned ${definition.displayName} project entry is intact.`,
  };
}

type ManagedBasePaths = Pick<
  ManagedMcpProjectPaths,
  "client" | "entryKind" | "serverName" | "projectRoot" | "destination" | "marker"
>;

async function resolveInstallPaths(
  input: {
    client: ManagedMcpProjectClient;
    projectRoot?: string;
    configPath?: string;
    storePath?: string;
    authoring?: boolean;
    entryKind?: ManagedMcpProjectEntryKind;
  },
  definition: ManagedMcpProjectDefinition,
): Promise<ManagedMcpProjectPaths> {
  const base = await resolveBasePaths(input.projectRoot, definition, input.entryKind);
  const config = resolveContained(base.projectRoot, input.configPath ?? "./synapsor.runner.json", "Runner config", definition);
  const store = resolveContained(base.projectRoot, input.storePath ?? "./.synapsor/local.db", "Runner store", definition);
  await rejectSymlinkChain(base.projectRoot, config, "Runner config");
  await rejectSymlinkChain(base.projectRoot, store, "Runner store");
  if (!input.authoring) await requireRegularFile(config, "Runner config");
  return {
    ...base,
    configArgument: projectArgument(base.projectRoot, config),
    storeArgument: projectArgument(base.projectRoot, store),
  };
}

async function resolveBasePaths(
  projectRootInput: string | undefined,
  definition: ManagedMcpProjectDefinition,
  entryKind: ManagedMcpProjectEntryKind = "explore",
): Promise<ManagedBasePaths> {
  const projectRoot = path.resolve(projectRootInput ?? process.cwd());
  await requireRealDirectory(projectRoot, `${definition.displayName} project root`);
  const destination = path.join(projectRoot, definition.destination);
  const marker = path.join(projectRoot, entryKind === "explore"
    ? definition.marker
    : definition.marker.replace(/\.json$/u, "-actions.json"));
  const serverName = managedServerNames[entryKind];
  await rejectSymlinkChain(projectRoot, destination, `${definition.displayName} project config`);
  await rejectSymlinkChain(projectRoot, marker, `${definition.displayName} ownership marker`);
  return {
    client: definition.client,
    entryKind,
    serverName,
    projectRoot,
    destination,
    marker,
  };
}

function defaultPaths(base: ManagedBasePaths): ManagedMcpProjectPaths {
  return {
    ...base,
    configArgument: "./synapsor.runner.json",
    storeArgument: "./.synapsor/local.db",
  };
}

async function pathsFromMarker(
  base: ManagedBasePaths,
  marker: ManagedInstallMarker,
  definition: ManagedMcpProjectDefinition,
): Promise<ManagedMcpProjectPaths> {
  const config = resolveContained(base.projectRoot, marker.config_path, "Recorded Runner config", definition);
  const store = resolveContained(base.projectRoot, marker.store_path, "Recorded Runner store", definition);
  await rejectSymlinkChain(base.projectRoot, config, "Recorded Runner config");
  await rejectSymlinkChain(base.projectRoot, store, "Recorded Runner store");
  return {
    ...base,
    configArgument: projectArgument(base.projectRoot, config),
    storeArgument: projectArgument(base.projectRoot, store),
  };
}

export async function resolveManagedMcpLauncher(
  packageSpec?: string,
  bundleUrl = new URL("./runner.mjs", import.meta.url),
): Promise<{ command: string; args: string[] }> {
  if (packageSpec === undefined) {
    // Reuse the installed build, including local tarball/unpublished releases.
    // Never make a working local installation depend on another registry fetch.
    try {
      const bundle = await fs.realpath(fileURLToPath(bundleUrl));
      if ((await fs.stat(bundle)).isFile()) return { command: process.execPath, args: [bundle] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const resolvedPackage = packageSpec ?? `@synapsor/runner@${runnerPackage.version}`;
  if (!resolvedPackage.trim() || resolvedPackage.length > 2_048 || /[\u0000-\u001f\u007f]/.test(resolvedPackage)) {
    throw new Error("Runner package spec must be a non-empty package reference without control characters");
  }
  return { command: "npx", args: ["-y", resolvedPackage] };
}

async function managedEntry(
  configPath: string,
  storePath: string,
  packageSpec: string | undefined,
  authoring: boolean,
): Promise<JsonRecord> {
  const launcher = await resolveManagedMcpLauncher(packageSpec);
  return {
    type: "stdio",
    command: launcher.command,
    args: authoring
      ? [
        ...launcher.args,
        "mcp",
        "serve",
        "--authoring",
        "--project-root",
        path.posix.dirname(configPath),
        "--config",
        configPath,
        "--local-test-runtime",
        ".synapsor/local-test-runtime.json",
      ]
      : [...launcher.args, "mcp", "serve", "--config", configPath, "--store", storePath],
  };
}

function setManagedEntry(
  existingText: string | undefined,
  definition: ManagedMcpProjectDefinition,
  serverName: ManagedMcpProjectServerName,
  entry: JsonRecord,
): string {
  const source = existingText ?? "{}\n";
  const edits = modify(source, [definition.serversKey, serverName], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return finalNewline(applyEdits(source, edits));
}

function removeManagedEntry(
  existingText: string,
  definition: ManagedMcpProjectDefinition,
  serverName: ManagedMcpProjectServerName,
): string {
  const edits = modify(existingText, [definition.serversKey, serverName], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return finalNewline(applyEdits(existingText, edits));
}

function resolveContained(
  root: string,
  value: string,
  label: string,
  definition: ManagedMcpProjectDefinition,
): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} must stay inside the project for project-scoped ${definition.displayName} installation: ${value}`);
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

async function readOptionalJsonDocument(value: string): Promise<JsonDocument | undefined> {
  try {
    const text = await fs.readFile(value, "utf8");
    const errors: ParseError[] = [];
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const first = errors[0]!;
      throw new Error(`${value} contains invalid JSON/JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`);
    }
    if (!isRecord(parsed)) throw new Error(`${value} must contain a JSON object`);
    return { value: parsed, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalText(value: string): Promise<string | undefined> {
  try {
    return await fs.readFile(value, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readMarker(
  value: string,
  definition: ManagedMcpProjectDefinition,
  serverName: ManagedMcpProjectServerName,
): Promise<ManagedInstallMarker | undefined> {
  const document = await readOptionalJsonDocument(value);
  const parsed = document?.value;
  if (!parsed) return undefined;
  if (
    parsed.schema_version !== definition.markerVersion
    || parsed.server_name !== serverName
    || parsed.destination !== definition.destination
    || typeof parsed.entry_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.entry_digest)
    || typeof parsed.config_path !== "string"
    || typeof parsed.store_path !== "string"
    || typeof parsed.installed_at !== "string"
  ) {
    throw new Error(`Invalid ${definition.displayName} ownership marker: ${value}`);
  }
  return {
    schema_version: definition.markerVersion,
    server_name: serverName,
    destination: definition.destination,
    entry_digest: parsed.entry_digest as `sha256:${string}`,
    config_path: parsed.config_path,
    store_path: parsed.store_path,
    installed_at: parsed.installed_at,
  };
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  await writeTextAtomic(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(destination: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
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

function assertSecretFree(value: unknown, definition: ManagedMcpProjectDefinition): void {
  const text = JSON.stringify(value);
  if (/postgres(?:ql)?:\/\/|mysql:\/\/|password|bearer\s+[a-z0-9._~+/=-]+|syn_wbr_|api[_-]?key/i.test(text)) {
    throw new Error(`${definition.displayName} MCP configuration must contain command paths only, never credentials or database URLs`);
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

function finalNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
