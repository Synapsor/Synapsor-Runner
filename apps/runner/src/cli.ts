#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { createMcpRuntime, serveStdio, type RuntimeCapabilityConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";
import { parseWritebackJob, protocolVersions, type ExecutionReceiptV1, type RunnerRegistrationV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
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
import { startLocalUiServer } from "./local-ui.js";

const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };
const handlerReceiptStatuses = new Set(["applied", "already_applied", "conflict", "failed"]);
const defaultConfigPath = "synapsor.runner.json";
const defaultStorePath = "./.synapsor/local.db";
const referenceDemoDir = "examples/reference-support-billing-app";
const referenceDemoConfigPath = `${referenceDemoDir}/synapsor.runner.json`;
const referenceDemoContainer = "synapsor_runner_reference_support_billing";
const referenceDemoDatabase = "synapsor_reference_support_billing";
const referenceDemoEnv: Record<string, string> = {
  REFERENCE_POSTGRES_READ_URL: "postgresql://synapsor_reader:synapsor_reader_password@localhost:55435/synapsor_reference_support_billing",
  REFERENCE_POSTGRES_WRITE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "local_reviewer",
  SYNAPSOR_ENGINE: "postgres",
  SYNAPSOR_DATABASE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
  SYNAPSOR_RUNNER_ID: "synapsor_demo_runner",
  SYNAPSOR_SOURCE_ID: "app_postgres",
  SYNAPSOR_CONTROL_PLANE_URL: "http://127.0.0.1:0",
  SYNAPSOR_RUNNER_TOKEN: "syn_wbr_demo_local",
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage([]);
    return 0;
  }
  if (isHelpRequest(rest)) {
    usage([command, ...rest.filter((arg) => arg !== "--help" && arg !== "-h")]);
    return 0;
  }
  if (command === "help") {
    usage(rest);
    return 0;
  }
  if (command === "init") return init(rest);
  if (command === "inspect") return inspect(rest);
  if (command === "config") return configCommand(rest);
  if (command === "doctor") return doctor(rest);
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "propose") return propose(rest);
  if (command === "audit") return audit(rest);
  if (command === "start") return start();
  if (command === "runner") return runnerCommand(rest);
  if (command === "cloud") return cloud(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "tools") return tools(rest);
  if (command === "onboard") return onboard(rest);
  if (command === "demo") return demo(rest);
  if (command === "recipes") return recipes(rest);
  if (command === "benchmark") return benchmark(rest);
  if (command === "proposals") return proposals(rest);
  if (command === "replay") return replay(rest);
  if (command === "shadow") return shadow(rest);
  if (command === "ui") return ui(rest);
  usage([]);
  return 2;
}

async function init(args: string[]): Promise<number> {
  const specPath = optionalArg(args, "--spec");
  if (specPath) {
    return initFromSpec(args, specPath);
  }
  if (args.includes("--wizard") || (process.stdin.isTTY && process.stdout.isTTY && !args.includes("--starter"))) {
    return runInitWizard(args);
  }
  const inspectionJson = optionalArg(args, "--inspection-json");
  if (inspectionJson) {
    const inspection = JSON.parse(await fs.readFile(inspectionJson, "utf8")) as SchemaInspection;
    const databaseInput = databaseInputFromArgs(args);
    return initFromInspection(args, inspection, databaseInput.configDatabaseUrlEnv);
  }
  const databaseInput = databaseInputFromArgs(args);
  if (databaseInput.explicit) {
    const engine = (optionalArg(args, "--engine") ?? "auto") as InspectEngine;
    if (!["postgres", "mysql", "auto"].includes(engine)) {
      throw new Error("init --engine must be postgres, mysql, or auto when --from, --from-env, or --database-url-env is used");
    }
    const inspection = await inspectDatabase({
      engine,
      databaseUrlEnv: databaseInput.inspectionDatabaseUrlEnv,
      schema: optionalArg(args, "--schema"),
      env: databaseInput.env,
    });
    return initFromInspection(args, inspection, databaseInput.configDatabaseUrlEnv);
  }
  const output = outputArg(args) ?? "synapsor.runner.json";
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

type WizardAsk = (question: string, defaultValue?: string) => Promise<string>;

export async function runInitWizard(
  args: string[],
  options: {
    ask?: WizardAsk;
    env?: NodeJS.ProcessEnv;
    inspection?: SchemaInspection;
    stdout?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<number> {
  const ask = options.ask ?? askTtyQuestion;
  const stdout = options.stdout ?? process.stdout;
  stdout.write("Synapsor Runner guided init\n");
  stdout.write("Use a staging or disposable Postgres/MySQL database first. The wizard stores environment-variable names, not credentials.\n\n");

  const engineInput = await askChoice(ask, "Engine", optionalArg(args, "--engine") ?? "auto", ["postgres", "mysql", "auto"]);
  const databaseInput = databaseInputFromArgs(args);
  if (databaseInput.inlineUrl) {
    stdout.write("Using the command-line connection string for schema inspection only. The generated config will store an environment-variable name, not the URL.\n");
  }
  const configDatabaseUrlEnv = await askEnvName(ask, "Read URL environment variable for generated config", databaseInput.configDatabaseUrlEnv);
  const inspection = options.inspection ?? await inspectDatabase({
    engine: engineInput as InspectEngine,
    databaseUrlEnv: databaseInput.inspectionDatabaseUrlEnv,
    schema: optionalArg(args, "--schema"),
    env: databaseInput.env ?? options.env ?? process.env,
  });
  stdout.write(summarizeInspection(inspection));
  stdout.write("\n");

  const schema = await askDefault(ask, "Schema/database to inspect", optionalArg(args, "--schema") ?? inspection.schemas[0] ?? "public");
  const tables = inspection.tables.filter((table) => table.schema === schema);
  if (tables.length === 0) throw new Error(`no tables/views found in schema ${schema}`);
  stdout.write("Available objects:\n");
  for (const table of tables.slice(0, 20)) {
    stdout.write(`  - ${table.schema}.${table.name} (${table.type}, pk=${table.primary_key.join(",") || "none"}, tenant=${table.suggestions.tenant_columns.join(",") || "none"})\n`);
  }
  const tableName = await askDefault(ask, "Table/view for this capability", optionalArg(args, "--table") ?? tables[0]?.name ?? "");
  const table = findInspectionTable(inspection, tableName, schema);
  if (!table) throw new Error(`table not found in inspection: ${schema}.${tableName}`);
  const columns = table.columns.map((column) => column.name);

  const primaryKey = await askColumn(ask, "Primary-key column", optionalArg(args, "--primary-key") ?? table.primary_key[0] ?? inferPrimaryKeyCandidate(table), columns);
  const suggestedTenant = optionalArg(args, "--tenant-key") ?? table.suggestions.tenant_columns[0];
  const tenantAnswer = await askDefault(ask, "Tenant/scope column. Leave blank only for a reviewed single-tenant dev source", suggestedTenant ?? "");
  const singleTenantDev = !tenantAnswer && (await askDefault(ask, "No tenant column selected. Type yes to mark this as a single-tenant dev source", "no")).toLowerCase() === "yes";
  if (!tenantAnswer && !singleTenantDev) throw new Error("tenant/scope column is required unless single-tenant dev source is explicitly confirmed");
  if (tenantAnswer && !columns.includes(tenantAnswer)) throw new Error(`tenant column ${tenantAnswer} does not exist on ${table.schema}.${table.name}`);

  const mode = await askChoice(ask, "Mode", optionalArg(args, "--mode") ?? "read_only", ["read_only", "shadow", "review"]);
  const conflictAnswer = mode === "read_only"
    ? optionalArg(args, "--conflict-column") ?? ""
    : await askDefault(ask, "Conflict/version column", optionalArg(args, "--conflict-column") ?? table.suggestions.conflict_columns[0] ?? "");
  if (conflictAnswer && !columns.includes(conflictAnswer)) throw new Error(`conflict column ${conflictAnswer} does not exist on ${table.schema}.${table.name}`);
  const defaultVisible = table.suggestions.default_visible_columns.join(",");
  let visibleColumns = parseColumnList(await askDefault(ask, "Read-visible columns", optionalArg(args, "--visible-columns") ?? defaultVisible));
  ensureColumnsExist(visibleColumns, columns, "visible");

  if (mode !== "read_only" && !conflictAnswer) {
    const weak = await askDefault(ask, "No conflict/version column selected. Type yes to continue with a weak guard", "no");
    if (weak.toLowerCase() !== "yes") throw new Error("conflict/version column is required unless weak guard is explicitly acknowledged");
  }
  let recipeSpec: OnboardingSelectionSpec | undefined;
  if (mode !== "read_only") {
    const actionSetup = await askChoice(ask, "Business action setup", optionalArg(args, "--recipe") ? "recipe" : "manual", ["manual", "recipe"]);
    if (actionSetup === "recipe") {
      const recipes = await loadBuiltInRecipes();
      stdout.write("Available recipes:\n");
      for (const recipe of recipes) {
        stdout.write(`  - ${recipe.id}: ${recipe.summary}\n`);
      }
      const recipeId = await askDefault(ask, "Recipe id", optionalArg(args, "--recipe") ?? recipes[0]?.id ?? "");
      const recipe = await requireRecipe(recipeId);
      stdout.write(`Mapping recipe ${recipe.id} to ${table.schema}.${table.name}\n`);
      const columnMap: Record<string, string> = {};
      const recipeFields = recipeColumns(recipe);
      for (const field of recipeFields) {
        const mapped = await askColumn(ask, `Recipe field ${field} maps to column`, columns.includes(field) ? field : undefined, columns);
        columnMap[field] = mapped;
      }
      recipeSpec = remapRecipeSpec(recipe.spec, columnMap);
      visibleColumns = uniqueStrings([...visibleColumns, ...(recipeSpec.visible_columns ?? [])]);
      ensureColumnsExist(visibleColumns, columns, "visible");
    }
  }

  let patch: NonNullable<OnboardingSelectionSpec["patch"]> = {};
  let patchArgs: OnboardingSelectionSpec["patch_args"] = undefined;
  let allowedColumns: string[] | undefined;
  let numericBounds: OnboardingSelectionSpec["numeric_bounds"] = undefined;
  let transitionGuards: OnboardingSelectionSpec["transition_guards"] = undefined;
  if (mode !== "read_only") {
    const patchable = columns.filter((column) => !new Set([primaryKey, tenantAnswer, conflictAnswer].filter(Boolean)).has(column));
    const defaultPatch = recipeSpec?.patch
      ? formatPatchMappings(recipeSpec.patch)
      : optionalArg(args, "--patch-from-arg")
      ? repeatedArgs(args, "--patch-from-arg").map((binding) => `${binding.split("=")[0]}=arg:${binding.split("=").slice(1).join("=")}`).join(",")
      : `${patchable[0] ?? columns[0]}=arg:value`;
    const patchInput = await askDefault(ask, "Proposal patch mappings (column=arg:name or column=fixed:value, comma-separated)", defaultPatch);
    const parsed = parseWizardPatchMappings(patchInput);
    patch = parsed.patch;
    patchArgs = { ...(recipeSpec?.patch_args ?? {}), ...(parsed.patchArgs ?? {}) };
    if (Object.keys(patchArgs).length === 0) patchArgs = undefined;
    allowedColumns = recipeSpec?.allowed_columns ?? Object.keys(patch);
    ensureColumnsExist(allowedColumns, columns, "patch");
    const numericBoundsInput = await askDefault(
      ask,
      "Numeric patch bounds (optional, column=minimum:maximum, comma-separated)",
      formatNumericBounds(recipeSpec?.numeric_bounds ?? parseNumericBoundsFlags(args)),
    );
    numericBounds = parseNumericBoundsInput(numericBoundsInput);
    if (numericBounds) ensureColumnsExist(Object.keys(numericBounds), columns, "numeric bound");
    const transitionInput = await askDefault(
      ask,
      "Status transition guards (optional, column=from:to|to;from:to, comma-separated)",
      formatTransitionGuards(recipeSpec?.transition_guards ?? parseTransitionGuardFlags(args)),
    );
    transitionGuards = parseTransitionGuardsInput(transitionInput);
    if (transitionGuards) {
      ensureColumnsExist(Object.keys(transitionGuards), columns, "transition guard");
      const transitionFromColumns = Object.values(transitionGuards).map((guard) => guard.from_column).filter((value): value is string => Boolean(value));
      if (transitionFromColumns.length > 0) ensureColumnsExist(transitionFromColumns, columns, "transition from");
    }
  }

  const namespace = await askDefault(ask, "Capability namespace", optionalArg(args, "--namespace") ?? recipeSpec?.namespace ?? "source");
  const objectName = await askDefault(ask, "Business object name", optionalArg(args, "--object-name") ?? recipeSpec?.object_name ?? safeObjectName(table.name));
  const lookupArg = await askDefault(ask, "Model-visible object id argument", optionalArg(args, "--lookup-arg") ?? recipeSpec?.lookup_arg ?? `${objectName}_id`);
  const tenantEnv = await askEnvName(ask, "Trusted tenant env var", optionalArg(args, "--tenant-env") ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = await askEnvName(ask, "Trusted principal env var", optionalArg(args, "--principal-env") ?? "SYNAPSOR_PRINCIPAL");
  const writeUrlEnv = mode === "review"
    ? await askEnvName(ask, "Write URL env var for trusted apply path", optionalArg(args, "--write-url-env") ?? "SYNAPSOR_DATABASE_WRITE_URL")
    : optionalArg(args, "--write-url-env") ?? "SYNAPSOR_DATABASE_WRITE_URL";
  const approvalRole = mode === "read_only" ? "local_reviewer" : await askDefault(ask, "Required approval role", optionalArg(args, "--approval-role") ?? recipeSpec?.approval?.required_role ?? "local_reviewer");

  const spec: OnboardingSelectionSpec = {
    version: 1,
    engine: inspection.engine,
    mode: mode as "read_only" | "shadow" | "review",
    source_name: optionalArg(args, "--source-name"),
    read_url_env: configDatabaseUrlEnv,
    write_url_env: writeUrlEnv,
    schema: table.schema,
    table: table.name,
    primary_key: primaryKey,
    tenant_key: tenantAnswer || undefined,
    single_tenant_dev: singleTenantDev,
    conflict_column: conflictAnswer || undefined,
    namespace,
    object_name: objectName,
    inspect_tool_name: recipeSpec?.inspect_tool_name,
    proposal_tool_name: recipeSpec?.proposal_tool_name,
    lookup_arg: lookupArg,
    visible_columns: visibleColumns,
    allowed_columns: allowedColumns,
    patch,
    patch_args: patchArgs,
    numeric_bounds: numericBounds,
    transition_guards: transitionGuards,
    trusted_context: {
      tenant_id_env: tenantEnv,
      principal_env: principalEnv,
    },
    approval: {
      required_role: approvalRole,
    },
  };
  const generated = generateRunnerConfigFromSpec(spec);
  const tools = (generated.config.capabilities as Array<{ name: string; kind: string }>).map((capability) => `${capability.name} (${capability.kind})`);
  stdout.write("\nPreview:\n");
  stdout.write(`  source: ${inspection.engine} ${table.schema}.${table.name}\n`);
  stdout.write(`  mode: ${mode}\n`);
  stdout.write(`  exposed tools: ${tools.join(", ")}\n`);
  stdout.write("  not exposed: execute_sql, approval tools, commit tools, database URLs, write credentials, model-controlled tenant authority\n");
  const confirmed = await askDefault(ask, "Write generated config and MCP snippets? Type yes to continue", "no");
  if (confirmed.toLowerCase() !== "yes") throw new Error("guided init canceled before writing files");
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, args.includes("--force"));
  stdout.write(`Next: run \`${cliCommandName()} doctor --config synapsor.runner.json\`, then \`${cliCommandName()} mcp serve --config synapsor.runner.json --store ./.synapsor/local.db\`.\n`);
  return 0;
}

async function initFromSpec(args: string[], specPath: string): Promise<number> {
  if (!args.includes("--non-interactive")) {
    throw new Error("init --spec requires --non-interactive so reviewed selections are explicit.");
  }
  const output = outputArg(args) ?? "synapsor.runner.json";
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
  const primaryKey = optionalArg(args, "--primary-key") ?? (table.primary_key.length === 1 ? table.primary_key[0] : inferPrimaryKeyCandidate(table));
  if (!primaryKey) {
    throw new Error(`--primary-key is required for ${table.schema}.${table.name}; detected primary keys: ${table.primary_key.join(", ") || "none"}`);
  }
  if (table.primary_key.length === 0 && primaryKey) {
    process.stderr.write(`warning: no database primary-key constraint detected for ${table.schema}.${table.name}; using candidate column ${primaryKey}. Verify uniqueness before enabling writeback.\n`);
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
  const numericBounds = parseNumericBoundsFlags(args);
  const transitionGuards = parseTransitionGuardFlags(args);
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
    numeric_bounds: numericBounds,
    transition_guards: transitionGuards,
    trusted_context: {
      tenant_id_env: optionalArg(args, "--tenant-env") ?? "SYNAPSOR_TENANT_ID",
      principal_env: optionalArg(args, "--principal-env") ?? "SYNAPSOR_PRINCIPAL",
    },
    approval: {
      required_role: optionalArg(args, "--approval-role") ?? "local_reviewer",
    },
  };
  const generated = generateRunnerConfigFromSpec(spec);
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, args.includes("--force"));
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
  process.stdout.write(`Next: set the referenced environment variables, run \`${cliCommandName()} config validate\`, then run \`${cliCommandName()} mcp serve\`.\n`);
}

async function askTtyQuestion(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    return await rl.question(`${question}${suffix}: `);
  } finally {
    rl.close();
  }
}

async function askDefault(ask: WizardAsk, question: string, defaultValue?: string): Promise<string> {
  const answer = (await ask(question, defaultValue)).trim();
  return answer || defaultValue || "";
}

async function askChoice(ask: WizardAsk, question: string, defaultValue: string, choices: string[]): Promise<string> {
  const answer = await askDefault(ask, `${question} (${choices.join("/")})`, defaultValue);
  if (!choices.includes(answer)) throw new Error(`${question} must be one of: ${choices.join(", ")}`);
  return answer;
}

async function askEnvName(ask: WizardAsk, question: string, defaultValue: string): Promise<string> {
  const answer = await askDefault(ask, question, defaultValue);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(answer)) throw new Error(`${question} must be an environment-variable name`);
  return answer;
}

async function askColumn(ask: WizardAsk, question: string, defaultValue: string | undefined, columns: string[]): Promise<string> {
  const answer = await askDefault(ask, question, defaultValue);
  if (!answer) throw new Error(`${question} is required`);
  if (!columns.includes(answer)) throw new Error(`${question} ${answer} does not exist in selected table/view`);
  return answer;
}

function parseColumnList(value: string): string[] {
  return uniqueStrings(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function ensureColumnsExist(selected: string[], available: string[], kind: string): void {
  if (selected.length === 0) throw new Error(`at least one ${kind} column is required`);
  const missing = selected.filter((column) => !available.includes(column));
  if (missing.length > 0) throw new Error(`${kind} columns do not exist on selected table/view: ${missing.join(", ")}`);
}

function parseWizardPatchMappings(input: string): {
  patch: NonNullable<OnboardingSelectionSpec["patch"]>;
  patchArgs: OnboardingSelectionSpec["patch_args"];
} {
  const patch: NonNullable<OnboardingSelectionSpec["patch"]> = {};
  const patchArgs: NonNullable<OnboardingSelectionSpec["patch_args"]> = {};
  for (const entry of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [column, ...rest] = entry.split("=");
    const value = rest.join("=");
    if (!column || !value) throw new Error("patch mappings must use column=arg:name or column=fixed:value");
    if (value.startsWith("arg:")) {
      const arg = value.slice("arg:".length).trim();
      if (!arg) throw new Error(`patch mapping for ${column} is missing argument name`);
      patch[column] = { from_arg: arg };
      patchArgs[arg] = { type: "string", required: true, max_length: 500 };
    } else if (value.startsWith("fixed:")) {
      patch[column] = { fixed: parseFixedPatchValue(value.slice("fixed:".length)) };
    } else {
      throw new Error("patch mappings must use arg: or fixed:");
    }
  }
  if (Object.keys(patch).length === 0) throw new Error("at least one patch mapping is required for proposal modes");
  return { patch, patchArgs: Object.keys(patchArgs).length > 0 ? patchArgs : undefined };
}

function recipeColumns(recipe: CapabilityRecipe): string[] {
  const spec = recipe.spec;
  const transitionColumns = Object.entries(spec.transition_guards ?? {}).flatMap(([column, guard]) => [column, guard.from_column].filter((value): value is string => Boolean(value)));
  return uniqueStrings([
    ...recipe.required_columns,
    ...recipe.visible_columns,
    ...recipe.allowed_write_columns,
    recipe.recommended_primary_key,
    recipe.recommended_tenant_key,
    recipe.recommended_conflict_column,
    spec.primary_key,
    spec.tenant_key,
    spec.conflict_column,
    ...(spec.visible_columns ?? []),
    ...(spec.allowed_columns ?? []),
    ...Object.keys(spec.patch ?? {}),
    ...Object.keys(spec.numeric_bounds ?? {}),
    ...transitionColumns,
  ].filter((value): value is string => Boolean(value)));
}

function remapRecipeSpec(spec: OnboardingSelectionSpec, columnMap: Record<string, string>): OnboardingSelectionSpec {
  const mapColumn = (value: string | undefined): string | undefined => value ? columnMap[value] ?? value : undefined;
  const mapped: OnboardingSelectionSpec = {
    ...structuredClone(spec),
    primary_key: mapColumn(spec.primary_key) ?? spec.primary_key,
    tenant_key: mapColumn(spec.tenant_key),
    conflict_column: mapColumn(spec.conflict_column),
    visible_columns: spec.visible_columns.map((column) => mapColumn(column) ?? column),
    allowed_columns: spec.allowed_columns?.map((column) => mapColumn(column) ?? column),
    patch: mapRecordKeys(spec.patch, mapColumn),
    numeric_bounds: mapRecordKeys(spec.numeric_bounds, mapColumn),
    transition_guards: mapTransitionGuards(spec.transition_guards, mapColumn),
  };
  return mapped;
}

function mapRecordKeys<T>(
  value: Record<string, T> | undefined,
  mapKey: (value: string | undefined) => string | undefined,
): Record<string, T> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [mapKey(key) ?? key, entry]));
}

function mapTransitionGuards(
  value: OnboardingSelectionSpec["transition_guards"],
  mapColumn: (value: string | undefined) => string | undefined,
): OnboardingSelectionSpec["transition_guards"] {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([column, guard]) => [
    mapColumn(column) ?? column,
    {
      ...guard,
      ...(guard.from_column ? { from_column: mapColumn(guard.from_column) ?? guard.from_column } : {}),
    },
  ]));
}

function formatPatchMappings(patch: NonNullable<OnboardingSelectionSpec["patch"]>): string {
  return Object.entries(patch).map(([column, binding]) => {
    if (binding.from_arg) return `${column}=arg:${binding.from_arg}`;
    return `${column}=fixed:${String(binding.fixed)}`;
  }).join(",");
}

function safeObjectName(tableName: string): string {
  const base = tableName.replace(/[^A-Za-z0-9_]/g, "_").replace(/s$/, "");
  return /^[A-Za-z_]/.test(base) ? base : `record_${base}`;
}

function findInspectionTable(inspection: SchemaInspection, tableName: string, schemaName?: string): TableInfo | undefined {
  const candidates = inspection.tables.filter((table) => {
    if (schemaName && table.schema !== schemaName) return false;
    return table.name === tableName || `${table.schema}.${table.name}` === tableName;
  });
  if (candidates.length === 1) return candidates[0];
  return candidates.find((table) => table.schema === schemaName) ?? candidates[0];
}

function inferPrimaryKeyCandidate(table: TableInfo): string | undefined {
  if (table.primary_key.length === 1) return table.primary_key[0];
  const columns = new Set(table.columns.map((column) => column.name));
  const objectName = safeObjectName(table.name);
  const candidates = [
    "id",
    `${objectName}_id`,
    `${table.name}_id`,
  ];
  return candidates.find((candidate) => columns.has(candidate));
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

function parseNumericBoundsFlags(args: string[]): OnboardingSelectionSpec["numeric_bounds"] {
  return parseNumericBoundsInput(repeatedArgs(args, "--numeric-bound").join(","));
}

function parseNumericBoundsInput(input: string): OnboardingSelectionSpec["numeric_bounds"] {
  const bounds: NonNullable<OnboardingSelectionSpec["numeric_bounds"]> = {};
  for (const entry of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [column, ...rest] = entry.split("=");
    const range = rest.join("=");
    if (!column || !range) throw new Error("numeric bounds must use column=minimum:maximum");
    const [minimumRaw, maximumRaw] = range.split(":");
    const bound: { minimum?: number; maximum?: number } = {};
    if (minimumRaw) {
      const minimum = Number(minimumRaw);
      if (!Number.isFinite(minimum)) throw new Error(`numeric bound minimum for ${column} must be a finite number`);
      bound.minimum = minimum;
    }
    if (maximumRaw) {
      const maximum = Number(maximumRaw);
      if (!Number.isFinite(maximum)) throw new Error(`numeric bound maximum for ${column} must be a finite number`);
      bound.maximum = maximum;
    }
    if (bound.minimum === undefined && bound.maximum === undefined) {
      throw new Error(`numeric bound for ${column} must define minimum, maximum, or both`);
    }
    bounds[column] = bound;
  }
  return Object.keys(bounds).length > 0 ? bounds : undefined;
}

function formatNumericBounds(bounds: OnboardingSelectionSpec["numeric_bounds"]): string {
  if (!bounds) return "";
  return Object.entries(bounds)
    .map(([column, bound]) => `${column}=${bound.minimum ?? ""}:${bound.maximum ?? ""}`)
    .join(",");
}

function parseTransitionGuardFlags(args: string[]): OnboardingSelectionSpec["transition_guards"] {
  return parseTransitionGuardsInput(repeatedArgs(args, "--transition-guard").join(","));
}

function parseTransitionGuardsInput(input: string): OnboardingSelectionSpec["transition_guards"] {
  const guards: NonNullable<OnboardingSelectionSpec["transition_guards"]> = {};
  for (const entry of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [column, ...rest] = entry.split("=");
    const transitions = rest.join("=");
    if (!column || !transitions) throw new Error("transition guards must use column=from:to|to;from:to");
    const allowed: Record<string, string[]> = {};
    for (const transition of transitions.split(";").map((item) => item.trim()).filter(Boolean)) {
      const [from, ...targetParts] = transition.split(":");
      const targets = targetParts.join(":").split("|").map((item) => item.trim()).filter(Boolean);
      if (!from || targets.length === 0) throw new Error(`transition guard for ${column} must use from:to|to`);
      allowed[from] = targets;
    }
    guards[column] = { allowed };
  }
  return Object.keys(guards).length > 0 ? guards : undefined;
}

function formatTransitionGuards(guards: OnboardingSelectionSpec["transition_guards"]): string {
  if (!guards) return "";
  return Object.entries(guards)
    .map(([column, guard]) => `${column}=${Object.entries(guard.allowed).map(([from, targets]) => `${from}:${targets.join("|")}`).join(";")}`)
    .join(",");
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
  const databaseInput = databaseInputFromArgs(args);
  const engine = (optionalArg(args, "--engine") ?? "auto") as InspectEngine;
  if (!["postgres", "mysql", "auto"].includes(engine)) {
    throw new Error("inspect --engine must be postgres, mysql, or auto.");
  }
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv: databaseInput.inspectionDatabaseUrlEnv,
    schema: optionalArg(args, "--schema"),
    env: databaseInput.env,
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  } else {
    if (databaseInput.inlineUrl) {
      process.stderr.write("Tip: prefer `--from-env DATABASE_URL` for reusable setup so connection strings do not land in shell history.\n");
    }
    process.stdout.write(formatSchemaInspectionForCli(inspection, databaseInput.configDatabaseUrlEnv));
  }
  return 0;
}

function formatSchemaInspectionForCli(inspection: SchemaInspection, databaseUrlEnv: string): string {
  const lines = [
    "Synapsor schema inspection",
    `Engine: ${inspection.engine}`,
    `Server: ${inspection.server_version}`,
    `Current user: ${inspection.current_user}`,
    `Schemas: ${inspection.schemas.join(", ") || "(none)"}`,
    "",
    `Found ${inspection.tables.length} tables/views:`,
  ];
  for (const table of inspection.tables) {
    lines.push(`- ${table.schema}.${table.name} (${table.type})`);
    const primaryKeyCandidate = inferPrimaryKeyCandidate(table);
    lines.push(`  primary key: ${table.primary_key.join(", ") || (primaryKeyCandidate ? `not detected; candidate: ${primaryKeyCandidate}` : "not detected")}`);
    lines.push(`  possible tenant/scope columns: ${table.suggestions.tenant_columns.join(", ") || "not detected"}`);
    lines.push(`  possible conflict/version columns: ${table.suggestions.conflict_columns.join(", ") || "not detected"}`);
    lines.push(`  fields suggested for review: ${table.suggestions.sensitive_columns.join(", ") || "none"}`);
    lines.push(`  suggested visible fields: ${table.suggestions.default_visible_columns.slice(0, 12).join(", ") || "none"}`);
  }
  if (inspection.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of inspection.warnings) lines.push(`! ${warning}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${cliCommandName()} init --wizard --from-env ${databaseUrlEnv}`);
  lines.push(`  ${cliCommandName()} tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db`);
  return `${lines.join("\n")}\n`;
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
  const outputPath = outputArg(args);
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

function trustedContextsForDoctor(config: RuntimeConfig): Array<[string, Record<string, unknown>]> {
  const contexts: Array<[string, Record<string, unknown>]> = [];
  if (config.trusted_context?.values) contexts.push(["trusted_context", config.trusted_context.values]);
  for (const [name, context] of Object.entries(config.contexts ?? {})) {
    contexts.push([`contexts.${name}`, context.values ?? {}]);
  }
  if (contexts.length === 0) contexts.push(["trusted_context", {}]);
  return contexts;
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

type CapabilityRecipe = {
  id: string;
  title: string;
  summary: string;
  expected_table_type: string;
  required_columns: string[];
  recommended_primary_key: string;
  recommended_tenant_key: string;
  recommended_conflict_column: string;
  visible_columns: string[];
  allowed_write_columns: string[];
  semantic_tools: string[];
  notes: string[];
  spec: OnboardingSelectionSpec;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const recipeDir = path.resolve(moduleDir, "../../..", "recipes");

async function loadBuiltInRecipes(): Promise<CapabilityRecipe[]> {
  const entries = await fs.readdir(recipeDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(recipeDir, entry.name))
    .sort();
  return Promise.all(files.map((file) => loadRecipeFile(file)));
}

async function loadRecipeFile(filePath: string): Promise<CapabilityRecipe> {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
  return normalizeRecipe(parsed, resolved);
}

async function requireRecipe(recipeIdOrPath: string): Promise<CapabilityRecipe> {
  if (looksLikeRecipePath(recipeIdOrPath)) {
    return loadRecipeFile(recipeIdOrPath);
  }
  const file = path.join(recipeDir, `${recipeIdOrPath}.json`);
  if (await fileExists(file)) {
    return loadRecipeFile(file);
  }
  throw new Error(`unknown recipe ${recipeIdOrPath}. Run ${cliCommandName()} recipes list, or pass a recipe JSON file path.`);
}

function looksLikeRecipePath(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function normalizeRecipe(value: unknown, source: string): CapabilityRecipe {
  if (!isRecord(value)) throw new Error(`recipe ${source} must be a JSON object`);
  const recipe: CapabilityRecipe = {
    id: requiredString(value, "id", source),
    title: requiredString(value, "title", source),
    summary: requiredString(value, "summary", source),
    expected_table_type: requiredString(value, "expected_table_type", source),
    required_columns: requiredStringArray(value, "required_columns", source),
    recommended_primary_key: requiredString(value, "recommended_primary_key", source),
    recommended_tenant_key: requiredString(value, "recommended_tenant_key", source),
    recommended_conflict_column: requiredString(value, "recommended_conflict_column", source),
    visible_columns: requiredStringArray(value, "visible_columns", source),
    allowed_write_columns: requiredStringArray(value, "allowed_write_columns", source),
    semantic_tools: requiredStringArray(value, "semantic_tools", source),
    notes: requiredStringArray(value, "notes", source),
    spec: requiredRecord(value, "spec", source) as OnboardingSelectionSpec,
  };
  if (!recipe.spec.namespace || !recipe.spec.table || !recipe.spec.primary_key) {
    throw new Error(`recipe ${source} spec must include namespace, table, and primary_key`);
  }
  return recipe;
}

function requiredString(value: Record<string, unknown>, key: string, source: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "") throw new Error(`recipe ${source} requires string ${key}`);
  return item;
}

function requiredStringArray(value: Record<string, unknown>, key: string, source: string): string[] {
  const item = value[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`recipe ${source} requires string[] ${key}`);
  }
  return item;
}

function requiredRecord(value: Record<string, unknown>, key: string, source: string): Record<string, unknown> {
  const item = value[key];
  if (!isRecord(item)) throw new Error(`recipe ${source} requires object ${key}`);
  return item;
}

async function doctor(args: string[] = []): Promise<number> {
  if (args.includes("--first-run")) return firstRunDoctor(args);
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

type FirstRunCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  checked: string;
  why: string;
  fix: string;
};

async function firstRunDoctor(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const checks: FirstRunCheck[] = [];
  checks.push(commandCheck("bash", "Bash shell is available.", "The first-run script is a Bash script.", "Install bash, then rerun ./scripts/try-synapsor.sh."));
  checks.push(commandCheck("docker", "Docker CLI is installed.", "The first-run demo starts disposable Postgres/MySQL containers.", "Install Docker Desktop or Docker Engine, then rerun ./scripts/try-synapsor.sh."));
  checks.push(commandCheck("node", "Node.js is installed for source-checkout commands.", "Source commands such as corepack pnpm runner use Node.", "Install Node.js 22+, or run ./scripts/try-synapsor.sh which uses Docker for the demo."));
  checks.push(commandCheck("corepack", "Corepack is installed for the pinned pnpm version.", "The source checkout uses packageManager pnpm@10.14.0.", "Run corepack enable after installing Node.js, or use the Docker-only first-run script."));
  checks.push(await pnpmInstallCheck());
  checks.push(diskSpaceCheck());
  checks.push(memoryCheck());

  if (commandExists("docker")) {
    const info = spawnSync("docker", ["info"], { encoding: "utf8" });
    checks.push(info.status === 0
      ? pass("docker-daemon", "Docker daemon is reachable.", "The demo needs Docker to start disposable databases.", "No action needed.")
      : fail(
        "docker-daemon",
        "Docker daemon is not reachable.",
        "The first-run demo starts disposable Postgres/MySQL containers.",
        dockerFix(info.stderr || info.stdout),
      ));
    const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
    checks.push(compose.status === 0
      ? pass("docker-compose", "Docker Compose is available.", "The reference app and fixtures use Docker Compose.", "No action needed.")
      : warn("docker-compose", "Docker Compose was not detected.", "The reference app uses Docker Compose.", "Install a Docker version with `docker compose`, then rerun the demo."));
    const staleContainers = dockerNames(["ps", "-a", "--format", "{{.Names}}"])
      .filter((name) => /synapsor_runner|mcp-postgres|mcp-mysql|postgres-support|mysql-orders|reference-support/i.test(name));
    checks.push(staleContainers.length === 0
      ? pass("stale-containers", "No stale Synapsor demo containers found.", "Stale containers can hold ports or old fixture state.", "No action needed.")
      : warn("stale-containers", `Stale Synapsor demo containers found: ${staleContainers.join(", ")}`, "Stale containers can hold ports or old fixture state.", "./scripts/try-synapsor.sh --reset"));
  }

  for (const port of [55433, 55434, 55435, 53307]) {
    const available = await isPortAvailable(port);
    checks.push(available
      ? pass(`port-${port}`, `Port ${port} is available.`, "The first-run fixtures bind predictable local demo ports.", "No action needed.")
      : fail(`port-${port}`, `Port ${port} is already in use.`, "The first-run fixtures need predictable local demo ports.", `Stop the process using port ${port}, or run ./scripts/try-synapsor.sh --reset if it is a stale demo container.`));
  }

  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const configExists = await fileExists(configPath);
  checks.push(configExists
    ? pass("config", `Runner config exists at ${configPath}.`, "MCP serve/smoke need a reviewed config.", "No action needed.")
    : warn("config", `Runner config not found at ${configPath}.`, "Own-database MCP setup needs a generated config.", `Run ${cliCommandName()} demo first, or run ${cliCommandName()} init --wizard --from-env DATABASE_URL.`));

  if (configExists) {
    const parsedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
    const validation = validateRunnerCapabilityConfig(parsedConfig);
    checks.push(validation.ok
      ? pass("config-valid", "Runner config validates.", "Invalid configs must fail before exposing MCP tools.", "No action needed.")
      : fail("config-valid", `Runner config failed validation: ${validation.errors.map((error) => error.code).join(", ")}`, "Invalid configs must fail before exposing MCP tools.", `Run ${cliCommandName()} config validate --config ${configPath}.`));
    checks.push(...firstRunConfigEnvChecks(parsedConfig));
  }
  checks.push(await sqliteStoreCheck(storePath));
  checks.push(...await mcpClientConfigLeakChecks(args));

  const report = { ok: checks.every((check) => check.status !== "fail"), checks };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatFirstRunDoctor(report));
  }
  return report.ok ? 0 : 1;
}

function commandCheck(command: string, checked: string, why: string, fix: string): FirstRunCheck {
  return commandExists(command) ? pass(command, checked, why, "No action needed.") : fail(command, `${command} was not found.`, why, fix);
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dockerNames(args: string[]): string[] {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function dockerFix(message: string): string {
  if (/permission denied/i.test(message)) return "Your user cannot access the Docker socket. Add your user to the docker group or start Docker Desktop, then rerun ./scripts/try-synapsor.sh.";
  return "Start Docker Desktop or the Docker daemon, then run ./scripts/try-synapsor.sh.";
}

async function pnpmInstallCheck(): Promise<FirstRunCheck> {
  if (!await fileExists("package.json")) {
    return warn("package-json", "No package.json found in the current directory.", "Source checkout commands must run from the repository root.", "cd into synapsor-runner before running synapsor commands from this checkout.");
  }
  return await fileExists("node_modules/.pnpm") || await fileExists("node_modules")
    ? pass("pnpm-install", "Dependencies appear installed for source-checkout commands.", "Commands like corepack pnpm runner use local workspace packages.", "No action needed.")
    : warn("pnpm-install", "Dependencies are not installed yet.", "Source-checkout commands need workspace dependencies.", "Run corepack pnpm install, or use ./scripts/try-synapsor.sh for the Docker-only demo.");
}

function diskSpaceCheck(): FirstRunCheck {
  const result = spawnSync("df", ["-Pk", "."], { encoding: "utf8" });
  if (result.status !== 0) {
    return warn("disk-space", "Could not check available disk space.", "Docker image builds and disposable databases need free local disk.", "Run df -h . if the demo fails during Docker build or database startup.");
  }
  const line = result.stdout.trim().split(/\r?\n/)[1] ?? "";
  const availableKb = Number(line.trim().split(/\s+/)[3] ?? "0");
  const availableGb = availableKb / 1024 / 1024;
  if (!Number.isFinite(availableGb) || availableGb <= 0) {
    return warn("disk-space", "Could not parse available disk space.", "Docker image builds and disposable databases need free local disk.", "Run df -h . if the demo fails during Docker build or database startup.");
  }
  if (availableGb < 2) {
    return warn("disk-space", `Only ${availableGb.toFixed(1)} GB free in this workspace filesystem.`, "Docker image builds and disposable databases need local disk headroom.", "Free a few GB, then rerun ./scripts/try-synapsor.sh.");
  }
  return pass("disk-space", `${availableGb.toFixed(1)} GB free in this workspace filesystem.`, "Docker image builds and disposable databases need local disk headroom.", "No action needed.");
}

function memoryCheck(): FirstRunCheck {
  const totalGb = os.totalmem() / 1024 / 1024 / 1024;
  if (totalGb < 4) {
    return warn("memory", `Host reports ${totalGb.toFixed(1)} GB total memory.`, "Docker build plus Postgres/MySQL fixtures need memory headroom.", "Close other heavy apps or increase Docker memory if the demo is killed.");
  }
  return pass("memory", `Host reports ${totalGb.toFixed(1)} GB total memory.`, "Docker build plus Postgres/MySQL fixtures need memory headroom.", "No action needed.");
}

function firstRunConfigEnvChecks(config: RuntimeConfig): FirstRunCheck[] {
  const checks: FirstRunCheck[] = [];
  for (const [contextName, values] of trustedContextsForDoctor(config)) {
    for (const envName of [
      String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID"),
      String(values.principal_env ?? "SYNAPSOR_PRINCIPAL"),
    ]) {
      checks.push(process.env[envName]
        ? pass(`env-${envName}`, `${envName} is set for ${contextName}.`, "Trusted tenant/principal values must come from the launcher, not the model.", "No action needed.")
        : warn(`env-${envName}`, `${envName} is not set for ${contextName}.`, "Trusted tenant/principal values must come from the launcher, not the model.", `Set ${envName}, or use the generated .env.example as a template.`));
    }
  }
  for (const [sourceName, source] of Object.entries(config.sources ?? {})) {
    checks.push(process.env[source.read_url_env]
      ? pass(`env-${source.read_url_env}`, `${source.read_url_env} is set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", "No action needed.")
      : warn(`env-${source.read_url_env}`, `${source.read_url_env} is not set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", `Set ${source.read_url_env} before running doctor, tools preview, or mcp serve against your own database.`));
    if (source.write_url_env) {
      checks.push(process.env[source.write_url_env]
        ? pass(`env-${source.write_url_env}`, `${source.write_url_env} is set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", "No action needed.")
        : warn(`env-${source.write_url_env}`, `${source.write_url_env} is not set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", `Set ${source.write_url_env} only when you are ready to apply an approved writeback job.`));
      const readValue = process.env[source.read_url_env];
      const writeValue = process.env[source.write_url_env];
      if (readValue && writeValue && readValue === writeValue) {
        checks.push(fail(`credential-split-${sourceName}`, `Read and write env vars resolve to the same credential for ${sourceName}.`, "Read/proposal authority and writeback authority must be separated.", "Use a read-only credential for MCP reads and a separate writer credential only for trusted apply."));
      }
    }
  }
  return checks;
}

async function sqliteStoreCheck(storePath: string): Promise<FirstRunCheck> {
  if (storePath === ":memory:") {
    return pass("sqlite-store", "Using in-memory SQLite store.", "The local UI and replay need a store when you want persistent proposals.", "No action needed for tests.");
  }
  if (await fileExists(storePath)) {
    return pass("sqlite-store", `SQLite local store exists at ${storePath}.`, "The local UI and replay read proposal/evidence state from this store.", "No action needed.");
  }
  return warn("sqlite-store", `SQLite local store not found at ${storePath}.`, "The local UI and replay need a store after a demo or proposal run.", "Run ./scripts/try-synapsor.sh, corepack pnpm demo:reference, or create a proposal before opening the UI.");
}

async function mcpClientConfigLeakChecks(args: string[]): Promise<FirstRunCheck[]> {
  const explicit = optionalArg(args, "--client-config");
  const paths = explicit ? [explicit] : await defaultMcpClientConfigPaths();
  if (paths.length === 0) {
    return [warn("mcp-client-config", "No generated MCP client config snippets found yet.", "MCP clients should receive command paths only, never database URLs or credentials.", `Generate one with ${cliCommandName()} mcp config --absolute-paths --config <config> --store <store>.`)];
  }
  const checks: FirstRunCheck[] = [];
  for (const filePath of paths) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      const leaked = /postgres(?:ql)?:\/\/|mysql:\/\/|password\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|syn_wbr_/i.test(text);
      checks.push(leaked
        ? fail(`mcp-client-config-${filePath}`, `MCP client config appears to contain a database URL, password, or token: ${filePath}.`, "MCP clients must only receive the local runner command and arguments.", `Regenerate the snippet with ${cliCommandName()} mcp config ... and keep DB URLs in environment variables.`)
        : pass(`mcp-client-config-${filePath}`, `MCP client config has no obvious database URL, password, or bearer token: ${filePath}.`, "MCP clients must only receive the local runner command and arguments.", "No action needed."));
    } catch (error) {
      checks.push(warn(`mcp-client-config-${filePath}`, `Could not read MCP client config: ${filePath}.`, "MCP clients should receive command paths only, never database URLs or credentials.", error instanceof Error ? error.message : String(error)));
    }
  }
  return checks;
}

async function defaultMcpClientConfigPaths(): Promise<string[]> {
  const dir = path.resolve(".synapsor/mcp");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function pass(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "pass", checked, why, fix };
}

function warn(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "warn", checked, why, fix };
}

function fail(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "fail", checked, why, fix };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function formatFirstRunDoctor(report: { ok: boolean; checks: FirstRunCheck[] }): string {
  const lines = [`Synapsor Runner first-run doctor: ${report.ok ? "ok" : "needs attention"}`, ""];
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${icon} ${check.checked}`);
    lines.push(`Why it matters: ${check.why}`);
    lines.push(`Fix: ${check.fix}`, "");
  }
  return `${lines.join("\n")}\n`;
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

  const contextsToCheck = trustedContextsForDoctor(parsed);
  for (const [contextName, contextValues] of contextsToCheck) {
    const tenantEnv = String(contextValues.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
    const principalEnv = String(contextValues.principal_env ?? "SYNAPSOR_PRINCIPAL");
    for (const envName of [tenantEnv, principalEnv]) {
      checks.push(envPresenceCheck(envName, `${envName} is required for trusted context ${contextName}.`));
    }
  }

  const sources = parsed.sources ?? {};
  for (const [sourceName, source] of Object.entries(sources)) {
    checks.push(envPresenceCheck(source.read_url_env, `${source.read_url_env} is required for ${sourceName} reads.`));
    if (parsed.mode === "review") {
      if (sourceNeedsSqlWriteback(parsed, sourceName)) {
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
          checks.push({ name: `source:${sourceName}:write-url-env`, ok: false, level: "fail", message: "SQL writeback proposal capabilities require write_url_env for trusted writeback." });
        }
      }
    }
    await inspectConfiguredSource({ config: parsed, sourceName, source, checks });
  }

  for (const [executorName, executor] of Object.entries(parsed.executors ?? {})) {
    if (!isRecord(executor)) continue;
    if (executor.type === "http_handler") {
      const urlEnv = String(executor.url_env ?? "");
      if (urlEnv) checks.push(envPresenceCheck(urlEnv, `${urlEnv} is required for http_handler executor ${executorName}.`));
      const auth = isRecord(executor.auth) ? executor.auth : undefined;
      const tokenEnv = typeof auth?.token_env === "string" ? auth.token_env : undefined;
      if (tokenEnv) checks.push(envPresenceCheck(tokenEnv, `${tokenEnv} is required for http_handler executor ${executorName} bearer auth.`));
    }
    if (executor.type === "command_handler") {
      const commandEnv = String(executor.command_env ?? "");
      if (commandEnv) checks.push(envPresenceCheck(commandEnv, `${commandEnv} is required for command_handler executor ${executorName}.`));
    }
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
  const directProposalId = positional(args, 0);
  const proposalId = optionalArg(args, "--proposal") ?? (directProposalId && !directProposalId.endsWith(".json") ? directProposalId : undefined);
  if (proposalId) return applyProposal(args, proposalId);

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

async function applyProposal(args: string[], proposalId: string): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const runnerId = optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner";
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  const resolvedProposalId = await resolveProposalId(proposalId, storePath);
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`cannot apply proposal with invalid local config: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`);
  }
  if (config.mode !== "review") {
    throw new Error(`local proposal apply requires review mode, got ${config.mode}`);
  }
  if (storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  const store = new ProposalStore(storePath);
  try {
    const proposal = requireLocalProposal(store, resolvedProposalId);
    const capability = findProposalCapability(config, proposal);
    const executorName = proposalExecutorName(proposal, capability);
    if (executorName === "sql_update") {
      const job = store.createWritebackJobFromProposal(resolvedProposalId, {
        project_id: optionalArg(args, "--project") ?? "local",
        runner_id: runnerId,
        lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
      });
      const result = await applySqlJob(job, configPath, storePath, dryRun, envWithDemoDefaults(config, configPath));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    const executor = executorConfig(config, executorName);
    if (executor.type === "http_handler") {
      const result = await applyHttpHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, env: envWithDemoDefaults(config, configPath) });
      process.stdout.write(`${JSON.stringify(redactConfig(result), null, 2)}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    if (executor.type === "command_handler") {
      const result = await applyCommandHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, env: envWithDemoDefaults(config, configPath) });
      process.stdout.write(`${JSON.stringify(redactConfig(result), null, 2)}\n`);
      return result.status === "failed" ? 1 : 0;
    }
    throw new Error(`unsupported executor type for ${executorName}`);
  } finally {
    store.close();
  }
}

async function applySqlJob(job: unknown, configPath: string, storePath: string | undefined, dryRun: boolean, env: NodeJS.ProcessEnv = process.env): Promise<WritebackResult> {
  const parsedJob = parseWritebackJob(job);
  await verifyLocalWritebackAuthority(parsedJob, configPath, storePath);
  const config: RunnerConfig = {
    controlPlaneUrl: env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: env.SYNAPSOR_SOURCE_ID || parsedJob.source_id,
    databaseUrl: env.SYNAPSOR_DATABASE_URL || "",
    engine: parsedJob.engine,
    pollIntervalMs: Number(env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    logLevel: (env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: env.SYNAPSOR_STATE_DIR || "./state"
  };
  const result = await adapters[parsedJob.engine].apply(parsedJob, config);
  if (storePath) {
    const store = new ProposalStore(storePath);
    try {
      store.recordExecutionReceipt(toExecutionReceipt(parsedJob, result, config.dryRun));
    } finally {
      store.close();
    }
  }
  return result;
}

type HttpHandlerExecutor = {
  type: "http_handler";
  url_env: string;
  method?: "POST" | "PUT" | "PATCH";
  auth?: { type: "bearer_env"; token_env: string };
  timeout_ms?: number;
};

type CommandHandlerExecutor = {
  type: "command_handler";
  command_env: string;
  timeout_ms?: number;
};

type LocalExecutor = HttpHandlerExecutor | CommandHandlerExecutor | { type: "sql_update" };

function sourceNeedsSqlWriteback(config: RuntimeConfig, sourceName: string): boolean {
  return (config.capabilities ?? []).some((capability) => {
    if (capability.kind !== "proposal" || capability.source !== sourceName) return false;
    return (capability.executor ?? "sql_update") === "sql_update";
  });
}

function findProposalCapability(config: RuntimeConfig, proposal: StoredProposal): NonNullable<RuntimeConfig["capabilities"]>[number] {
  const capability = (config.capabilities ?? []).find((candidate) => {
    if (candidate.kind !== "proposal") return false;
    if (candidate.name !== proposal.action) return false;
    if (candidate.source !== proposal.source_id) return false;
    if (candidate.target.schema !== proposal.source_schema) return false;
    if (candidate.target.table !== proposal.source_table) return false;
    if (candidate.target.primary_key !== proposal.change_set.source.primary_key.column) return false;
    return true;
  });
  if (!capability) {
    throw new Error(`proposal ${proposal.proposal_id} does not match any reviewed proposal capability in local config`);
  }
  return capability;
}

function proposalExecutorName(proposal: StoredProposal, capability: NonNullable<RuntimeConfig["capabilities"]>[number]): string {
  const writeback = proposal.change_set.writeback as { executor?: unknown };
  return capability.executor ?? (typeof writeback.executor === "string" ? writeback.executor : undefined) ?? "sql_update";
}

function executorConfig(config: RuntimeConfig, executorName: string): LocalExecutor {
  const raw = config.executors?.[executorName];
  if (!isRecord(raw)) throw new Error(`executor ${executorName} is not configured`);
  if (raw.type === "http_handler") return raw as HttpHandlerExecutor;
  if (raw.type === "command_handler") return raw as CommandHandlerExecutor;
  if (raw.type === "sql_update") return { type: "sql_update" };
  throw new Error(`executor ${executorName} has unsupported type`);
}

async function applyHttpHandlerProposal(input: {
  store: ProposalStore;
  proposalId: string;
  proposal: StoredProposal;
  executorName: string;
  executor: HttpHandlerExecutor;
  runnerId: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const url = input.env[input.executor.url_env];
  if (!url) throw new Error(`${input.executor.url_env} is not set`);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": prepared.request.idempotency_key,
  };
  if (input.executor.auth) {
    const token = input.env[input.executor.auth.token_env];
    if (!token) throw new Error(`${input.executor.auth.token_env} is not set`);
    headers.authorization = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, input.executor.timeout_ms ?? 5000));
  let receipt: ExecutionReceiptV1;
  try {
    const response = await fetch(url, {
      method: input.executor.method ?? "POST",
      headers,
      body: JSON.stringify({ ...prepared.request, executor: input.executorName, dry_run: input.dryRun }),
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseOptionalJson(text);
    receipt = response.ok
      ? handlerReceiptFromBody({ proposal: prepared.proposal, request: prepared.request, body, runnerId: input.runnerId, dryRun: input.dryRun })
      : failedHandlerReceipt({ proposal: prepared.proposal, request: prepared.request, runnerId: input.runnerId, safeErrorCode: `HANDLER_HTTP_${response.status}` });
  } catch (error) {
    const code = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "HANDLER_TIMEOUT" : "HANDLER_REQUEST_FAILED";
    receipt = failedHandlerReceipt({ proposal: prepared.proposal, request: prepared.request, runnerId: input.runnerId, safeErrorCode: code });
  } finally {
    clearTimeout(timeout);
  }
  input.store.recordExecutionReceipt(receipt);
  return receipt;
}

async function applyCommandHandlerProposal(input: {
  store: ProposalStore;
  proposalId: string;
  proposal: StoredProposal;
  executorName: string;
  executor: CommandHandlerExecutor;
  runnerId: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const commandText = input.env[input.executor.command_env];
  if (!commandText) throw new Error(`${input.executor.command_env} is not set`);
  const [command, ...commandArgs] = splitCommand(commandText);
  if (!command) throw new Error(`${input.executor.command_env} did not contain a command`);
  const body = await runCommandHandler(command, commandArgs, {
    ...prepared.request,
    executor: input.executorName,
    dry_run: input.dryRun,
  }, Math.max(1, input.executor.timeout_ms ?? 5000));
  const receipt = handlerReceiptFromBody({ proposal: prepared.proposal, request: prepared.request, body, runnerId: input.runnerId, dryRun: input.dryRun });
  input.store.recordExecutionReceipt(receipt);
  return receipt;
}

function prepareHandlerProposal(store: ProposalStore, proposal: StoredProposal, runnerId: string): {
  proposal: StoredProposal;
  request: Record<string, unknown> & { writeback_job_id: string; idempotency_key: string };
} {
  if (proposal.state === "applied") throw new Error(`proposal ${proposal.proposal_id} is already applied`);
  if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
    throw new Error(`proposal ${proposal.proposal_id} is ${proposal.state}, not approved for handler writeback`);
  }
  const prepared = proposal.state === "approved"
    ? store.markPendingWorker(proposal.proposal_id, proposal.proposal_hash, proposal.proposal_version)
    : proposal;
  const changeSet = prepared.change_set;
  const writebackJobId = `hwb_${prepared.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}`;
  return {
    proposal: prepared,
    request: {
      schema_version: "synapsor.handler-writeback.v1",
      writeback_job_id: writebackJobId,
      proposal_id: prepared.proposal_id,
      proposal_version: prepared.proposal_version,
      proposal_hash: prepared.proposal_hash,
      action: prepared.action,
      runner_hint: runnerId,
      idempotency_key: `${prepared.proposal_id}:${prepared.object_id}`,
      source: changeSet.source,
      target: {
        schema: prepared.source_schema,
        table: prepared.source_table,
        primary_key: changeSet.source.primary_key,
      },
      tenant_guard: changeSet.guards.tenant,
      allowed_columns: changeSet.guards.allowed_columns,
      before: changeSet.before,
      patch: changeSet.patch,
      after: changeSet.after,
      guards: changeSet.guards,
      evidence: changeSet.evidence,
      approval: changeSet.approval,
      source_database_mutated: false,
    },
  };
}

function duplicateHandlerReceipt(store: ProposalStore, proposalId: string): { receipt: ExecutionReceiptV1 } | undefined {
  const receipts = store.receipts(proposalId);
  const existing = receipts.find((receipt) => receipt.writeback_job_id.startsWith("hwb_"));
  return existing ? { receipt: existing.receipt } : undefined;
}

function alreadyAppliedReceipt(receipt: ExecutionReceiptV1, runnerId: string): ExecutionReceiptV1 {
  if (receipt.status !== "applied" && receipt.status !== "already_applied") return receipt;
  const now = new Date().toISOString();
  return {
    ...receipt,
    runner_id: runnerId,
    status: "already_applied",
    rows_affected: 0,
    source_database_mutated: false,
    executed_at: now,
    safe_error_code: undefined,
    receipt_hash: hashReceipt({
      writeback_job_id: receipt.writeback_job_id,
      proposal_id: receipt.proposal_id,
      status: "already_applied",
      idempotency_key: receipt.idempotency_key,
      executed_at: now,
    }),
  };
}

function handlerReceiptFromBody(input: {
  proposal: StoredProposal;
  request: { writeback_job_id: string; idempotency_key: string };
  body: unknown;
  runnerId: string;
  dryRun: boolean;
}): ExecutionReceiptV1 {
  const body = isRecord(input.body) ? input.body : {};
  const rawStatus = String(body.status ?? "failed");
  const status = handlerReceiptStatuses.has(rawStatus) ? rawStatus as ExecutionReceiptV1["status"] : "failed";
  const rowsAffected = Number.isInteger(body.rows_affected) && Number(body.rows_affected) >= 0
    ? Number(body.rows_affected)
    : status === "applied" && !input.dryRun ? 1 : 0;
  const sourceDatabaseMutated = !input.dryRun && (status === "applied" || status === "already_applied")
    ? body.source_database_mutated !== false
    : false;
  return buildHandlerReceipt({
    writebackJobId: input.request.writeback_job_id,
    proposalId: input.proposal.proposal_id,
    runnerId: input.runnerId,
    status,
    rowsAffected,
    idempotencyKey: input.request.idempotency_key,
    previousVersion: scalarOrUndefined(body.previous_version),
    newVersion: scalarOrUndefined(body.new_version),
    sourceDatabaseMutated,
    safeErrorCode: typeof body.safe_error_code === "string" ? body.safe_error_code : status === "failed" ? "HANDLER_FAILED" : undefined,
    details: safeHandlerDetails(body.details),
  });
}

function failedHandlerReceipt(input: {
  proposal: StoredProposal;
  request: { writeback_job_id: string; idempotency_key: string };
  runnerId: string;
  safeErrorCode: string;
}): ExecutionReceiptV1 {
  return buildHandlerReceipt({
    writebackJobId: input.request.writeback_job_id,
    proposalId: input.proposal.proposal_id,
    runnerId: input.runnerId,
    status: "failed",
    rowsAffected: 0,
    idempotencyKey: input.request.idempotency_key,
    sourceDatabaseMutated: false,
    safeErrorCode: input.safeErrorCode,
  });
}

function buildHandlerReceipt(input: {
  writebackJobId: string;
  proposalId: string;
  runnerId: string;
  status: ExecutionReceiptV1["status"];
  rowsAffected: number;
  idempotencyKey: string;
  previousVersion?: string | number | boolean | null;
  newVersion?: string | number | boolean | null;
  sourceDatabaseMutated: boolean;
  safeErrorCode?: string;
  details?: unknown;
}): ExecutionReceiptV1 {
  const core = {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: input.writebackJobId,
    proposal_id: input.proposalId,
    runner_id: input.runnerId,
    status: input.status,
    rows_affected: input.rowsAffected,
    idempotency_key: input.idempotencyKey,
    previous_version: input.previousVersion,
    new_version: input.newVersion,
    source_database_mutated: input.sourceDatabaseMutated,
    executed_at: new Date().toISOString(),
    safe_error_code: input.safeErrorCode,
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
  return {
    ...core,
    receipt_hash: hashReceipt(core),
  };
}

function hashReceipt(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function parseOptionalJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { status: "failed", safe_error_code: "HANDLER_INVALID_JSON" };
  }
}

function scalarOrUndefined(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function safeHandlerDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  return redactConfig(value);
}

async function runCommandHandler(command: string, args: string[], request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (body: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(body);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "failed", safe_error_code: "HANDLER_TIMEOUT" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish({ status: "failed", safe_error_code: "HANDLER_REQUEST_FAILED" }));
    child.on("close", (code) => {
      if (code === 0) finish(parseOptionalJson(stdout));
      else finish({ status: "failed", safe_error_code: `HANDLER_EXIT_${code ?? "UNKNOWN"}`, details: { stderr: stderr.slice(0, 500) } });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
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
  const runnerVersion = String(parsed.cloud.runner_version || process.env.npm_package_version || "0.1.0-alpha.1").trim();
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
  if (subcommand === "config") return mcpConfig(rest);
  if (subcommand === "configure") return mcpConfigure(rest);
  if (subcommand === "smoke") return mcpSmoke(rest);
  usage(["mcp"]);
  return 2;
}

async function tools(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "preview") return toolsPreview(rest);
  usage(["tools"]);
  return 2;
}

async function onboard(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "db") {
    usage(["onboard"]);
    return 2;
  }
  process.stdout.write("Synapsor Runner own-database onboarding\n");
  process.stdout.write("You will inspect metadata, choose one table/view, confirm safety rules, and generate semantic MCP tools without writing JSON by hand.\n\n");
  const outputPath = outputArg(rest) ?? "synapsor.runner.json";
  const storePath = optionalArg(rest, "--store") ?? "./.synapsor/local.db";
  const result = await runInitWizard(["--wizard", ...rest]);
  if (result !== 0) return result;
  process.stdout.write("\nValidation:\n");
  const configCode = await configValidate(["--config", outputPath]);
  const smokeCode = await mcpSmoke(["--config", outputPath, "--store", storePath]);
  process.stdout.write("Doctor:\n");
  const doctorCode = await doctor(["--config", outputPath]);
  if (doctorCode !== 0) {
    process.stdout.write("Doctor reported setup attention. This is expected if trusted context or writeback env vars are not set yet.\n");
  }
  process.stdout.write("\nNext commands:\n");
  process.stdout.write(`1. Serve MCP:\n   ${cliCommandName()} mcp serve --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write(`2. Open local UI:\n   ${cliCommandName()} ui --tour --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write("3. Approve/apply only after setting a trusted write credential and reviewing the proposal.\n");
  return configCode === 0 && smokeCode === 0 ? 0 : 1;
}

async function demo(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand && !subcommand.startsWith("-") && subcommand !== "reference-support-billing") {
    usage(["demo"]);
    return 2;
  }
  if (args.includes("--quick")) return quickDemo();
  return prepareReferenceDemo(args);
}

async function quickDemo(): Promise<number> {
  process.stdout.write([
    "Synapsor Runner quick demo (fixture-only)",
    "",
    "Raw MCP shape:",
    "execute_sql(sql: string)",
    "Risk: the model can write arbitrary SQL with database authority.",
    "",
    "Synapsor shape:",
    "billing.inspect_invoice(invoice_id)",
    "billing.propose_late_fee_waiver(invoice_id, reason)",
    "",
    "Agent requested:",
    "billing.propose_late_fee_waiver(invoice_id=\"INV-3001\")",
    "",
    "Trusted context:",
    "tenant_id = acme",
    "principal = support.agent",
    "",
    "Proposal:",
    "invoice.late_fee_cents: 5500 -> 0",
    "",
    "Source DB changed:",
    "no",
    "",
    "Approval:",
    "required outside MCP",
    "",
    "Replay:",
    "available after approval/apply",
    "",
    "Next:",
    `${cliCommandName()} demo`,
    `${cliCommandName()} audit examples/dangerous-mcp-tools.json`,
    "",
  ].join("\n"));
  return 0;
}

async function mcpServe(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG;
  const readOnly = args.includes("--read-only");
  const config = readOnly
    ? { ...await readRuntimeConfig(configPath ?? defaultConfigPath), mode: "read_only" as const }
    : undefined;
  await serveStdio({
    configPath,
    storePath: optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE,
    config,
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

async function propose(args: string[]): Promise<number> {
  const capabilityName = firstPositional(args);
  if (!capabilityName) throw new Error("propose requires <capability-name>");
  const configPath = optionalArg(args, "--config") ?? defaultConfigPath;
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? defaultStorePath;
  const config = await readRuntimeConfig(configPath);
  const capability = (config.capabilities ?? []).find((item) => item.name === capabilityName);
  if (!capability) throw new Error(`proposal capability not found: ${capabilityName}`);
  if (capability.kind !== "proposal") throw new Error(`${capabilityName} is a ${capability.kind} capability. Use a proposal capability with ${cliCommandName()} propose.`);
  const input = await proposalInput(args, capability);
  const env = envWithDemoDefaults(config, configPath);
  const store = new ProposalStore(storePath);
  const runtime = createMcpRuntime(config, { store, env });
  try {
    const result = await runtime.callTool(capabilityName, input);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatProposeResult(capabilityName, result, storePath));
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function audit(args: string[]): Promise<number> {
  const url = optionalArg(args, "--url");
  const stdio = optionalArg(args, "--stdio");
  const mcpConfig = optionalArg(args, "--mcp-config");
  const target = url ?? (stdio ? `stdio:${stdio}` : mcpConfig ?? firstPositional(args));
  if (!target) throw new Error("audit requires <target>, --mcp-config <path>, --stdio <command>, or --url <url>");
  const forwarded = args.filter((arg, index) => {
    const previous = args[index - 1];
    return !["--url", "--stdio", "--mcp-config"].includes(arg) && !["--url", "--stdio", "--mcp-config"].includes(previous ?? "");
  });
  return mcpAudit([target, ...forwarded.filter((arg) => arg !== target)]);
}

async function proposalInput(args: string[], capability: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  const jsonInput = optionalArg(args, "--json");
  const inputPath = optionalArg(args, "--input");
  const sample = args.includes("--sample");
  const selected = [Boolean(jsonInput), Boolean(inputPath), sample].filter(Boolean).length;
  if (selected > 1) throw new Error("propose accepts only one of --sample, --input, or --json");
  if (jsonInput) {
    const parsed = JSON.parse(jsonInput);
    if (!isRecord(parsed)) throw new Error("propose --json must be a JSON object");
    return parsed;
  }
  if (inputPath) {
    const parsed = JSON.parse(await fs.readFile(inputPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("propose --input must point to a JSON object");
    return parsed;
  }
  if (sample) return sampleInputForCapability(capability);
  throw new Error(`propose ${capability.name} requires --sample, --input <file>, or --json '<object>'`);
}

function sampleInputForCapability(capability: RuntimeCapabilityConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(capability.args)) {
    if (name === capability.lookup.id_from_arg) input[name] = sampleIdForCapability(capability, name);
    else if (/reason/i.test(name)) input[name] = "approved support waiver";
    else if (/resolution/i.test(name)) input[name] = "Resolved after reviewing policy evidence.";
    else if (/status/i.test(name)) input[name] = "pending_review";
    else if (/amount|cents|fee|credit|balance/i.test(name)) input[name] = typeof spec.maximum === "number" ? Math.min(spec.maximum, 1000) : 0;
    else if (spec.type === "number") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
    else if (spec.enum?.length) input[name] = spec.enum[0];
    else input[name] = `sample_${name}`;
  }
  const missing = Object.entries(capability.args)
    .filter(([, spec]) => spec.required !== false)
    .filter(([name]) => input[name] === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`no sample exists for ${capability.name}. Required input fields: ${missing.join(", ")}`);
  }
  return input;
}

function sampleIdForCapability(capability: RuntimeCapabilityConfig, argName: string): string {
  const text = `${capability.name} ${capability.target.table} ${argName}`.toLowerCase();
  if (/invoice|billing/.test(text)) return "INV-3001";
  if (/ticket|support/.test(text)) return "T-1042";
  if (/order/.test(text)) return "ord_1001";
  if (/account|customer/.test(text)) return "cust_acme_1";
  return "sample_1";
}

function formatProposeResult(capabilityName: string, result: Record<string, unknown>, storePath: string): string {
  const proposalId = String(result.proposal_id ?? "");
  const evidenceId = String(result.evidence_bundle_id ?? "");
  const sourceChanged = result.source_database_changed === true || result.source_database_mutated === true;
  const lines = [
    "Proposal created.",
    "",
    "Capability:",
    capabilityName,
    "",
    "Proposal:",
    proposalId || "(missing)",
    "",
    "Evidence:",
    evidenceId || "(missing)",
    "",
    "Source DB changed:",
    sourceChanged ? "yes" : "no",
    "",
    "Review:",
    `${cliCommandName()} proposals show ${proposalId || "latest"} --store ${storePath}`,
    `${cliCommandName()} proposals approve ${proposalId || "latest"} --store ${storePath}`,
    `${cliCommandName()} apply ${proposalId || "latest"} --store ${storePath}`,
    `${cliCommandName()} replay ${proposalId || "latest"} --store ${storePath}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function mcpConfigure(args: string[]): Promise<number> {
  const client = optionalArg(args, "--client");
  if (!client) throw new Error("mcp configure requires --client generic-stdio|claude-desktop|cursor|vscode");
  const useAbsolutePaths = args.includes("--absolute-paths");
  const rawConfigPath = optionalArg(args, "--config") ?? "./synapsor.runner.json";
  const rawStorePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const configPath = useAbsolutePaths ? path.resolve(rawConfigPath) : rawConfigPath;
  const storePath = useAbsolutePaths ? path.resolve(rawStorePath) : rawStorePath;
  if (!await fileExists(rawConfigPath)) {
    process.stderr.write(`Warning: config path does not exist yet: ${rawConfigPath}\n`);
  }
  if (!path.isAbsolute(configPath) || !path.isAbsolute(storePath)) {
    process.stderr.write("Warning: relative paths are resolved by the MCP client working directory. Use --absolute-paths if the client runs from another directory.\n");
  }
  const snippet = mcpClientSnippet(client, configPath, storePath);
  if (args.includes("--write")) {
    const destination = optionalArg(args, "--destination");
    if (!destination) throw new Error("mcp configure --write requires --destination <path>");
    await writeMcpClientSnippet(destination, client, snippet, args.includes("--yes"));
    process.stdout.write(`wrote MCP ${client} configuration to ${destination}\n`);
  } else {
    process.stderr.write(`Paste this ${client} MCP config into your local MCP client settings. It contains command paths only, not database URLs or write credentials.\n`);
    process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
  }
  return 0;
}

async function mcpConfig(args: string[]): Promise<number> {
  const [client, ...rest] = args;
  if (!client || client.startsWith("--")) return mcpConfigure(["--client", "claude-desktop", ...args]);
  return mcpConfigure(["--client", client, ...rest]);
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

async function mcpSmoke(args: string[]): Promise<number> {
  const boundary = await inspectMcpToolBoundary(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: boundary.ok, config_path: boundary.configPath, store_path: boundary.storePath, tools: boundary.names, checks: boundary.checks }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMcpSmoke(boundary));
  }
  return boundary.ok ? 0 : 1;
}

async function toolsPreview(args: string[]): Promise<number> {
  const boundary = await inspectMcpToolBoundary(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: boundary.ok,
      config_path: boundary.configPath,
      store_path: boundary.storePath,
      exposed_to_mcp: boundary.names,
      not_exposed_to_mcp: defaultBlockedToolSurface(),
      checks: boundary.checks,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(formatToolsPreview(boundary));
  }
  return boundary.ok ? 0 : 1;
}

async function inspectMcpToolBoundary(args: string[]): Promise<{
  ok: boolean;
  configPath: string;
  storePath: string;
  names: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const configPath = optionalArg(args, "--config") ?? "./synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  if (!await fileExists(configPath)) {
    throw new Error(`MCP tool preview could not find ${configPath}.\n\nWhy it matters:\nThe MCP server needs a reviewed config before it can expose semantic tools.\n\nFix:\nRun ${cliCommandName()} init --wizard --from-env DATABASE_URL, or pass --config <path>.`);
  }
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  const runtime = createMcpRuntime(parsed, { storePath });
  try {
    const tools = runtime.listTools();
    const names = tools.map((tool) => tool.name);
    const serialized = JSON.stringify(tools);
    const checks = [
      { name: "semantic tools present", ok: names.length > 0, detail: names.join(", ") || "none" },
      { name: "execute_sql absent", ok: !names.some((name) => /execute_sql|run_query|query_database/i.test(name)), detail: "model does not receive raw SQL tools" },
      { name: "approval tools absent", ok: !names.some((name) => /approve/i.test(name)), detail: "approval stays outside MCP" },
      { name: "commit tools absent", ok: !names.some((name) => /commit|apply_writeback/i.test(name)), detail: "commit stays outside MCP" },
      { name: "database_url absent", ok: !/postgres(?:ql)?:\/\/|mysql:\/\//i.test(serialized), detail: "MCP config uses env var names, not connection strings" },
      { name: "write credentials absent", ok: !/(password|secret|bearer|private[_-]?key|token)/i.test(serialized), detail: "MCP tools do not include write credentials" },
    ];
    const ok = checks.every((check) => check.ok);
    return { ok, configPath, storePath, names, checks };
  } finally {
    runtime.close();
  }
}

function defaultBlockedToolSurface(): string[] {
  return [
    "execute_sql / raw query tools",
    "approval tools",
    "commit/apply tools",
    "database URLs",
    "write credentials",
    "model-controlled tenant authority",
    "arbitrary table or column names",
  ];
}

function formatToolsPreview(input: {
  ok: boolean;
  configPath: string;
  storePath: string;
  names: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): string {
  const lines = [
    `Synapsor tools preview: ${input.ok ? "ok" : "failed"}`,
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    "",
    "Exposed to MCP:",
    ...(input.names.length > 0 ? input.names.map((name) => `  - ${name}`) : ["  - (none)"]),
    "",
    "Not exposed to MCP:",
    ...defaultBlockedToolSurface().map((name) => `  - ${name}`),
    "",
    "Safety checks:",
  ];
  for (const check of input.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    lines.push(`  ${check.detail}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${cliCommandName()} mcp serve --config ${input.configPath} --store ${input.storePath}`);
  return `${lines.join("\n")}\n`;
}

function formatMcpSmoke(input: {
  ok: boolean;
  configPath: string;
  storePath: string;
  names: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): string {
  const lines = [
    `Synapsor MCP smoke: ${input.ok ? "ok" : "failed"}`,
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    "",
    "Tools the model would see:",
    ...input.names.map((name) => `  - ${name}`),
    "",
  ];
  for (const check of input.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    lines.push(`  ${check.detail}`);
  }
  return `${lines.join("\n")}\n`;
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

async function recipes(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return recipesList(rest);
  if (subcommand === "show") return recipesShow(rest);
  if (subcommand === "init") return recipesInit(rest);
  usage();
  return 2;
}

async function recipesList(args: string[]): Promise<number> {
  const recipes = await loadBuiltInRecipes();
  const payload = recipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    summary: recipe.summary,
    semantic_tools: recipe.semantic_tools,
  }));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ recipes: payload }, null, 2)}\n`);
  } else {
    for (const recipe of payload) {
      process.stdout.write(`${recipe.id}\n  ${recipe.summary}\n  tools: ${recipe.semantic_tools.join(", ")}\n`);
    }
  }
  return 0;
}

async function recipesShow(args: string[]): Promise<number> {
  const recipeId = positional(args, 0);
  if (!recipeId) throw new Error("recipes show requires <recipe_id_or_recipe.json>");
  const recipe = await requireRecipe(recipeId);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(recipe, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${recipe.title} (${recipe.id})\n`);
  process.stdout.write(`${recipe.summary}\n`);
  process.stdout.write(`Expected table: ${recipe.expected_table_type}\n`);
  process.stdout.write(`Required columns: ${recipe.required_columns.join(", ")}\n`);
  process.stdout.write(`Primary key: ${recipe.recommended_primary_key}\n`);
  process.stdout.write(`Tenant key: ${recipe.recommended_tenant_key}\n`);
  process.stdout.write(`Conflict/version column: ${recipe.recommended_conflict_column}\n`);
  process.stdout.write(`Visible columns: ${recipe.visible_columns.join(", ")}\n`);
  process.stdout.write(`Allowed write columns: ${recipe.allowed_write_columns.join(", ")}\n`);
  process.stdout.write(`Tools: ${recipe.semantic_tools.join(", ")}\n`);
  for (const note of recipe.notes) process.stdout.write(`- ${note}\n`);
  return 0;
}

async function recipesInit(args: string[]): Promise<number> {
  const recipeId = positional(args, 0);
  if (!recipeId) throw new Error("recipes init requires <recipe_id_or_recipe.json>");
  const recipe = await requireRecipe(recipeId);
  const engine = optionalArg(args, "--engine");
  if (engine !== undefined && engine !== "postgres" && engine !== "mysql") {
    throw new Error("recipes init --engine must be postgres or mysql");
  }
  const mode = optionalArg(args, "--mode");
  if (mode !== undefined && mode !== "read_only" && mode !== "shadow" && mode !== "review") {
    throw new Error("recipes init --mode must be read_only, shadow, or review");
  }
  const spec: OnboardingSelectionSpec = {
    ...structuredClone(recipe.spec),
    ...(engine ? { engine } : {}),
    ...(mode ? { mode } : {}),
  };
  if (mode === "read_only") {
    delete spec.patch;
    delete spec.patch_args;
    delete spec.allowed_columns;
    delete spec.numeric_bounds;
    delete spec.transition_guards;
  }
  const generated = generateRunnerConfigFromSpec(spec);
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, args.includes("--force"));
  process.stdout.write(`initialized recipe ${recipe.id}\n`);
  process.stdout.write("Review the generated table and column names against your staging database before serving MCP tools.\n");
  return 0;
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
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  if (isRunnerConfigLike(parsed)) {
    const runtime = createMcpRuntime(parsed as RuntimeConfig, { storePath: ":memory:" });
    try {
      return { tools: runtime.listTools() };
    } finally {
      runtime.close();
    }
  }
  return parsed;
}

function isRunnerConfigLike(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && Array.isArray(value.capabilities);
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
  usage(["proposals"]);
  return 2;
}

async function replay(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand && !["show", "export"].includes(subcommand)) return replayShow(args);
  if (subcommand === "show") return replayShow(rest);
  if (subcommand === "export") return replayExport(rest);
  usage(["replay"]);
  return 2;
}

async function shadow(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return shadowList(rest);
  if (subcommand === "record-human-action") return shadowRecordHumanAction(rest);
  if (subcommand === "compare") return shadowCompare(rest);
  if (subcommand === "report") return shadowReport(rest);
  usage(["shadow"]);
  return 2;
}

async function ui(args: string[]): Promise<number> {
  const portArg = optionalArg(args, "--port");
  const server = await startLocalUiServer({
    configPath: optionalArg(args, "--config") ?? "synapsor.runner.json",
    storePath: optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db",
    host: optionalArg(args, "--host") ?? "127.0.0.1",
    port: portArg ? Number(portArg) : 0,
    allowRemoteBind: args.includes("--allow-remote-bind"),
    tour: args.includes("--tour"),
  });
  process.stdout.write(`Synapsor Runner local UI: ${server.url}\n`);
  process.stdout.write("Approval and rejection actions require the per-run local session plus CSRF token. Press Ctrl+C to stop.\n");
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function shadowList(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const proposals = store.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ proposals }, null, 2)}\n`);
    } else if (proposals.length === 0) {
      process.stdout.write("No shadow proposals found.\n");
    } else {
      for (const proposal of proposals) process.stdout.write(formatProposalSummary(proposal));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function shadowRecordHumanAction(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("shadow record-human-action requires <proposal_id>");
  const patchPath = optionalArg(args, "--patch");
  if (!patchPath) throw new Error("shadow record-human-action requires --patch <human-action.json>");
  const patch = JSON.parse(await fs.readFile(patchPath, "utf8"));
  if (!isRecord(patch)) throw new Error("shadow human-action patch must be a JSON object");
  const store = await openLocalStore(args);
  try {
    const action = store.recordShadowHumanAction(proposalId, {
      actor: optionalArg(args, "--actor") ?? process.env.USER ?? "human_operator",
      patch,
      notes: optionalArg(args, "--notes"),
    });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(action, null, 2)}\n`);
    } else {
      process.stdout.write(`recorded human action ${action.action_id} for ${proposalId}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function shadowCompare(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("shadow compare requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const comparison = store.compareShadowProposal(proposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    } else {
      process.stdout.write(formatShadowComparison(comparison));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function shadowReport(args: string[]): Promise<number> {
  const store = await openLocalStore(args);
  try {
    const report = store.shadowReport();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write([
        "Shadow mode report",
        `total shadow proposals: ${report.total_shadow_proposals}`,
        `with human action: ${report.with_human_action}`,
        `exact matches: ${report.exact_matches}`,
        `partial matches: ${report.partial_matches}`,
        `mismatches: ${report.mismatches}`,
        `no human action: ${report.no_human_action}`,
        "",
      ].join("\n"));
      for (const comparison of report.comparisons) process.stdout.write(formatShadowComparison(comparison));
    }
    return 0;
  } finally {
    store.close();
  }
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
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = store.getProposal(resolvedProposalId);
    if (!proposal) throw new Error(`proposal not found: ${resolvedProposalId}`);
    const payload = { proposal, events: store.events(resolvedProposalId), receipts: store.receipts(resolvedProposalId) };
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
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Approve proposal ${resolvedProposalId} for guarded writeback?`);
    const updated = store.approveProposal(resolvedProposalId, {
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
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!args.includes("--json")) {
      process.stdout.write(formatProposalDetail(proposal));
    }
    await confirmDangerousAction(args, `Reject proposal ${resolvedProposalId}?`);
    const updated = store.rejectProposal(resolvedProposalId, {
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
  const output = outputArg(args);
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const job = store.createWritebackJobFromProposal(resolvedProposalId, {
      project_id: optionalArg(args, "--project") ?? "local",
      runner_id: optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner",
      lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
    });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    if (output) {
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, text, "utf8");
      process.stdout.write(`created writeback job ${job.writeback_job_id} for ${resolvedProposalId} at ${output}\n`);
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
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const replayRecord = store.replay(resolvedProposalId);
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
  const output = outputArg(args);
  if (!output) throw new Error("replay export requires --output <path>");
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const replayRecord = store.replay(resolvedProposalId);
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

async function resolveProposalId(proposalId: string, storePath: string): Promise<string> {
  if (proposalId !== "latest") return proposalId;
  const store = new ProposalStore(storePath);
  try {
    return resolveProposalIdFromStore(proposalId, store);
  } finally {
    store.close();
  }
}

function resolveProposalIdFromStore(proposalId: string, store: ProposalStore): string {
  if (proposalId !== "latest") return proposalId;
  const latest = store.listProposals()[0];
  if (!latest) throw new Error("no proposals found in the local store");
  return latest.proposal_id;
}

async function readRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  return parsed;
}

function envWithDemoDefaults(config: RuntimeConfig, configPath: string): NodeJS.ProcessEnv {
  if (!isReferenceDemoConfig(config, configPath)) return process.env;
  return { ...referenceDemoEnv, ...process.env };
}

function isReferenceDemoConfig(config: RuntimeConfig, configPath: string): boolean {
  const normalized = path.normalize(configPath);
  const hasReferenceSource = Boolean(config.sources?.app_postgres?.read_url_env === "REFERENCE_POSTGRES_READ_URL");
  return hasReferenceSource || normalized.endsWith(path.normalize(referenceDemoConfigPath));
}

async function prepareReferenceDemo(args: string[]): Promise<number> {
  const force = args.includes("--force") || args.includes("--reset");
  const composePath = path.resolve(referenceDemoDir, "docker-compose.yml");
  if (!await fileExists(composePath)) throw new Error(`demo compose file not found: ${composePath}`);
  const configPath = path.resolve(defaultConfigPath);
  if (await fileExists(configPath) && !force) {
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
    if (!isReferenceDemoConfig(existing, defaultConfigPath)) {
      throw new Error(`${defaultConfigPath} already exists and is not the Synapsor demo config. Rerun with --force, or pass --config to later commands.`);
    }
  }
  await fs.mkdir(path.resolve(".synapsor"), { recursive: true });
  await fs.rm(path.resolve(defaultStorePath), { force: true });
  process.stdout.write([
    "Synapsor Runner demo",
    "",
    "Raw database MCP tools can hand the model SQL and write authority.",
    "Synapsor Runner exposes semantic capabilities instead:",
    "  billing.inspect_invoice",
    "  billing.propose_late_fee_waiver",
    "",
    "Demo flow:",
    "proposal first -> source unchanged -> approval outside MCP -> guarded writeback -> replay",
    "",
    "Starting disposable Postgres fixture...",
    "",
  ].join("\n"));
  const down = spawnSync("docker", ["compose", "-f", composePath, "down", "-v", "--remove-orphans"], { stdio: "inherit", env: process.env });
  if (down.status !== 0) return down.status ?? 1;
  const up = spawnSync("docker", ["compose", "-f", composePath, "up", "-d"], { stdio: "inherit", env: process.env });
  if (up.status !== 0) return up.status ?? 1;
  await waitForReferenceDemoDatabase();
  await fs.copyFile(path.resolve(referenceDemoConfigPath), configPath);
  process.stdout.write([
    "Synapsor Runner demo is ready.",
    "",
    "What is running:",
    "* Demo Postgres database",
    "* Synapsor local store",
    "* Safe MCP capability config",
    "",
    "Try:",
    `1. ${cliCommandName()} propose billing.propose_late_fee_waiver --sample`,
    `2. ${cliCommandName()} proposals show latest`,
    `3. ${cliCommandName()} proposals approve latest --yes`,
    `4. ${cliCommandName()} apply latest`,
    `5. ${cliCommandName()} replay latest`,
    "",
    "Connect MCP:",
    `${cliCommandName()} mcp config --absolute-paths --config ./synapsor.runner.json --store ./.synapsor/local.db`,
    "",
    "Open UI:",
    `${cliCommandName()} ui --tour`,
    "",
  ].join("\n"));
  return 0;
}

async function waitForReferenceDemoDatabase(): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync("docker", ["exec", referenceDemoContainer, "pg_isready", "-U", "synapsor_admin", "-d", referenceDemoDatabase], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`demo database did not become ready: ${last}`);
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

function outputArg(args: string[]): string | undefined {
  return optionalArg(args, "--output") ?? optionalArg(args, "--out");
}

const INLINE_DATABASE_URL_ENV = "SYNAPSOR_RUNNER_INLINE_DATABASE_URL";

function databaseInputFromArgs(args: string[]): {
  explicit: boolean;
  inlineUrl: boolean;
  inspectionDatabaseUrlEnv: string;
  configDatabaseUrlEnv: string;
  env?: NodeJS.ProcessEnv;
} {
  const inlineFromFlag = optionalArg(args, "--from");
  const inlineFromPosition = firstDatabaseUrlPositional(args);
  if (inlineFromFlag && inlineFromPosition) {
    throw new Error("pass the database URL either as --from <url> or as the positional inspect URL, not both.");
  }
  const inlineUrl = inlineFromFlag ?? inlineFromPosition;
  if (inlineUrl && !isDatabaseUrl(inlineUrl)) {
    throw new Error("--from must be a postgres://, postgresql://, or mysql:// URL.");
  }
  const fromEnv = optionalArg(args, "--from-env") ?? optionalArg(args, "--database-url-env");
  const configDatabaseUrlEnv = fromEnv ?? "SYNAPSOR_DATABASE_READ_URL";
  if (inlineUrl) {
    return {
      explicit: true,
      inlineUrl: true,
      inspectionDatabaseUrlEnv: INLINE_DATABASE_URL_ENV,
      configDatabaseUrlEnv,
      env: { ...process.env, [INLINE_DATABASE_URL_ENV]: inlineUrl },
    };
  }
  return {
    explicit: Boolean(fromEnv),
    inlineUrl: false,
    inspectionDatabaseUrlEnv: configDatabaseUrlEnv,
    configDatabaseUrlEnv,
  };
}

function firstDatabaseUrlPositional(args: string[]): string | undefined {
  const positionalValue = firstPositional(args);
  return positionalValue && isDatabaseUrl(positionalValue) ? positionalValue : undefined;
}

function isDatabaseUrl(value: string): boolean {
  return /^(postgres(?:ql)?:\/\/|mysql:\/\/)/i.test(value);
}

function firstPositional(args: string[]): string | undefined {
  const flagsWithValues = new Set([
    "--allowed-columns",
    "--approval-role",
    "--actor",
    "--bearer-env",
    "--config",
    "--conflict-column",
    "--database-url-env",
    "--destination",
    "--engine",
    "--from",
    "--from-env",
    "--host",
    "--input",
    "--job",
    "--lease-seconds",
    "--lookup-arg",
    "--mode",
    "--mcp-config",
    "--namespace",
    "--numeric-bound",
    "--object-name",
    "--output",
    "--out",
    "--patch-fixed",
    "--patch-from-arg",
    "--port",
    "--primary-key",
    "--principal-env",
    "--project",
    "--reason",
    "--recipe",
    "--runner",
    "--schema",
    "--source-name",
    "--state",
    "--stdio",
    "--store",
    "--table",
    "--tenant-env",
    "--tenant-key",
    "--timeout-ms",
    "--transition-guard",
    "--url",
    "--visible-columns",
    "--write-url-env",
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
  const approvalStatus = currentApprovalStatus(proposal);
  const writebackStatus = currentWritebackStatus(proposal);
  return [
    `proposal: ${proposal.proposal_id}`,
    `state: ${proposal.state}`,
    `action: ${proposal.action}`,
    `principal: ${changeSet.principal.id} (${changeSet.principal.source})`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `primary key: ${changeSet.source.primary_key.column}=${formatScalar(changeSet.source.primary_key.value)}`,
    `approval: ${approvalStatus}${changeSet.approval.required_role ? ` required role ${changeSet.approval.required_role}` : ""}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `allowed columns: ${changeSet.guards.allowed_columns.join(", ")}`,
    `conflict guard: ${conflictGuard.column || "none"}=${formatScalar(conflictGuard.value)}`,
    `evidence: ${changeSet.evidence.bundle_id}  query ${changeSet.evidence.query_fingerprint}  items ${evidenceItems}`,
    `writeback: ${writebackStatus} via ${changeSet.writeback.mode}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    "diff:",
    ...Object.keys(changeSet.patch).map((column) => {
      const before = changeSet.before[column as keyof typeof changeSet.before];
      const proposed = changeSet.after[column as keyof typeof changeSet.after];
      return `  ${column}: ${JSON.stringify(before)} -> ${JSON.stringify(proposed)}`;
    }),
  ].join("\n") + "\n";
}

function currentApprovalStatus(proposal: StoredProposal): string {
  if (proposal.state === "rejected") return "rejected";
  if (proposal.state === "canceled") return "canceled";
  if (["approved", "pending_worker", "applied", "conflict", "failed"].includes(proposal.state)) return "approved";
  return proposal.change_set.approval.status;
}

function currentWritebackStatus(proposal: StoredProposal): string {
  if (proposal.state === "pending_worker") return "pending_worker";
  if (proposal.state === "applied") return "applied";
  if (proposal.state === "conflict") return "conflict";
  if (proposal.state === "failed") return "failed";
  return proposal.change_set.writeback.status;
}

function formatShadowComparison(comparison: {
  proposal_id: string;
  status: string;
  matching_columns: string[];
  differing_columns: string[];
  missing_from_human: string[];
  extra_human_columns: string[];
  notes?: string;
}): string {
  return [
    `shadow comparison: ${comparison.proposal_id}`,
    `status: ${comparison.status}`,
    `matching columns: ${comparison.matching_columns.join(", ") || "none"}`,
    `differing columns: ${comparison.differing_columns.join(", ") || "none"}`,
    `missing from human action: ${comparison.missing_from_human.join(", ") || "none"}`,
    `extra human columns: ${comparison.extra_human_columns.join(", ") || "none"}`,
    ...(comparison.notes ? [`notes: ${comparison.notes}`] : []),
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
      runner_version: "0.1.0-alpha.1",
      project_id: "token_scope",
      adapter_id: "mcp.your_adapter",
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

function isHelpRequest(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function cliCommandName(): string {
  return process.env.SYNAPSOR_RUNNER_COMMAND_NAME || "synapsor";
}

function usage(args: string[] = []): void {
  const [command, subcommand] = args;
  const key = command === "mcp" && subcommand ? `mcp ${subcommand}` : command ?? "";
  const cmd = cliCommandName();
  const help: Record<string, string> = {
    "": `Synapsor Runner

Safe MCP tools for Postgres/MySQL-backed agent actions.

Usage:
  ${cmd} <command>

Commands:
  inspect      Inspect a Postgres/MySQL schema
  init         Generate a Synapsor capability contract
  mcp          Serve safe semantic tools over MCP
  propose      Create a local evidence-backed proposal
  audit        Review MCP/database tool risk
  proposals   Review, approve, or reject proposals
  apply        Apply an approved proposal with guarded writeback
  replay       Show what happened
  demo         Start the local commit-safety demo
  ui           Open the local review UI

Examples:
  ${cmd} inspect --from-env DATABASE_URL
  ${cmd} init --wizard --from-env DATABASE_URL
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} propose billing.propose_late_fee_waiver --sample
  ${cmd} audit ./synapsor.runner.json
`,
    inspect: `Usage:
  ${cmd} inspect --from-env DATABASE_URL [--engine auto|postgres|mysql] [--schema public] [--json]
  ${cmd} inspect "<postgres-or-mysql-url>" [--engine auto|postgres|mysql] [--schema public] [--json]

Inspect schema metadata without mutating the database or printing credentials.
`,
    init: `Usage:
  ${cmd} init --wizard --from-env DATABASE_URL [--mode read_only|review|shadow] [--out synapsor.runner.json]
  ${cmd} init --inspection-json schema.json --table invoices --mode review --patch-from-arg waiver_reason=reason

Generate a reviewed Synapsor Runner contract. Defaults to read-only in the wizard.
`,
    mcp: `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp config --absolute-paths --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp audit ./tools-list.json

MCP clients see semantic tools. They do not receive raw SQL, write credentials, approval tools, or commit tools.
`,
    "mcp serve": `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db [--read-only] [--local]

Start the stdio MCP server. Startup logs stay off stdout so the MCP protocol remains clean.
`,
    "mcp config": `Usage:
  ${cmd} mcp config [claude-desktop|cursor|generic|vscode] [--absolute-paths] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Print MCP client configuration that references the local runner command, not database URLs. Defaults to claude-desktop.
`,
    propose: `Usage:
  ${cmd} propose <capability-name> --sample [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} propose <capability-name> --input ./input.json
  ${cmd} propose <capability-name> --json '{"invoice_id":"INV-3001","reason":"support-approved waiver"}'

Create the same evidence-backed proposal the MCP tool would create. The source database is not mutated.
`,
    audit: `Usage:
  ${cmd} audit ./synapsor.runner.json
  ${cmd} audit --mcp-config ./claude_desktop_config.json
  ${cmd} audit --stdio "node ./server.js"
  ${cmd} audit --url http://localhost:3000/mcp

Static MCP/database risk review only. This is not a security guarantee.
`,
    proposals: `Usage:
  ${cmd} proposals list [--store ./.synapsor/local.db]
  ${cmd} proposals show latest
  ${cmd} proposals approve latest --yes
  ${cmd} proposals reject latest --reason "..."

Review decisions happen outside the model-facing MCP tool surface.
`,
    apply: `Usage:
  ${cmd} apply latest [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} apply --job job.json --config ./synapsor.runner.json --store ./.synapsor/local.db

Apply an approved proposal through guarded writeback. Requires a trusted write credential.
`,
    replay: `Usage:
  ${cmd} replay latest [--store ./.synapsor/local.db]
  ${cmd} replay show latest
  ${cmd} replay export latest --output replay.json

Show evidence, proposal events, receipts, and replay state without rerunning side effects.
`,
	    demo: `Usage:
	  ${cmd} demo [--force]
	  ${cmd} demo --quick

	Start a disposable local Postgres demo and write ./synapsor.runner.json for the first-run flow.
	Use --quick for a fixture-only 15-second explanation with no Docker startup.
	`,
    ui: `Usage:
  ${cmd} ui [--tour] [--config synapsor.runner.json] [--store ./.synapsor/local.db]

Open the localhost review UI for proposals, diffs, evidence, receipts, and replay.
`,
  };
  process.stdout.write(help[key] ?? help[command ?? ""] ?? help[""] ?? "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}${formatCliErrorHint(message)}\n`);
      process.exit(1);
    });
}

function formatCliErrorHint(message: string): string {
  if (/self-signed certificate|certificate.*chain|unable to verify/i.test(message)) {
    return [
      "",
      "",
      "Hint:",
      "  The database is reachable, but TLS certificate verification failed.",
      "  For disposable local/dev RDS tests, use sslmode=no-verify in the URL.",
      "  For real staging/production-like testing, install the database CA bundle and keep certificate verification enabled.",
    ].join("\n");
  }
  return "";
}
