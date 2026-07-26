import path from "node:path";
import process from "node:process";
import { stableStringArray } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { confirmDangerousAction, readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import {
  installManagedMcpProject,
  managedMcpProjectDefinition,
  managedMcpProjectStatus,
  parseManagedMcpProjectClient,
  previewManagedMcpProjectInstall,
  uninstallManagedMcpProject,
  type ManagedMcpProjectClient,
} from "./managed-mcp-project.js";
import { audit, fetchStdioMcpToolsCommand, mcpAuditToolNames } from "./mcp-audit.js";
import { isManagedAuthoringEntry } from "./mcp-project-domain.js";
import { defaultBlockedToolSurface, inspectMcpToolBoundary, mcpConfig, mcpConfigure, mcpServe, mcpServeHttp, mcpServeStreamableHttp, mcpSmoke } from "./mcp-runtime.js";
import { prepareScopedExplore } from "./scoped-explore.js";


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


async function mcpProjectInstall(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  const definition = managedMcpProjectDefinition(client);
  assertKnownOptions(rest, new Set(["--project", "--project-root", "--config", "--store", "--authoring", "--dry-run", "--yes", "--json"]), `mcp install ${client}`);
  if (!rest.includes("--project")) {
    throw new Error(`mcp install ${client} requires --project so Runner changes only the current project's ${definition.destination}`);
  }
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const authoring = rest.includes("--authoring");
  const configPath = runnerConfigPath(rest, "./synapsor.runner.json");
  const storePath = resolvedLocalStorePath(rest);
  let toolNames: string[];
  if (authoring) {
    await prepareScopedExplore({ projectRoot, transport: "stdio", env: process.env });
    toolNames = ["app.describe_data", "app.explore_data"];
  } else {
    const absoluteConfig = path.resolve(projectRoot, configPath);
    await readRuntimeConfig(absoluteConfig);
    const boundary = await inspectMcpToolBoundary(["--config", absoluteConfig, "--store", ":memory:"]);
    if (!boundary.ok) {
      throw new Error(`${definition.displayName} install refused because the reviewed model-facing boundary failed: ${boundary.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}`);
    }
    toolNames = boundary.names;
  }
  const preview = await previewManagedMcpProjectInstall({ client, projectRoot, configPath, storePath, authoring });
  const report = managedMcpProjectLifecycleReport(client, preview, toolNames, authoring);
  const json = rest.includes("--json");
  if (rest.includes("--dry-run") || preview.action === "unchanged") {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatManagedMcpProjectPreview(report));
    return 0;
  }
  if (!json) process.stdout.write(formatManagedMcpProjectPreview(report));
  await confirmDangerousAction(rest, `Install the reviewed Synapsor MCP entry in ${path.relative(projectRoot, preview.paths.destination)}?`);
  const installed = await installManagedMcpProject({ client, projectRoot, configPath, storePath, authoring });
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, action: installed.action, installed: true, backup: installed.backup ?? null }, null, 2)}\n`);
  } else {
    process.stdout.write(`${definition.displayName} project MCP entry installed at ${path.relative(projectRoot, installed.paths.destination)}.\n`);
    if (installed.backup) process.stdout.write(`Backup: ${installed.backup}\n`);
    process.stdout.write(`${definition.reloadInstruction}, then run \`synapsor-runner mcp status ${client} --project\` to verify the reviewed tool boundary.\n`);
  }
  return 0;
}


async function mcpProjectStatus(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  const definition = managedMcpProjectDefinition(client);
  assertKnownOptions(rest, new Set(["--project", "--project-root", "--json", "--check-launch", "--timeout-ms"]), `mcp status ${client}`);
  if (!rest.includes("--project")) throw new Error(`mcp status ${client} requires --project`);
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const status = await managedMcpProjectStatus(client, projectRoot);
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
      const configPath = path.resolve(projectRoot, status.paths.configArgument);
      const boundary = await inspectMcpToolBoundary(["--config", configPath, "--store", ":memory:"]);
      tools = boundary.names;
      staticBoundaryOk = boundary.ok;
      if (!boundary.ok) {
        launch = { checked: false, ok: false, message: `Static tool boundary failed: ${boundary.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}` };
      }
    }
    if (staticBoundaryOk && rest.includes("--check-launch")) {
      const entry = status.entry;
      const command = typeof entry?.command === "string" ? entry.command : "";
      const commandArgs = Array.isArray(entry?.args) && entry.args.every((value) => typeof value === "string") ? entry.args as string[] : [];
      if (!command) throw new Error(`${definition.displayName} Synapsor entry does not contain a valid command`);
      const timeoutMs = Number(optionalArg(rest, "--timeout-ms") ?? "10000");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("--timeout-ms must be an integer from 100 to 120000");
      const response = await fetchStdioMcpToolsCommand(command, commandArgs, timeoutMs, projectRoot);
      const liveNames = mcpAuditToolNames(response);
      const matches = stableStringArray(liveNames).join("\n") === stableStringArray(tools).join("\n");
      launch = {
        checked: true,
        ok: matches,
        message: matches ? `${definition.displayName} command started and exposed exactly ${liveNames.length} reviewed tool(s).` : `Started command exposed ${liveNames.join(", ") || "no tools"}; expected ${tools.join(", ") || "no tools"}.`,
      };
    }
  }
  const report = {
    ok: status.state === "installed" && launch.ok,
    client,
    client_name: definition.displayName,
    state: status.state,
    mode: authoring ? "authoring" : "runtime",
    message: status.message,
    destination: path.relative(projectRoot, status.paths.destination),
    config: authoring ? null : status.paths.configArgument,
    store: authoring ? null : status.paths.storeArgument,
    tools,
    not_exposed_to_mcp: defaultBlockedToolSurface(),
    launch,
  };
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatManagedMcpProjectStatus(report));
  return report.ok ? 0 : 1;
}


async function mcpProjectUninstall(args: string[]): Promise<number> {
  const [clientValue, ...rest] = args;
  const client = parseManagedMcpProjectClient(clientValue);
  const definition = managedMcpProjectDefinition(client);
  assertKnownOptions(rest, new Set(["--project", "--project-root", "--dry-run", "--yes", "--json"]), `mcp uninstall ${client}`);
  if (!rest.includes("--project")) throw new Error(`mcp uninstall ${client} requires --project`);
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? process.cwd());
  const status = await managedMcpProjectStatus(client, projectRoot);
  const preview = {
    ok: status.state === "installed" || status.state === "not_installed",
    client,
    client_name: definition.displayName,
    state: status.state,
    changed: status.state === "installed",
    destination: path.relative(projectRoot, status.paths.destination),
    preserves_other_servers: true,
    message: status.message,
  };
  const json = rest.includes("--json");
  if (rest.includes("--dry-run") || !preview.changed) {
    if (json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    else process.stdout.write(`${preview.message}\n${preview.changed ? `Will remove only the Runner-owned Synapsor entry from ${preview.destination}.\n` : "No file change is needed.\n"}`);
    return preview.ok ? 0 : 1;
  }
  if (!json) process.stdout.write(`${preview.message}\nWill remove only the Runner-owned Synapsor entry from ${preview.destination}.\n`);
  if (!preview.ok) throw new Error(`${definition.displayName} project entry is unowned or changed; refusing to remove it automatically`);
  await confirmDangerousAction(rest, `Remove only the Runner-owned Synapsor MCP entry from ${preview.destination}?`);
  const removed = await uninstallManagedMcpProject({ client, projectRoot });
  if (json) process.stdout.write(`${JSON.stringify({ ...preview, changed: removed.changed, backup: removed.backup ?? null }, null, 2)}\n`);
  else process.stdout.write(`Removed Runner-owned ${definition.displayName} project MCP entry. Backup: ${removed.backup}\n`);
  return 0;
}


function managedMcpProjectLifecycleReport(
  client: ManagedMcpProjectClient,
  preview: Awaited<ReturnType<typeof previewManagedMcpProjectInstall>>,
  tools: string[],
  authoring = false,
): Record<string, unknown> {
  const definition = managedMcpProjectDefinition(client);
  return {
    ok: true,
    client,
    client_name: definition.displayName,
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
