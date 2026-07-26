import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { capabilityWritebackExecutor, capabilityWritebackMode, CloudLinkedSynchronizer, createDefaultRuntimeStore, enqueueCloudLinkedResult, loadRuntimeConfigFromFile, type ResultFormat, type RuntimeConfig, type ToolNameStyle } from "@synapsor-runner/mcp-server";
import {
  type ProposalRuntimeStore
} from "@synapsor-runner/proposal-store";
import {
  loadConfig,
  runOnce,
  startPolling,
  type WritebackResultReporter
} from "@synapsor-runner/worker-core";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord, shellQuote } from "./cli-format.js";
import { assertKnownOptions, envValue, optionalArg } from "./cli-options.js";
import { defaultConfigPath, defaultStorePath, readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { adapters } from "./cli-runtime.js";
import { trustedContextsForDoctor } from "./doctor-domain.js";
import { doctor } from "./first-run-doctor.js";
import { handlerSecurityWarning } from "./handler-templates.js";
import { assertReceiptTopologyForTransport, inspectMcpToolBoundary, mcpServeStreamableHttp, networkHttpSecurityArgs, toolNameStyleOption } from "./mcp-runtime.js";
import { resultFormatOption } from "./mcp-shared.js";
import { assertNoActiveStoreLease } from "./store-lease.js";
import { capabilityOperation, formatSourceReceiptMode } from "./writeback-domain.js";
import { verifyLocalWritebackAuthority } from "./writeback-execution.js";


export async function startWorker(args: string[] = []): Promise<number> {
  const workerOptions = new Map<string, string>();
  const once = args.includes("--once");
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--once") continue;
    if (flag !== "--config" && flag !== "--store") {
      throw new Error(`start accepts own-database onboarding flags or Cloud worker flags --config, --store, and --once. Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    workerOptions.set(flag, value);
    index += 1;
  }
  const configPath = workerOptions.get("--config");
  const storePath = workerOptions.get("--store");
  if (Boolean(configPath) !== Boolean(storePath)) throw new Error("Cloud worker mode requires both --config and --store");
  if (once && (!configPath || !storePath)) throw new Error("Cloud worker --once requires both --config and --store so local reviewed authority is rechecked");
  const config = loadConfig();
  const cloudLinkedWorker = configPath && storePath
    ? createCloudLinkedWorkerSync(configPath, storePath)
    : undefined;
  if (once) {
    const reviewedConfigPath = configPath;
    const reviewedStorePath = storePath;
    if (!reviewedConfigPath || !reviewedStorePath) {
      throw new Error("Cloud worker --once requires both --config and --store so local reviewed authority is rechecked");
    }
    try {
      await cloudLinkedWorker?.synchronizer.drainOnce();
      const completed = await runOnce(
        config,
        adapters,
        (job) => verifyLocalWritebackAuthority(job, reviewedConfigPath, reviewedStorePath, { cloudApproved: true }),
        cloudLinkedWorker?.reportResult,
      );
      process.stdout.write(`Cloud worker completed ${completed} job(s).\n`);
      return 0;
    } finally {
      await closeCloudLinkedWorkerSync(cloudLinkedWorker);
    }
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  cloudLinkedWorker?.synchronizer.start();
  try {
    await startPolling(
      config,
      adapters,
      controller.signal,
      configPath && storePath
        ? (job) => verifyLocalWritebackAuthority(job, configPath, storePath, { cloudApproved: true })
        : undefined,
      cloudLinkedWorker?.reportResult,
    );
    return 0;
  } finally {
    await closeCloudLinkedWorkerSync(cloudLinkedWorker);
  }
}


type CloudLinkedWorkerSync = {
  runtimeConfig: RuntimeConfig;
  store: ProposalRuntimeStore;
  synchronizer: CloudLinkedSynchronizer;
  reportResult: WritebackResultReporter;
};


function createCloudLinkedWorkerSync(configPath: string, storePath: string): CloudLinkedWorkerSync | undefined {
  const runtimeConfig = loadRuntimeConfigFromFile(configPath);
  if (runtimeConfig.governance?.mode !== "cloud_linked") return undefined;
  const store = createDefaultRuntimeStore(runtimeConfig, process.env, storePath);
  const synchronizer = new CloudLinkedSynchronizer(runtimeConfig, store, process.env);
  const reportResult: WritebackResultReporter = async ({ job, result, leaseId }) => {
    const outboxItem = await enqueueCloudLinkedResult({
      config: runtimeConfig,
      store,
      proposalId: job.proposal_id,
      result,
      leaseId,
    });
    if (outboxItem) await synchronizer.flushEvent(outboxItem.event_id);
  };
  return { runtimeConfig, store, synchronizer, reportResult };
}


async function closeCloudLinkedWorkerSync(sync: CloudLinkedWorkerSync | undefined): Promise<void> {
  if (!sync) return;
  await sync.synchronizer.stop();
  await sync.store.close();
}


export async function up(args: string[] = []): Promise<number> {
  const allowed = new Set([
    "--config",
    "--store",
    "--transport",
    "--serve",
    "--with-handler",
    "--host",
    "--port",
    "--auth-token-env",
    "--previous-auth-token-env",
    "--alias-mode",
    "--tool-name-style",
    "--openai-tool-aliases",
    "--result-format",
    "--handler-check",
    "--open-ui",
    "--print-next",
    "--dry-run",
    "--dev-no-auth",
    "--cors-origin",
    "--trusted-tls-proxy",
    "--unsafe-allow-cleartext-http",
    "--tls-cert-env",
    "--tls-key-env",
    "--tls-ca-env",
    "--require-client-cert",
    "--allow-concurrent-store",
  ]);
  assertKnownOptions(args, allowed, "up");
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const config = await readRuntimeConfig(configPath);
  const storePath = resolvedLocalStorePath(args, config.storage?.sqlite_path, defaultStorePath);
  const serveRequested = args.includes("--serve");
  const transport = optionalArg(args, "--transport") ?? (serveRequested ? "streamable-http" : "stdio");
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new Error("--transport must be stdio or streamable-http");
  }
  if (serveRequested && transport === "stdio") {
    throw new Error("up --serve starts the Streamable HTTP MCP server. Omit --transport or use --transport streamable-http; for stdio, use mcp client-config so the client launches Runner.");
  }
  assertReceiptTopologyForTransport(config, transport);
  const port = Number(optionalArg(args, "--port") ?? "8766");
  if (transport === "streamable-http" && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  const aliasMode = toolNameStyleOption(args);
  const resultFormat = resultFormatOption(args);
  const claimsAuth = trustedContextsForDoctor(config).some((context) => context.provider === "http_claims");
  const authTokenEnv = optionalArg(args, "--auth-token-env")
    ?? config.http_security?.static_token?.active_env
    ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`cannot bring Runner up with invalid config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
  }
  if (storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  await assertNoActiveStoreLease(storePath, args.includes("--allow-concurrent-store"), "review-mode up");

  const boundary = await inspectMcpToolBoundary([
    "--config", configPath,
    "--store", storePath,
    "--alias-mode", aliasMode,
  ]);
  process.stdout.write(formatReviewModeUp({
    aliasMode,
    authTokenEnv,
    boundary,
    config,
    configPath,
    dryRun: args.includes("--dry-run"),
    host: optionalArg(args, "--host") ?? "127.0.0.1",
    openUi: args.includes("--open-ui"),
    port,
    resultFormat,
    networkSecurityArgs: networkHttpSecurityArgs(args),
    serveRequested,
    storePath,
    transport,
  }));

  if (args.includes("--with-handler") || args.includes("--handler-check")) {
    process.stdout.write("\nHandler check:\n");
    const doctorCode = await doctor(["--config", configPath, "--store", storePath, "--check-handlers"]);
    if (doctorCode !== 0) return doctorCode;
  }

  if (args.includes("--dry-run") || !serveRequested) return boundary.ok ? 0 : 1;
  if (!boundary.ok) return 1;

  const serveArgs = [
    "--config", configPath,
    "--store", storePath,
    "--host", optionalArg(args, "--host") ?? "127.0.0.1",
    "--port", String(port),
    ...(claimsAuth
      ? []
      : ["--auth-token-env", authTokenEnv]),
    "--alias-mode", aliasMode,
    ...(resultFormat ? ["--result-format", String(resultFormat)] : []),
    ...(args.includes("--dev-no-auth") ? ["--dev-no-auth"] : []),
    ...(optionalArg(args, "--cors-origin") ? ["--cors-origin", optionalArg(args, "--cors-origin") as string] : []),
    ...networkHttpSecurityArgs(args),
    ...(args.includes("--allow-concurrent-store") ? ["--allow-concurrent-store"] : []),
  ];
  return mcpServeStreamableHttp(serveArgs);
}


function formatReviewModeUp(input: {
  aliasMode: ToolNameStyle;
  authTokenEnv: string;
  boundary: Awaited<ReturnType<typeof inspectMcpToolBoundary>>;
  config: RuntimeConfig;
  configPath: string;
  dryRun: boolean;
  host: string;
  openUi: boolean;
  port: number;
  resultFormat?: ResultFormat;
  networkSecurityArgs: string[];
  serveRequested: boolean;
  storePath: string;
  transport: string;
}): string {
  const lines = [
    "Synapsor Runner review-mode up",
    "",
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    `Mode: ${input.config.mode}`,
    `Transport: ${input.transport}`,
    `Serve now: ${input.serveRequested ? "yes" : "no"}`,
    `Alias mode: ${input.aliasMode}`,
    `Result format: ${input.resultFormat ? `v${input.resultFormat}` : configResultFormat(input.config)}`,
    `Dry run: ${input.dryRun ? "yes" : "no"}`,
    "",
    "Model-facing tools:",
    ...formatUpToolLines(input.boundary),
    "",
    "Writeback paths:",
    ...formatUpWritebackLines(input.config),
  ];
  const handlerLines = formatUpHandlerLines(input.config);
  if (handlerLines.length > 0) {
    lines.push("", "App-owned handler requirements:", ...handlerLines, "", handlerSecurityWarning);
  }
  lines.push("", "Server guidance:");
  if (input.transport === "stdio") {
    lines.push(
      "  stdio mode is launched by an MCP client. This command does not hold a protocol session open.",
      `  Print client config: ${cliCommandName()} mcp client-config --client claude-desktop --config ${input.configPath} --store ${input.storePath}`,
      `  Serve command used by clients: ${cliCommandName()} mcp serve --config ${input.configPath} --store ${input.storePath} --alias-mode ${input.aliasMode}`,
    );
  } else {
    const directTls = input.networkSecurityArgs.includes("--tls-cert-env");
    const claimsAuth = trustedContextsForDoctor(input.config).some((context) => context.provider === "http_claims");
    const channel = directTls
      ? "direct TLS"
      : input.networkSecurityArgs.includes("--trusted-tls-proxy")
        ? "trusted TLS proxy/private hop"
        : input.networkSecurityArgs.includes("--unsafe-allow-cleartext-http")
          ? "UNSAFE cleartext break glass"
          : "loopback cleartext";
    const authArgs = claimsAuth ? "" : ` --auth-token-env ${input.authTokenEnv}`;
    lines.push(
      `  Streamable HTTP endpoint: ${directTls ? "https" : "http"}://${input.host}:${input.port}/mcp`,
      `  Channel: ${channel}`,
      claimsAuth
        ? `  Auth: signed per-session ${input.config.session_auth?.provider ?? "JWT"}; Runner verifies issuer/audience and trusted tenant/principal claims.`
        : `  Opaque endpoint token env: ${input.authTokenEnv} (${envValue(process.env, input.authTokenEnv) ? "set" : "missing"}); shared service access, not user identity.`,
      input.serveRequested
        ? input.dryRun
          ? "  Status: dry run only; server not started."
          : "  Status: starting after this checklist."
        : `  Start command: ${cliCommandName()} up --serve --config ${shellQuote(input.configPath)} --store ${shellQuote(input.storePath)} --port ${input.port}${authArgs} --alias-mode ${input.aliasMode}${input.networkSecurityArgs.length ? ` ${input.networkSecurityArgs.map(shellQuote).join(" ")}` : ""}`,
    );
  }
  if (input.openUi) {
    lines.push("", "Local review UI:", `  ${cliCommandName()} ui --open --tour --config ${input.configPath} --store ${input.storePath}`);
  }
  lines.push("", "Next commands:", ...formatUpNextCommands(input.config, input.configPath, input.storePath), "");
  return `${lines.join("\n")}\n`;
}


function formatUpToolLines(boundary: Awaited<ReturnType<typeof inspectMcpToolBoundary>>): string[] {
  if (boundary.exposures.length === 0) return ["  - (none)"];
  return boundary.exposures.map((item) => item.isAlias
    ? `  - ${item.exposedName} -> ${item.canonicalName}`
    : `  - ${item.exposedName}`);
}


function formatUpWritebackLines(config: RuntimeConfig): string[] {
  const proposals = (config.capabilities ?? []).filter((capability) => capability.kind === "proposal");
  if (proposals.length === 0) return ["  - no proposal capabilities; this config is read-only from Runner's perspective"];
  return proposals.map((capability) => {
    const mode = capabilityWritebackMode(capability);
    if (mode === "none") {
      return `  - ${capability.name}: proposal-only; no local writeback`;
    }
    if (mode === "cloud_worker") {
      return `  - ${capability.name}: cloud-worker writeback; local apply disabled`;
    }
    if (mode === "direct_sql") {
      const source = config.sources?.[capability.source];
      const envName = source?.write_url_env ?? "SYNAPSOR_DATABASE_URL";
      const cardinality = capability.operation?.cardinality === "set"
        ? `bounded-set ${capabilityOperation(capability).toUpperCase()} (max ${capability.operation.max_rows}; fixed selection; human/operator approval)`
        : `one-row ${capabilityOperation(capability).toUpperCase()}`;
      const reversibility = capability.reversibility?.mode === "reviewed_inverse" ? "; reviewed compensation enabled" : "; compensation not configured";
      return `  - ${capability.name}: direct guarded ${cardinality} via ${envName} (${envValue(process.env, envName) ? "set" : "missing"}); receipts ${formatSourceReceiptMode(source)}${reversibility}`;
    }
    const executorName = capabilityWritebackExecutor(capability) ?? "missing_executor";
    const executor = config.executors?.[executorName] as Record<string, unknown> | undefined;
    return `  - ${capability.name}: app-owned ${String(executor?.type ?? "executor")} ${executorName}`;
  });
}


function formatUpHandlerLines(config: RuntimeConfig): string[] {
  const lines: string[] = [];
  for (const [name, executor] of Object.entries(config.executors ?? {})) {
    if (!isRecord(executor)) continue;
    if (executor.type === "http_handler") {
      const urlEnv = typeof executor.url_env === "string" ? executor.url_env : "";
      const auth = isRecord(executor.auth) ? executor.auth : undefined;
      const tokenEnv = typeof auth?.token_env === "string" ? auth.token_env : undefined;
      const signingSecretEnv = typeof executor.signing_secret_env === "string" ? executor.signing_secret_env : undefined;
      lines.push(`  - ${name}: http_handler`);
      if (urlEnv) lines.push(`    url env: ${urlEnv} (${envValue(process.env, urlEnv) ? "set" : "missing"})`);
      if (tokenEnv) lines.push(`    bearer token env: ${tokenEnv} (${envValue(process.env, tokenEnv) ? "set" : "missing"})`);
      if (signingSecretEnv) lines.push(`    signing secret env: ${signingSecretEnv} (${envValue(process.env, signingSecretEnv) ? "set" : "missing"})`);
      if (!signingSecretEnv) lines.push("    signing secret env: not configured (recommended unless loopback-only)");
    } else if (executor.type === "command_handler") {
      const commandEnv = typeof executor.command_env === "string" ? executor.command_env : "";
      lines.push(`  - ${name}: command_handler`);
      if (commandEnv) lines.push(`    command env: ${commandEnv} (${envValue(process.env, commandEnv) ? "set" : "missing"})`);
    }
  }
  return lines;
}


function configResultFormat(config: RuntimeConfig): string {
  return config.result_format === 2 ? "v2" : config.result_format === 1 ? "v1" : "default";
}


function formatUpNextCommands(config: RuntimeConfig, configPath: string, storePath: string): string[] {
  const firstTool = (config.capabilities ?? [])[0]?.name ?? "<capability>";
  const hasHandlers = Object.keys(config.executors ?? {}).length > 0;
  return [
    `  - Preview tools: ${cliCommandName()} tools preview --config ${configPath} --store ${storePath}`,
    `  - Smoke call: ${cliCommandName()} smoke call ${firstTool} --sample --config ${configPath} --store ${storePath}`,
    `  - List proposals: ${cliCommandName()} proposals list --store ${storePath}`,
    `  - Show proposal: ${cliCommandName()} proposals show latest --store ${storePath}`,
    `  - Approve proposal: ${cliCommandName()} proposals approve latest --yes --store ${storePath}`,
    `  - Apply approved proposal: ${cliCommandName()} apply latest --config ${configPath} --store ${storePath}`,
    `  - Replay: ${cliCommandName()} replay show latest --store ${storePath}`,
    `  - Tail events: ${cliCommandName()} events tail --store ${storePath}`,
    `  - Direct writeback doctor: ${cliCommandName()} doctor --config ${configPath} --check-writeback`,
    ...(hasHandlers ? [`  - Handler doctor: ${cliCommandName()} doctor --config ${configPath} --check-handlers`] : []),
  ];
}
