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
  type GeneratedOnboardingFiles,
  type InspectEngine,
  type OnboardingSelectionSpec,
  type SchemaInspection,
  type TableInfo,
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
  if (command === "benchmark") return benchmark(rest);
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
  const inspectionJson = optionalArg(args, "--inspection-json");
  if (inspectionJson) {
    const inspection = JSON.parse(await fs.readFile(inspectionJson, "utf8")) as SchemaInspection;
    return initFromInspection(args, inspection, optionalArg(args, "--database-url-env") ?? "SYNAPSOR_DATABASE_READ_URL");
  }
  const databaseUrlEnv = optionalArg(args, "--database-url-env");
  if (databaseUrlEnv) {
    const engine = (optionalArg(args, "--engine") ?? "auto") as InspectEngine;
    if (!["postgres", "mysql", "auto"].includes(engine)) {
      throw new Error("init --engine must be postgres, mysql, or auto when --database-url-env is used");
    }
    const inspection = await inspectDatabase({
      engine,
      databaseUrlEnv,
      schema: optionalArg(args, "--schema"),
    });
    return initFromInspection(args, inspection, databaseUrlEnv);
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
  await writeGeneratedOnboardingFiles(output, generated, force);
  return 0;
}

async function initFromInspection(args: string[], inspection: SchemaInspection, databaseUrlEnv: string): Promise<number> {
  const tableName = optionalArg(args, "--table");
  if (!tableName) {
    const available = inspection.tables.slice(0, 12).map((table) => `${table.schema}.${table.name}`).join(", ");
    throw new Error(`init from inspection requires --table <name>. Available objects: ${available || "(none)"}`);
  }
  const schemaName = optionalArg(args, "--schema");
  const table = findInspectionTable(inspection, tableName, schemaName);
  if (!table) {
    throw new Error(`table not found in inspection: ${schemaName ? `${schemaName}.` : ""}${tableName}`);
  }
  const mode = optionalArg(args, "--mode") ?? "shadow";
  if (!["read_only", "shadow", "review"].includes(mode)) {
    throw new Error("init from inspection --mode must be read_only, shadow, or review");
  }
  const primaryKey = optionalArg(args, "--primary-key") ?? (table.primary_key.length === 1 ? table.primary_key[0] : undefined);
  if (!primaryKey) {
    throw new Error(`--primary-key is required for ${table.schema}.${table.name}; detected primary keys: ${table.primary_key.join(", ") || "none"}`);
  }
  const tenantKey = optionalArg(args, "--tenant-key") ?? table.suggestions.tenant_columns[0];
  const singleTenantDev = args.includes("--single-tenant-dev");
  if (!tenantKey && !singleTenantDev) {
    throw new Error(`--tenant-key is required for ${table.schema}.${table.name}, or pass --single-tenant-dev for a reviewed single-tenant dev source.`);
  }
  const conflictColumn = optionalArg(args, "--conflict-column") ?? table.suggestions.conflict_columns[0];
  if (mode !== "read_only" && !conflictColumn) {
    process.stderr.write(`warning: no conflict/version column selected for ${table.schema}.${table.name}; generated proposal will require weak-guard acknowledgement.\n`);
  }
  const visibleColumns = listArg(args, "--visible-columns") ?? table.suggestions.default_visible_columns;
  if (visibleColumns.length === 0) {
    throw new Error(`no visible columns selected for ${table.schema}.${table.name}; pass --visible-columns col1,col2`);
  }
  const patch = parsePatchFlags(args);
  if (mode !== "read_only" && Object.keys(patch).length === 0) {
    throw new Error(`${mode} init requires at least one --patch-fixed column=value or --patch-from-arg column=arg. Use --mode read_only for inspect-only tools.`);
  }
  const allowedColumns = listArg(args, "--allowed-columns") ?? Object.keys(patch);
  const spec: OnboardingSelectionSpec = {
    version: 1,
    engine: inspection.engine,
    mode: mode as "read_only" | "shadow" | "review",
    source_name: optionalArg(args, "--source-name"),
    read_url_env: databaseUrlEnv,
    write_url_env: optionalArg(args, "--write-url-env") ?? "SYNAPSOR_DATABASE_WRITE_URL",
    schema: table.schema,
    table: table.name,
    primary_key: primaryKey,
    tenant_key: tenantKey,
    single_tenant_dev: singleTenantDev,
    conflict_column: conflictColumn,
    namespace: optionalArg(args, "--namespace") ?? "source",
    object_name: optionalArg(args, "--object-name"),
    lookup_arg: optionalArg(args, "--lookup-arg"),
    visible_columns: visibleColumns,
    allowed_columns: allowedColumns,
    patch,
    trusted_context: {
      tenant_id_env: optionalArg(args, "--tenant-env") ?? "SYNAPSOR_TENANT_ID",
      principal_env: optionalArg(args, "--principal-env") ?? "SYNAPSOR_PRINCIPAL",
    },
    approval: {
      required_role: optionalArg(args, "--approval-role") ?? "local_reviewer",
    },
  };
  const generated = generateRunnerConfigFromSpec(spec);
  await writeGeneratedOnboardingFiles(optionalArg(args, "--output") ?? "synapsor.runner.json", generated, args.includes("--force"));
  process.stdout.write(`selected ${table.schema}.${table.name} from ${inspection.engine} inspection\n`);
  process.stdout.write(`exposed tools: ${(generated.config.capabilities as Array<{ name: string }>).map((capability) => capability.name).join(", ")}\n`);
  return 0;
}

async function writeGeneratedOnboardingFiles(output: string, generated: GeneratedOnboardingFiles, force: boolean): Promise<void> {
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
}

function findInspectionTable(inspection: SchemaInspection, tableName: string, schemaName?: string): TableInfo | undefined {
  const candidates = inspection.tables.filter((table) => {
    if (schemaName && table.schema !== schemaName) return false;
    return table.name === tableName || `${table.schema}.${table.name}` === tableName;
  });
  if (candidates.length === 1) return candidates[0];
  return candidates.find((table) => table.schema === schemaName) ?? candidates[0];
}

function listArg(args: string[], flag: string): string[] | undefined {
  const value = optionalArg(args, flag);
  if (!value) return undefined;
  return uniqueStrings(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function repeatedArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(String(args[index + 1]));
  }
  return values;
}

function parsePatchFlags(args: string[]): NonNullable<OnboardingSelectionSpec["patch"]> {
  const patch: NonNullable<OnboardingSelectionSpec["patch"]> = {};
  for (const binding of repeatedArgs(args, "--patch-fixed")) {
    const [column, ...rest] = binding.split("=");
    const value = rest.join("=");
    if (!column || rest.length === 0) throw new Error("--patch-fixed must use column=value");
    patch[column] = { fixed: parseFixedPatchValue(value) };
  }
  for (const binding of repeatedArgs(args, "--patch-from-arg")) {
    const [column, ...rest] = binding.split("=");
    const arg = rest.join("=");
    if (!column || !arg) throw new Error("--patch-from-arg must use column=arg_name");
    patch[column] = { from_arg: arg };
  }
  return patch;
}

function parseFixedPatchValue(value: string): string | number | boolean | null {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
  if (subcommand === "migrate") return configMigrate(args.slice(1));
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

async function configMigrate(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const outputPath = optionalArg(args, "--output");
  const write = args.includes("--write") || Boolean(outputPath);
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  const version = Number((parsed as { version?: unknown }).version ?? 1);
  if (version !== 1) {
    throw new Error(`unsupported config version ${String((parsed as { version?: unknown }).version)}; no automatic widening migration is available`);
  }
  const validation = validateRunnerCapabilityConfig(parsed);
  if (!validation.ok) {
    throw new Error(`cannot migrate invalid config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
  }
  const normalized = normalizeConfigForMigration(parsed);
  if (!write) {
    process.stdout.write(`config already current: version ${version}\n`);
    process.stdout.write("No file written. Use --output <path> or --write --yes to write a normalized copy.\n");
    return 0;
  }
  const destination = outputPath ? path.resolve(outputPath) : path.resolve(configPath);
  process.stderr.write(`Destination: ${destination}\n`);
  if (!outputPath) {
    process.stderr.write("Existing config will be backed up before writing.\n");
  }
  await confirmDangerousAction(args.includes("--yes") ? ["--yes"] : [], "Write migrated config?");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!outputPath) {
    const backupPath = `${destination}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(path.resolve(configPath), backupPath);
    process.stderr.write(`Backup: ${backupPath}\n`);
  }
  await fs.writeFile(destination, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote migrated config: ${destination}\n`);
  return 0;
}

function normalizeConfigForMigration(config: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  clone.version = 1;
  return clone;
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
  const configPath = optionalArg(args, "--config") ?? (await fileExists("synapsor.runner.json") ? "synapsor.runner.json" : undefined);
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  if (configPath) {
    if (!dryRun && !storePath) {
      throw new Error("local config writeback apply requires --store so proposal approval and digest can be verified");
    }
    await verifyLocalWritebackAuthority(job, configPath, storePath);
  }
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

async function verifyLocalWritebackAuthority(job: WritebackJob, configPath: string, storePath?: string): Promise<void> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`cannot apply writeback with invalid local config: ${validation.errors.map((error) => error.code).join(", ")}`);
  }
  if (config.mode !== "review") {
    throw new Error(`local writeback apply requires review mode, got ${config.mode}`);
  }
  const source = config.sources?.[job.source_id];
  if (!source) {
    throw new Error(`writeback source ${job.source_id} is not present in reviewed config`);
  }
  if (source.engine !== job.engine) {
    throw new Error(`writeback engine ${job.engine} does not match reviewed source ${job.source_id}`);
  }
  if (Date.parse(String(job.lease_expires_at)) < Date.now()) {
    throw new Error("writeback job lease has expired");
  }
  const proposalCapabilities = (config.capabilities ?? []).filter((capability) => capability.kind === "proposal" && capability.source === job.source_id);
  const matching = proposalCapabilities.find((capability) => capabilityMatchesJob(capability, job));
  if (!matching) {
    throw new Error("writeback job does not match any reviewed proposal capability in local config");
  }
  const reviewedAllowed = new Set(matching.allowed_columns ?? []);
  for (const column of job.allowed_columns) {
    if (!reviewedAllowed.has(column)) {
      throw new Error(`writeback job allowlist widens reviewed authority: ${column}`);
    }
  }
  for (const column of Object.keys(job.patch)) {
    if (!reviewedAllowed.has(column)) {
      throw new Error(`writeback patch column is not reviewed by local config: ${column}`);
    }
  }
  if (matching.conflict_guard?.column && job.conflict_guard.kind === "version_column" && matching.conflict_guard.column !== job.conflict_guard.column) {
    throw new Error("writeback conflict guard does not match reviewed capability");
  }
  if (storePath) {
    const store = new ProposalStore(storePath);
    try {
      const proposal = store.getProposal(job.proposal_id);
      if (!proposal) throw new Error(`local proposal not found for writeback job: ${job.proposal_id}`);
      if (proposal.state !== "approved" && proposal.state !== "pending_worker" && proposal.state !== "applied") {
        throw new Error(`local proposal ${job.proposal_id} is ${proposal.state}, not approved for writeback`);
      }
      if (proposal.proposal_hash !== job.approval_id) {
        throw new Error("writeback approval/proposal digest does not match local proposal");
      }
    } finally {
      store.close();
    }
  }
}

function capabilityMatchesJob(capability: NonNullable<RuntimeConfig["capabilities"]>[number], job: WritebackJob): boolean {
  if (capability.target.schema !== job.target.schema) return false;
  if (capability.target.table !== job.target.table) return false;
  if (capability.target.primary_key !== job.target.primary_key.column) return false;
  if (!capability.target.tenant_key || capability.target.tenant_key !== job.target.tenant_guard.column) return false;
  const reviewedAllowed = new Set(capability.allowed_columns ?? []);
  if (reviewedAllowed.size === 0) return false;
  return Object.keys(job.patch).every((column) => reviewedAllowed.has(column));
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
  if (subcommand === "configure") return mcpConfigure(rest);
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

async function mcpConfigure(args: string[]): Promise<number> {
  const client = optionalArg(args, "--client");
  if (!client) throw new Error("mcp configure requires --client generic-stdio|claude-desktop|cursor|vscode");
  const configPath = optionalArg(args, "--config") ?? "./synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const snippet = mcpClientSnippet(client, configPath, storePath);
  if (args.includes("--write")) {
    const destination = optionalArg(args, "--destination");
    if (!destination) throw new Error("mcp configure --write requires --destination <path>");
    await writeMcpClientSnippet(destination, client, snippet, args.includes("--yes"));
    process.stdout.write(`wrote MCP ${client} configuration to ${destination}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
  }
  return 0;
}

function mcpClientSnippet(client: string, configPath: string, storePath: string): Record<string, unknown> {
  const command = "synapsor";
  const args = ["mcp", "serve", "--config", configPath, "--store", storePath];
  if (client === "generic" || client === "generic-stdio") return { command, args };
  if (client === "claude-desktop" || client === "cursor") {
    return { mcpServers: { synapsor: { command, args } } };
  }
  if (client === "vscode") {
    return { servers: { synapsor: { type: "stdio", command, args } } };
  }
  throw new Error(`unsupported MCP client: ${client}`);
}

async function writeMcpClientSnippet(destination: string, client: string, snippet: Record<string, unknown>, yes: boolean): Promise<void> {
  const resolved = path.resolve(destination);
  let existing: Record<string, unknown> = {};
  let hadExisting = false;
  try {
    existing = JSON.parse(await fs.readFile(resolved, "utf8")) as Record<string, unknown>;
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged = mergeMcpClientSnippet(client, existing, snippet);
  JSON.parse(JSON.stringify(merged));
  process.stderr.write(`Destination: ${resolved}\n`);
  if (hadExisting) {
    process.stderr.write("Existing file will be backed up before writing.\n");
  }
  await confirmDangerousAction(yes ? ["--yes"] : [], "Write MCP client configuration?");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  if (hadExisting) {
    const backupPath = `${resolved}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(resolved, backupPath);
    process.stderr.write(`Backup: ${backupPath}\n`);
  }
  await fs.writeFile(resolved, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function mergeMcpClientSnippet(client: string, existing: Record<string, unknown>, snippet: Record<string, unknown>): Record<string, unknown> {
  if (client === "generic" || client === "generic-stdio") return snippet;
  if (client === "claude-desktop" || client === "cursor") {
    const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
    const snippetServers = isRecord(snippet.mcpServers) ? snippet.mcpServers : {};
    return { ...existing, mcpServers: { ...existingServers, ...snippetServers } };
  }
  if (client === "vscode") {
    const existingServers = isRecord(existing.servers) ? existing.servers : {};
    const snippetServers = isRecord(snippet.servers) ? snippet.servers : {};
    return { ...existing, servers: { ...existingServers, ...snippetServers } };
  }
  throw new Error(`unsupported MCP client: ${client}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function benchmark(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand !== "mcp-efficiency") {
    usage();
    return 2;
  }
  const report = buildMcpEfficiencyBenchmark();
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatMcpEfficiencyBenchmark(report));
  return 0;
}

type BenchmarkPath = {
  name: string;
  tools: Array<Record<string, unknown>>;
  scripted_plan: string[];
  schema_context: Record<string, unknown>;
  business_result: Record<string, unknown>;
  exposes_raw_sql: boolean;
  exposes_write_credentials: boolean;
  approval_separated: boolean;
  stale_row_conflict_checked: boolean;
};

type BenchmarkMeasurement = {
  exposed_tools: number;
  serialized_tools_list_bytes: number;
  serialized_tools_list_tokens: number;
  schema_context_bytes: number;
  schema_context_tokens: number;
  business_result_bytes: number;
  business_result_tokens: number;
  scripted_tool_calls: number;
  exposes_raw_sql: boolean;
  exposes_write_credentials: boolean;
  approval_separated: boolean;
  stale_row_conflict_checked: boolean;
};

function buildMcpEfficiencyBenchmark(): Record<string, unknown> {
  const genericPath: BenchmarkPath = {
    name: "generic_database_mcp_reference",
    tools: [
      {
        name: "list_tables",
        description: "List available database tables.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "describe_table",
        description: "Describe columns and indexes for an arbitrary table.",
        input_schema: {
          type: "object",
          properties: {
            schema: { type: "string" },
            table: { type: "string" },
          },
          required: ["table"],
          additionalProperties: false,
        },
      },
      {
        name: "query_database",
        description: "Run a read query against the database.",
        input_schema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
          required: ["sql"],
          additionalProperties: false,
        },
      },
      {
        name: "execute_sql",
        description: "Execute a SQL statement that may modify database state.",
        input_schema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
          required: ["sql"],
          additionalProperties: false,
        },
      },
    ],
    scripted_plan: [
      "list_tables",
      "describe_table invoices",
      "query_database SELECT invoice",
      "formulate raw UPDATE",
      "execute_sql UPDATE invoice",
    ],
    schema_context: {
      tables: {
        invoices: {
          columns: ["id", "tenant_id", "customer_id", "late_fee_cents", "waiver_reason", "status", "updated_at"],
          primary_key: "id",
          tenant_key: "tenant_id",
          mutable_columns: "not enforced by tool schema",
        },
      },
    },
    business_result: {
      row: { id: "INV-3001", tenant_id: "acme", late_fee_cents: 5500, status: "overdue", updated_at: "2026-06-20T14:31:08Z" },
      planned_sql: "UPDATE invoices SET late_fee_cents = 0 WHERE id = 'INV-3001';",
    },
    exposes_raw_sql: true,
    exposes_write_credentials: false,
    approval_separated: false,
    stale_row_conflict_checked: false,
  };

  const semanticPath: BenchmarkPath = {
    name: "synapsor_runner_semantic_path",
    tools: [
      {
        name: "billing.inspect_invoice",
        description: "Inspect one invoice within trusted tenant scope and return reviewed evidence fields.",
        input_schema: {
          type: "object",
          properties: { invoice_id: { type: "string", maxLength: 128 } },
          required: ["invoice_id"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "billing.propose_late_fee_waiver",
        description: "Create a review-required proposal to waive one invoice late fee; source DB remains unchanged.",
        input_schema: {
          type: "object",
          properties: {
            invoice_id: { type: "string", maxLength: 128 },
            reason: { type: "string", maxLength: 500 },
          },
          required: ["invoice_id", "reason"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: false },
      },
    ],
    scripted_plan: [
      "billing.inspect_invoice",
      "billing.propose_late_fee_waiver",
    ],
    schema_context: {
      capability: "billing.propose_late_fee_waiver",
      target: "public.invoices",
      trusted_scope: ["tenant_id from SYNAPSOR_TENANT_ID", "principal from SYNAPSOR_PRINCIPAL"],
      visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      conflict_guard: "updated_at",
    },
    business_result: {
      status: "review_required",
      proposal_id: "wrp_fixture",
      source_database_changed: false,
      diff: {
        late_fee_cents: { before: 5500, proposed: 0 },
        waiver_reason: { before: null, proposed: "customer requested review" },
      },
      approval: { status: "pending", required_role: "billing_lead" },
    },
    exposes_raw_sql: false,
    exposes_write_credentials: false,
    approval_separated: true,
    stale_row_conflict_checked: true,
  };

  return {
    benchmark: "mcp-efficiency",
    fixture: "late-fee-waiver",
    tokenizer: {
      name: "synapsor-fixture-tokenizer-v1",
      version: 1,
      method: "deterministic regex tokenization for fixture comparison; not a model billing tokenizer",
    },
    note: "This benchmark compares the included fixture/reference workflow only. It is not a universal token-savings claim.",
    paths: {
      [genericPath.name]: measureBenchmarkPath(genericPath),
      [semanticPath.name]: measureBenchmarkPath(semanticPath),
    },
    scripted_plans: {
      [genericPath.name]: genericPath.scripted_plan,
      [semanticPath.name]: semanticPath.scripted_plan,
    },
  };
}

function measureBenchmarkPath(pathSpec: BenchmarkPath): BenchmarkMeasurement {
  const toolsJson = JSON.stringify({ tools: pathSpec.tools });
  const schemaContextJson = JSON.stringify(pathSpec.schema_context);
  const businessResultJson = JSON.stringify(pathSpec.business_result);
  return {
    exposed_tools: pathSpec.tools.length,
    serialized_tools_list_bytes: Buffer.byteLength(toolsJson, "utf8"),
    serialized_tools_list_tokens: countFixtureTokens(toolsJson),
    schema_context_bytes: Buffer.byteLength(schemaContextJson, "utf8"),
    schema_context_tokens: countFixtureTokens(schemaContextJson),
    business_result_bytes: Buffer.byteLength(businessResultJson, "utf8"),
    business_result_tokens: countFixtureTokens(businessResultJson),
    scripted_tool_calls: pathSpec.scripted_plan.length,
    exposes_raw_sql: pathSpec.exposes_raw_sql,
    exposes_write_credentials: pathSpec.exposes_write_credentials,
    approval_separated: pathSpec.approval_separated,
    stale_row_conflict_checked: pathSpec.stale_row_conflict_checked,
  };
}

function countFixtureTokens(text: string): number {
  return text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0;
}

function formatMcpEfficiencyBenchmark(report: Record<string, unknown>): string {
  const paths = report.paths as Record<string, BenchmarkMeasurement>;
  const generic = paths.generic_database_mcp_reference;
  const semantic = paths.synapsor_runner_semantic_path;
  if (!generic || !semantic) {
    throw new Error("benchmark report is missing expected fixture paths");
  }
  const lines = [
    "MCP efficiency benchmark: late-fee-waiver fixture",
    "Tokenizer: synapsor-fixture-tokenizer-v1 (deterministic fixture tokenizer; not a model billing tokenizer)",
    "Scope: included fixture/reference workflow only; not a universal savings claim.",
    "",
    "Generic database MCP reference:",
    `  exposed tools: ${generic.exposed_tools}`,
    `  tools/list: ${generic.serialized_tools_list_bytes} bytes, ${generic.serialized_tools_list_tokens} tokens`,
    `  scripted tool calls: ${generic.scripted_tool_calls}`,
    `  schema/context: ${generic.schema_context_bytes} bytes, ${generic.schema_context_tokens} tokens`,
    `  business result: ${generic.business_result_bytes} bytes, ${generic.business_result_tokens} tokens`,
    `  raw SQL exposed: ${generic.exposes_raw_sql ? "yes" : "no"}`,
    `  approval separated: ${generic.approval_separated ? "yes" : "no"}`,
    `  stale-row conflict checked: ${generic.stale_row_conflict_checked ? "yes" : "no"}`,
    "",
    "Synapsor Runner semantic path:",
    `  exposed tools: ${semantic.exposed_tools}`,
    `  tools/list: ${semantic.serialized_tools_list_bytes} bytes, ${semantic.serialized_tools_list_tokens} tokens`,
    `  scripted tool calls: ${semantic.scripted_tool_calls}`,
    `  schema/context: ${semantic.schema_context_bytes} bytes, ${semantic.schema_context_tokens} tokens`,
    `  business result: ${semantic.business_result_bytes} bytes, ${semantic.business_result_tokens} tokens`,
    `  raw SQL exposed: ${semantic.exposes_raw_sql ? "yes" : "no"}`,
    `  approval separated: ${semantic.approval_separated ? "yes" : "no"}`,
    `  stale-row conflict checked: ${semantic.stale_row_conflict_checked ? "yes" : "no"}`,
    "",
    "Run with --json to inspect machine-readable measurements and scripted plans.",
  ];
  return `${lines.join("\n")}\n`;
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
  init --database-url-env SYNAPSOR_DATABASE_READ_URL --engine auto --table invoices --namespace billing --patch-from-arg waiver_reason=reason [--patch-fixed late_fee_cents=0]
  init --inspection-json schema-inspection.json --table invoices --namespace billing --patch-from-arg waiver_reason=reason
  inspect --database-url-env SYNAPSOR_DATABASE_READ_URL [--engine auto|postgres|mysql] [--schema public] [--json]
  config validate [--config synapsor.runner.json] [--json]
  config show [--config synapsor.runner.json] [--redacted]
  config migrate [--config synapsor.runner.json] [--output migrated.json]
  config migrate --config synapsor.runner.json --write --yes
  doctor
  validate --job ./job.json
  apply --job ./job.json [--config synapsor.runner.json] [--dry-run] [--store ./.synapsor/local.db]
  start
  runner start
  runner doctor
  cloud connect [--config ./synapsor.cloud.json]
  mcp serve [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  mcp audit ./tools-list.json [--json]
  mcp configure --client generic-stdio|claude-desktop|cursor|vscode [--print] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  mcp configure --client claude-desktop --write --destination ./client-config.json [--yes]
  benchmark mcp-efficiency [--json]
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
