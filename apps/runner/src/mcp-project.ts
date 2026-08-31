import path from "node:path";
import process from "node:process";
import { stableStringArray } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { confirmDangerousAction, readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import {
  installManagedMcpProjectSet,
  managedMcpProjectDefinition,
  managedMcpProjectStatus,
  parseManagedMcpProjectClient,
  previewManagedMcpProjectInstall,
  uninstallManagedMcpProject,
  type ManagedMcpProjectClient,
  type ManagedMcpProjectEntryKind,
  type ManagedMcpProjectPreview,
} from "./managed-mcp-project.js";
import { audit, fetchStdioMcpToolsCommand, mcpAuditToolNames } from "./mcp-audit.js";
import { isManagedAuthoringEntry } from "./mcp-project-domain.js";
import { defaultBlockedToolSurface, inspectMcpToolBoundary, mcpConfig, mcpConfigure, mcpServe, mcpServeHttp, mcpServeStreamableHttp, mcpSmoke } from "./mcp-runtime.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";


export async function mcp(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "serve") return mcpServe(rest);
  if (subcommand === "serve-http") {
    if (rest.includes("--authoring")) throw new Error("Scoped Explore is authoring-only and is never available over HTTP.");
    return mcpServeHttp(rest);
  }
  if (subcommand === "serve-streamable-http") {
    if (rest.includes("--authoring")) throw new Error("Scoped Explore is authoring-only and is never available over Streamable HTTP.");
    return mcpServeStreamableHttp(rest);
  }
  if (subcommand === "audit") return audit(rest);
  if (subcommand === "config") return mcpConfig(rest);
  if (subcommand === "client-config") return mcpConfigure(rest);
  if (subcommand === "configure") return mcpConfigure(rest);
  if (subcommand === "install") return mcpProjectInstall(rest);
  if (subcommand === "uninstall") return mcpProjectUninstall(rest);
  if (subcommand === "status") return mcpProjectStatus(rest);
  if (subcommand === "smoke") return mcpSmoke(rest);
  usage(["mcp"]);
  return 2;
}

type ManagedMcpInstallRuntime = {
  role: "read" | "action";
  entryKind: ManagedMcpProjectEntryKind;
  configPath: string;
  storePath: string;
  authoring: boolean;
  toolNames: string[];
  preview: ManagedMcpProjectPreview;
};


async function mcpProjectInstall(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  const definition = managedMcpProjectDefinition(client);
  assertKnownOptions(rest, new Set([
    "--project", "--project-root", "--config", "--store", "--authoring",
    "--include-actions", "--action-config", "--dry-run", "--yes", "--json",
  ]), `mcp install ${client}`);
  if (!rest.includes("--project")) {
    throw new Error(`mcp install ${client} requires --project so Runner changes only the current project's ${definition.destination}`);
  }
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const requestedAuthoring = rest.includes("--authoring");
  const includeActions = rest.includes("--include-actions");
  if (includeActions && !requestedAuthoring) {
    throw new Error("--include-actions requires --authoring so local Explore and proposal tools remain separate managed MCP runtimes");
  }
  if (!includeActions && optionalArg(rest, "--action-config")) {
    throw new Error("--action-config requires --include-actions");
  }
  const configPath = runnerConfigPath(rest, "./synapsor.runner.json");
  const storePath = resolvedLocalStorePath(rest);
  let authoring = requestedAuthoring;
  let toolNames: string[];
  if (requestedAuthoring) {
    const runtime = await createScopedExploreBoundarySetRuntime({
      projectRoot,
      transport: "stdio",
      env: process.env,
    });
    try {
      await runtime.describe({ limit: 10, include_time_coverage: false });
    } finally {
      await runtime.close();
    }
    toolNames = ["app.describe_data", "app.explore_data"];
  } else {
    const absoluteConfig = path.resolve(projectRoot, configPath);
    await readRuntimeConfig(absoluteConfig);
    const boundary = await inspectMcpToolBoundary(["--config", absoluteConfig, "--store", ":memory:"]);
    if (!boundary.ok) {
      throw new Error(`${definition.displayName} install refused because the reviewed model-facing boundary failed: ${boundary.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}`);
    }
    toolNames = boundary.names;
    if (boundary.surface === "local_explore") {
      authoring = true;
      const localExploreRoot = path.dirname(absoluteConfig);
      const runtime = await createScopedExploreBoundarySetRuntime({
        projectRoot: localExploreRoot,
        transport: "stdio",
        env: process.env,
      });
      try {
        await runtime.describe({ limit: 10, include_time_coverage: false });
      } finally {
        await runtime.close();
      }
    }
  }
  const preview = await previewManagedMcpProjectInstall({
    client,
    projectRoot,
    configPath,
    storePath,
    authoring,
    entryKind: "explore",
  });
  const runtimes: ManagedMcpInstallRuntime[] = [{
    role: "read",
    entryKind: "explore",
    configPath,
    storePath,
    authoring,
    toolNames,
    preview,
  }];
  if (includeActions) {
    const actionConfigPath = optionalArg(rest, "--action-config") ?? "./synapsor.actions.runner.json";
    const absoluteActionConfig = path.resolve(projectRoot, actionConfigPath);
    const actionConfig = await readRuntimeConfig(absoluteActionConfig);
    if (!actionConfig.action_boundary) {
      throw new Error(`${definition.displayName} Action install refused because ${actionConfigPath} has no active reviewed Action Boundary`);
    }
    const actionBoundary = await inspectMcpToolBoundary([
      "--config", absoluteActionConfig,
      "--store", ":memory:",
    ]);
    const nonProposalTools = actionBoundary.capabilityDetails
      .filter((detail) => detail.kind !== "proposal")
      .map((detail) => detail.name);
    if (!actionBoundary.ok || actionBoundary.names.length === 0 || nonProposalTools.length > 0) {
      const failures = [
        ...actionBoundary.checks.filter((check) => !check.ok).map((check) => check.name),
        ...(actionBoundary.names.length === 0 ? ["no active proposal tools"] : []),
        ...(nonProposalTools.length ? [`non-proposal tools present: ${nonProposalTools.join(", ")}`] : []),
      ];
      throw new Error(`${definition.displayName} Action install refused because the reviewed proposal boundary failed: ${failures.join(", ")}`);
    }
    const actionPreview = await previewManagedMcpProjectInstall({
      client,
      projectRoot,
      configPath: actionConfigPath,
      storePath,
      authoring: false,
      entryKind: "actions",
    });
    runtimes.push({
      role: "action",
      entryKind: "actions",
      configPath: actionConfigPath,
      storePath,
      authoring: false,
      toolNames: actionBoundary.names,
      preview: actionPreview,
    });
  }
  const reports = runtimes.map((runtime) => managedMcpProjectLifecycleReport(
    client,
    runtime.preview,
    runtime.toolNames,
    runtime.authoring,
    runtime.role,
  ));
  const report = includeActions
    ? managedMcpProjectSetLifecycleReport(client, reports)
    : reports[0]!;
  const json = rest.includes("--json");
  if (rest.includes("--dry-run") || runtimes.every((runtime) => runtime.preview.action === "unchanged")) {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(includeActions
      ? formatManagedMcpProjectSetPreview(report)
      : formatManagedMcpProjectPreview(report));
    return 0;
  }
  if (!json) process.stdout.write(includeActions
    ? formatManagedMcpProjectSetPreview(report)
    : formatManagedMcpProjectPreview(report));
  await confirmDangerousAction(
    rest,
    includeActions
      ? `Install the separate reviewed Read and Action MCP entries in ${path.relative(projectRoot, preview.paths.destination)}?`
      : `Install the reviewed Synapsor MCP entry in ${path.relative(projectRoot, preview.paths.destination)}?`,
  );
  const installed = await installManagedMcpProjectSet({
    client,
    projectRoot,
    entries: runtimes.map((runtime) => ({
      configPath: runtime.configPath,
      storePath: runtime.storePath,
      authoring: runtime.authoring,
      entryKind: runtime.entryKind,
    })),
  });
  if (json) {
    const backup = installed.backup;
    process.stdout.write(`${JSON.stringify({
      ...report,
      installed: true,
      ...(includeActions
        ? { backups: backup ? [backup] : [] }
        : backup
          ? { backup }
          : {}),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(includeActions
      ? `${definition.displayName} project MCP entries installed: synapsor (Read) and synapsor-actions (proposals).\n`
      : `${definition.displayName} project MCP entry installed at ${path.relative(projectRoot, installed.previews[0]!.paths.destination)}.\n`);
    const backups = installed.backup ? [installed.backup] : [];
    for (const backup of backups) process.stdout.write(`Backup: ${backup}\n`);
    process.stdout.write(
      `${definition.reloadInstruction}, then run \`synapsor-runner mcp status ${client} --project${includeActions ? " --include-actions" : ""}\` to verify the reviewed tool boundary.\n`,
    );
  }
  return 0;
}


async function mcpProjectStatus(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  assertKnownOptions(rest, new Set([
    "--project", "--project-root", "--include-actions", "--json", "--check-launch", "--timeout-ms",
  ]), `mcp status ${client}`);
  if (!rest.includes("--project")) throw new Error(`mcp status ${client} requires --project`);
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const includeActions = rest.includes("--include-actions");
  const checkLaunch = rest.includes("--check-launch");
  const timeoutMs = Number(optionalArg(rest, "--timeout-ms") ?? "10000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be an integer from 100 to 120000");
  }
  const reports = [];
  for (const entryKind of (["explore", ...(includeActions ? ["actions" as const] : [])] as ManagedMcpProjectEntryKind[])) {
    reports.push(await managedMcpProjectStatusReport({
      client,
      projectRoot,
      entryKind,
      checkLaunch,
      timeoutMs,
    }));
  }
  if (includeActions) {
    const report = {
      ok: reports.every((entry) => entry.ok),
      client,
      client_name: managedMcpProjectDefinition(client).displayName,
      destination: reports[0]?.destination,
      runtimes: reports,
      not_exposed_to_mcp: defaultBlockedToolSurface(),
    };
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatManagedMcpProjectSetStatus(report));
    return report.ok ? 0 : 1;
  }
  const report = reports[0]!;
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatManagedMcpProjectStatus(report));
  return report.ok ? 0 : 1;
}

type ManagedMcpStatusReport = {
  ok: boolean;
  client: ManagedMcpProjectClient;
  client_name: string;
  role: "read" | "action";
  entry: string;
  state: string;
  mode: string;
  message: string;
  destination: string;
  config: string | null;
  store: string | null;
  tools: string[];
  not_exposed_to_mcp: string[];
  launch: { checked: boolean; ok: boolean; message: string };
};

async function managedMcpProjectStatusReport(input: {
  client: ManagedMcpProjectClient;
  projectRoot: string;
  entryKind: ManagedMcpProjectEntryKind;
  checkLaunch: boolean;
  timeoutMs: number;
}): Promise<ManagedMcpStatusReport> {
  const definition = managedMcpProjectDefinition(input.client);
  const status = await managedMcpProjectStatus(input.client, input.projectRoot, input.entryKind);
  const authoring = status.state === "installed" && isManagedAuthoringEntry(status.entry);
  let tools: string[] = [];
  let launch: { checked: boolean; ok: boolean; message: string } = {
    checked: false,
    ok: status.state === "installed",
    message: "Launch probe not requested; pass --check-launch to execute the configured stdio tools/list handshake.",
  };
  if (status.state === "installed") {
    let staticBoundaryOk = true;
    if (authoring) {
      tools = ["app.describe_data", "app.explore_data"];
    } else {
      const configPath = path.resolve(input.projectRoot, status.paths.configArgument);
      const boundary = await inspectMcpToolBoundary(["--config", configPath, "--store", ":memory:"]);
      tools = boundary.names;
      staticBoundaryOk = boundary.ok;
      if (!boundary.ok) {
        launch = { checked: false, ok: false, message: `Static tool boundary failed: ${boundary.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}` };
      }
    }
    if (staticBoundaryOk && input.checkLaunch) {
      const entry = status.entry;
      const command = typeof entry?.command === "string" ? entry.command : "";
      const commandArgs = Array.isArray(entry?.args) && entry.args.every((value) => typeof value === "string") ? entry.args as string[] : [];
      if (!command) throw new Error(`${definition.displayName} Synapsor entry does not contain a valid command`);
      const response = await fetchStdioMcpToolsCommand(command, commandArgs, input.timeoutMs, input.projectRoot);
      const liveNames = mcpAuditToolNames(response);
      const matches = stableStringArray(liveNames).join("\n") === stableStringArray(tools).join("\n");
      launch = {
        checked: true,
        ok: matches,
        message: matches ? `${definition.displayName} command started and exposed exactly ${liveNames.length} reviewed tool(s).` : `Started command exposed ${liveNames.join(", ") || "no tools"}; expected ${tools.join(", ") || "no tools"}.`,
      };
    }
  }
  return {
    ok: status.state === "installed" && launch.ok,
    client: input.client,
    client_name: definition.displayName,
    role: input.entryKind === "actions" ? "action" : "read",
    entry: status.paths.serverName,
    state: status.state,
    mode: authoring ? "authoring" : "runtime",
    message: status.message,
    destination: path.relative(input.projectRoot, status.paths.destination),
    config: authoring ? null : status.paths.configArgument,
    store: authoring ? null : status.paths.storeArgument,
    tools,
    not_exposed_to_mcp: defaultBlockedToolSurface(),
    launch,
  };
}


async function mcpProjectUninstall(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  const definition = managedMcpProjectDefinition(client);
  assertKnownOptions(rest, new Set([
    "--project", "--project-root", "--include-actions", "--dry-run", "--yes", "--json",
  ]), `mcp uninstall ${client}`);
  if (!rest.includes("--project")) throw new Error(`mcp uninstall ${client} requires --project`);
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const includeActions = rest.includes("--include-actions");
  const statuses = [];
  for (const entryKind of (["explore", ...(includeActions ? ["actions" as const] : [])] as ManagedMcpProjectEntryKind[])) {
    statuses.push({
      entryKind,
      status: await managedMcpProjectStatus(client, projectRoot, entryKind),
    });
  }
  const entries = statuses.map(({ entryKind, status }) => ({
    role: entryKind === "actions" ? "action" : "read",
    entry: status.paths.serverName,
    state: status.state,
    changed: status.state === "installed",
    message: status.message,
  }));
  const preview = {
    ok: statuses.every(({ status }) => status.state === "installed" || status.state === "not_installed"),
    client,
    client_name: definition.displayName,
    state: statuses.every(({ status }) => status.state === "not_installed") ? "not_installed" : "present",
    changed: statuses.some(({ status }) => status.state === "installed"),
    destination: path.relative(projectRoot, statuses[0]!.status.paths.destination),
    preserves_other_servers: true,
    entries,
    message: includeActions
      ? "Runner checked the independently owned Read and Action MCP entries."
      : statuses[0]!.status.message,
  };
  const json = rest.includes("--json");
  if (rest.includes("--dry-run") || !preview.changed) {
    if (json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    else process.stdout.write(`${preview.message}\n${preview.changed ? `Will remove only the listed Runner-owned entries from ${preview.destination}.\n` : "No file change is needed.\n"}`);
    return preview.ok ? 0 : 1;
  }
  if (!json) process.stdout.write(`${preview.message}\nWill remove only the listed Runner-owned entries from ${preview.destination}.\n`);
  if (!preview.ok) throw new Error(`${definition.displayName} project entry is unowned or changed; refusing to remove it automatically`);
  await confirmDangerousAction(
    rest,
    `Remove only the listed Runner-owned Synapsor MCP entr${includeActions ? "ies" : "y"} from ${preview.destination}?`,
  );
  const removed = [];
  for (const { entryKind, status } of [...statuses].reverse()) {
    if (status.state !== "installed") continue;
    removed.push(await uninstallManagedMcpProject({ client, projectRoot, entryKind }));
  }
  const backups = removed.flatMap((result) => result.backup ? [result.backup] : []);
  if (json) process.stdout.write(`${JSON.stringify({
    ...preview,
    changed: removed.some((result) => result.changed),
    ...(includeActions
      ? { backups }
      : backups[0]
        ? { backup: backups[0] }
        : {}),
  }, null, 2)}\n`);
  else {
    process.stdout.write(`Removed ${removed.length} Runner-owned ${definition.displayName} project MCP entr${removed.length === 1 ? "y" : "ies"}.\n`);
    for (const backup of backups) process.stdout.write(`Backup: ${backup}\n`);
  }
  return 0;
}


function managedMcpProjectLifecycleReport(
  client: ManagedMcpProjectClient,
  preview: Awaited<ReturnType<typeof previewManagedMcpProjectInstall>>,
  tools: string[],
  authoring = false,
  role: "read" | "action" = "read",
): Record<string, unknown> {
  const definition = managedMcpProjectDefinition(client);
  return {
    ok: true,
    client,
    client_name: definition.displayName,
    role,
    entry: preview.paths.serverName,
    action: preview.action,
    mode: authoring ? "authoring" : "runtime",
    destination: path.relative(preview.paths.projectRoot, preview.paths.destination),
    config: authoring ? null : preview.paths.configArgument,
    store: authoring ? null : preview.paths.storeArgument,
    preserves_other_servers: true,
    credentials_in_client_config: false,
    ...(client === "cursor" ? { credentials_in_cursor_config: false } : {}),
    tools,
    not_exposed_to_mcp: defaultBlockedToolSurface(),
  };
}

function managedMcpProjectSetLifecycleReport(
  client: ManagedMcpProjectClient,
  runtimes: Record<string, unknown>[],
): Record<string, unknown> {
  const definition = managedMcpProjectDefinition(client);
  return {
    ok: runtimes.every((runtime) => runtime.ok === true),
    client,
    client_name: definition.displayName,
    action: runtimes.every((runtime) => runtime.action === "unchanged") ? "unchanged" : "install_or_update",
    destination: runtimes[0]?.destination ?? definition.destination,
    preserves_other_servers: true,
    credentials_in_client_config: false,
    trusted_identity_in_client_config: false,
    runtimes,
    not_exposed_to_mcp: defaultBlockedToolSurface(),
  };
}


function formatManagedMcpProjectPreview(report: Record<string, unknown>): string {
  const tools = Array.isArray(report.tools) ? report.tools.join(", ") : "";
  const clientName = String(report.client_name);
  return [
    `${clientName} project MCP ${String(report.action)} preview`,
    `Mode: ${String(report.mode)}`,
    `Destination: ${String(report.destination)}`,
    ...(report.mode === "authoring"
      ? ["Project root: .", "Transport: local stdio only"]
      : [`Runner config: ${String(report.config)}`, `Runner store: ${String(report.store)}`]),
    `Model-facing tools: ${tools || "none"}`,
    "Approval, apply, revert, policy, credentials, and trusted identity stay outside MCP.",
    `Other ${clientName} MCP servers and project settings are preserved.`,
    "",
  ].join("\n");
}

function formatManagedMcpProjectSetPreview(report: Record<string, unknown>): string {
  const runtimes = Array.isArray(report.runtimes)
    ? report.runtimes.filter((runtime): runtime is Record<string, unknown> => Boolean(runtime) && typeof runtime === "object")
    : [];
  const clientName = String(report.client_name);
  return [
    `${clientName} project MCP Read + Action preview`,
    `Destination: ${String(report.destination)}`,
    ...runtimes.flatMap((runtime) => [
      `${runtime.role === "action" ? "Action Boundary" : "Read Boundary"} entry: ${String(runtime.entry)} [${String(runtime.action)}]`,
      `  Model-facing tools: ${Array.isArray(runtime.tools) ? runtime.tools.join(", ") : "none"}`,
      ...(runtime.role === "action" ? [`  Runner config: ${String(runtime.config)}`] : []),
    ]),
    "Trusted tenant and principal values come from the client process environment; they are not stored in the client config.",
    "Approval, apply, revert, policy editing, credentials, SQL, and boundary activation stay outside MCP.",
    `Other ${clientName} MCP servers and project settings are preserved.`,
    "",
  ].join("\n");
}


function formatManagedMcpProjectStatus(report: {
  ok: boolean;
  client_name: string;
  state: string;
  message: string;
  mode: string;
  destination: string;
  config: string | null;
  tools: string[];
  launch: { checked: boolean; ok: boolean; message: string };
}): string {
  return [
    `${report.client_name} project MCP: ${report.state}`,
    report.message,
    `Mode: ${report.mode}`,
    `Destination: ${report.destination}`,
    ...(report.mode === "authoring" ? ["Project root: ."] : [`Runner config: ${report.config}`]),
    `Model-facing tools: ${report.tools.join(", ") || "none"}`,
    `Launch: ${report.launch.message}`,
    "Approval, apply, revert, policy, credentials, and trusted identity are not model-facing.",
    "",
  ].join("\n");
}

function formatManagedMcpProjectSetStatus(report: {
  ok: boolean;
  client_name: string;
  destination?: string;
  runtimes: ManagedMcpStatusReport[];
}): string {
  return [
    `${report.client_name} project MCP Read + Action: ${report.ok ? "installed" : "needs attention"}`,
    `Destination: ${report.destination ?? "project client config"}`,
    ...report.runtimes.flatMap((runtime) => [
      `${runtime.role === "action" ? "Action Boundary" : "Read Boundary"} entry: ${runtime.entry} [${runtime.state}]`,
      `  Model-facing tools: ${runtime.tools.join(", ") || "none"}`,
      `  Launch: ${runtime.launch.message}`,
    ]),
    "Trusted tenant and principal values are inherited at launch and are not stored in the client config.",
    "Approval, apply, revert, policy editing, credentials, SQL, and boundary activation are not model-facing.",
    "",
  ].join("\n");
}
