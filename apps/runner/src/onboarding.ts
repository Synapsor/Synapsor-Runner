import { createMcpRuntime, loadRuntimeConfigFromFile, type DbRowReader, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { mysqlReceiptMigration } from "@synapsor-runner/mysql";
import { postgresReceiptMigration } from "@synapsor-runner/postgres";
import {
  assessDirectWritePrerequisites,
  generateRunnerConfigFromSpec,
  inspectDatabase,
  summarizeInspection,
  type GeneratedOnboardingFiles,
  type InspectEngine,
  type OnboardingSelectionSpec,
  type SchemaInspection,
  type TableInfo
} from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { cliCommandName } from "./cli-command-meta.js";
import { writeFileGuarded } from "./cli-files.js";
import { isRecord } from "./cli-format.js";
import { envValue, firstPositional, listArg, optionalArg, outputArg, positiveIntegerOption, repeatedArgs, uniqueStrings } from "./cli-options.js";
import { databaseInputFromArgs, defaultStorePath, generatedSmokeInputPath } from "./cli-project.js";
import { RunnerSourceConfig } from "./cli-runtime.js";
import { starterCloudConfig, starterLocalConfig } from "./config-templates.js";
import { handlerSecurityWarning, handlerTemplateDefinitions, HandlerTemplateName, resolveHandlerTemplateName, writeHandlerTemplateFile } from "./handler-templates.js";
import { formatSmokeCallResult, normalizeResultFormatAnswer, resultFormatOption } from "./mcp-shared.js";
import { buildCanonicalOnboardingArtifacts, type CanonicalOnboardingArtifacts } from "./onboarding-artifacts.js";
import { detectProjectContext, formatProjectDetection } from "./project-detection.js";
import { CapabilityRecipe, loadBuiltInRecipes, requireRecipe } from "./recipe-domain.js";
import type { SchemaCandidateFormat } from "./schema-candidates.js";
import { quoteSqlIdentifier } from "./sql-identifiers.js";
import { formatSourceReceiptMode } from "./writeback-domain.js";


export async function init(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  const schemaFormat = schemaCandidateFormat(subcommand);
  if (schemaFormat) return initFromDeveloperSchema(schemaFormat, rest);
  const answersPath = optionalArg(args, "--answers");
  if (answersPath) {
    return initFromAnswers(args, answersPath);
  }
  const specPath = optionalArg(args, "--spec");
  if (specPath) {
    return initFromSpec(args, specPath);
  }
  const scripted = isScriptedOnboardingArgs(args);
  if (args.includes("--wizard") || (process.stdin.isTTY && process.stdout.isTTY && !args.includes("--starter") && !scripted)) {
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


function schemaCandidateFormat(value: string | undefined): SchemaCandidateFormat | undefined {
  if (value === "from-prisma") return "prisma";
  if (value === "from-drizzle") return "drizzle";
  if (value === "from-openapi") return "openapi";
  return undefined;
}


async function initFromDeveloperSchema(format: SchemaCandidateFormat, args: string[]): Promise<number> {
  const inputPath = firstPositional(args);
  if (!inputPath) throw new Error(`init from-${format} requires <input-file>`);
  const outputDir = outputArg(args);
  if (!outputDir) {
    throw new Error(`init from-${format} requires --output <separate-candidate-directory>`);
  }
  const { generateSchemaCandidateDirectory } = await import("./schema-candidates.js");
  const result = await generateSchemaCandidateDirectory({
    format,
    inputPath,
    outputDir,
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${[
    `Synapsor ${format} candidates generated`,
    `Output: ${result.output_dir}`,
    `Source digest: ${result.source_digest}`,
    `Objects: ${result.objects}`,
    `Capabilities: ${result.capabilities}`,
    "",
    "Safety state: blocked and unreviewed",
    "- schema/API shape was inspected; tenant and principal authority were not inferred;",
    "- proposal writeback is disabled;",
    "- Runner mode is shadow and no database source is configured;",
    "- production configuration was not changed.",
    "",
    `Review ${path.join(result.output_dir, "REVIEW.md")} and the candidate contract before activating anything.`,
  ].join("\n")}\n`);
  return 0;
}


type WizardAsk = (question: string, defaultValue?: string) => Promise<string>;


export async function runInitWizard(
  args: string[],
  options: {
    ask?: WizardAsk;
    env?: NodeJS.ProcessEnv;
    inspection?: SchemaInspection;
    readRow?: DbRowReader;
    stdout?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<number> {
  const ask = options.ask ?? askTtyQuestion;
  const stdout = options.stdout ?? process.stdout;
  stdout.write("Synapsor Runner guided init\n");
  stdout.write("Use a staging or disposable Postgres/MySQL database first. The wizard stores environment-variable names, not credentials.\n");
  stdout.write("Flow: inspect database -> create trusted context -> create capability -> expose MCP tool.\n\n");

  stdout.write("Step 1: Inspect database metadata\n");
  const engineInput = await askChoice(ask, "Engine", optionalArg(args, "--engine") ?? "auto", ["postgres", "mysql", "auto"]);
  const databaseInput = databaseInputFromArgs(args, { implyDatabaseUrl: true });
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
  stdout.write("\nStep 2: Create trusted context\n");
  stdout.write("Choose the source object and trusted scope. Tenant and principal values come from your backend/session, not from the model.\n");
  const tableName = await askDefault(ask, "Source table/view for this context", optionalArg(args, "--table") ?? tables[0]?.name ?? "");
  const table = findInspectionTable(inspection, tableName, schema);
  if (!table) throw new Error(`table not found in inspection: ${schema}.${tableName}`);
  const columns = table.columns.map((column) => column.name);

  const primaryKey = await askColumn(ask, "Primary-key column", optionalArg(args, "--primary-key") ?? table.primary_key[0] ?? inferPrimaryKeyCandidate(table), columns);
  const suggestedTenant = optionalArg(args, "--tenant-key") ?? table.suggestions.tenant_columns[0];
  const tenantAnswer = await askDefault(ask, "Trusted tenant/scope column", suggestedTenant ?? "");
  const singleTenantDev = !tenantAnswer && (await askDefault(ask, "No tenant column selected. Type yes to mark this as a single-tenant dev source", "no")).toLowerCase() === "yes";
  if (!tenantAnswer && !singleTenantDev) throw new Error("tenant/scope column is required unless single-tenant dev source is explicitly confirmed");
  if (tenantAnswer && !columns.includes(tenantAnswer)) throw new Error(`tenant column ${tenantAnswer} does not exist on ${table.schema}.${table.name}`);
  const tenantEnv = await askEnvName(ask, "Trusted tenant env var", optionalArg(args, "--tenant-env") ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = await askEnvName(ask, "Trusted principal env var", optionalArg(args, "--principal-env") ?? "SYNAPSOR_PRINCIPAL");

  stdout.write("\nStep 3: Create capability\n");
  stdout.write("Name the semantic tool the model can call. Table, key, visible fields, and mode define what that capability can do.\n");
  const mode = await askChoice(ask, "Capability mode", optionalArg(args, "--mode") ?? "read_only", ["read_only", "shadow", "review"]);
  const operation = mode === "read_only"
    ? "update"
    : await askChoice(ask, "Proposal operation", optionalArg(args, "--operation") ?? "update", ["update", "insert", "delete"]);
  const conflictAnswer = mode === "read_only" || operation === "insert"
    ? optionalArg(args, "--conflict-column") ?? ""
    : await askDefault(ask, "Conflict/version column", optionalArg(args, "--conflict-column") ?? table.suggestions.conflict_columns[0] ?? "");
  if (conflictAnswer && !columns.includes(conflictAnswer)) throw new Error(`conflict column ${conflictAnswer} does not exist on ${table.schema}.${table.name}`);
  const defaultVisible = table.suggestions.default_visible_columns.join(",");
  let visibleColumns = parseColumnList(await askDefault(ask, "Capability read-visible columns", optionalArg(args, "--visible-columns") ?? defaultVisible));
  ensureColumnsExist(visibleColumns, columns, "visible");

  if (mode !== "read_only" && operation === "delete" && !conflictAnswer) {
    throw new Error("hard DELETE is unavailable without an inspected exact conflict/version column; use a guarded soft-delete UPDATE instead");
  }
  if (mode !== "read_only" && operation === "update" && !conflictAnswer) {
    const weak = await askDefault(ask, "No conflict/version column selected. Type yes to continue with a weak guard", "no");
    if (weak.toLowerCase() !== "yes") throw new Error("conflict/version column is required unless weak guard is explicitly acknowledged");
  }
  let recipeSpec: OnboardingSelectionSpec | undefined;
  if (mode !== "read_only" && operation === "update") {
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
  if (mode !== "read_only" && operation !== "delete") {
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

  let deduplication: OnboardingSelectionSpec["deduplication"];
  if (mode !== "read_only" && operation === "insert") {
    if (!tenantAnswer) throw new Error("native guarded INSERT requires a trusted tenant column");
    const inferred = inferInsertDeduplication(table, tenantAnswer, primaryKey);
    const mappingInput = await askDefault(
      ask,
      "INSERT dedup mapping (column=proposal_id|trusted_tenant|fixed:value, comma-separated)",
      optionalArg(args, "--dedup") ?? formatDeduplication(inferred),
    );
    deduplication = parseDeduplicationInput(mappingInput);
    const assessment = assessDirectWritePrerequisites(table, {
      operation: "insert",
      primary_key: primaryKey,
      tenant_key: tenantAnswer,
      allowed_columns: allowedColumns ?? [],
      patch_columns: Object.keys(patch),
      dedup_columns: deduplication.components.map((component) => component.column),
    });
    const failures = assessment.filter((item) => item.level === "fail");
    if (failures.length > 0) throw new Error(`native INSERT prerequisites failed: ${failures.map((item) => item.message).join(" ")}`);
  }

  const inferredObjectName = recipeSpec?.object_name ?? safeObjectName(table.name);
  const namespace = await askDefault(ask, "Capability namespace", optionalArg(args, "--namespace") ?? recipeSpec?.namespace ?? inferCapabilityNamespace(table.name));
  const objectName = await askDefault(ask, "Business object name", optionalArg(args, "--object-name") ?? inferredObjectName);
  const lookupArg = await askDefault(ask, "Model-visible object id argument", optionalArg(args, "--lookup-arg") ?? recipeSpec?.lookup_arg ?? `${objectName}_id`);
  const defaultInspectToolName = recipeSpec?.inspect_tool_name ?? `${namespace}.inspect_${objectName}`;
  const inspectToolName = await askDefault(
    ask,
    "Read capability name",
    optionalArg(args, "--read-tool") ?? optionalArg(args, "--inspect-tool-name") ?? defaultInspectToolName,
  );
  const defaultProposalToolName = recipeSpec?.proposal_tool_name ?? `${namespace}.propose_${objectName}_${operation}`;
  const proposalToolName = mode === "read_only" ? undefined : await askDefault(
    ask,
    "Proposal capability name",
    optionalArg(args, "--proposal-tool") ?? optionalArg(args, "--proposal-tool-name") ?? defaultProposalToolName,
  );
  const smokeObjectId = await askDefault(ask, "Optional real object id for a first smoke call", optionalArg(args, "--smoke-id") ?? "");
  const objectLabel = objectName.replace(/_/g, " ");
  const inspectDescription = await askDefault(
    ask,
    "Read capability description",
    optionalArg(args, "--inspect-description") ?? `Inspect one ${objectLabel} in trusted tenant scope before answering or proposing a change.`,
  );
  const inspectReturnsHint = await askDefault(
    ask,
    "Read capability returns hint",
    optionalArg(args, "--inspect-returns-hint") ?? `Returns reviewed ${objectLabel} fields, evidence handle, query audit, and source_database_changed:false.`,
  );
  const proposalDescription = mode === "read_only" ? undefined : await askDefault(
    ask,
    "Proposal capability description",
    optionalArg(args, "--proposal-description") ?? `Create a review-required proposal to ${operation} one ${objectLabel}. The source database remains unchanged until approval and writeback.`,
  );
  const proposalReturnsHint = mode === "read_only" ? undefined : await askDefault(
    ask,
    "Proposal capability returns hint",
    optionalArg(args, "--proposal-returns-hint") ?? "Returns a proposal id, exact before/after diff, evidence handle, approval status, and source_database_changed:false.",
  );
  const resultFormatAnswer = await askChoice(ask, "MCP result envelope", optionalArg(args, "--result-format") ? normalizeResultFormatAnswer(optionalArg(args, "--result-format") as string) : "v2", ["v2", "v1", "default"]);
  const resultFormat = resultFormatAnswer === "v1" ? 1 : resultFormatAnswer === "v2" ? 2 : undefined;
  let writeUrlEnv: string | undefined = optionalArg(args, "--write-url-env");
  let writeback: OnboardingSelectionSpec["writeback"] | undefined;
  let receipts: OnboardingSelectionSpec["receipts"] | undefined;
  let versionAdvance: OnboardingSelectionSpec["version_advance"] | undefined;
  let generatedHandlerTemplate: { name: HandlerTemplateName; output: string } | undefined;
  if (mode === "review") {
    const writebackPath = await askChoice(
      ask,
      "Writeback path",
      optionalArg(args, "--writeback") ?? "sql_update",
      ["sql_update", "http_handler", "command_handler"],
    );
    if (writebackPath === "sql_update") {
      writeUrlEnv = await askEnvName(ask, "Write URL env var for trusted direct SQL apply", writeUrlEnv ?? "SYNAPSOR_DATABASE_WRITE_URL");
      writeback = { executor: "sql_update" };
      stdout.write("Receipt authority controls crash classification. source_db is atomic with the mutation; runner_ledger changes no source schema but may require operator reconciliation after an ambiguous crash.\n");
      const receiptChoice = await askChoice(
        ask,
        "Receipt mode",
        optionalArg(args, "--receipt-mode") ?? "source_auto_migrate",
        ["source_auto_migrate", "source_precreated", "runner_ledger"],
      );
      receipts = receiptChoice === "runner_ledger"
        ? { authority: "runner_ledger" }
        : {
          authority: "source_db",
          provisioning: receiptChoice === "source_auto_migrate" ? "auto_migrate" : "precreated",
          schema: optionalArg(args, "--receipt-schema"),
          table: optionalArg(args, "--receipt-table") ?? "synapsor_writeback_receipts",
        };
      if (receipts.authority === "runner_ledger" && operation === "update") {
        if (!conflictAnswer) throw new Error("runner_ledger UPDATE requires an exact conflict/version column");
        const conflictColumn = table.columns.find((column) => column.name === conflictAnswer);
        const inferredStrategy = conflictColumn && /int|numeric|decimal|number/i.test(conflictColumn.data_type)
          ? "integer_increment"
          : "database_generated";
        const strategy = await askChoice(
          ask,
          "Version advancement strategy",
          optionalArg(args, "--version-advance") ?? inferredStrategy,
          ["integer_increment", "database_generated"],
        );
        versionAdvance = { column: conflictAnswer, strategy: strategy as "integer_increment" | "database_generated" };
      }
    } else if (writebackPath === "http_handler") {
      const urlEnv = await askEnvName(ask, "App-owned HTTP handler URL env var", optionalArg(args, "--handler-url-env") ?? "SYNAPSOR_APP_WRITEBACK_URL");
      const tokenEnv = await askOptionalEnvName(ask, "Optional HTTP handler bearer-token env var", optionalArg(args, "--handler-token-env") ?? "");
      const signingSecretEnv = await askOptionalEnvName(ask, "Optional HTTP handler HMAC signing-secret env var", optionalArg(args, "--handler-signing-secret-env") ?? "");
      writeback = {
        executor: "http_handler",
        executor_name: optionalArg(args, "--executor-name"),
        handler_url_env: urlEnv,
        ...(tokenEnv ? { handler_token_env: tokenEnv } : {}),
        ...(signingSecretEnv ? { handler_signing_secret_env: signingSecretEnv } : {}),
        timeout_ms: positiveIntegerOption(args, "--handler-timeout-ms"),
      };
      const writeTemplate = await askChoice(ask, "Write starter app-owned handler template", args.includes("--skip-handler-template") ? "no" : "yes", ["yes", "no"]);
      if (writeTemplate === "yes") {
        const template = await askChoice(ask, "Handler template", optionalArg(args, "--handler-template") ?? "node-fastify", ["node-fastify", "python-fastapi"]) as HandlerTemplateName;
        const output = await askDefault(ask, "Handler template output", optionalArg(args, "--handler-output") ?? optionalArg(args, "--handler-template-output") ?? handlerTemplateDefinitions[template].fileName);
        generatedHandlerTemplate = { name: template, output };
      }
    } else {
      const commandEnv = await askEnvName(ask, "App-owned command handler env var", optionalArg(args, "--handler-command-env") ?? "SYNAPSOR_APP_WRITEBACK_COMMAND");
      writeback = {
        executor: "command_handler",
        executor_name: optionalArg(args, "--executor-name"),
        handler_command_env: commandEnv,
        timeout_ms: positiveIntegerOption(args, "--handler-timeout-ms"),
      };
      const writeTemplate = await askChoice(ask, "Write starter app-owned handler template", args.includes("--skip-handler-template") ? "no" : "yes", ["yes", "no"]);
      if (writeTemplate === "yes") {
        const output = await askDefault(ask, "Handler template output", optionalArg(args, "--handler-output") ?? optionalArg(args, "--handler-template-output") ?? handlerTemplateDefinitions.command.fileName);
        generatedHandlerTemplate = { name: "command", output };
      }
    }
  }
  if (mode === "review" && writeback?.executor === "sql_update" && operation === "delete") {
    const assessment = assessDirectWritePrerequisites(table, {
      operation: "delete",
      primary_key: primaryKey,
      tenant_key: tenantAnswer || undefined,
      allowed_columns: [],
      patch_columns: [],
      conflict_column: conflictAnswer || undefined,
    });
    const failures = assessment.filter((item) => item.level === "fail");
    if (failures.length > 0) throw new Error(`native hard DELETE prerequisites failed: ${failures.map((item) => item.message).join(" ")} Prefer a guarded soft-delete UPDATE or an app-owned executor.`);
  }
  const approvalRole = mode === "read_only" ? "local_reviewer" : await askDefault(ask, "Required approval role", optionalArg(args, "--approval-role") ?? recipeSpec?.approval?.required_role ?? "local_reviewer");

  let spec: OnboardingSelectionSpec = {
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
    inspect_tool_name: inspectToolName,
    proposal_tool_name: proposalToolName,
    inspect_description: inspectDescription,
    inspect_returns_hint: inspectReturnsHint,
    proposal_description: proposalDescription,
    proposal_returns_hint: proposalReturnsHint,
    lookup_arg: lookupArg,
    result_format: resultFormat as 1 | 2 | undefined,
    visible_columns: visibleColumns,
    operation: operation as "update" | "insert" | "delete",
    deduplication,
    version_advance: versionAdvance,
    receipts,
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
    writeback,
  };
  let generated = generateRunnerConfigFromSpec(spec);
  stdout.write("\nPreview:\n");
  printWizardContractPreview(stdout, { spec, generated, engine: inspection.engine, table });
  if (generatedHandlerTemplate) {
    stdout.write(`  handler template: ${generatedHandlerTemplate.output}\n`);
    stdout.write(`${handlerSecurityWarning}\n`);
  }
  const editPreview = await askDefault(ask, "Edit visible fields or capability names before writing? Type yes to edit", "no");
  if (editPreview.toLowerCase() === "yes") {
    const updatedVisible = parseColumnList(await askDefault(
      ask,
      "Final visible columns",
      spec.visible_columns?.join(",") ?? visibleColumns.join(","),
    ));
    ensureColumnsExist(updatedVisible, columns, "visible");
    const currentReadTool = spec.inspect_tool_name ?? (generated.config.capabilities as Array<{ name: string; kind: string }>).find((capability) => capability.kind === "read")?.name ?? inspectToolName;
    const updatedReadTool = await askDefault(ask, "Final read capability name", currentReadTool);
    const currentProposalTool = spec.proposal_tool_name ?? (generated.config.capabilities as Array<{ name: string; kind: string }>).find((capability) => capability.kind === "proposal")?.name ?? proposalToolName ?? "";
    const updatedProposalTool = spec.mode === "read_only" ? undefined : await askDefault(ask, "Final proposal capability name", currentProposalTool);
    spec = {
      ...spec,
      visible_columns: updatedVisible,
      inspect_tool_name: updatedReadTool,
      proposal_tool_name: updatedProposalTool,
    };
    generated = generateRunnerConfigFromSpec(spec);
    stdout.write("\nUpdated preview:\n");
    printWizardContractPreview(stdout, { spec, generated, engine: inspection.engine, table });
  }
  const generatedCapabilities = generated.config.capabilities as Array<{ name: string; kind: string }>;
  const smokeToolName = generatedCapabilities[0]?.name ?? "<inspect_tool>";
  const confirmed = await askDefault(ask, "Write generated config and MCP snippets? Type yes to continue", "no");
  if (confirmed.toLowerCase() !== "yes") throw new Error("guided init canceled before writing files");
  const outputPath = outputArg(args) ?? "synapsor.runner.json";
  await writeGeneratedOnboardingFiles(outputPath, generated, spec, args.includes("--force"), {
    printNext: false,
    table,
    activationConfirmed: spec.mode === "review",
  });
  if (generatedHandlerTemplate) {
    await writeHandlerTemplateFile(generatedHandlerTemplate.name, generatedHandlerTemplate.output, args.includes("--force"));
    stdout.write(`created ${generatedHandlerTemplate.output}\n`);
  }
  if (smokeObjectId) {
    await writeGeneratedSmokeInputFile(lookupArg, smokeObjectId, args.includes("--force"));
    stdout.write(`created ${generatedSmokeInputPath}\n`);
    const smoke = await maybeRunGeneratedSmokeCall({
      config: loadRuntimeConfigFromFile(outputPath),
      configPath: outputPath,
      env: options.env ?? process.env,
      input: { [lookupArg]: smokeObjectId },
      readUrlEnv: configDatabaseUrlEnv,
      tenantEnv,
      principalEnv,
      readRow: options.readRow,
      storePath: defaultStorePath,
      toolName: smokeToolName,
    });
    stdout.write(smoke);
  }
  stdout.write("Next:\n");
  stdout.write(`  1. Set trusted env vars from .env.example, then run: ${cliCommandName()} doctor --config ${outputPath}\n`);
  if (smokeObjectId) {
    stdout.write(`  2. Smoke-call the read capability: ${cliCommandName()} smoke call ${smokeToolName} --input ${generatedSmokeInputPath} --config ${outputPath} --store ${defaultStorePath}\n`);
  } else {
    stdout.write(`  2. Smoke-call a real row: ${cliCommandName()} smoke call ${smokeToolName} --json '{"${lookupArg}":"<real_id>"}' --config ${outputPath} --store ${defaultStorePath}\n`);
  }
  stdout.write(`  3. Serve MCP tools: ${cliCommandName()} mcp serve --config ${outputPath} --store ${defaultStorePath}\n`);
  if (receipts?.authority === "runner_ledger") {
    stdout.write("  Networked/Streamable HTTP with runner_ledger requires storage.shared_postgres.mode=runtime_store; local SQLite is intentionally limited to one stdio/operator process.\n");
  } else {
    stdout.write(`  OpenAI Agents SDK: use ${cliCommandName()} mcp serve-streamable-http --config ${outputPath} --store ${defaultStorePath} --alias-mode openai\n`);
  }
  return 0;
}


function printWizardContractPreview(
  stdout: Pick<NodeJS.WriteStream, "write">,
  input: {
    spec: OnboardingSelectionSpec;
    generated: GeneratedOnboardingFiles;
    engine: InspectEngine;
    table: TableInfo;
  },
): void {
  const capabilities = input.generated.config.capabilities as Array<{ name: string; kind: string }>;
  const tools = capabilities.map((capability) => `${capability.name} (${capability.kind})`);
  const readCapability = capabilities.find((capability) => capability.kind === "read")?.name ?? input.spec.inspect_tool_name ?? "<read_tool>";
  const proposalCapability = capabilities.find((capability) => capability.kind === "proposal")?.name ?? input.spec.proposal_tool_name;
  const visibleColumns = input.spec.visible_columns ?? [];
  const tenantEnv = input.spec.trusted_context?.tenant_id_env ?? "SYNAPSOR_TENANT_ID";
  const principalEnv = input.spec.trusted_context?.principal_env ?? "SYNAPSOR_PRINCIPAL";
  const visiblePreview = visibleColumns.length <= 12
    ? visibleColumns.join(", ")
    : `${visibleColumns.slice(0, 12).join(", ")} (+${visibleColumns.length - 12} more)`;
  stdout.write(`  trusted context: tenant from ${tenantEnv}${input.spec.single_tenant_dev ? " (single-tenant dev source)" : input.spec.tenant_key ? ` via ${input.spec.tenant_key}` : ""}; principal from ${principalEnv}\n`);
  stdout.write(`  source: ${input.engine} ${input.table.schema}.${input.table.name}\n`);
  stdout.write(`  primary key: ${input.spec.primary_key}${input.spec.conflict_column ? `; conflict guard: ${input.spec.conflict_column}` : ""}\n`);
  stdout.write(`  visible fields: ${visiblePreview || "none"}\n`);
  stdout.write(`  mode: ${input.spec.mode}\n`);
  stdout.write(`  activation: ${input.spec.mode === "review" ? "disabled until the final explicit confirmation" : input.spec.mode === "shadow" ? "shadow-only; approval and writeback disabled" : "read-only"}\n`);
  if (input.spec.mode !== "read_only") stdout.write(`  operation: ${(input.spec.operation ?? "update").toUpperCase()}; max rows: 1\n`);
  stdout.write(`  result envelope: ${input.spec.result_format ? `v${input.spec.result_format}` : "default"}\n`);
  stdout.write(`  writeback path: ${input.spec.writeback?.executor ?? (input.spec.mode === "review" ? "sql_update" : "none")}\n`);
  if (input.spec.writeback?.executor === "sql_update") {
    const source = (input.generated.config.sources as Record<string, RunnerSourceConfig>)[input.spec.source_name ?? (input.spec.engine === "postgres" ? "local_postgres" : "local_mysql")];
    stdout.write(`  receipt mode: ${formatSourceReceiptMode(source)}\n`);
  }
  if (input.spec.deduplication) stdout.write(`  source dedup columns: ${input.spec.deduplication.components.map((component) => component.column).join(", ")}\n`);
  if (input.spec.version_advance) stdout.write(`  version advance: ${input.spec.version_advance.column}:${input.spec.version_advance.strategy}\n`);
  stdout.write(`  read capability: ${readCapability}\n`);
  if (proposalCapability) stdout.write(`  proposal capability: ${proposalCapability}\n`);
  stdout.write(`  exposed tools: ${tools.join(", ")}\n`);
  stdout.write("  not exposed: execute_sql, approval tools, commit tools, database URLs, write credentials, model-controlled tenant authority\n");
}


async function initFromSpec(args: string[], specPath: string): Promise<number> {
  if (!args.includes("--non-interactive")) {
    throw new Error("init --spec requires --non-interactive so reviewed selections are explicit.");
  }
  const output = outputArg(args) ?? "synapsor.runner.json";
  const force = args.includes("--force");
  const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as OnboardingSelectionSpec;
  assertGeneratedReviewActivation(args, spec, "init --spec");
  const generated = generateRunnerConfigFromSpec(spec);
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(generated.config, null, 2)}\n`);
    return 0;
  }
  await writeGeneratedOnboardingFiles(output, generated, spec, force, { activationConfirmed: args.includes("--yes") });
  return 0;
}


async function initFromAnswers(args: string[], answersPath: string): Promise<number> {
  const output = outputArg(args) ?? "synapsor.runner.json";
  const force = args.includes("--force");
  const raw = JSON.parse(await fs.readFile(answersPath, "utf8"));
  const spec = answersToSelectionSpec(raw);
  assertGeneratedReviewActivation(args, spec, "init --answers");
  const generated = generateRunnerConfigFromSpec(spec);
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(generated.config, null, 2)}\n`);
    return 0;
  }
  await writeGeneratedOnboardingFiles(output, generated, spec, force, { activationConfirmed: args.includes("--yes") });
  await maybeWriteHandlerTemplateForArgs(args, spec.writeback);
  return 0;
}


export function isScriptedOnboardingArgs(args: string[]): boolean {
  return args.includes("--yes") ||
    args.includes("--non-interactive") ||
    args.includes("--dry-run") ||
    Boolean(optionalArg(args, "--answers")) ||
    Boolean(optionalArg(args, "--inspection-json")) ||
    Boolean(optionalArg(args, "--table"));
}


function answersToSelectionSpec(raw: unknown): OnboardingSelectionSpec {
  if (!isRecord(raw)) throw new Error("--answers file must contain a JSON object");
  const mode = stringValue(raw.mode) ?? "review";
  if (!["read_only", "shadow", "review"].includes(mode)) throw new Error("answers.mode must be read_only, shadow, or review");
  const engine = stringValue(raw.engine) ?? "postgres";
  if (engine !== "postgres" && engine !== "mysql") throw new Error("answers.engine must be postgres or mysql");
  const table = requiredAnswerString(raw.table, "table");
  const objectName = stringValue(raw.object_name) ?? safeObjectName(table);
  const namespace = stringValue(raw.namespace) ?? inferCapabilityNamespace(table);
  const writebackRaw = stringValue(raw.writeback) ?? "sql_update";
  if (!["sql_update", "http_handler", "command_handler"].includes(writebackRaw)) throw new Error("answers.writeback must be sql_update, http_handler, or command_handler");
  const writeback = writebackRaw === "sql_update"
    ? { executor: "sql_update" as const }
    : writebackRaw === "http_handler"
      ? {
          executor: "http_handler" as const,
          handler_url_env: stringValue(raw.handler_url_env) ?? "SYNAPSOR_APP_WRITEBACK_URL",
          ...(stringValue(raw.handler_token_env) ? { handler_token_env: stringValue(raw.handler_token_env) } : {}),
          ...(stringValue(raw.handler_signing_secret_env) ? { handler_signing_secret_env: stringValue(raw.handler_signing_secret_env) } : {}),
        }
      : {
          executor: "command_handler" as const,
          handler_command_env: stringValue(raw.handler_command_env) ?? "SYNAPSOR_APP_WRITEBACK_COMMAND",
        };
  const operation = (stringValue(raw.operation) ?? "update") as "update" | "insert" | "delete";
  if (!["update", "insert", "delete"].includes(operation)) throw new Error("answers.operation must be update, insert, or delete");
  const patch = parsePatchBindings(arrayOrStringList(raw.patch), "--answers.patch");
  if (operation === "delete" && Object.keys(patch).length > 0) throw new Error("answers.patch must be empty for DELETE");
  if (mode !== "read_only" && operation !== "delete" && Object.keys(patch).length === 0) {
    throw new Error(`answers.patch must define at least one reviewed column for ${operation.toUpperCase()}`);
  }
  const allowedColumns = arrayOrStringList(raw.allowed_columns);
  const conflictColumn = stringValue(raw.conflict_column);
  if (mode !== "read_only" && operation === "delete" && !conflictColumn) throw new Error("answers.conflict_column is required for DELETE");
  const tenantKey = stringValue(raw.tenant_column) ?? stringValue(raw.tenant_key);
  const deduplication = operation === "insert" ? deduplicationFromAnswerValue(raw.deduplication ?? raw.dedup) : undefined;
  if (operation === "insert" && !deduplication) throw new Error("answers.deduplication is required for INSERT");
  const receipts = mode === "review" && writeback.executor === "sql_update" ? receiptsFromAnswerValue(raw.receipts ?? raw.receipt_mode) : undefined;
  const versionAdvance = operation === "update" ? versionAdvanceFromAnswerValue(raw.version_advance) : undefined;
  if (receipts?.authority === "runner_ledger" && operation === "update" && !versionAdvance) {
    throw new Error("answers.version_advance is required for runner_ledger UPDATE");
  }
  return {
    version: 1,
    engine,
    mode: mode as "read_only" | "shadow" | "review",
    source_name: stringValue(raw.source_name),
    read_url_env: stringValue(raw.read_url_env) ?? stringValue(raw.database_url_env) ?? "DATABASE_URL",
    write_url_env: writeback.executor === "sql_update" ? stringValue(raw.write_url_env) ?? "SYNAPSOR_DATABASE_WRITE_URL" : stringValue(raw.write_url_env),
    schema: requiredAnswerString(raw.schema, "schema"),
    table,
    primary_key: requiredAnswerString(raw.primary_key, "primary_key"),
    tenant_key: tenantKey,
    single_tenant_dev: raw.single_tenant_dev === true,
    conflict_column: conflictColumn,
    namespace,
    object_name: objectName,
    inspect_tool_name: stringValue(raw.read_tool) ?? stringValue(raw.inspect_tool_name),
    proposal_tool_name: stringValue(raw.proposal_tool) ?? stringValue(raw.proposal_tool_name),
    lookup_arg: stringValue(raw.id_arg) ?? stringValue(raw.lookup_arg),
    inspect_description: stringValue(raw.read_description) ?? stringValue(raw.inspect_description),
    inspect_returns_hint: stringValue(raw.read_returns_hint) ?? stringValue(raw.inspect_returns_hint),
    proposal_description: stringValue(raw.proposal_description),
    proposal_returns_hint: stringValue(raw.proposal_returns_hint),
    result_format: resultFormatFromAnswerValue(raw.result_format),
    visible_columns: arrayOrStringList(raw.visible_columns),
    operation,
    deduplication,
    version_advance: versionAdvance,
    receipts,
    allowed_columns: allowedColumns.length > 0 ? allowedColumns : undefined,
    patch,
    numeric_bounds: parseNumericBoundsInput(arrayOrStringList(raw.patch_bounds ?? raw.numeric_bounds).join(",")),
    transition_guards: parseTransitionGuardsInput(arrayOrStringList(raw.status_guards ?? raw.transition_guards).join(",")),
    trusted_context: {
      tenant_id_env: stringValue(raw.tenant_env) ?? "SYNAPSOR_TENANT_ID",
      principal_env: stringValue(raw.principal_env) ?? "SYNAPSOR_PRINCIPAL",
    },
    approval: {
      required_role: stringValue(raw.approval_role) ?? "local_reviewer",
    },
    writeback,
  };
}


function deduplicationFromAnswerValue(value: unknown): OnboardingSelectionSpec["deduplication"] {
  if (typeof value === "string") return parseDeduplicationInput(value);
  if (!isRecord(value) || !Array.isArray(value.components)) return undefined;
  const components: NonNullable<OnboardingSelectionSpec["deduplication"]>["components"] = value.components.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`answers.deduplication.components[${index}] must be an object`);
    const column = requiredAnswerString(entry.column, `deduplication.components[${index}].column`);
    const source = requiredAnswerString(entry.source, `deduplication.components[${index}].source`);
    if (source !== "proposal_id" && source !== "trusted_tenant" && source !== "fixed") {
      throw new Error(`answers.deduplication.components[${index}].source must be proposal_id, trusted_tenant, or fixed`);
    }
    if (source === "fixed") {
      if (!("fixed" in entry)) throw new Error(`answers.deduplication.components[${index}].fixed is required for source fixed`);
      const fixed = entry.fixed;
      if (fixed !== null && !["string", "number", "boolean"].includes(typeof fixed)) {
        throw new Error(`answers.deduplication.components[${index}].fixed must be a scalar or null`);
      }
      return { column, source: "fixed", fixed: fixed as string | number | boolean | null };
    }
    return { column, source: source as "proposal_id" | "trusted_tenant" };
  });
  if (components.length === 0) throw new Error("answers.deduplication.components must not be empty");
  return { components };
}


function receiptsFromAnswerValue(value: unknown): OnboardingSelectionSpec["receipts"] {
  if (value === undefined || value === null || value === "") return { authority: "source_db", provisioning: "auto_migrate" };
  if (typeof value === "string") {
    if (value === "runner_ledger") return { authority: "runner_ledger" };
    if (value === "source_auto_migrate") return { authority: "source_db", provisioning: "auto_migrate" };
    if (value === "source_precreated") return { authority: "source_db", provisioning: "precreated" };
    throw new Error("answers.receipt_mode must be source_auto_migrate, source_precreated, or runner_ledger");
  }
  if (!isRecord(value)) throw new Error("answers.receipts must be an object or receipt mode string");
  const authority = requiredAnswerString(value.authority, "receipts.authority");
  if (authority === "runner_ledger") return { authority };
  if (authority !== "source_db") throw new Error("answers.receipts.authority must be source_db or runner_ledger");
  const provisioning = stringValue(value.provisioning) ?? "auto_migrate";
  if (provisioning !== "auto_migrate" && provisioning !== "precreated") {
    throw new Error("answers.receipts.provisioning must be auto_migrate or precreated");
  }
  return {
    authority,
    provisioning,
    ...(stringValue(value.schema) ? { schema: stringValue(value.schema) } : {}),
    ...(stringValue(value.table) ? { table: stringValue(value.table) } : {}),
  };
}


function versionAdvanceFromAnswerValue(value: unknown): OnboardingSelectionSpec["version_advance"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const [column, strategy] = value.split(":").map((part) => part.trim());
    if (!column || (strategy !== "integer_increment" && strategy !== "database_generated")) {
      throw new Error("answers.version_advance must use column:integer_increment or column:database_generated");
    }
    return { column, strategy };
  }
  if (!isRecord(value)) throw new Error("answers.version_advance must be an object or column:strategy string");
  const column = requiredAnswerString(value.column, "version_advance.column");
  const strategy = requiredAnswerString(value.strategy, "version_advance.strategy");
  if (strategy !== "integer_increment" && strategy !== "database_generated") {
    throw new Error("answers.version_advance.strategy must be integer_increment or database_generated");
  }
  return { column, strategy };
}


async function maybeWriteHandlerTemplateForArgs(args: string[], writeback: OnboardingSelectionSpec["writeback"]): Promise<void> {
  if (!writeback || writeback.executor === "sql_update" || args.includes("--no-emit-handler") || args.includes("--skip-handler-template")) return;
  if (!args.includes("--emit-handler") && !optionalArg(args, "--handler-template") && !optionalArg(args, "--handler-output") && !optionalArg(args, "--handler-template-output")) return;
  const defaultTemplate: HandlerTemplateName = writeback.executor === "command_handler" ? "command" : "node-fastify";
  const template = resolveHandlerTemplateName(optionalArg(args, "--handler-template") ?? defaultTemplate);
  const output = optionalArg(args, "--handler-output") ?? optionalArg(args, "--handler-template-output") ?? handlerTemplateDefinitions[template].fileName;
  await writeHandlerTemplateFile(template, output, args.includes("--force"));
  process.stdout.write(`created ${output}\n`);
  process.stdout.write(`${handlerSecurityWarning}\n`);
}


function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}


function requiredAnswerString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`--answers missing ${field}`);
  return result;
}


function arrayOrStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}


function resultFormatFromAnswerValue(value: unknown): 1 | 2 | undefined {
  if (value === undefined || value === null || value === "" || value === "default") return undefined;
  if (value === 1 || value === "1" || value === "v1") return 1;
  if (value === 2 || value === "2" || value === "v2") return 2;
  throw new Error("result_format must be default, v1, v2, 1, or 2");
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
  const operation = (optionalArg(args, "--operation") ?? "update") as "update" | "insert" | "delete";
  if (!["update", "insert", "delete"].includes(operation)) throw new Error("--operation must be update, insert, or delete");
  const primaryKey = optionalArg(args, "--primary-key") ?? (table.primary_key.length === 1 ? table.primary_key[0] : inferPrimaryKeyCandidate(table));
  if (!primaryKey) {
    throw new Error(`--primary-key is required for ${table.schema}.${table.name}; detected primary keys: ${table.primary_key.join(", ") || "none"}`);
  }
  if (table.primary_key.length === 0 && primaryKey) {
    process.stderr.write(`warning: no database primary-key constraint detected for ${table.schema}.${table.name}; using candidate column ${primaryKey}. Verify uniqueness before enabling writeback.\n`);
  }
  const tenantKey = optionalArg(args, "--tenant-column") ?? optionalArg(args, "--tenant-key") ?? table.suggestions.tenant_columns[0];
  const singleTenantDev = args.includes("--single-tenant-dev");
  if (!tenantKey && !singleTenantDev) {
    throw new Error(`--tenant-key is required for ${table.schema}.${table.name}, or pass --single-tenant-dev for a reviewed single-tenant dev source.`);
  }
  const conflictColumn = optionalArg(args, "--conflict-column") ?? table.suggestions.conflict_columns[0];
  if (mode !== "read_only" && operation === "delete" && !conflictColumn) {
    throw new Error(`native hard DELETE requires --conflict-column on ${table.schema}.${table.name}; use soft-delete UPDATE or an app-owned executor`);
  }
  if (mode !== "read_only" && operation === "update" && !conflictColumn) {
    process.stderr.write(`warning: no conflict/version column selected for ${table.schema}.${table.name}; generated proposal will require weak-guard acknowledgement.\n`);
  }
  const visibleColumns = listArg(args, "--visible-columns") ?? table.suggestions.default_visible_columns;
  if (visibleColumns.length === 0) {
    throw new Error(`no visible columns selected for ${table.schema}.${table.name}; pass --visible-columns col1,col2`);
  }
  const patch = parsePatchFlags(args);
  if (mode !== "read_only" && operation !== "delete" && Object.keys(patch).length === 0) {
    throw new Error(`${mode} init requires at least one --patch-fixed column=value or --patch-from-arg column=arg. Use --mode read_only for inspect-only tools.`);
  }
  if (operation === "delete" && Object.keys(patch).length > 0) throw new Error("native DELETE does not accept patch mappings");
  const numericBounds = parseNumericBoundsFlags(args);
  const transitionGuards = parseTransitionGuardFlags(args);
  const allowedColumns = listArg(args, "--allowed-columns") ?? Object.keys(patch);
  const writeback = writebackSpecFromArgs(args);
  const sqlWriteback = (writeback?.executor ?? "sql_update") === "sql_update";
  const receipts = mode === "review" && sqlWriteback ? receiptSpecFromArgs(args) : undefined;
  if (operation === "insert" && !tenantKey) throw new Error("native guarded INSERT requires a trusted tenant column; single-tenant development acknowledgement is not sufficient");
  const deduplication = operation === "insert"
    ? optionalArg(args, "--dedup")
      ? parseDeduplicationInput(optionalArg(args, "--dedup") as string)
      : inferInsertDeduplication(table, tenantKey ?? "", primaryKey)
    : undefined;
  const versionAdvance = operation === "update" && receipts?.authority === "runner_ledger"
    ? inferVersionAdvanceFromArgs(args, table, conflictColumn)
    : undefined;
  if (mode === "review" && sqlWriteback) {
    const assessment = assessDirectWritePrerequisites(table, {
      operation,
      primary_key: primaryKey,
      tenant_key: tenantKey,
      allowed_columns: operation === "delete" ? [] : allowedColumns,
      patch_columns: Object.keys(patch),
      conflict_column: conflictColumn,
      version_advance: versionAdvance,
      dedup_columns: deduplication?.components.map((component) => component.column),
    });
    const failures = assessment.filter((item) => item.level === "fail");
    if (failures.length > 0) throw new Error(`native ${operation.toUpperCase()} prerequisites failed: ${failures.map((item) => item.message).join(" ")}`);
  }
  const objectName = optionalArg(args, "--object-name") ?? safeObjectName(table.name);
  const namespace = optionalArg(args, "--namespace") ?? inferCapabilityNamespace(table.name);
  const spec: OnboardingSelectionSpec = {
    version: 1,
    engine: inspection.engine,
    mode: mode as "read_only" | "shadow" | "review",
    source_name: optionalArg(args, "--source-name"),
    read_url_env: databaseUrlEnv,
    write_url_env: sqlWriteback ? optionalArg(args, "--write-url-env") ?? "SYNAPSOR_DATABASE_WRITE_URL" : optionalArg(args, "--write-url-env"),
    schema: table.schema,
    table: table.name,
    primary_key: primaryKey,
    tenant_key: tenantKey,
    single_tenant_dev: singleTenantDev,
    conflict_column: conflictColumn,
    namespace,
    object_name: objectName,
    inspect_tool_name: optionalArg(args, "--read-tool") ?? optionalArg(args, "--inspect-tool-name"),
    proposal_tool_name: optionalArg(args, "--proposal-tool") ?? optionalArg(args, "--proposal-tool-name"),
    lookup_arg: optionalArg(args, "--id-arg") ?? optionalArg(args, "--lookup-arg"),
    inspect_description: optionalArg(args, "--read-description") ?? optionalArg(args, "--inspect-description"),
    inspect_returns_hint: optionalArg(args, "--read-returns-hint") ?? optionalArg(args, "--inspect-returns-hint"),
    proposal_description: optionalArg(args, "--proposal-description"),
    proposal_returns_hint: optionalArg(args, "--proposal-returns-hint"),
    result_format: resultFormatOption(args),
    visible_columns: visibleColumns,
    operation,
    deduplication,
    version_advance: versionAdvance,
    receipts,
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
    writeback,
  };
  const generated = generateRunnerConfigFromSpec(spec);
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(generated.config, null, 2)}\n`);
    return 0;
  }
  assertGeneratedReviewActivation(args, spec, "own-database onboarding");
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, spec, args.includes("--force"), {
    table,
    activationConfirmed: args.includes("--yes"),
  });
  await maybeWriteHandlerTemplateForArgs(args, writeback);
  process.stdout.write(`selected ${table.schema}.${table.name} from ${inspection.engine} inspection\n`);
  process.stdout.write(`exposed tools: ${(generated.config.capabilities as Array<{ name: string }>).map((capability) => capability.name).join(", ")}\n`);
  return 0;
}


export async function writeGeneratedOnboardingFiles(
  output: string,
  generated: GeneratedOnboardingFiles,
  selection: OnboardingSelectionSpec,
  force: boolean,
  options: { printNext?: boolean; table?: TableInfo; activationConfirmed?: boolean } = {},
): Promise<CanonicalOnboardingArtifacts> {
  const configPath = path.resolve(output);
  const projectRoot = path.dirname(configPath);
  const contractPath = canonicalContractPath(configPath);
  const environmentPath = path.join(projectRoot, ".env.example");
  const mcpDirectory = path.join(projectRoot, ".synapsor/mcp");
  const manifestPath = path.join(projectRoot, ".synapsor/onboarding.json");
  const project = await detectProjectContext(projectRoot);
  const artifacts = buildCanonicalOnboardingArtifacts({
    generated,
    selection,
    ...(options.table ? { table: options.table } : {}),
    configPath,
    contractPath,
    project,
    activationConfirmed: options.activationConfirmed,
  });
  const configArgument = `./${path.basename(configPath)}`;
  const snippets = rewriteGeneratedMcpSnippets(artifacts.mcpSnippets, configArgument);
  const targets = [
    configPath,
    contractPath,
    environmentPath,
    manifestPath,
    ...Object.keys(snippets).map((fileName) => path.join(mcpDirectory, fileName)),
  ];
  await assertGeneratedTargetsWritable(targets, force);
  await writeFileGuarded(configPath, `${JSON.stringify(artifacts.config, null, 2)}\n`, true);
  await writeFileGuarded(contractPath, `${JSON.stringify(artifacts.contract, null, 2)}\n`, true);
  await writeFileGuarded(environmentPath, artifacts.envExample, true);
  await fs.mkdir(mcpDirectory, { recursive: true });
  for (const [fileName, snippet] of Object.entries(snippets)) {
    await writeFileGuarded(path.join(mcpDirectory, fileName), `${JSON.stringify(snippet, null, 2)}\n`, true);
  }
  await writeFileGuarded(manifestPath, `${JSON.stringify(artifacts.manifest, null, 2)}\n`, true);
  process.stdout.write(formatProjectDetection(project));
  process.stdout.write(`created ${displayPath(configPath)}\n`);
  process.stdout.write(`created canonical contract ${displayPath(contractPath)}\n`);
  process.stdout.write(`created ${displayPath(environmentPath)}\n`);
  process.stdout.write(`created MCP client snippets under ${displayPath(mcpDirectory)}\n`);
  process.stdout.write(`created onboarding manifest ${displayPath(manifestPath)}\n`);
  if (options.printNext !== false) {
    process.stdout.write(`Next: set the referenced environment variables, run \`${cliCommandName()} config validate --config ${configArgument}\`, then add the reviewed tools to a project client with \`${cliCommandName()} mcp install <cursor|claude-code|vscode> --project --config ${configArgument}\`.\n`);
  }
  return artifacts;
}


export function assertGeneratedReviewActivation(args: string[], selection: OnboardingSelectionSpec, command: string): void {
  if (selection.mode === "review" && !args.includes("--yes")) {
    throw new Error(`${command} generated a review/writeback action, but it remains disabled. Review the preview and rerun with --yes to activate the reviewed action.`);
  }
}


function canonicalContractPath(configPath: string): string {
  const fileName = path.basename(configPath);
  const extension = path.extname(fileName);
  const contractName = fileName.endsWith(".runner.json")
    ? `${fileName.slice(0, -".runner.json".length)}.contract.json`
    : `${extension ? fileName.slice(0, -extension.length) : fileName}.contract.json`;
  return path.join(path.dirname(configPath), contractName);
}


function rewriteGeneratedMcpSnippets(
  snippets: Record<string, unknown>,
  configPath: string,
): Record<string, unknown> {
  return replaceStringDeep(structuredClone(snippets), "./synapsor.runner.json", configPath) as Record<string, unknown>;
}


function replaceStringDeep(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((item) => replaceStringDeep(item, from, to));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStringDeep(item, from, to)]));
}


async function assertGeneratedTargetsWritable(targets: string[], force: boolean): Promise<void> {
  if (force) return;
  for (const target of targets) {
    try {
      await fs.access(target);
      throw new Error(`${displayPath(target)} already exists. Use --force to overwrite the generated artifact set.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}


export function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  if (!relative) return ".";
  return relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative;
}


async function writeGeneratedSmokeInputFile(lookupArg: string, objectId: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(generatedSmokeInputPath)), { recursive: true });
  await writeFileGuarded(generatedSmokeInputPath, `${JSON.stringify({ [lookupArg]: objectId }, null, 2)}\n`, force);
}


async function maybeRunGeneratedSmokeCall(input: {
  config: RuntimeConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  input: Record<string, unknown>;
  readUrlEnv: string;
  tenantEnv: string;
  principalEnv: string;
  readRow?: DbRowReader;
  storePath: string;
  toolName: string;
}): Promise<string> {
  const required = uniqueStrings([input.readUrlEnv, input.tenantEnv, input.principalEnv])
    .filter((envName) => !envValue(input.env, envName));
  if (required.length > 0) {
    return [
      "Smoke call not run yet.",
      `Missing trusted/runtime env vars: ${required.join(", ")}`,
      "Set them from .env.example, then run the printed smoke command.",
      "",
    ].join("\n");
  }
  const runtime = createMcpRuntime(input.config, { storePath: input.storePath, env: input.env, readRow: input.readRow });
  try {
    const result = await runtime.callTool(input.toolName, input.input);
    return [
      result.ok === false ? "Smoke call attempted but did not pass." : "Smoke call ran successfully.",
      "",
      formatSmokeCallResult(input.toolName, input.input, result, {
        configPath: input.configPath,
        storePath: input.storePath,
        storeAuthority: "local_sqlite",
        sharedPostgresSchema: "synapsor_runner",
      }),
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "Smoke call attempted but did not pass.",
      `Reason: ${message}`,
      "The generated config was written. Fix the trusted env values or object id, then rerun the printed smoke command.",
      "",
    ].join("\n");
  } finally {
    await runtime.close();
  }
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


async function askOptionalEnvName(ask: WizardAsk, question: string, defaultValue: string): Promise<string | undefined> {
  const answer = await askDefault(ask, question, defaultValue);
  if (!answer) return undefined;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(answer)) throw new Error(`${question} must be an environment-variable name`);
  return answer;
}


async function askColumn(ask: WizardAsk, question: string, defaultValue: string | undefined, columns: string[]): Promise<string> {
  const answer = await askDefault(ask, question, defaultValue);
  if (!answer) throw new Error(`${question} is required`);
  if (!columns.includes(answer)) throw new Error(`${question} ${answer} does not exist in selected table/view`);
  return answer;
}


function writebackSpecFromArgs(args: string[]): OnboardingSelectionSpec["writeback"] | undefined {
  const raw = optionalArg(args, "--writeback");
  if (!raw) return undefined;
  if (!["sql_update", "http_handler", "command_handler"].includes(raw)) {
    throw new Error("--writeback must be sql_update, http_handler, or command_handler");
  }
  if (raw === "sql_update") return { executor: "sql_update" };
  if (raw === "http_handler") {
    return {
      executor: "http_handler",
      executor_name: optionalArg(args, "--executor-name"),
      handler_url_env: optionalArg(args, "--handler-url-env") ?? "SYNAPSOR_APP_WRITEBACK_URL",
      ...(optionalArg(args, "--handler-token-env") ? { handler_token_env: optionalArg(args, "--handler-token-env") } : {}),
      ...(optionalArg(args, "--handler-signing-secret-env") ? { handler_signing_secret_env: optionalArg(args, "--handler-signing-secret-env") } : {}),
      timeout_ms: positiveIntegerOption(args, "--handler-timeout-ms"),
    };
  }
  return {
    executor: "command_handler",
    executor_name: optionalArg(args, "--executor-name"),
    handler_command_env: optionalArg(args, "--handler-command-env") ?? "SYNAPSOR_APP_WRITEBACK_COMMAND",
    timeout_ms: positiveIntegerOption(args, "--handler-timeout-ms"),
  };
}


function receiptSpecFromArgs(args: string[]): NonNullable<OnboardingSelectionSpec["receipts"]> {
  const mode = optionalArg(args, "--receipt-mode") ?? "source_auto_migrate";
  if (mode === "runner_ledger") return { authority: "runner_ledger" };
  if (mode !== "source_auto_migrate" && mode !== "source_precreated") {
    throw new Error("--receipt-mode must be source_auto_migrate, source_precreated, or runner_ledger");
  }
  return {
    authority: "source_db",
    provisioning: mode === "source_auto_migrate" ? "auto_migrate" : "precreated",
    ...(optionalArg(args, "--receipt-schema") ? { schema: optionalArg(args, "--receipt-schema") } : {}),
    table: optionalArg(args, "--receipt-table") ?? "synapsor_writeback_receipts",
  };
}


function inferVersionAdvanceFromArgs(
  args: string[],
  table: TableInfo,
  conflictColumn: string | undefined,
): NonNullable<OnboardingSelectionSpec["version_advance"]> {
  if (!conflictColumn) throw new Error("runner_ledger UPDATE requires --conflict-column");
  const column = table.columns.find((item) => item.name === conflictColumn);
  if (!column) throw new Error(`conflict/version column does not exist: ${conflictColumn}`);
  const inferred = /int|numeric|decimal|number/i.test(column.data_type) ? "integer_increment" : "database_generated";
  const strategy = optionalArg(args, "--version-advance") ?? inferred;
  if (strategy !== "integer_increment" && strategy !== "database_generated") throw new Error("--version-advance must be integer_increment or database_generated");
  return { column: conflictColumn, strategy };
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


function inferInsertDeduplication(table: TableInfo, tenantKey: string, primaryKey: string): NonNullable<OnboardingSelectionSpec["deduplication"]> {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const sourceUniqueSets = [
    ...(table.primary_key.length ? [table.primary_key] : []),
    ...table.unique_constraints.map((constraint) => constraint.columns),
  ];
  const candidate = sourceUniqueSets.find((set) => {
    const nonTenant = set.filter((column) => column !== tenantKey);
    return nonTenant.length === 1 && isProposalIdentityColumn(columns.get(nonTenant[0]!));
  });
  if (!candidate) {
    throw new Error(`native INSERT requires a PRIMARY KEY/UNIQUE constraint containing one non-generated text identity column. Add a reviewed request/idempotency column, or use an app-owned executor.`);
  }
  const proposalColumn = candidate.find((column) => column !== tenantKey)!;
  const components: NonNullable<OnboardingSelectionSpec["deduplication"]>["components"] = [
    { column: proposalColumn, source: "proposal_id" },
  ];
  if (tenantKey !== proposalColumn) components.push({ column: tenantKey, source: "trusted_tenant" });
  if (primaryKey !== proposalColumn && candidate.includes(primaryKey) && !components.some((component) => component.column === primaryKey)) {
    throw new Error("native INSERT cannot infer a deterministic value for the selected primary key; use an identity/default primary key or an app-owned executor.");
  }
  return { components };
}


function isProposalIdentityColumn(column: TableInfo["columns"][number] | undefined): boolean {
  return Boolean(column && !column.generated && !column.identity && /char|text|string/i.test(column.data_type));
}


function formatDeduplication(value: OnboardingSelectionSpec["deduplication"]): string {
  return value?.components.map((component) => component.source === "fixed"
    ? `${component.column}=fixed:${String(component.fixed)}`
    : `${component.column}=${component.source}`).join(",") ?? "";
}


function parseDeduplicationInput(input: string): NonNullable<OnboardingSelectionSpec["deduplication"]> {
  const components = input.split(",").map((item) => item.trim()).filter(Boolean).map((entry) => {
    const [column, ...rest] = entry.split("=");
    const source = rest.join("=").trim();
    if (!column || !source) throw new Error("INSERT dedup mappings must use column=proposal_id|trusted_tenant|fixed:value");
    if (source === "proposal_id" || source === "trusted_tenant") return { column: column.trim(), source } as const;
    if (source.startsWith("fixed:")) return { column: column.trim(), source: "fixed" as const, fixed: parseFixedPatchValue(source.slice("fixed:".length)) };
    throw new Error("INSERT dedup mappings must use proposal_id, trusted_tenant, or fixed:value");
  });
  if (components.length === 0) throw new Error("INSERT requires at least one dedup mapping");
  return { components };
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
    deduplication: spec.deduplication ? {
      components: spec.deduplication.components.map((component) => ({
        ...component,
        column: mapColumn(component.column) ?? component.column,
      })),
    } : undefined,
    version_advance: spec.version_advance ? {
      ...spec.version_advance,
      column: mapColumn(spec.version_advance.column) ?? spec.version_advance.column,
    } : undefined,
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


function inferCapabilityNamespace(tableName: string): string {
  const objectName = safeObjectName(tableName);
  const [firstPart] = objectName.split("_").filter(Boolean);
  return firstPart ?? objectName;
}


export function requiredWritebackEngine(args: string[]): "postgres" | "mysql" {
  const value = optionalArg(args, "--engine") ?? firstPositional(args);
  if (value === "postgres" || value === "mysql") return value;
  throw new Error("writeback command requires --engine postgres or --engine mysql");
}


export function formatPostgresReceiptMigration(schema?: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedTable = tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "postgres");
  if (!schema) {
    return [
      "-- Synapsor Runner direct SQL writeback receipt table.",
      "-- Run this once as a database owner before doctor/apply. The steady-state writer does not need schema CREATE.",
      `${postgresReceiptMigration.replace("synapsor_writeback_receipts", quotedTable)};`,
      "",
    ].join("\n");
  }
  const quotedSchema = quoteSqlIdentifier(schema, "postgres");
  const qualified = `${quotedSchema}.${quotedTable}`;
  return [
    "-- Synapsor Runner direct SQL writeback receipt table.",
    "-- Run this once as a database owner. If you use a dedicated schema, ensure the writer connection search_path includes it.",
    `CREATE SCHEMA IF NOT EXISTS ${quotedSchema};`,
    `${postgresReceiptMigration.replace("synapsor_writeback_receipts", qualified)};`,
    "",
    "-- Example writer URL option for this schema:",
    `-- postgresql://writer:...@host/db?options=-csearch_path%3D${encodeURIComponent(`${schema},public`)}`,
    "",
  ].join("\n");
}


export function formatMysqlReceiptMigration(database?: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedTable = tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "mysql");
  return [
    "-- Synapsor Runner direct SQL writeback receipt table.",
    "-- Run this in the database/schema used by the trusted writer connection.",
    ...(database ? [`USE ${quoteSqlIdentifier(database, "mysql")};`] : []),
    `${mysqlReceiptMigration.replace("synapsor_writeback_receipts", quotedTable)};`,
    "",
  ].join("\n");
}


export function formatPostgresReceiptGrants(schema: string, writerRole: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedSchema = quoteSqlIdentifier(schema, "postgres");
  const quotedRole = writerRole === "<writer_role>" ? writerRole : quoteSqlIdentifier(writerRole, "postgres");
  const table = `${quotedSchema}.${tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "postgres")}`;
  return [
    "-- Least-privilege grants for a pre-created Synapsor Runner receipt table.",
    `GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole};`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ${quotedRole};`,
    "",
    "-- If the schema is not public, make sure the writer connection search_path includes it.",
    `-- ALTER ROLE ${quotedRole} SET search_path = ${schema}, public;`,
    "",
  ].join("\n");
}


export function formatMysqlReceiptGrants(database: string, writerRole: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedDatabase = database === "<database_name>" ? "`<database_name>`" : quoteSqlIdentifier(database, "mysql");
  const account = writerRole === "<writer_role>" ? "'<writer_user>'@'%'" : writerRole;
  return [
    "-- Least-privilege grants for a pre-created Synapsor Runner receipt table.",
    `GRANT SELECT, INSERT, UPDATE ON ${quotedDatabase}.${tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "mysql")} TO ${account};`,
    "",
  ].join("\n");
}


function findInspectionTable(inspection: SchemaInspection, tableName: string, schemaName?: string): TableInfo | undefined {
  const candidates = inspection.tables.filter((table) => {
    if (schemaName && table.schema !== schemaName) return false;
    return table.name === tableName || `${table.schema}.${table.name}` === tableName;
  });
  if (candidates.length === 1) return candidates[0];
  return candidates.find((table) => table.schema === schemaName) ?? candidates[0];
}


export function inferPrimaryKeyCandidate(table: TableInfo): string | undefined {
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


function parsePatchFlags(args: string[]): NonNullable<OnboardingSelectionSpec["patch"]> {
  const patch: NonNullable<OnboardingSelectionSpec["patch"]> = {};
  Object.assign(patch, parsePatchBindings(repeatedArgs(args, "--patch"), "--patch"));
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


function parsePatchBindings(bindings: string[], label: string): NonNullable<OnboardingSelectionSpec["patch"]> {
  const patch: NonNullable<OnboardingSelectionSpec["patch"]> = {};
  for (const rawBinding of bindings.flatMap((binding) => binding.split(",")).map((item) => item.trim()).filter(Boolean)) {
    const [column, ...rest] = rawBinding.split("=");
    const expression = rest.join("=");
    if (!column || !expression) throw new Error(`${label} must use column=fixed:value or column=arg:name`);
    const [kind, ...valueParts] = expression.split(":");
    const value = valueParts.join(":");
    if (!valueParts.length || !value) throw new Error(`${label} must use column=fixed:value or column=arg:name`);
    if (kind === "fixed") {
      patch[column] = { fixed: parseFixedPatchValue(value) };
    } else if (kind === "arg") {
      patch[column] = { from_arg: value };
    } else {
      throw new Error(`${label} patch kind for ${column} must be fixed or arg`);
    }
  }
  return patch;
}


function parseNumericBoundsFlags(args: string[]): OnboardingSelectionSpec["numeric_bounds"] {
  return parseNumericBoundsInput([...repeatedArgs(args, "--numeric-bound"), ...repeatedArgs(args, "--patch-bounds")].join(","));
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
  return parseTransitionGuardsInput([...repeatedArgs(args, "--transition-guard"), ...repeatedArgs(args, "--status-guards")].join(","));
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
