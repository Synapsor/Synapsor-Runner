import { createMcpRuntime, loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import {
  generateRunnerConfigFromSpec,
  type OnboardingSelectionSpec
} from "@synapsor-runner/schema-inspector";
import {
  auditMcpManifest,
  formatMcpAuditReport,
  formatMcpAuditSarif,
  formatMcpAuditVerboseReport
} from "@synapsor-runner/worker-core";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { formatMcpAuditMarkdown } from "./activity-formatting.js";
import { generateAuditCandidateDirectory } from "./audit-candidates.js";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord, shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { envValue, firstPositional, optionalArg, outputArg, parseJsonRpcResponse, positional, splitCommand } from "./cli-options.js";
import { assertGeneratedReviewActivation, writeGeneratedOnboardingFiles } from "./onboarding.js";
import { loadBuiltInRecipes, requireRecipe } from "./recipe-domain.js";
import { ui } from "./ui-command.js";


const dangerousDatabaseMcpAuditExample = {
  tools: [
    {
      name: "execute_sql",
      description: "Execute arbitrary SQL against the application database.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
        },
        required: ["sql"],
      },
    },
    {
      name: "run_query",
      description: "Run any query and return database rows.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          table: { type: "string" },
          columns: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["query"],
      },
    },
    {
      name: "approve_refund",
      description: "Approve and issue a customer refund immediately.",
      inputSchema: {
        type: "object",
        properties: {
          refund_id: { type: "string" },
          tenant_id: { type: "string" },
          amount_cents: { type: "number" },
        },
        required: ["refund_id", "tenant_id", "amount_cents"],
      },
    },
    {
      name: "update_customer",
      description: "Update a customer record directly.",
      inputSchema: {
        type: "object",
        properties: {
          customer_id: { type: "string" },
          tenant_id: { type: "string" },
          column: { type: "string" },
          value: { type: "string" },
        },
        required: ["customer_id", "tenant_id", "column", "value"],
      },
    },
    {
      name: "delete_order",
      description: "Delete an order from the database.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          tenant_id: { type: "string" },
        },
        required: ["order_id", "tenant_id"],
      },
    },
    {
      name: "query_database",
      description: "Query arbitrary tables and columns from the database.",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" },
          schema: { type: "string" },
          table: { type: "string" },
          columns: {
            type: "array",
            items: { type: "string" },
          },
          where: { type: "string" },
        },
        required: ["table"],
      },
    },
  ],
};


async function mcpAudit(args: string[]): Promise<number> {
  const format = optionalArg(args, "--format") ?? (args.includes("--json") ? "json" : "text");
  if (!["text", "json", "markdown", "sarif"].includes(format)) {
    throw new Error("audit --format must be text, json, markdown, or sarif");
  }
  const { target, payload } = await resolveMcpAuditInput(args);
  const report = auditMcpManifest(payload, { target, liveSelectedServer: optionalArg(args, "--live-server") });
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(formatMcpAuditMarkdown(report));
  else if (format === "sarif") process.stdout.write(formatMcpAuditSarif(report));
  else process.stdout.write(args.includes("--verbose") ? formatMcpAuditVerboseReport(report) : formatMcpAuditReport(report));
  return 0;
}


export async function audit(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "generate") return auditGenerate(rest);
  return mcpAudit(args);
}


async function auditGenerate(args: string[]): Promise<number> {
  const outputDir = outputArg(args);
  if (!outputDir) {
    throw new Error("audit generate requires --output <separate-candidate-directory>");
  }
  if (args.includes("--open-ui") && (args.includes("--json") || optionalArg(args, "--format") === "json")) {
    throw new Error("audit generate --open-ui cannot be combined with JSON output");
  }
  const { target, payload } = await resolveMcpAuditInput(args);
  const result = await generateAuditCandidateDirectory({
    manifest: payload,
    target,
    outputDir,
    force: args.includes("--force"),
  });
  const candidateConfig = path.join(result.output_dir, "synapsor.candidate.runner.json");
  const candidateStore = path.join(result.output_dir, ".synapsor/candidate-shadow.db");
  if (args.includes("--json") || optionalArg(args, "--format") === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${[
    "Synapsor audit candidates generated",
    `Output: ${result.output_dir}`,
    `Source digest: ${result.source_digest}`,
    `Overall risk: ${result.overall_risk}`,
    `Candidates: ${result.candidates.length}`,
    "",
    "Safety state: blocked and unreviewed",
    "- proposal writeback is none;",
    "- Runner mode is shadow;",
    "- no source is configured;",
    "- production configuration was not changed.",
    "",
    `Review ${path.join(result.output_dir, "REVIEW.md")} before copying any definition into an active contract.`,
    `Open the blocked candidate workbench: ${cliCommandName()} ui --open --tour --config ${shellQuote(candidateConfig)} --store ${shellQuote(candidateStore)}`,
  ].join("\n")}\n`);
  if (args.includes("--open-ui")) {
    process.stdout.write("\nOpening the local candidate workbench. The candidate has no source or writeback authority.\n");
    return ui(["--open", "--tour", "--config", candidateConfig, "--store", candidateStore]);
  }
  return 0;
}


async function resolveMcpAuditInput(args: string[]): Promise<{ target: string; payload: unknown }> {
  const url = optionalArg(args, "--url");
  const stdio = optionalArg(args, "--stdio");
  const mcpConfig = optionalArg(args, "--mcp-config");
  const example = optionalArg(args, "--example");
  const target = example
    ? `example:${example}`
    : url ?? (stdio ? `stdio:${stdio}` : mcpConfig ?? firstPositional(args));
  if (!target) {
    throw new Error("audit requires <target>, --example dangerous-db-mcp, --mcp-config <path>, --stdio <command>, or --url <url>");
  }
  const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "5000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("audit --timeout-ms must be from 1 through 120000");
  }
  const payload = example
    ? builtInMcpAuditExample(example)
    : await readMcpAuditTarget(target, args, timeoutMs);
  return { target, payload };
}


export async function recipes(args: string[]): Promise<number> {
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
  assertGeneratedReviewActivation(args, spec, "recipes init");
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, spec, args.includes("--force"), {
    activationConfirmed: args.includes("--yes"),
  });
  process.stdout.write(`initialized recipe ${recipe.id}\n`);
  process.stdout.write("Review the generated table and column names against your staging database before serving MCP tools.\n");
  return 0;
}


export async function benchmark(args: string[]): Promise<number> {
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
  const liveServer = optionalArg(args, "--live-server");
  if (liveServer) {
    if (!optionalArg(args, "--mcp-config")) throw new Error("audit --live-server requires --mcp-config <path>");
    if (!args.includes("--yes")) throw new Error("audit --live-server executes the selected configured MCP command and requires --yes after operator review");
    return attachSelectedLiveMcpTools(parsed, liveServer, target, timeoutMs);
  }
  if (isRunnerConfigLike(parsed)) {
    const runtime = createMcpRuntime(loadRuntimeConfigFromFile(target), { storePath: ":memory:" });
    try {
      return { tools: runtime.listTools() };
    } finally {
      await runtime.close();
    }
  }
  return parsed;
}


async function attachSelectedLiveMcpTools(input: unknown, serverName: string, configPath: string, timeoutMs: number): Promise<unknown> {
  if (!isRecord(input) || !isRecord(input.mcpServers)) throw new Error("MCP client config must contain an mcpServers object");
  const rawServer = input.mcpServers[serverName];
  if (!isRecord(rawServer)) throw new Error(`MCP client config does not contain server ${serverName}`);
  if (typeof rawServer.command !== "string" || !rawServer.command.trim()) {
    throw new Error("audit --live-server currently supports explicitly reviewed stdio commands only; use --url for a remote MCP endpoint");
  }
  if (/[\u0000-\u001f\u007f]/.test(rawServer.command)) throw new Error("configured MCP command contains control characters");
  if (!Array.isArray(rawServer.args) || rawServer.args.some((item) => typeof item !== "string" || /[\u0000\u000a\u000d]/.test(item))) {
    throw new Error("configured MCP stdio args must be an array of strings without control characters");
  }
  const resolvedConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(resolvedConfigPath);
  const workspace = path.basename(configDirectory) === ".cursor"
    ? path.dirname(configDirectory)
    : configDirectory;
  const expandWorkspace = (value: string): string => {
    const expanded = value.replaceAll("${workspaceFolder}", workspace).replaceAll("${pathSeparator}", path.sep).replaceAll("${/}", path.sep);
    if (/\$\{[^}]+\}/.test(expanded)) throw new Error("audit --live-server refuses unresolved config interpolation; export tools/list explicitly instead");
    return expanded;
  };
  const command = expandWorkspace(rawServer.command);
  const commandArgs = rawServer.args.map((item) => expandWorkspace(item));
  process.stderr.write(`Audit consent: querying tools/list from configured server ${serverName}; no business tool will be called.\n`);
  const response = await fetchStdioMcpToolsCommand(command, commandArgs, timeoutMs, workspace);
  const envelope = isRecord(response) && isRecord(response.result) ? response.result : response;
  if (!isRecord(envelope) || !Array.isArray(envelope.tools)) throw new Error("selected MCP server tools/list response did not contain a tools array");
  return {
    ...input,
    mcpServers: {
      ...input.mcpServers,
      [serverName]: {
        ...rawServer,
        tools: envelope.tools,
        x_synapsor_audit_live_tools_list: true,
      },
    },
  };
}


function builtInMcpAuditExample(example: string): unknown {
  if (example === "dangerous-db-mcp") return dangerousDatabaseMcpAuditExample;
  throw new Error(`unknown audit example: ${example}. Available examples: dangerous-db-mcp`);
}


function isRunnerConfigLike(value: unknown): boolean {
  return isRecord(value)
    && value.version === 1
    && (Array.isArray(value.capabilities) || Array.isArray(value.contracts));
}


async function fetchRemoteMcpTools(target: string, args: string[], timeoutMs: number): Promise<unknown> {
  const bearerEnv = optionalArg(args, "--bearer-env") ?? "SYNAPSOR_MCP_AUDIT_BEARER";
  const bearer = envValue(process.env, bearerEnv);
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
  return fetchStdioMcpToolsCommand(command, commandArgs, timeoutMs);
}


export async function fetchStdioMcpToolsCommand(command: string, commandArgs: string[], timeoutMs: number, cwd?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      ...(cwd ? { cwd } : {}),
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


export function mcpAuditToolNames(payload: unknown): string[] {
  const envelope = isRecord(payload) && isRecord(payload.result) ? payload.result : payload;
  if (!isRecord(envelope) || !Array.isArray(envelope.tools)) {
    throw new Error("MCP tools/list response did not contain a tools array");
  }
  const names = envelope.tools.map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : "");
  if (names.some((name) => !name)) throw new Error("MCP tools/list response contained a tool without a name");
  return names;
}
