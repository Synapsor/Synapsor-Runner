#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { createMcpRuntime, serveStdio, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";
import { parseWritebackJob, protocolVersions, type RunnerRegistrationV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import {
  generateRunnerConfigFromSpec,
  inspectDatabase,
  summarizeInspection,
  type InspectEngine,
  type OnboardingSelectionSpec,
} from "@synapsor-runner/schema-inspector";
import {
  auditMcpManifest,
  createLogger,
  doctorChecks,
  formatMcpAuditReport,
  loadConfig,
  startPolling,
  type RunnerConfig,
} from "@synapsor-runner/worker-core";

const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "init") return init(rest);
  if (command === "inspect") return inspect(rest);
  if (command === "config") return configCommand(rest);
  if (command === "doctor") return doctor(rest);
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "start") return start();
  if (command === "runner") return runnerCommand(rest);
  if (command === "cloud") return cloud(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "proposals") return proposals(rest);
  if (command === "replay") return replay(rest);
  usage();
  return 2;
}

async function init(args: string[]): Promise<number> {
  const specPath = optionalArg(args, "--spec");
  if (specPath) {
    return initFromSpec(args, specPath);
  }
  const output = optionalArg(args, "--output") ?? "synapsor.runner.json";
  const engine = optionalArg(args, "--engine") ?? "postgres";
  const mode = optionalArg(args, "--mode") ?? "review";
  if (engine !== "postgres" && engine !== "mysql") {
    throw new Error("init --engine must be postgres or mysql");
  }
  if (!["read_only", "shadow", "review", "cloud"].includes(mode)) {
    throw new Error("init --mode must be read_only, shadow, review, or cloud");
  }
  const resolved = path.resolve(output);
  if (!args.includes("--force")) {
    try {
      await fs.access(resolved);
      throw new Error(`${output} already exists. Use --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const config = mode === "cloud" ? starterCloudConfig() : starterLocalConfig(engine, mode);
  await fs.writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stdout.write(`created ${output}\n`);
  process.stdout.write("Edit table/column names and set the referenced environment variables before serving MCP tools.\n");
  return 0;
}

async function initFromSpec(args: string[], specPath: string): Promise<number> {
  if (!args.includes("--non-interactive")) {
    throw new Error("init --spec requires --non-interactive so reviewed selections are explicit.");
  }
  const output = optionalArg(args, "--output") ?? "synapsor.runner.json";
  const force = args.includes("--force");
  const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as OnboardingSelectionSpec;
  const generated = generateRunnerConfigFromSpec(spec);
  await writeFileGuarded(output, `${JSON.stringify(generated.config, null, 2)}\n`, force);
  await writeFileGuarded(".env.example", generated.envExample, force);
  await fs.mkdir(path.resolve(".synapsor/mcp"), { recursive: true });
  for (const [fileName, snippet] of Object.entries(generated.mcpSnippets)) {
    await writeFileGuarded(path.join(".synapsor/mcp", fileName), `${JSON.stringify(snippet, null, 2)}\n`, force);
  }
  await fs.mkdir(path.resolve(".synapsor"), { recursive: true });
  process.stdout.write(`created ${output}\n`);
  process.stdout.write("created .env.example\n");
  process.stdout.write("created MCP client snippets under .synapsor/mcp\n");
  process.stdout.write("Next: set the referenced environment variables, run `synapsor config validate`, then run `synapsor mcp serve`.\n");
  return 0;
}

async function inspect(args: string[]): Promise<number> {
  const databaseUrlEnv = optionalArg(args, "--database-url-env") ?? "SYNAPSOR_DATABASE_READ_URL";
  const engine = (optionalArg(args, "--engine") ?? "auto") as InspectEngine;
  if (!["postgres", "mysql", "auto"].includes(engine)) {
    throw new Error("inspect --engine must be postgres, mysql, or auto.");
  }
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv,
    schema: optionalArg(args, "--schema"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  } else {
    process.stdout.write(summarizeInspection(inspection));
  }
  return 0;
}

async function configCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "validate") return configValidate(args.slice(1));
  if (subcommand === "show") return configShow(args.slice(1));
  usage();
  return 2;
}

async function configValidate(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  const result = validateRunnerCapabilityConfig(parsed);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`config valid: ${configPath}\n`);
    for (const warning of result.warnings) {
      process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
    }
  } else {
    process.stdout.write(`config invalid: ${configPath}\n`);
    for (const error of result.errors) {
      process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

async function configShow(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  const output = args.includes("--redacted") ? redactConfig(parsed) : parsed;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

function envPresenceCheck(envName: string, message: string): DoctorCheck {
  return {
    name: `env:${envName}`,
    ok: Boolean(process.env[envName]),
    level: process.env[envName] ? "pass" : "fail",
    message: process.env[envName] ? `${envName} is set.` : message,
  };
}

async function inspectConfiguredSource(input: {
  config: RuntimeConfig;
  sourceName: string;
  source: NonNullable<RuntimeConfig["sources"]>[string];
  checks: DoctorCheck[];
}): Promise<void> {
  if (!process.env[input.source.read_url_env]) return;
  const capabilities = (input.config.capabilities ?? []).filter((capability) => capability.source === input.sourceName);
  const schemas = Array.from(new Set(capabilities.map((capability) => capability.target.schema)));
  for (const schema of schemas.length ? schemas : [undefined]) {
    try {
      const inspection = await inspectDatabase({
        engine: input.source.engine,
        databaseUrlEnv: input.source.read_url_env,
        schema,
      });
      input.checks.push({
        name: `source:${input.sourceName}:read-connectivity${schema ? `:${schema}` : ""}`,
        ok: true,
        level: "pass",
        message: `Read-only metadata inspection succeeded for ${input.sourceName}${schema ? ` schema ${schema}` : ""}.`,
      });
      for (const capability of capabilities.filter((item) => !schema || item.target.schema === schema)) {
        const table = inspection.tables.find((item) => item.schema === capability.target.schema && item.name === capability.target.table);
        if (!table) {
          input.checks.push({
            name: `capability:${capability.name}:target`,
            ok: false,
            level: "fail",
            message: `Target ${capability.target.schema}.${capability.target.table} was not visible to ${input.source.read_url_env}.`,
          });
          continue;
        }
        input.checks.push({
          name: `capability:${capability.name}:target`,
          ok: true,
          level: "pass",
          message: `Found target ${capability.target.schema}.${capability.target.table}.`,
        });
        const columnNames = new Set(table.columns.map((column) => column.name));
        for (const [label, column] of [
          ["primary key", capability.target.primary_key],
          ["tenant guard", capability.target.tenant_key],
          ["conflict guard", capability.conflict_guard?.column],
          ...capability.visible_columns.map((item) => ["visible column", item] as const),
          ...(capability.allowed_columns ?? []).map((item) => ["allowed write column", item] as const),
        ] as Array<readonly [string, string | undefined]>) {
          if (!column) continue;
          input.checks.push({
            name: `capability:${capability.name}:column:${column}`,
            ok: columnNames.has(column),
            level: columnNames.has(column) ? "pass" : "fail",
            message: columnNames.has(column) ? `${label} ${column} exists.` : `${label} ${column} does not exist on ${capability.target.schema}.${capability.target.table}.`,
          });
        }
        if (capability.kind === "proposal" && !table.writable) {
          input.checks.push({
            name: `capability:${capability.name}:writable-target`,
            ok: false,
            level: "fail",
            message: `Proposal capability targets a view/non-table object: ${capability.target.schema}.${capability.target.table}.`,
          });
        }
      }
    } catch (error) {
      input.checks.push({
        name: `source:${input.sourceName}:read-connectivity${schema ? `:${schema}` : ""}`,
        ok: false,
        level: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function localToolNames(config: RuntimeConfig, checks: DoctorCheck[]): string[] {
  try {
    const runtime = createMcpRuntime(config, { storePath: ":memory:" });
    try {
      const tools = runtime.listTools().map((tool) => tool.name);
      checks.push({
        name: "mcp-runtime",
        ok: true,
        level: "pass",
        message: `MCP runtime listed ${tools.length} configured tools.`,
      });
      return tools;
    } finally {
      runtime.close();
    }
  } catch (error) {
    checks.push({
      name: "mcp-runtime",
      ok: false,
      level: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function formatLocalDoctorReport(report: LocalDoctorReport): string {
  const lines = [`Synapsor Runner doctor: ${report.ok ? "ok" : "failed"}`, `Config: ${report.config_path}`, `Mode: ${report.mode}`];
  if (report.tools.length) {
    lines.push("Exposed MCP tools:");
    for (const tool of report.tools) lines.push(`  - ${tool}`);
  }
  for (const check of report.checks) {
    const prefix = check.level === "pass" ? "✓" : check.level === "warn" ? "!" : "x";
    lines.push(`${prefix} ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  message: string;
};

type LocalDoctorReport = {
  ok: boolean;
  mode: string;
  config_path: string;
  checks: DoctorCheck[];
  tools: string[];
};

async function doctor(args: string[] = []): Promise<number> {
  const configPath = optionalArg(args, "--config");
  if (configPath || await fileExists("synapsor.runner.json")) {
    return localDoctor(args);
  }
  const config = loadConfig();
  const logger = createLogger(config);
  const report = await doctorChecks(config, adapters[config.engine]);
  logger.info("doctor checks", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

async function localDoctor(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const allowSharedCredential = args.includes("--allow-shared-credential");
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  const checks: DoctorCheck[] = [];
  const validation = validateRunnerCapabilityConfig(parsed);
  checks.push({
    name: "config-valid",
    ok: validation.ok,
    level: validation.ok ? "pass" : "fail",
    message: validation.ok ? "Config parses and validates." : validation.errors.map((error) => `${error.path} ${error.code}`).join("; "),
  });
  for (const warning of validation.warnings) {
    checks.push({ name: `config-warning:${warning.code}`, ok: true, level: "warn", message: warning.message });
  }

  const trustedValues = parsed.trusted_context?.values ?? {};
  const tenantEnv = String(trustedValues.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = String(trustedValues.principal_env ?? "SYNAPSOR_PRINCIPAL");
  for (const envName of [tenantEnv, principalEnv]) {
    checks.push(envPresenceCheck(envName, `${envName} is required for trusted context.`));
  }

  const sources = parsed.sources ?? {};
  for (const [sourceName, source] of Object.entries(sources)) {
    checks.push(envPresenceCheck(source.read_url_env, `${source.read_url_env} is required for ${sourceName} reads.`));
    if (parsed.mode === "review") {
      if (source.write_url_env) {
        checks.push(envPresenceCheck(source.write_url_env, `${source.write_url_env} is required for trusted writeback in review mode.`));
        const readValue = process.env[source.read_url_env];
        const writeValue = process.env[source.write_url_env];
        if (readValue && writeValue && readValue === writeValue) {
          checks.push({
            name: `source:${sourceName}:credential-separation`,
            ok: allowSharedCredential,
            level: allowSharedCredential ? "warn" : "fail",
            message: allowSharedCredential
              ? "Read and write URL env vars currently resolve to the same value; accepted only because --allow-shared-credential was provided."
              : "Read and write URL env vars resolve to the same value. Use separate credentials or rerun with --allow-shared-credential for local testing.",
          });
        } else if (readValue && writeValue) {
          checks.push({ name: `source:${sourceName}:credential-separation`, ok: true, level: "pass", message: "Read and write URL env vars are distinct." });
        }
      } else {
        checks.push({ name: `source:${sourceName}:write-url-env`, ok: false, level: "fail", message: "Review mode requires write_url_env for trusted writeback." });
      }
    }
    await inspectConfiguredSource({ config: parsed, sourceName, source, checks });
  }

  const tools = localToolNames(parsed, checks);
  const forbiddenTools = tools.filter((tool) => /execute_sql|run_query|approve|commit|apply_writeback/i.test(tool));
  checks.push({
    name: "mcp-tool-boundary",
    ok: forbiddenTools.length === 0,
    level: forbiddenTools.length === 0 ? "pass" : "fail",
    message: forbiddenTools.length === 0 ? "MCP tool catalog is semantic-only." : `Forbidden model-facing tools: ${forbiddenTools.join(", ")}`,
  });

  const report: LocalDoctorReport = {
    ok: checks.every((check) => check.level !== "fail"),
    mode: String(parsed.mode),
    config_path: configPath,
    checks,
    tools,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatLocalDoctorReport(report));
  }
  return report.ok ? 0 : 1;
}

async function validate(args: string[]): Promise<number> {
  const job = await readJob(args);
  parseWritebackJob(job);
  process.stdout.write("job valid\n");
  return 0;
}

async function apply(args: string[]): Promise<number> {
  const raw = await readJob(args);
  const job = parseWritebackJob(raw);
  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const config: RunnerConfig = {
    controlPlaneUrl: process.env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: process.env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: process.env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: process.env.SYNAPSOR_SOURCE_ID || job.source_id,
    databaseUrl: process.env.SYNAPSOR_DATABASE_URL || "",
    engine: job.engine,
    pollIntervalMs: Number(process.env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    logLevel: (process.env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: process.env.SYNAPSOR_STATE_DIR || "./state"
  };
  const result = await adapters[job.engine].apply(job, config);
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  if (storePath) {
    if (storePath !== ":memory:") {
      await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
    }
    const store = new ProposalStore(storePath);
    try {
      store.recordExecutionReceipt(toExecutionReceipt(job, result, config.dryRun));
    } finally {
      store.close();
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "failed" ? 1 : 0;
}

async function start(): Promise<number> {
  const config = loadConfig();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await startPolling(config, adapters, controller.signal);
  return 0;
}

async function runnerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "start") return start();
  if (subcommand === "doctor") return doctor(rest);
  usage();
  return 2;
}

async function cloud(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "connect") return cloudConnect(rest);
  usage();
  return 2;
}

async function cloudConnect(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG ?? "synapsor.cloud.json";
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    cloud?: {
      base_url_env?: string;
      runner_token_env?: string;
      runner_id?: string;
      runner_version?: string;
      project_id?: string;
      source_id?: string;
      engines?: string[];
      capabilities?: string[];
    };
  };
  if (!parsed.cloud) {
    process.stdout.write(`cloud config missing in ${configPath}\n`);
    return 1;
  }
  const baseUrlEnv = parsed.cloud.base_url_env || "SYNAPSOR_CLOUD_BASE_URL";
  const tokenEnv = parsed.cloud.runner_token_env || "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = process.env[baseUrlEnv];
  const runnerToken = process.env[tokenEnv];
  const missing = [baseUrl ? "" : baseUrlEnv, runnerToken ? "" : tokenEnv].filter(Boolean);
  if (missing.length > 0) {
    process.stdout.write(`missing environment variables: ${missing.join(", ")}\n`);
    return 1;
  }
  if (!baseUrl || !runnerToken) {
    process.stdout.write("missing Cloud connection settings\n");
    return 1;
  }
  const sourceId = String(parsed.cloud.source_id || process.env.SYNAPSOR_SOURCE_ID || "").trim();
  if (!sourceId || sourceId === "src_replace_me") {
    process.stdout.write("cloud.source_id is required before registering a runner. It must match the scoped Cloud runner token source.\n");
    return 1;
  }
  const runnerId = String(parsed.cloud.runner_id || process.env.SYNAPSOR_RUNNER_ID || "synapsor_runner_local").trim();
  const runnerVersion = String(parsed.cloud.runner_version || process.env.npm_package_version || "0.1.0-alpha.0").trim();
  const engines = normalizeEngines(parsed.cloud.engines);
  const capabilities = normalizeCapabilities(parsed.cloud.capabilities);
  const client = new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId,
  });
  const report = await client.doctor();
  if (!report.ok) {
    process.stdout.write(`cloud connection failed: status ${report.status}\n`);
    return 1;
  }
  const registration: RunnerRegistrationV1 = {
    schema_version: protocolVersions.runnerRegistration,
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    capabilities,
    scope: {
      project_id: String(parsed.cloud.project_id || "token_scope"),
      source_ids: [sourceId],
    },
    registered_at: new Date().toISOString(),
  };
  await client.register(registration);
  await client.runnerHeartbeat({
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    source_ids: [sourceId],
    status: "online",
    details: {
      mode: "cloud_connect",
      database_credentials_sent: false,
      adapter_catalog_supported: true,
      writeback_supported: true,
    },
  });
  process.stdout.write(`cloud connection ok for ${sourceId}\n`);
  process.stdout.write(`registered runner ${runnerId}\n`);
  process.stdout.write("sent metadata: runner id/version, engines, capabilities, and source id. Database URLs and credentials were not sent.\n");
  return 0;
}

async function mcp(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "serve") return mcpServe(rest);
  if (subcommand === "audit") return mcpAudit(rest);
  usage();
  return 2;
}

async function mcpServe(args: string[]): Promise<number> {
  await serveStdio({
    configPath: optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG,
    storePath: optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE,
  });
  return 0;
}

async function mcpAudit(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const target = firstPositional(args);
  if (!target) {
    throw new Error("mcp audit requires <target>");
  }
  const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "5000");
  const payload = await readMcpAuditTarget(target, args, timeoutMs);
  const report = auditMcpManifest(payload, { target });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatMcpAuditReport(report));
  return 0;
}

async function readMcpAuditTarget(target: string, args: string[], timeoutMs: number): Promise<unknown> {
  if (/^https?:\/\//i.test(target)) {
    return fetchRemoteMcpTools(target, args, timeoutMs);
  }
  if (target.startsWith("stdio:")) {
    const command = target.slice("stdio:".length).trim();
    if (!command) throw new Error("mcp audit stdio target requires a command after stdio:");
    return fetchStdioMcpTools(command, timeoutMs);
  }
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function fetchRemoteMcpTools(target: string, args: string[], timeoutMs: number): Promise<unknown> {
  const bearerEnv = optionalArg(args, "--bearer-env") ?? "SYNAPSOR_MCP_AUDIT_BEARER";
  const bearer = process.env[bearerEnv];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const response = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`mcp audit remote tools/list failed with HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStdioMcpTools(commandText: string, timeoutMs: number): Promise<unknown> {
  const [command, ...commandArgs] = splitCommand(commandText);
  if (!command) throw new Error("mcp audit stdio target requires a command");
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(new Error(`mcp audit stdio tools/list timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const response = parseJsonRpcResponse(stdout, 2);
      if (!response) {
        reject(new Error(`mcp audit stdio tools/list response not found${stderr ? `: ${stderr.slice(0, 240)}` : ""}`));
        return;
      }
      resolve(response);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synapsor-mcp-audit", version: "0.1.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
  });
}

async function proposals(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return proposalsList(rest);
  if (subcommand === "show") return proposalsShow(rest);
  if (subcommand === "approve") return proposalsApprove(rest);
  if (subcommand === "reject") return proposalsReject(rest);
  if (subcommand === "writeback-job") return proposalsWritebackJob(rest);
  usage();
  return 2;
}

async function replay(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "show") return replayShow(rest);
  if (subcommand === "export") return replayExport(rest);
  usage();
  return 2;
}

async function proposalsList(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const state = optionalArg(args, "--state") as LocalProposalState | undefined;
    const rows = store.listProposals(state);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ proposals: rows }, null, 2)}\n`);
      return 0;
    }
    if (rows.length === 0) {
      process.stdout.write("No proposals found.\n");
      return 0;
    }
    for (const proposal of rows) {
      process.stdout.write(formatProposalSummary(proposal));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const payload = { proposal, events: store.events(proposalId), receipts: store.receipts(proposalId) };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(formatProposalDetail(proposal));
      for (const event of payload.events) {
        process.stdout.write(`event ${event.event_id}: ${event.kind} by ${event.actor} at ${event.created_at}\n`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsApprove(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals approve requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Approve proposal ${proposalId} for guarded writeback?`);
    const updated = store.approveProposal(proposalId, {
      approver: optionalArg(args, "--actor") ?? process.env.USER ?? "local_operator",
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason: optionalArg(args, "--reason") ?? undefined,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : `approved ${updated.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsReject(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals reject requires <proposal_id>");
  const reason = optionalArg(args, "--reason");
  if (!reason) throw new Error("proposals reject requires --reason <text>");
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Reject proposal ${proposalId}?`);
    const updated = store.rejectProposal(proposalId, {
      actor: optionalArg(args, "--actor") ?? process.env.USER ?? "local_operator",
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : `rejected ${updated.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsWritebackJob(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals writeback-job requires <proposal_id>");
  const output = optionalArg(args, "--output");
  const store = await openLocalStore(args);
  try {
    const job = store.createWritebackJobFromProposal(proposalId, {
      project_id: optionalArg(args, "--project") ?? "local",
      runner_id: optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner",
      lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
    });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    if (output) {
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, text, "utf8");
      process.stdout.write(`created writeback job ${job.writeback_job_id} for ${proposalId} at ${output}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function replayShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("replay show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const replayRecord = store.replay(proposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(replayRecord, null, 2)}\n`);
    } else {
      process.stdout.write(`Replay ${replayRecord.replay_id}\n`);
      process.stdout.write(formatProposalDetail(replayRecord.proposal));
      process.stdout.write(`events: ${replayRecord.events.length}\n`);
      process.stdout.write(`receipts: ${replayRecord.receipts.length}\n`);
      process.stdout.write(`evidence bundles: ${replayRecord.evidence.length}\n`);
      process.stdout.write(`query audit records: ${replayRecord.query_audit.length}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function replayExport(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("replay export requires <proposal_id>");
  const output = optionalArg(args, "--output");
  if (!output) throw new Error("replay export requires --output <path>");
  const store = await openLocalStore(args);
  try {
    const replayRecord = store.replay(proposalId);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(replayRecord, null, 2)}\n`, "utf8");
    process.stdout.write(`exported ${replayRecord.replay_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function openLocalStore(args: string[]): Promise<ProposalStore> {
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  if (storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  return new ProposalStore(storePath);
}

async function writeFileGuarded(filePath: string, content: string, force: boolean): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!force) {
    try {
      await fs.access(resolved);
      throw new Error(`${filePath} already exists. Use --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(filePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function redactConfig(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactConfig(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    if (/(url|password|secret|token|key|credential)/i.test(key)) return "<redacted>";
    if (/^(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+|syn_wbr_)/i.test(value)) return "<redacted>";
  }
  return value;
}

function requireLocalProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}

async function confirmDangerousAction(args: string[], question: string): Promise<void> {
  if (args.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    throw new Error("approval/rejection requires --yes in noninteractive mode");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("confirmation declined");
    }
  } finally {
    rl.close();
  }
}

function optionalArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function firstPositional(args: string[]): string | undefined {
  const flagsWithValues = new Set([
    "--actor",
    "--bearer-env",
    "--config",
    "--engine",
    "--job",
    "--lease-seconds",
    "--mode",
    "--output",
    "--project",
    "--reason",
    "--runner",
    "--state",
    "--store",
    "--timeout-ms",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (flagsWithValues.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function positional(args: string[], index: number): string | undefined {
  return args.filter((arg, argIndex) => {
    if (arg.startsWith("--")) return false;
    const previous = args[argIndex - 1];
    return previous === undefined || !previous.startsWith("--");
  })[index];
}

function splitCommand(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "" = "";
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in stdio command");
  if (current) parts.push(current);
  return parts;
}

function parseJsonRpcResponse(stdout: string, id: number): unknown | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (parsed.id === id) return parsed;
    } catch {
      // Ignore non-JSON log lines emitted by MCP servers.
    }
  }
  return undefined;
}

function formatProposalSummary(proposal: StoredProposal): string {
  return [
    `${proposal.proposal_id}  ${proposal.state}  ${proposal.action}`,
    `  target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `  tenant: ${proposal.tenant_id}  source changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}

function formatProposalDetail(proposal: StoredProposal): string {
  const changeSet = proposal.change_set;
  const conflictGuard = changeSet.guards.expected_version;
  const evidenceItems = changeSet.evidence.items?.length ?? 0;
  return [
    `proposal: ${proposal.proposal_id}`,
    `state: ${proposal.state}`,
    `action: ${proposal.action}`,
    `principal: ${changeSet.principal.id} (${changeSet.principal.source})`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `primary key: ${changeSet.source.primary_key.column}=${formatScalar(changeSet.source.primary_key.value)}`,
    `approval: ${changeSet.approval.status}${changeSet.approval.required_role ? ` required role ${changeSet.approval.required_role}` : ""}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `allowed columns: ${changeSet.guards.allowed_columns.join(", ")}`,
    `conflict guard: ${conflictGuard.column || "none"}=${formatScalar(conflictGuard.value)}`,
    `evidence: ${changeSet.evidence.bundle_id}  query ${changeSet.evidence.query_fingerprint}  items ${evidenceItems}`,
    `writeback: ${changeSet.writeback.status} via ${changeSet.writeback.mode}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    "diff:",
    ...Object.keys(changeSet.patch).map((column) => {
      const before = changeSet.before[column as keyof typeof changeSet.before];
      const proposed = changeSet.after[column as keyof typeof changeSet.after];
      return `  ${column}: ${JSON.stringify(before)} -> ${JSON.stringify(proposed)}`;
    }),
  ].join("\n") + "\n";
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function toExecutionReceipt(job: WritebackJob, result: WritebackResult, dryRun: boolean): Record<string, unknown> {
  const affectedRows = result.affected_rows ?? 0;
  const terminalStatus = result.status === "applied" && !dryRun && affectedRows === 0 ? "already_applied" : result.status;
  const previousVersion = job.conflict_guard.kind === "version_column" ? job.conflict_guard.expected_value : undefined;
  const receiptHash = typeof result.result_hash === "string" && result.result_hash.startsWith("sha256:")
    ? result.result_hash
    : `sha256:${crypto.createHash("sha256").update(JSON.stringify({
      job_id: job.job_id,
      status: terminalStatus,
      affected_rows: affectedRows,
      error_code: result.error_code ?? null,
    })).digest("hex")}`;
  return {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: job.job_id,
    proposal_id: job.proposal_id,
    runner_id: result.runner_id,
    status: terminalStatus,
    rows_affected: affectedRows,
    idempotency_key: job.idempotency_key,
    previous_version: previousVersion,
    new_version: result.result_version,
    source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
    executed_at: result.completed_at ?? new Date().toISOString(),
    safe_error_code: result.error_code,
    receipt_hash: receiptHash,
  };
}

async function readJob(args: string[]): Promise<unknown> {
  const index = args.indexOf("--job");
  const jobPath = index >= 0 ? args[index + 1] : undefined;
  if (!jobPath) {
    throw new Error("--job <path> is required");
  }
  return JSON.parse(await fs.readFile(jobPath, "utf8"));
}

function starterLocalConfig(engine: "postgres" | "mysql", mode: string): Record<string, unknown> {
  const sourceName = engine === "postgres" ? "app_postgres" : "app_mysql";
  const readUrlEnv = engine === "postgres" ? "APP_POSTGRES_READ_URL" : "APP_MYSQL_READ_URL";
  const writeUrlEnv = engine === "postgres" ? "APP_POSTGRES_WRITE_URL" : "APP_MYSQL_WRITE_URL";
  return {
    version: 1,
    mode,
    storage: {
      sqlite_path: "./.synapsor/local.db",
    },
    sources: {
      [sourceName]: {
        engine,
        read_url_env: readUrlEnv,
        write_url_env: writeUrlEnv,
        statement_timeout_ms: 3000,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
    },
    capabilities: [
      {
        name: "records.inspect_record",
        kind: "read",
        source: sourceName,
        target: {
          schema: engine === "postgres" ? "public" : "app",
          table: "records",
          primary_key: "id",
          tenant_key: "tenant_id",
        },
        args: {
          record_id: {
            type: "string",
            required: true,
            max_length: 128,
          },
        },
        lookup: {
          id_from_arg: "record_id",
        },
        visible_columns: ["id", "tenant_id", "updated_at"],
        evidence: "required",
        max_rows: 1,
      },
    ],
  };
}

function starterCloudConfig(): Record<string, unknown> {
  return {
    version: 1,
    mode: "cloud",
    storage: {
      sqlite_path: "./.synapsor/local.db",
    },
    trusted_context: {
      provider: "cloud_session",
    },
    cloud: {
      base_url_env: "SYNAPSOR_CLOUD_BASE_URL",
      runner_token_env: "SYNAPSOR_RUNNER_TOKEN",
      runner_id: "synapsor_runner_local",
      runner_version: "0.1.0-alpha.0",
      project_id: "token_scope",
      adapter_id: "mcp.billing",
      source_id: "src_replace_me",
      engines: ["postgres", "mysql"],
      capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
      session: {},
    },
  };
}

function normalizeEngines(value: unknown): Array<"postgres" | "mysql"> {
  const requested = Array.isArray(value) ? value.map((engine) => String(engine).trim().toLowerCase()) : [];
  const engines = requested.filter((engine): engine is "postgres" | "mysql" => engine === "postgres" || engine === "mysql");
  return engines.length > 0 ? engines : ["postgres", "mysql"];
}

function normalizeCapabilities(value: unknown): string[] {
  const defaults = ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"];
  const capabilities = Array.isArray(value) ? value.map((capability) => String(capability).trim()).filter(Boolean) : [];
  return capabilities.length > 0 ? capabilities : defaults;
}

function usage(): void {
  process.stdout.write(`synapsor-runner

Commands:
  init [--engine postgres|mysql] [--mode read_only|shadow|review|cloud] [--output synapsor.runner.json] [--force]
  init --spec onboarding-selection.json --non-interactive [--output synapsor.runner.json] [--force]
  inspect --database-url-env SYNAPSOR_DATABASE_READ_URL [--engine auto|postgres|mysql] [--schema public] [--json]
  config validate [--config synapsor.runner.json] [--json]
  config show [--config synapsor.runner.json] [--redacted]
  doctor
  validate --job ./job.json
  apply --job ./job.json [--dry-run] [--store ./.synapsor/local.db]
  start
  runner start
  runner doctor
  cloud connect [--config ./synapsor.cloud.json]
  mcp serve [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  mcp audit ./tools-list.json [--json]
  proposals list [--store ./.synapsor/local.db] [--state pending_review] [--json]
  proposals show <proposal_id> [--store ./.synapsor/local.db] [--json]
  proposals approve <proposal_id> [--store ./.synapsor/local.db] [--actor local_user] [--yes]
  proposals reject <proposal_id> --reason "..." [--store ./.synapsor/local.db] [--yes]
  proposals writeback-job <proposal_id> [--store ./.synapsor/local.db] [--project local] [--runner local_runner] [--output job.json]
  replay show <proposal_id> [--store ./.synapsor/local.db] [--json]
  replay export <proposal_id> --output replay.json [--store ./.synapsor/local.db]
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
