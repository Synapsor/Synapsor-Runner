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
import { CloudControlClient, CloudControlError, ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { validateRunnerCapabilityConfig, type ConfigValidationResult } from "@synapsor-runner/config";
import { assertApprovalPolicyResolvable, assertProposalWritebackResolvable, capabilityWritebackExecutor, capabilityWritebackMode, CloudLinkedSynchronizer, createDefaultRuntimeStore, createMcpRuntime, enqueueCloudLinkedResult, resolveRuntimeConfig, serveStdio, startHttpMcpServer, startStreamableHttpMcpServer, toolNameExposures, type DbRowReader, type ResultFormat, type RuntimeCapabilityConfig, type RuntimeConfig, type StreamableHttpTlsOptions, type ToolNameStyle } from "@synapsor-runner/mcp-server";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { inspectMysqlWritebackSource, mysqlAdapter, mysqlReceiptMigration } from "@synapsor-runner/mysql";
import { createPostgresPool, inspectPostgresWritebackSource, postgresAdapter, postgresReceiptMigration } from "@synapsor-runner/postgres";
import {
  PostgresWritebackIntentStore,
  ProposalStore,
  sharedPostgresRuntimeStoreMigration,
  type EvidenceSearchFilters,
  type EventSearchFilters,
  type LocalProposalState,
  type OperationalMetricRow,
  type PolicyRecommendation,
  type ProposalRuntimeStore,
  type ProposalEvent,
  type ProposalReplayRecord,
  type ProposalSearchFilters,
  type QueryAuditSearchFilters,
  type ReceiptSearchFilters,
  type SharedLedgerEntry,
  type StoredEvidenceBundle,
  type StoredProposal,
  type StoredWritebackIntent,
  type StoredWritebackReceipt,
  type StorePruneResult,
  type StoreStats,
  type WorkerQueueItem,
} from "@synapsor-runner/proposal-store";
import { parseWritebackJob, protocolVersions, type ChangeSet, type ChangeSetV1, type CompensationChangeSetV1, type ExecutionReceiptV1, type ExecutionReceiptV2, type ExecutionReceiptV3, type ExecutionReceiptV4, type InverseDescriptorV1, type RunnerActivityV1, type RunnerProposalV1, type RunnerRegistrationV1, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";
import { normalizeContract, validateContract, type SynapsorContract } from "@synapsor/spec";
import {
  assessDirectWritePrerequisites,
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
  compensationInverseFromJob,
  createLogger,
  doctorChecks,
  formatMcpAuditReport,
  loadConfig,
  runOnce,
  startPolling,
  type McpAuditReport,
  type RunnerConfig,
  type ReconciliationObservation,
  type WritebackResultReporter,
  type WritebackIntentStore,
} from "@synapsor-runner/worker-core";
import { compileAgentDslWithWarnings, validateAgentDsl } from "@synapsor/dsl";
import { startLocalUiServer, type LocalUiStoreAccess } from "./local-ui.js";
import { resolveOperatorIdentity, verifyJwtOperatorProof, verifySignedOperatorProof, type OperatorIdentityConfig } from "./operator-identity.js";
import { hydrateManagedSecrets, type ManagedSecretsProvider } from "./secrets-manager.js";
import { explainContract, formatContractExplanation, formatContractLint, lintContract, lintFails, loadReviewedContract } from "./contract-tools.js";
import { formatContractTestReport, runContractTests } from "./contract-testing.js";
import { runLanguageServer } from "./language-server.js";
import { createComplianceReport, formatComplianceReport, readComplianceReport, verifyComplianceReport } from "./compliance-report.js";
import { decideGraduatedTrustRecommendation, evaluateGraduatedTrust, formatGraduatedTrustEvaluation, markGraduatedTrustArtifactExported, prepareGraduatedTrustArtifact } from "./graduated-trust.js";
import runnerPackage from "../package.json" with { type: "json" };
import dslPackage from "../../../packages/dsl/package.json" with { type: "json" };
import specPackage from "../../../packages/spec/package.json" with { type: "json" };

const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };
const handlerReceiptStatuses = new Set(["applied", "already_applied", "conflict", "failed"]);
type RunnerSourceConfig = NonNullable<RuntimeConfig["sources"]>[string];
type RunnerCapabilityConfig = NonNullable<RuntimeConfig["capabilities"]>[number];
const runtimeStoreBridgeFlag = "--runtime-store-bridge";

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
const defaultConfigPath = "synapsor.runner.json";
const defaultStorePath = "./.synapsor/local.db";
const quickDemoStorePath = "./.synapsor/quick-demo.db";
const generatedSmokeInputPath = "./.synapsor/smoke-input.json";
const handlerSecurityWarning = [
  "IMPORTANT: your app handler owns the final business write.",
  "Runner creates the proposal and calls your handler only after approval, but your handler must still enforce:",
  "- tenant/scope check;",
  "- expected-version or conflict guard;",
  "- idempotency key;",
  "- allowed business action;",
  "- transaction/rollback;",
  "- safe error receipt.",
  "",
  "If you skip those checks, you can reintroduce cross-tenant writes, lost updates, or duplicate writes.",
  "Use the generated template/helper pattern and keep handler credentials out of MCP.",
].join("\n");
const handlerTemplateDefinitions = {
  "node-fastify": {
    aliases: ["node", "fastify"],
    fileName: "synapsor-writeback-handler.mjs",
    description: "HTTP handler template for a Node/Fastify application service.",
    content: `import Fastify from "fastify";

const port = Number(process.env.PORT || 8787);
const expectedToken = process.env.SYNAPSOR_APP_WRITEBACK_TOKEN || "dev-handler-token";

const app = Fastify({ logger: true });

app.post("/synapsor/writeback", async (request, reply) => {
  const auth = request.headers.authorization || "";
  if (auth !== \`Bearer \${expectedToken}\`) {
    return reply.code(401).send({ status: "failed", safe_error_code: "UNAUTHORIZED" });
  }

  const body = request.body || {};
  const changeSet = body.change_set || {};

  if (!body.proposal_id || !body.idempotency_key || !changeSet.scope?.tenant_id) {
    return reply.code(400).send({ status: "failed", safe_error_code: "BAD_WRITEBACK_REQUEST" });
  }

  if (body.dry_run) {
    return {
      status: "applied",
      rows_affected: 0,
      source_database_mutated: false,
      details: { dry_run: true },
    };
  }

  /*
   * IMPORTANT: your app handler owns the final business write.
   * Runner creates the proposal and calls your handler only after approval,
   * but your handler must still enforce tenant/scope, expected-version or
   * conflict guard, idempotency key, allowed business action,
   * transaction/rollback, and safe error receipt.
   *
   * If you skip those checks, you can reintroduce cross-tenant writes,
   * lost updates, or duplicate writes. Keep handler credentials out of MCP.
   *
   * Put your app-owned transaction here.
   *
   * Examples:
   * - insert a refund_review row;
   * - insert an account_credit row;
   * - open a support_ticket row;
   * - update multiple related rows in one app transaction.
   *
   * Re-check tenant/principal authorization, idempotency, row/version guards,
   * and business policy before mutating application state.
   */

  return {
    status: "applied",
    rows_affected: 1,
    previous_version: String(changeSet.guards?.expected_version?.value || ""),
    new_version: new Date().toISOString(),
    source_database_mutated: true,
  };
});

app.listen({ host: "127.0.0.1", port });
`,
  },
  "python-fastapi": {
    aliases: ["python", "fastapi"],
    fileName: "synapsor_writeback_handler.py",
    description: "HTTP handler template for a Python/FastAPI application service.",
    content: `import os
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
expected_token = os.getenv("SYNAPSOR_APP_WRITEBACK_TOKEN", "dev-handler-token")


@app.post("/synapsor/writeback")
async def synapsor_writeback(body: dict, authorization: str | None = Header(default=None)):
    if authorization != f"Bearer {expected_token}":
        raise HTTPException(status_code=401, detail={"status": "failed", "safe_error_code": "UNAUTHORIZED"})

    change_set = body.get("change_set") or {}
    scope = change_set.get("scope") or {}
    if not body.get("proposal_id") or not body.get("idempotency_key") or not scope.get("tenant_id"):
        raise HTTPException(status_code=400, detail={"status": "failed", "safe_error_code": "BAD_WRITEBACK_REQUEST"})

    if body.get("dry_run"):
        return {
            "status": "applied",
            "rows_affected": 0,
            "source_database_mutated": False,
            "details": {"dry_run": True},
        }

    # Put your app-owned transaction here.
    #
    # IMPORTANT: your app handler owns the final business write.
    # Runner creates the proposal and calls your handler only after approval,
    # but your handler must still enforce tenant/scope, expected-version or
    # conflict guard, idempotency key, allowed business action,
    # transaction/rollback, and safe error receipt.
    #
    # If you skip those checks, you can reintroduce cross-tenant writes,
    # lost updates, or duplicate writes. Keep handler credentials out of MCP.
    #
    # Examples:
    # - insert a refund_review row;
    # - insert an account_credit row;
    # - open a support_ticket row;
    # - update multiple related rows in one app transaction.
    #
    # Re-check tenant/principal authorization, idempotency, row/version guards,
    # and business policy before mutating application state.

    expected_version = ((change_set.get("guards") or {}).get("expected_version") or {}).get("value", "")
    return {
        "status": "applied",
        "rows_affected": 1,
        "previous_version": str(expected_version),
        "new_version": datetime.now(timezone.utc).isoformat(),
        "source_database_mutated": True,
    }
`,
  },
  command: {
    aliases: ["script", "local-command"],
    fileName: "synapsor-command-handler.mjs",
    description: "Local command handler template for scripts or job runners.",
    content: `#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const changeSet = request.change_set || {};

if (!request.proposal_id || !request.idempotency_key || !changeSet.scope?.tenant_id) {
  process.stdout.write(JSON.stringify({
    status: "failed",
    safe_error_code: "BAD_WRITEBACK_REQUEST",
    source_database_mutated: false,
  }));
  process.exit(0);
}

if (request.dry_run) {
  process.stdout.write(JSON.stringify({
    status: "applied",
    rows_affected: 0,
    source_database_mutated: false,
    details: { dry_run: true },
  }));
  process.exit(0);
}

/*
 * IMPORTANT: your app handler owns the final business write.
 * Runner creates the proposal and calls your handler only after approval,
 * but your handler must still enforce tenant/scope, expected-version or
 * conflict guard, idempotency key, allowed business action,
 * transaction/rollback, and safe error receipt.
 *
 * If you skip those checks, you can reintroduce cross-tenant writes,
 * lost updates, or duplicate writes. Keep handler credentials out of MCP.
 *
 * Put your app-owned command transaction here.
 *
 * Examples:
 * - call an internal service;
 * - enqueue a review job;
 * - run an app script that uses your normal ORM.
 *
 * Re-check tenant/principal authorization, idempotency, row/version guards,
 * and business policy before mutating application state.
 */

process.stdout.write(JSON.stringify({
  status: "applied",
  rows_affected: 1,
  previous_version: String(changeSet.guards?.expected_version?.value || ""),
  new_version: new Date().toISOString(),
  source_database_mutated: true,
}));
`,
  },
} as const;
type HandlerTemplateName = keyof typeof handlerTemplateDefinitions;
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
  const [command, ...rest] = normalizeCliArgv(argv);
  if (!command || command === "--help" || command === "-h") {
    usage([]);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${await runnerPackageVersion()}\n`);
    return 0;
  }
  if (!isKnownTopLevelCommand(command)) {
    process.stderr.write(`Unknown command: ${cliCommandName()} ${command}\n\nTry:\n${cliCommandName()} --help\n`);
    return 2;
  }
  if (isHelpRequest(rest)) {
    usage([command, ...rest.filter((arg) => arg !== "--help" && arg !== "-h")]);
    return 0;
  }
  if (command === "help") {
    usage(rest);
    return 0;
  }
  if (command === "language-server") return runLanguageServer();
  await maybeHydrateManagedSecrets(rest);
  if (command === "init") return init(rest);
  if (command === "inspect") return inspect(rest);
  if (command === "config") return configCommand(rest);
  if (command === "contract") return contractCommand(rest);
  if (command === "report") return reportCommand(rest);
  if (command === "policy") return policyCommand(rest);
  if (command === "dsl") return dslCommand(rest);
  if (command === "doctor") return doctor(rest);
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "revert") return revert(rest);
  if (command === "propose") return propose(rest);
  if (command === "audit") return audit(rest);
  if (command === "start") return start(rest);
  if (command === "up") return up(rest);
  if (command === "runner") return runnerCommand(rest);
  if (command === "cloud") return cloud(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "smoke") return smoke(rest);
  if (command === "tools") return tools(rest);
  if (command === "writeback") return writeback(rest);
  if (command === "handler") return handler(rest);
  if (command === "onboard") return onboard(rest);
  if (command === "demo") return demo(rest);
  if (command === "recipes") return recipes(rest);
  if (command === "benchmark") return benchmark(rest);
  if (command === "proposals") return proposals(rest);
  if (command === "replay") return replay(rest);
  if (command === "evidence") return evidence(rest);
  if (command === "query-audit") return queryAudit(rest);
  if (command === "receipts") return receipts(rest);
  if (command === "activity") return activity(rest);
  if (command === "events") return events(rest);
  if (command === "metrics") return metrics(rest);
  if (command === "worker") return workerCommand(rest);
  if (command === "store") return storeCommand(rest);
  if (command === "shadow") return shadow(rest);
  if (command === "ui") return ui(rest);
  process.stderr.write(`Unknown command: ${cliCommandName()} ${command}\n\nTry:\n${cliCommandName()} --help\n`);
  return 2;
}

function normalizeCliArgv(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (first === "synapsor-runner" || first === "synapsor") return rest;
  return argv;
}

async function maybeHydrateManagedSecrets(args: string[]): Promise<void> {
  const rawProvider = optionalArg(args, "--secrets-provider");
  if (!rawProvider) return;
  const provider = managedSecretsProvider(rawProvider);
  const result = await hydrateManagedSecrets({
    provider,
    mapEnv: optionalArg(args, "--secret-map-env"),
    valuesEnv: optionalArg(args, "--secret-values-env"),
    regionEnv: optionalArg(args, "--aws-region-env"),
    overwrite: args.includes("--secrets-overwrite"),
    env: process.env,
  });
  if (!result) return;
  process.stderr.write(`Synapsor loaded ${result.loaded.length} managed secret(s) from ${result.provider}${result.skipped.length ? `; ${result.skipped.length} existing env value(s) left unchanged` : ""}.\n`);
}

function managedSecretsProvider(value: string): ManagedSecretsProvider {
  if (value === "aws-secretsmanager-cli" || value === "env-json") return value;
  throw new Error("--secrets-provider must be aws-secretsmanager-cli or env-json.");
}

async function init(args: string[]): Promise<number> {
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
  await writeGeneratedOnboardingFiles(outputPath, generated, args.includes("--force"), { printNext: false });
  if (generatedHandlerTemplate) {
    await writeHandlerTemplateFile(generatedHandlerTemplate.name, generatedHandlerTemplate.output, args.includes("--force"));
    stdout.write(`created ${generatedHandlerTemplate.output}\n`);
  }
  if (smokeObjectId) {
    await writeGeneratedSmokeInputFile(lookupArg, smokeObjectId, args.includes("--force"));
    stdout.write(`created ${generatedSmokeInputPath}\n`);
    const smoke = await maybeRunGeneratedSmokeCall({
      config: generated.config as RuntimeConfig,
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
  const generated = generateRunnerConfigFromSpec(spec);
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(generated.config, null, 2)}\n`);
    return 0;
  }
  await writeGeneratedOnboardingFiles(output, generated, force);
  return 0;
}

async function initFromAnswers(args: string[], answersPath: string): Promise<number> {
  const output = outputArg(args) ?? "synapsor.runner.json";
  const force = args.includes("--force");
  const raw = JSON.parse(await fs.readFile(answersPath, "utf8"));
  const spec = answersToSelectionSpec(raw);
  const generated = generateRunnerConfigFromSpec(spec);
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(generated.config, null, 2)}\n`);
    return 0;
  }
  await writeGeneratedOnboardingFiles(output, generated, force);
  await maybeWriteHandlerTemplateForArgs(args, spec.writeback);
  return 0;
}

function isScriptedOnboardingArgs(args: string[]): boolean {
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
  await writeGeneratedOnboardingFiles(outputArg(args) ?? "synapsor.runner.json", generated, args.includes("--force"));
  await maybeWriteHandlerTemplateForArgs(args, writeback);
  process.stdout.write(`selected ${table.schema}.${table.name} from ${inspection.engine} inspection\n`);
  process.stdout.write(`exposed tools: ${(generated.config.capabilities as Array<{ name: string }>).map((capability) => capability.name).join(", ")}\n`);
  return 0;
}

async function writeGeneratedOnboardingFiles(
  output: string,
  generated: GeneratedOnboardingFiles,
  force: boolean,
  options: { printNext?: boolean } = {},
): Promise<void> {
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
  if (options.printNext !== false) {
    process.stdout.write(`Next: set the referenced environment variables, run \`${cliCommandName()} config validate\`, then run \`${cliCommandName()} mcp serve\`.\n`);
  }
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

function positiveIntegerOption(args: string[], name: string): number | undefined {
  const raw = optionalArg(args, name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
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

function requiredWritebackEngine(args: string[]): "postgres" | "mysql" {
  const value = optionalArg(args, "--engine") ?? firstPositional(args);
  if (value === "postgres" || value === "mysql") return value;
  throw new Error("writeback command requires --engine postgres or --engine mysql");
}

function formatPostgresReceiptMigration(schema?: string, tableName = "synapsor_writeback_receipts"): string {
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

function formatMysqlReceiptMigration(database?: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedTable = tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "mysql");
  return [
    "-- Synapsor Runner direct SQL writeback receipt table.",
    "-- Run this in the database/schema used by the trusted writer connection.",
    ...(database ? [`USE ${quoteSqlIdentifier(database, "mysql")};`] : []),
    `${mysqlReceiptMigration.replace("synapsor_writeback_receipts", quotedTable)};`,
    "",
  ].join("\n");
}

function formatPostgresReceiptGrants(schema: string, writerRole: string, tableName = "synapsor_writeback_receipts"): string {
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

function formatMysqlReceiptGrants(database: string, writerRole: string, tableName = "synapsor_writeback_receipts"): string {
  const quotedDatabase = database === "<database_name>" ? "`<database_name>`" : quoteSqlIdentifier(database, "mysql");
  const account = writerRole === "<writer_role>" ? "'<writer_user>'@'%'" : writerRole;
  return [
    "-- Least-privilege grants for a pre-created Synapsor Runner receipt table.",
    `GRANT SELECT, INSERT, UPDATE ON ${quotedDatabase}.${tableName === "synapsor_writeback_receipts" ? tableName : quoteSqlIdentifier(tableName, "mysql")} TO ${account};`,
    "",
  ].join("\n");
}

function quoteSqlIdentifier(identifier: string, engine: "postgres" | "mysql"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe ${engine} identifier: ${identifier}`);
  }
  return engine === "postgres" ? `"${identifier}"` : `\`${identifier}\``;
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
  lines.push(`  ${cliCommandName()} onboard db --from-env ${databaseUrlEnv}`);
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

async function contractCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return contractValidate(rest);
  if (subcommand === "normalize") return contractNormalize(rest);
  if (subcommand === "bundle") return contractBundle(rest);
  if (subcommand === "explain") return contractExplain(rest);
  if (subcommand === "lint") return contractLint(rest);
  if (subcommand === "test") return contractTest(rest);
  usage(["contract"]);
  return 2;
}

async function dslCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return dslValidate(rest);
  if (subcommand === "compile") return dslCompile(rest);
  usage(["dsl"]);
  return 2;
}

async function dslValidate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("dsl validate requires a DSL source file such as contract.synapsor.sql or contract.synapsor");
  const source = await fs.readFile(target, "utf8");
  const strict = args.includes("--strict");
  const result = validateAgentDsl(source);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`dsl valid: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
  } else {
    process.stdout.write(`dsl invalid: ${target}\n`);
    for (const error of result.errors) process.stdout.write(`error ${error.line}:${error.column} ${error.code}: ${error.message}\n`);
  }
  return result.ok && (!strict || result.warnings.length === 0) ? 0 : 1;
}

async function dslCompile(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("dsl compile requires a DSL source file such as contract.synapsor.sql or contract.synapsor");
  const source = await fs.readFile(target, "utf8");
  const strict = args.includes("--strict");
  const result = compileAgentDslWithWarnings(source);
  if (strict && result.warnings.length > 0) {
    process.stdout.write(`dsl warnings treated as errors: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
    return 1;
  }
  const contract = result.contract;
  const output = outputArg(args);
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  for (const warning of result.warnings) process.stderr.write(`warning ${warning.line}:${warning.column} ${warning.code}: ${warning.message}\n`);
  return 0;
}

async function contractValidate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract validate requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const result = validateContract(parsed);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`contract valid: ${target}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
  } else {
    process.stdout.write(`contract invalid: ${target}\n`);
    for (const error of result.errors) process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
  }
  return result.ok ? 0 : 1;
}

async function contractNormalize(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract normalize requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const normalized = normalizeContract(parsed);
  const output = outputArg(args);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote normalized contract: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function contractExplain(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract explain requires a .synapsor.sql, .synapsor, or canonical contract JSON file");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "markdown" | "json";
  if (!["text", "markdown", "json"].includes(format)) throw new Error("contract explain --format must be text, markdown, or json");
  const loaded = await loadReviewedContract(target);
  const text = formatContractExplanation(explainContract(loaded.contract), format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract explanation: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function contractLint(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract lint requires a .synapsor.sql, .synapsor, or canonical contract JSON file");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "json" | "sarif";
  if (!["text", "json", "sarif"].includes(format)) throw new Error("contract lint --format must be text, json, or sarif");
  const failOn = (optionalArg(args, "--fail-on") ?? (args.includes("--strict") ? "warning" : "error")) as "error" | "warning";
  if (!["error", "warning"].includes(failOn)) throw new Error("contract lint --fail-on must be warning or error");
  const loaded = await loadReviewedContract(target);
  const configPath = optionalArg(args, "--config");
  const runnerConfig = configPath ? JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown> : undefined;
  const result = lintContract(loaded.contract, { runnerConfig, dslWarnings: loaded.dslWarnings });
  const text = formatContractLint(result, format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract lint report: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return lintFails(result, failOn) ? 1 : 0;
}

async function contractTest(args: string[]): Promise<number> {
  const contractPath = optionalArg(args, "--contract");
  const testsPath = optionalArg(args, "--tests");
  const configPath = optionalArg(args, "--config");
  if (!contractPath || !testsPath || !configPath) throw new Error("contract test requires --contract, --tests, and --config");
  const format = (optionalArg(args, "--format") ?? "text") as "text" | "json" | "junit";
  if (!["text", "json", "junit"].includes(format)) throw new Error("contract test --format must be text, json, or junit");
  const report = await runContractTests({
    contractPath,
    manifestPath: testsPath,
    configPath,
    live: args.includes("--live"),
    allowRemote: args.includes("--allow-remote"),
  });
  const text = formatContractTestReport(report, format);
  const output = outputArg(args);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`wrote contract test report: ${output}\n`);
  } else {
    process.stdout.write(text);
  }
  return report.ok ? 0 : 1;
}

async function reportCommand(args: string[]): Promise<number> {
  if (args[0] === "verify") {
    const file = firstPositional(args.slice(1));
    if (!file) throw new Error("report verify requires <report.json|report.md|report.pdf>");
    const result = await verifyComplianceReport(await readComplianceReport(file), optionalArg(args, "--public-key"));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Synapsor report verification: ${result.ok ? "PASS" : "FAIL"}\nCode: ${result.code}\nDigest: ${result.digest_ok ? "verified" : "invalid"}${result.signature_ok === undefined ? "" : `\nSignature: ${result.signature_ok ? "verified" : "invalid"}`}\n`);
    return result.ok ? 0 : 1;
  }
  const configPath = optionalArg(args, "--config");
  const config = configPath ? await readRuntimeConfig(configPath) : undefined;
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreReadBridge(args, config, "report", (bridgeStorePath) =>
      reportCommand(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const tenant = optionalArg(args, "--tenant")?.trim();
  if (!tenant) throw new Error("REPORT_TENANT_REQUIRED: report generation requires an explicit trusted --tenant scope");
  const object = optionalArg(args, "--object")?.trim();
  const principal = optionalArg(args, "--principal")?.trim();
  if (Boolean(object) === Boolean(principal)) throw new Error("report requires exactly one of --object <type:id> or --principal <principal>");
  const scope = object ? reportObjectScope(tenant, object) : { kind: "principal" as const, tenant_id: tenant, principal: principal! };
  const storePath = localStorePath(args);
  if (storePath !== ":memory:" && !await fileExists(storePath)) throw missingLocalStoreError(storePath);
  const format = (optionalArg(args, "--format") ?? "markdown") as "markdown" | "json" | "pdf";
  if (!["markdown", "json", "pdf"].includes(format)) throw new Error("report --format must be markdown, json, or pdf");
  const report = await createComplianceReport({
    storePath,
    scope,
    signingKeyPath: optionalArg(args, "--signing-key"),
    signingKeyId: optionalArg(args, "--key-id"),
  });
  const rendered = await formatComplianceReport(report, format);
  const output = outputArg(args);
  if (format === "pdf" && !output) throw new Error("report --format pdf requires --out <report.pdf>");
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, rendered);
    process.stdout.write(`wrote ${format} compliance report: ${output}\nIntegrity: ${report.integrity.digest}\n`);
  } else {
    process.stdout.write(String(rendered));
  }
  return 0;
}

function reportObjectScope(tenant: string, value: string): { kind: "object"; tenant_id: string; object_type: string; object_id: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new Error("report --object must be <type:id>");
  return { kind: "object", tenant_id: tenant, object_type: value.slice(0, separator), object_id: value.slice(separator + 1) };
}

async function policyCommand(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `policy ${args.slice(0, 3).join(" ")}`, (bridgeStorePath) =>
      policyCommand(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "policy recommendations", args);
  const storePath = localStorePath(args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `policy ${args.slice(0, 3).join(" ")}`, () => policyCommand(withoutSharedPostgresLedgerMirror(args)), config);
  }

  const [group, action] = args;
  if (group === "recommend") return policyRecommend(args.slice(1), configPath, config);
  if (group !== "recommendations") throw new Error("policy requires recommend or recommendations <list|show|approve|reject|export>");
  if (action === "list") return policyRecommendationsList(args.slice(2));
  if (action === "show") return policyRecommendationsShow(args.slice(2));
  if (action === "approve" || action === "reject") return policyRecommendationsDecide(action, args.slice(2), configPath, config);
  if (action === "export") return policyRecommendationsExport(args.slice(2));
  throw new Error("policy recommendations requires list, show, approve, reject, or export");
}

async function policyRecommend(args: string[], configPath: string, config: RuntimeConfig | undefined): Promise<number> {
  if (!config) throw new Error(`graduated trust requires a Runner config: ${configPath}`);
  const contractPath = requiredOption(args, "--contract", "policy recommend");
  const tenant = requiredOption(args, "--tenant", "policy recommend");
  const capability = requiredOption(args, "--capability", "policy recommend");
  const policy = requiredOption(args, "--policy", "policy recommend");
  const loaded = await loadReviewedContract(contractPath);
  const store = await openLocalStore(args);
  try {
    const result = await evaluateGraduatedTrust({
      config,
      contract: loaded.contract,
      store,
      tenant,
      capability,
      policy,
      now: optionalArg(args, "--now"),
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatGraduatedTrustEvaluation(result));
    return result.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

async function policyRecommendationsList(args: string[]): Promise<number> {
  const tenant = requiredOption(args, "--tenant", "policy recommendations list");
  const store = await openLocalStore(args);
  try {
    const recommendations = store.listPolicyRecommendations({
      tenant,
      capability: optionalArg(args, "--capability"),
      policy: optionalArg(args, "--policy"),
      status: optionalArg(args, "--status") as PolicyRecommendation["status"] | undefined,
    });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(recommendations, null, 2)}\n`);
    else if (recommendations.length === 0) process.stdout.write("No policy recommendations matched the trusted tenant scope.\n");
    else process.stdout.write(`${recommendations.map(formatPolicyRecommendationSummary).join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function policyRecommendationsShow(args: string[]): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error("policy recommendations show requires <recommendation_id>");
  const tenant = requiredOption(args, "--tenant", "policy recommendations show");
  const store = await openLocalStore(args);
  try {
    const recommendation = requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(recommendation, null, 2)}\n` : formatPolicyRecommendationDetail(recommendation));
    return 0;
  } finally {
    store.close();
  }
}

async function policyRecommendationsDecide(
  action: "approve" | "reject",
  args: string[],
  configPath: string,
  config: RuntimeConfig | undefined,
): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error(`policy recommendations ${action} requires <recommendation_id>`);
  const tenant = requiredOption(args, "--tenant", `policy recommendations ${action}`);
  const reason = requiredOption(args, "--reason", `policy recommendations ${action}`);
  if (!config?.operator_identity || config.operator_identity.provider === "dev_env") {
    throw new Error("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED: configure signed_key or jwt_oidc operator_identity");
  }
  const store = await openLocalStore(args);
  try {
    const recommendation = requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    await confirmDangerousAction(args, `${action === "approve" ? "Approve" : "Reject"} policy recommendation ${recommendationId}? This records a decision but does not activate a contract.`);
    const identity = await policyRecommendationIdentity({ args, config, configPath, store, recommendation, action, reason });
    const updated = await decideGraduatedTrustRecommendation({
      store,
      recommendationId,
      action,
      actor: identity.subject,
      reason,
      identity,
      now: optionalArg(args, "--now"),
    });
    operationalLog("info", "policy_recommendation_decision", {
      recommendation_id: updated.recommendation_id,
      tenant: updated.tenant_id,
      capability: updated.capability,
      policy: updated.policy,
      action,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      contract_activated: false,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : formatPolicyRecommendationDetail(updated));
    return 0;
  } finally {
    store.close();
  }
}

async function policyRecommendationsExport(args: string[]): Promise<number> {
  const recommendationId = positional(args, 0);
  if (!recommendationId) throw new Error("policy recommendations export requires <recommendation_id>");
  const tenant = requiredOption(args, "--tenant", "policy recommendations export");
  const contractPath = requiredOption(args, "--contract", "policy recommendations export");
  const output = outputArg(args);
  if (!output) throw new Error("policy recommendations export requires --out <contract.json>");
  const actor = requiredOption(args, "--actor", "policy recommendations export");
  const loaded = await loadReviewedContract(contractPath);
  const store = await openLocalStore(args);
  try {
    requirePolicyRecommendationForTenant(store, recommendationId, tenant);
    const artifact = await prepareGraduatedTrustArtifact({ store, recommendationId, activeContract: loaded.contract });
    await confirmDangerousAction(args, `Export reviewed policy artifact for ${recommendationId}? This does not push or activate it.`);
    await writeFileGuarded(output, `${JSON.stringify(artifact.contract, null, 2)}\n`, args.includes("--force"));
    const updated = await markGraduatedTrustArtifactExported({
      store,
      recommendationId,
      actor,
      artifactDigest: artifact.digest,
      now: optionalArg(args, "--now"),
    });
    operationalLog("info", "policy_recommendation_export", {
      recommendation_id: updated.recommendation_id,
      tenant: updated.tenant_id,
      artifact_digest: artifact.digest,
      base_contract_digest: updated.base_contract_digest,
      contract_activated: false,
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify({ recommendation: updated, artifact: { path: output, digest: artifact.digest, diff: artifact.diff }, activated: false }, null, 2)}\n`
      : `exported reviewable policy artifact: ${output}\nDigest: ${artifact.digest}\nChange: ${artifact.diff.field} ${artifact.diff.before} -> ${artifact.diff.after}\nActivation: not performed\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function policyRecommendationIdentity(input: {
  args: string[];
  config: RuntimeConfig;
  configPath: string;
  store: ProposalStore;
  recommendation: PolicyRecommendation;
  action: "approve" | "reject";
  reason: string;
}) {
  const evidenceProposalId = input.recommendation.evidence_proposal_ids[0];
  const evidenceProposal = evidenceProposalId ? input.store.getProposal(evidenceProposalId) : undefined;
  if (!evidenceProposal) throw new Error("POLICY_RECOMMENDATION_EVIDENCE_MISSING: the recommendation cannot be authorized without its bound proposal evidence");
  const syntheticProposal: StoredProposal = {
    ...evidenceProposal,
    proposal_id: input.recommendation.recommendation_id,
    proposal_version: 1,
    proposal_hash: input.recommendation.integrity_hash,
    tenant_id: input.recommendation.tenant_id,
    capability: input.recommendation.capability,
    action: `policy_change:${input.recommendation.policy}`,
  };
  const identity = await resolveOperatorIdentity({
    config: input.config.operator_identity as OperatorIdentityConfig,
    configPath: input.configPath,
    proposal: syntheticProposal,
    action: input.action,
    reason: input.reason,
    actor: optionalArg(input.args, "--actor"),
    identity: optionalArg(input.args, "--identity"),
    privateKeyPath: optionalArg(input.args, "--identity-key"),
  });
  if (!identity.verified || identity.provider === "dev_env") throw new Error("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED: decision identity was not cryptographically verified");
  return identity;
}

function requirePolicyRecommendationForTenant(store: ProposalStore, recommendationId: string, tenant: string): PolicyRecommendation {
  const recommendation = store.getPolicyRecommendation(recommendationId);
  if (!recommendation || recommendation.tenant_id !== tenant) throw new Error(`policy recommendation not found in trusted tenant scope: ${recommendationId}`);
  return recommendation;
}

function formatPolicyRecommendationSummary(recommendation: PolicyRecommendation): string {
  return `${recommendation.recommendation_id}  ${recommendation.status}  ${recommendation.capability}  ${recommendation.policy}.${recommendation.field} ${recommendation.current_threshold} -> ${recommendation.proposed_threshold}`;
}

function formatPolicyRecommendationDetail(recommendation: PolicyRecommendation): string {
  return [
    `Policy recommendation: ${recommendation.recommendation_id}`,
    `Status: ${recommendation.status}`,
    `Tenant: ${recommendation.tenant_id}`,
    `Capability: ${recommendation.capability}`,
    `Policy: ${recommendation.policy}`,
    `Threshold: ${recommendation.field} ${recommendation.current_threshold} -> ${recommendation.proposed_threshold}`,
    `Base contract: ${recommendation.base_contract_digest} (${recommendation.base_contract_version})`,
    `Evidence proposals: ${recommendation.evidence_proposal_ids.length}`,
    `Integrity: ${recommendation.integrity_hash}`,
    recommendation.decision ? `Decision: ${recommendation.decision.action} by ${recommendation.decision.actor}` : "Decision: pending verified operator review",
    recommendation.export ? `Artifact: ${recommendation.export.artifact_digest}` : "Artifact: not exported",
    "Activation: not performed by Runner",
    "",
  ].join("\n");
}

function requiredOption(args: string[], flag: string, command: string): string {
  const value = optionalArg(args, flag)?.trim();
  if (!value) throw new Error(`${command} requires ${flag} <value>`);
  return value;
}

async function contractBundle(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("contract bundle requires <synapsor.contract.json>");
  const outDir = outputArg(args) ?? "synapsor-runner-bundle";
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const contract = normalizeContract(parsed);
  const firstCapability = contract.capabilities[0];
  const firstSource = firstCapability?.source ?? "local_postgres";
  const engine = inferContractBundleEngine(contract);
  const readUrlEnv = engine === "mysql" ? "SYNAPSOR_DATABASE_READ_URL" : "SYNAPSOR_DATABASE_READ_URL";
  const hasProposals = contract.capabilities.some((capability) => capability.kind === "proposal");
  const sourceConfig: Record<string, unknown> = {
    engine,
    read_url_env: readUrlEnv,
    statement_timeout_ms: 3000,
  };
  if (hasProposals) sourceConfig.write_url_env = "SYNAPSOR_DATABASE_WRITE_URL";
  const runnerConfig = {
    version: 1,
    mode: hasProposals ? "review" : "read_only",
    result_format: 2,
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: ["./synapsor.contract.json"],
    sources: {
      [firstSource]: sourceConfig,
    },
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, "mcp-client-examples"), { recursive: true });
  await fs.writeFile(path.join(outDir, "synapsor.contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "synapsor.runner.json"), `${JSON.stringify(runnerConfig, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, ".env.example"), bundleEnvExample(contract, readUrlEnv, engine), "utf8");
  await fs.writeFile(path.join(outDir, "README.md"), bundleReadme(contract), "utf8");
  for (const [name, content] of Object.entries(bundleMcpClientExamples())) {
    await fs.writeFile(path.join(outDir, "mcp-client-examples", name), content, "utf8");
  }
  process.stdout.write(`created runner bundle: ${outDir}\n`);
  process.stdout.write("No database URLs, write credentials, tokens, or customer rows were included.\n");
  return 0;
}

function inferContractBundleEngine(contract: SynapsorContract): "postgres" | "mysql" {
  const engine = contract.resources?.find((resource) => resource.engine === "postgres" || resource.engine === "mysql")?.engine;
  return engine === "mysql" ? "mysql" : "postgres";
}

function bundleEnvExample(contract: SynapsorContract, readUrlEnv: string, engine: "postgres" | "mysql"): string {
  const context = contract.contexts[0];
  const tenantBinding = context?.bindings.find((binding) => binding.name === context.tenant_binding) ?? context?.bindings.find((binding) => binding.name === "tenant_id");
  const principalBinding = context?.bindings.find((binding) => binding.name === context.principal_binding) ?? context?.bindings.find((binding) => binding.name === "principal");
  return [
    "# Synapsor Runner bundle environment.",
    "# Fill these locally. Do not commit real values.",
    `# Set ${readUrlEnv} to your read-only ${engine === "mysql" ? "MySQL" : "Postgres"} URL.`,
    `${readUrlEnv}=`,
    ...(contract.capabilities.some((capability) => capability.kind === "proposal") ? ["# Optional: separate least-privilege write URL for guarded direct UPDATE writeback.", "SYNAPSOR_DATABASE_WRITE_URL="] : []),
    `${tenantBinding?.key ?? "SYNAPSOR_TENANT_ID"}=acme`,
    `${principalBinding?.key ?? "SYNAPSOR_PRINCIPAL"}=local_operator`,
    "",
  ].join("\n");
}

function bundleReadme(contract: SynapsorContract): string {
  const contractName = contract.metadata?.name ?? "Synapsor contract";
  return [
    `# ${contractName} Runner Bundle`,
    "",
    "This bundle lets you run a Cloud/exported Synapsor contract locally with Synapsor Runner.",
    "",
    "It includes:",
    "",
    "- `synapsor.contract.json`: canonical Synapsor contract;",
    "- `synapsor.runner.json`: local runtime wiring with env-var placeholders;",
    "- `.env.example`: placeholder runtime values only;",
    "- `mcp-client-examples/`: client snippets with command paths only.",
    "",
    "It does not include database passwords, write credentials, bearer tokens, or table rows.",
    "",
    "## Run Locally",
    "",
    "```bash",
    "cp .env.example .env",
    "# edit .env, then export the values in your shell",
    "set -a && . ./.env && set +a",
    "npx -y -p @synapsor/runner synapsor-runner contract validate ./synapsor.contract.json",
    "npx -y -p @synapsor/runner synapsor-runner config validate --config ./synapsor.runner.json",
    "npx -y -p @synapsor/runner synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db",
    "npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db",
    "```",
    "",
    "Approval and apply remain outside the model-facing MCP catalog. Inspect local history with:",
    "",
    "```bash",
    "npx -y -p @synapsor/runner synapsor-runner replay show latest --store ./.synapsor/local.db",
    "npx -y -p @synapsor/runner synapsor-runner cloud push ./synapsor.contract.json --dry-run",
    "```",
    "",
  ].join("\n");
}

function bundleMcpClientExamples(): Record<string, string> {
  const packageArgs = ["-y", "-p", "@synapsor/runner", "synapsor-runner"];
  const stdioArgs = [...packageArgs, "mcp", "serve", "--config", "./synapsor.runner.json", "--store", "./.synapsor/local.db"];
  const server = { command: "npx", args: stdioArgs };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "claude-desktop.json": json({ mcpServers: { "synapsor-runner": server } }),
    "cursor-project.mcp.json": json({ mcpServers: { "synapsor-runner": { type: "stdio", ...server } } }),
    "cursor-global.mcp.json": json({
      mcpServers: {
        "synapsor-runner": {
          type: "stdio",
          command: "npx",
          args: [...packageArgs, "mcp", "serve", "--config", "<absolute-path-to-bundle>/synapsor.runner.json", "--store", "<absolute-path-to-bundle>/.synapsor/local.db"],
        },
      },
    }),
    "generic-stdio.json": json({ name: "synapsor-runner", transport: "stdio", ...server }),
    "generic-streamable-http.json": json({ name: "synapsor-runner", transport: "streamable-http", url: "http://127.0.0.1:8766/mcp" }),
    "openai-agents-stdio.ts": `import { Agent, MCPServerStdio, run } from "@openai/agents";\n\nconst synapsor = new MCPServerStdio({\n  name: "Synapsor Runner",\n  fullCommand: "npx -y -p @synapsor/runner synapsor-runner mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db --alias-mode openai",\n});\nawait synapsor.connect();\ntry {\n  const agent = new Agent({ name: "Reviewed database agent", instructions: "Use only Synapsor business tools. Inspect evidence before proposing a change.", mcpServers: [synapsor] });\n  console.log((await run(agent, "Inspect the customer and propose a safe next action.")).finalOutput);\n} finally {\n  await synapsor.close();\n}\n`,
    "openai-agents-streamable-http.ts": `import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";\n\n// Start Runner separately with: synapsor-runner mcp serve --transport streamable-http --alias-mode openai --config ./synapsor.runner.json --store ./.synapsor/local.db\nconst synapsor = new MCPServerStreamableHttp({ name: "Synapsor Runner", url: "http://127.0.0.1:8766/mcp" });\nawait synapsor.connect();\ntry {\n  const agent = new Agent({ name: "Reviewed database agent", instructions: "Use only Synapsor business tools. Inspect evidence before proposing a change.", mcpServers: [synapsor] });\n  console.log((await run(agent, "Inspect the customer and propose a safe next action.")).finalOutput);\n} finally {\n  await synapsor.close();\n}\n`,
  };
}

async function configValidate(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const result = await validateConfigFile(configPath);
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

async function validateConfigFile(configPath: string): Promise<ConfigValidationResult> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  const raw = validateRunnerCapabilityConfig(parsed);
  if (!raw.ok) return raw;
  try {
    const resolved = resolveRuntimeConfig(parsed, path.dirname(path.resolve(configPath)));
    const resolvedValidation = validateRunnerCapabilityConfig(resolved);
    return {
      ok: resolvedValidation.ok,
      errors: resolvedValidation.errors,
      warnings: [...raw.warnings, ...resolvedValidation.warnings],
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        path: "$.contracts",
        code: "CONTRACT_RESOLUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }],
      warnings: raw.warnings,
    };
  }
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
  const value = envValue(process.env, envName);
  return {
    name: `env:${envName}`,
    ok: Boolean(value),
    level: value ? "pass" : "fail",
    message: value ? `${envName} is set.` : message,
  };
}

function proposalWritebackResolutionDoctorCheck(config: RuntimeConfig, capability: RunnerCapabilityConfig): DoctorCheck {
  const mode = capabilityWritebackMode(capability);
  if (mode === "none") {
    return {
      name: `capability:${capability.name}:writeback-resolution`,
      ok: true,
      level: "pass",
      message: "Capability explicitly declares no local writeback; proposals are review records only.",
    };
  }
  if (mode === "cloud_worker") {
    return {
      name: `capability:${capability.name}:writeback-resolution`,
      ok: true,
      level: "pass",
      message: "Capability declares cloud-worker writeback; local apply is intentionally unavailable.",
    };
  }
  try {
    assertProposalWritebackResolvable(config, capability);
    return {
      name: `capability:${capability.name}:writeback-resolution`,
      ok: true,
      level: "pass",
      message: mode === "direct_sql"
        ? "Direct SQL writeback definition resolves to a source and writer env var name."
        : `App-owned handler writeback resolves to executor ${capabilityWritebackExecutor(capability)}.`,
    };
  } catch (error) {
    return {
      name: `capability:${capability.name}:writeback-resolution`,
      ok: false,
      level: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function proposalApprovalPolicyResolutionDoctorCheck(config: RuntimeConfig, capability: RunnerCapabilityConfig): DoctorCheck {
  if (capability.approval?.mode !== "policy") {
    return {
      name: `capability:${capability.name}:approval-policy-resolution`,
      ok: true,
      level: "pass",
      message: "Capability does not use policy auto-approval.",
    };
  }
  try {
    assertApprovalPolicyResolvable(config, capability);
    const policy = (config.policies ?? []).find((candidate) => candidate.name === capability.approval?.policy);
    const limits = policy?.limits ?? [];
    return {
      name: `capability:${capability.name}:approval-policy-resolution`,
      ok: true,
      level: "pass",
      message: limits.length > 0
        ? `Approval policy ${capability.approval.policy} resolves with ${limits.length} reviewed aggregate limit(s): ${limits.map((limit) => limit.kind === "total" ? `total ${limit.field} <= ${limit.max} per ${limit.period}` : `count <= ${limit.max} per ${limit.period}`).join("; ")}.`
        : `Approval policy ${capability.approval.policy} resolves without aggregate limits; do not schedule unattended batch apply.`,
    };
  } catch (error) {
    return {
      name: `capability:${capability.name}:approval-policy-resolution`,
      ok: false,
      level: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function proposalReversibilityDoctorCheck(capability: RunnerCapabilityConfig): DoctorCheck {
  const operation = capabilityOperation(capability);
  if (capability.reversibility?.mode !== "reviewed_inverse") {
    return {
      name: `capability:${capability.name}:reversibility`,
      ok: true,
      level: "warn",
      message: "Direct writeback is not configured for reviewed compensation. Revert proposals will be unavailable for its receipts.",
    };
  }
  if (operation === "delete") {
    return {
      name: `capability:${capability.name}:reversibility`,
      ok: true,
      level: "warn",
      message: "Hard DELETE records a specific best-effort-unavailable inverse; hidden columns, triggers, cascades, and external effects cannot be reconstructed safely.",
    };
  }
  return {
    name: `capability:${capability.name}:reversibility`,
    ok: true,
    level: "pass",
    message: `Reviewed compensation enabled for ${capability.operation?.cardinality === "set" ? "bounded-set" : "single-row"} ${operation.toUpperCase()}; revert creates a new approval-required proposal and never writes directly.`,
  };
}

async function sharedPostgresLedgerDoctorChecks(config: RuntimeConfig): Promise<DoctorCheck[]> {
  const configured = config.storage?.shared_postgres;
  if (configured?.mode !== "mirror" && configured?.mode !== "runtime_store") return [];

  const mirror = sharedPostgresLedgerMirrorOptions([], config);
  const runtimeStoreMode = configured.mode === "runtime_store";
  const checks: DoctorCheck[] = [{
    name: runtimeStoreMode ? "shared-postgres-ledger:runtime-store-config" : "shared-postgres-ledger:mirror-config",
    ok: true,
    level: "pass",
    message: runtimeStoreMode
      ? `Shared Postgres runtime store is configured for schema ${mirror.schema} using URL env ${mirror.urlEnv}. MCP serving stores proposal, evidence, receipt, and replay records in this Postgres ledger under an advisory lock.`
      : `Shared Postgres ledger mirror is configured for schema ${mirror.schema} using URL env ${mirror.urlEnv}. Mutating CLI commands restore/sync through this ledger under an advisory lock.`,
  }];

  const databaseUrl = envValue(mirror.urlEnv);
  if (!databaseUrl) {
    checks.push({
      name: "shared-postgres-ledger:url-env",
      ok: false,
      level: "fail",
      message: `${mirror.urlEnv} is required for shared Postgres ledger ${runtimeStoreMode ? "runtime store" : "mirror"} mode.`,
    });
    return checks;
  }

  const pool = createPostgresPool(databaseUrl);
  try {
    const counts = await sharedPostgresLedgerTableCounts(pool, mirror.schema);
    const missing = Object.entries(counts)
      .filter(([, count]) => count === null)
      .map(([table]) => table);
    if (missing.length > 0) {
      checks.push({
        name: "shared-postgres-ledger:migration",
        ok: false,
        level: "fail",
        message: `Shared Postgres ledger schema ${mirror.schema} is not initialized; missing ${missing.join(", ")}. Run ${cliCommandName()} store shared-postgres apply-migration --schema ${mirror.schema} --url-env ${mirror.urlEnv} --yes before using ${runtimeStoreMode ? "runtime store" : "mirror"} mode.`,
      });
    } else {
      checks.push({
        name: "shared-postgres-ledger:migration",
        ok: true,
        level: "pass",
        message: `Shared Postgres ledger schema ${mirror.schema} is initialized (${Object.entries(counts).map(([table, count]) => `${table}=${count}`).join(", ")}).`,
      });
    }
  } catch (error) {
    checks.push({
      name: "shared-postgres-ledger:migration",
      ok: false,
      level: "fail",
      message: `Could not inspect shared Postgres ledger schema ${mirror.schema} using ${mirror.urlEnv}: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await pool.end();
  }
  return checks;
}

async function httpHandlerReachabilityCheck(executorName: string, rawUrl: string, timeoutMs: number): Promise<DoctorCheck> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        name: `executor:${executorName}:handler-reachability`,
        ok: false,
        level: "fail",
        message: "HTTP handler URL must use http or https.",
      };
    }
  } catch {
    return {
      name: `executor:${executorName}:handler-reachability`,
      ok: false,
      level: "fail",
      message: "HTTP handler URL env value is not a valid URL.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs || 3000, 10_000)));
  try {
    const response = await fetch(rawUrl, {
      method: "OPTIONS",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return {
      name: `executor:${executorName}:handler-reachability`,
      ok: true,
      level: "pass",
      message: `HTTP handler endpoint responded with HTTP ${response.status}; network path is reachable. This is not an apply/writeback probe.`,
    };
  } catch (error) {
    return {
      name: `executor:${executorName}:handler-reachability`,
      ok: false,
      level: "fail",
      message: `HTTP handler endpoint did not respond to the reachability probe (${safeReachabilityError(error)}).`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeReachabilityError(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  return "connection failed";
}

async function inspectConfiguredSource(input: {
  config: RuntimeConfig;
  sourceName: string;
  source: NonNullable<RuntimeConfig["sources"]>[string];
  checks: DoctorCheck[];
}): Promise<void> {
  if (!envValue(process.env, input.source.read_url_env)) return;
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
        if (capability.kind === "proposal" && capabilityWritebackMode(capability) === "direct_sql") {
          const operation = capabilityOperation(capability);
          const prerequisites = assessDirectWritePrerequisites(table, {
            operation,
            primary_key: capability.target.primary_key,
            tenant_key: capability.target.tenant_key,
            allowed_columns: capability.allowed_columns ?? [],
            patch_columns: Object.keys(capability.patch ?? {}),
            conflict_column: capability.conflict_guard?.column,
            version_advance: capability.operation?.version_advance,
            dedup_columns: capability.operation?.deduplication?.components.map((component) => component.column),
          });
          for (const prerequisite of prerequisites) {
            input.checks.push({
              name: `capability:${capability.name}:prerequisite:${prerequisite.code.toLowerCase()}`,
              ok: prerequisite.level !== "fail",
              level: prerequisite.level,
              message: prerequisite.message,
            });
          }
          if (input.source.receipts?.authority === "runner_ledger" && operation === "update" && !capability.operation?.version_advance) {
            input.checks.push({
              name: `capability:${capability.name}:prerequisite:runner-ledger-version-advance`,
              ok: false,
              level: "fail",
              message: "runner_ledger UPDATE requires reviewed monotonic version advancement in the same source transaction.",
            });
          }
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

async function localToolNames(config: RuntimeConfig, checks: DoctorCheck[]): Promise<string[]> {
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
      await runtime.close();
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
  const lines = [
    `Synapsor Runner doctor: ${report.ok ? "ok" : "failed"}`,
    `Config: ${report.config_path}`,
    `Mode: ${report.mode}`,
    `Governance authority: ${report.governance.authority_mode}`,
    `Evidence residency: ${report.governance.evidence_residency}`,
  ];
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

function formatLocalDoctorMarkdown(report: LocalDoctorReport): string {
  const store = report.store_stats;
  const boundaryOk = report.checks.find((check) => check.name === "mcp-tool-boundary")?.ok === true;
  const lines = [
    "# Synapsor Runner Doctor Report",
    "",
    `- Runner package: @synapsor/runner`,
    `- Node version: ${process.versions.node}`,
    `- Config: ${report.config_path}`,
    `- Mode: ${report.mode}`,
    `- Governance authority: ${report.governance.authority_mode}`,
    `- Evidence residency: ${report.governance.evidence_residency}`,
    `- Queue proposals while Cloud is unavailable: ${report.governance.queue_when_unavailable ? "yes" : "no"}`,
    `- Status: ${report.ok ? "ok" : "needs attention"}`,
    "",
    "## Semantic Tools",
    "",
    ...(report.tools.length ? report.tools.map((tool) => `- ${tool}`) : ["- none listed"]),
    "",
    "## Safety Boundary",
    "",
    `- Raw SQL / commit tools exposed: ${boundaryOk ? "no obvious forbidden tools detected" : "needs review"}`,
    "- Database URLs, passwords, bearer tokens, and private keys are intentionally not included in this report.",
    "",
    "## Local Store",
    "",
    `- Path: ${store?.path ?? "not configured"}`,
    `- Exists: ${store?.exists ? "yes" : "no"}`,
    ...(store?.exists
      ? [
        `- Proposals: ${store.proposals ?? 0}`,
        `- Evidence bundles: ${store.evidence ?? 0}`,
        `- Query audit records: ${store.query_audit ?? 0}`,
        `- Receipts: ${store.receipts ?? 0}`,
      ]
      : []),
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- ${check.level.toUpperCase()} ${check.name}: ${check.message}`),
    "",
    "## Redaction Note",
    "",
    "This report is redacted by design. Do not attach raw database URLs, passwords, API keys, bearer tokens, private keys, cookies, or customer data when sharing diagnostics.",
  ];
  return `${lines.join("\n")}\n`;
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  message: string;
};

type LocalDoctorGovernance = {
  authority_mode: "local_only" | "cloud_linked";
  evidence_residency: "metadata_only";
  queue_when_unavailable: boolean;
  pending?: number;
  leased?: number;
  acknowledged?: number;
  dead_letter?: number;
  reconciliation_required?: number;
  oldest_pending_at?: string;
  last_acknowledged_at?: string;
  last_reconciled_at?: string;
  last_reconciliation_error_code?: string;
  last_compacted_at?: string;
  last_compacted_count?: number;
  connection_error_code?: string;
};

type LocalDoctorReport = {
  ok: boolean;
  mode: string;
  config_path: string;
  checks: DoctorCheck[];
  tools: string[];
  governance: LocalDoctorGovernance;
  store_stats?: {
    path: string;
    exists: boolean;
    proposals?: number;
    evidence?: number;
    query_audit?: number;
    receipts?: number;
  };
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
const packageAssetRoot = path.resolve(moduleDir, "..");
const sourceAssetRoot = path.resolve(moduleDir, "../../..");

async function resolveAssetPath(relativePath: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(packageAssetRoot, relativePath),
    path.resolve(sourceAssetRoot, relativePath),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[0]!;
}

async function loadBuiltInRecipes(): Promise<CapabilityRecipe[]> {
  const recipeDir = await resolveAssetPath("recipes");
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
  const recipeDir = await resolveAssetPath("recipes");
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
  if (!process.env.SYNAPSOR_CONTROL_PLANE_URL) {
    throw new Error(`Local doctor requires --config ./synapsor.runner.json. Cloud worker doctor requires SYNAPSOR_CONTROL_PLANE_URL and the scoped worker environment.`);
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
    : warn("config", `Runner config not found at ${configPath}.`, "Own-database MCP setup needs a generated config.", `Run ${cliCommandName()} demo first, or run ${cliCommandName()} onboard db --from-env DATABASE_URL.`));

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
      checks.push(envValue(process.env, envName)
        ? pass(`env-${envName}`, `${envName} is set for ${contextName}.`, "Trusted tenant/principal values must come from the launcher, not the model.", "No action needed.")
        : warn(`env-${envName}`, `${envName} is not set for ${contextName}.`, "Trusted tenant/principal values must come from the launcher, not the model.", `Set ${envName}, or use the generated .env.example as a template.`));
    }
  }
  for (const [sourceName, source] of Object.entries(config.sources ?? {})) {
    checks.push(envValue(process.env, source.read_url_env)
      ? pass(`env-${source.read_url_env}`, `${source.read_url_env} is set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", "No action needed.")
      : warn(`env-${source.read_url_env}`, `${source.read_url_env} is not set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", `Set ${source.read_url_env} before running doctor, tools preview, or mcp serve against your own database.`));
    if (source.write_url_env) {
      checks.push(envValue(process.env, source.write_url_env)
        ? pass(`env-${source.write_url_env}`, `${source.write_url_env} is set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", "No action needed.")
        : warn(`env-${source.write_url_env}`, `${source.write_url_env} is not set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", `Set ${source.write_url_env} only when you are ready to apply an approved writeback job.`));
      const readValue = envValue(process.env, source.read_url_env);
      const writeValue = envValue(process.env, source.write_url_env);
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
  const checkHandlers = args.includes("--check-handlers");
  const checkWriteback = args.includes("--check-writeback") || args.includes("--check-db");
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
  let parsed = rawConfig;
  const checks: DoctorCheck[] = [];
  const validation = await validateConfigFile(configPath);
  checks.push({
    name: "config-valid",
    ok: validation.ok,
    level: validation.ok ? "pass" : "fail",
    message: validation.ok ? "Config parses and validates." : validation.errors.map((error) => `${error.path} ${error.code}`).join("; "),
  });
  for (const warning of validation.warnings) {
    checks.push({ name: `config-warning:${warning.code}`, ok: true, level: "warn", message: warning.message });
  }
  if (validation.ok) {
    parsed = await readRuntimeConfig(configPath);
  }
  checks.push(...await sharedPostgresLedgerDoctorChecks(parsed));
  checks.push(...graduatedTrustDoctorChecks(parsed));
  const governance = await cloudLinkedGovernanceDoctorStatus(parsed, args, checks);

  const contextsToCheck = trustedContextsForDoctor(parsed);
  for (const [contextName, contextValues] of contextsToCheck) {
    const tenantEnv = String(contextValues.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
    const principalEnv = String(contextValues.principal_env ?? "SYNAPSOR_PRINCIPAL");
    for (const envName of [tenantEnv, principalEnv]) {
      checks.push(envPresenceCheck(envName, `${envName} is required for trusted context ${contextName}.`));
    }
  }

  const sources = parsed.sources ?? {};
  if (parsed.mode === "review") {
    for (const capability of (parsed.capabilities ?? []).filter((item) => item.kind === "proposal")) {
      checks.push(proposalWritebackResolutionDoctorCheck(parsed, capability));
      checks.push(proposalApprovalPolicyResolutionDoctorCheck(parsed, capability));
      if (capabilityWritebackMode(capability) === "direct_sql") checks.push(proposalReversibilityDoctorCheck(capability));
      if (capability.operation?.cardinality === "set") {
        const selection = capability.operation.selection?.all
          .map((term) => `${term.column} ${term.operator} ${formatScalar(term.value)}`)
          .join(" AND ") || "exact reviewed batch items";
        const bounds = capability.operation.aggregate_bounds
          ?.map((bound) => `${bound.measure}(${bound.column}) <= ${bound.maximum}`)
          .join("; ") || "missing";
        checks.push({
          name: `capability:${capability.name}:bounded-set-authority`,
          ok: true,
          level: "pass",
          message: `Bounded-set ${capabilityOperation(capability).toUpperCase()}: fixed selection ${selection}; max rows ${capability.operation.max_rows}; aggregate bounds ${bounds}; human/operator approval required.`,
        });
      }
    }
  }
  for (const [sourceName, source] of Object.entries(sources)) {
    if (parsed.mode === "review" && sourceNeedsSqlWriteback(parsed, sourceName)) {
      checks.push(sourceReceiptModeDoctorCheck(parsed, sourceName, source));
    }
    checks.push(envPresenceCheck(source.read_url_env, `${source.read_url_env} is required for ${sourceName} reads.`));
    if (parsed.mode === "review") {
      if (sourceNeedsSqlWriteback(parsed, sourceName)) {
        if (source.write_url_env) {
          checks.push(envPresenceCheck(source.write_url_env, `${source.write_url_env} is required for trusted writeback in review mode.`));
          const readValue = envValue(process.env, source.read_url_env);
          const writeValue = envValue(process.env, source.write_url_env);
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
        const writeUrl = source.write_url_env ? envValue(process.env, source.write_url_env) : undefined;
        if (checkWriteback && writeUrl) {
          checks.push(...await directSqlWritebackDoctorChecks(parsed, sourceName, source, writeUrl));
        } else if (checkWriteback) {
          checks.push({
            name: `source:${sourceName}:writeback-probe`,
            ok: false,
            level: "fail",
            message: "Direct SQL writeback probe skipped because the writer env var is missing.",
          });
        } else {
          checks.push({
            name: `source:${sourceName}:writeback-probe`,
            ok: true,
            level: "warn",
            message: `Direct SQL writeback was not probed. Rerun doctor with --check-writeback to verify writer connectivity, receipt-table permissions, and rollback-only target-table access.`,
          });
        }
      }
    }
    await inspectConfiguredSource({ config: parsed, sourceName, source, checks });
  }

  for (const [executorName, executor] of Object.entries(parsed.executors ?? {})) {
    if (!isRecord(executor)) continue;
    if (executor.type === "http_handler") {
      const urlEnv = String(executor.url_env ?? "");
      if (urlEnv) {
        checks.push(envPresenceCheck(urlEnv, `${urlEnv} is required for http_handler executor ${executorName}.`));
        const handlerUrl = envValue(process.env, urlEnv);
        if (checkHandlers && handlerUrl) {
          checks.push(await httpHandlerReachabilityCheck(executorName, handlerUrl, Number(executor.timeout_ms ?? 3000)));
        } else if (!checkHandlers) {
          checks.push({
            name: `executor:${executorName}:handler-reachability`,
            ok: true,
            level: "warn",
            message: `Handler reachability was not probed for ${executorName}. Rerun doctor with --check-handlers to verify the network path without applying a proposal.`,
          });
        }
      }
      const auth = isRecord(executor.auth) ? executor.auth : undefined;
      const tokenEnv = typeof auth?.token_env === "string" ? auth.token_env : undefined;
      if (tokenEnv) checks.push(envPresenceCheck(tokenEnv, `${tokenEnv} is required for http_handler executor ${executorName} bearer auth.`));
      const signingSecretEnv = typeof executor.signing_secret_env === "string" ? executor.signing_secret_env : undefined;
      if (signingSecretEnv) {
        checks.push(envPresenceCheck(signingSecretEnv, `${signingSecretEnv} is required to sign http_handler requests for executor ${executorName}.`));
      } else {
        checks.push({
          name: `executor:${executorName}:handler-signing`,
          ok: true,
          level: "warn",
          message: `No signing_secret_env is configured for http_handler executor ${executorName}. HMAC signing is recommended unless the handler is loopback-only and protected by another trusted boundary.`,
        });
      }
    }
    if (executor.type === "command_handler") {
      const commandEnv = String(executor.command_env ?? "");
      if (commandEnv) checks.push(envPresenceCheck(commandEnv, `${commandEnv} is required for command_handler executor ${executorName}.`));
    }
  }

  const tools = await localToolNames(parsed, checks);
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
    governance,
    store_stats: await localDoctorStoreStats(optionalArg(args, "--store") ?? parsed.storage?.sqlite_path),
  };
  if (args.includes("--report")) {
    const output = outputArg(args) ?? "synapsor-doctor.md";
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, formatLocalDoctorMarkdown(report), "utf8");
    process.stdout.write(`wrote redacted doctor report: ${output}\n`);
  } else if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatLocalDoctorReport(report));
  }
  return report.ok ? 0 : 1;
}

async function cloudLinkedGovernanceDoctorStatus(
  config: RuntimeConfig,
  args: string[],
  checks: DoctorCheck[],
): Promise<LocalDoctorGovernance> {
  if (config.governance?.mode !== "cloud_linked") {
    checks.push({ name: "governance:authority", ok: true, level: "pass", message: "Governance authority is local-only; no Synapsor Cloud account is required." });
    return { authority_mode: "local_only", evidence_residency: "metadata_only", queue_when_unavailable: false };
  }
  const storePath = optionalArg(args, "--store") ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  let store: ReturnType<typeof createDefaultRuntimeStore> | undefined;
  let synchronizer: CloudLinkedSynchronizer | undefined;
  try {
    store = createDefaultRuntimeStore(config, process.env, storePath);
    synchronizer = new CloudLinkedSynchronizer(config, store, process.env);
    const status = await synchronizer.status();
    checks.push({
      name: "governance:authority",
      ok: true,
      level: "pass",
      message: `Governance authority is Synapsor Cloud; local store ${storePath} is an operational spool/mirror and is never uploaded.`,
    });
    checks.push({
      name: "governance:evidence-residency",
      ok: true,
      level: "pass",
      message: "Evidence residency is metadata_only; source rows, SQL details, kept-out fields, credentials, and replay payloads remain local.",
    });
    const unhealthy = status.dead_letter > 0 || status.reconciliation_required > 0;
    const lagging = status.pending > 0 || status.leased > 0;
    checks.push({
      name: "governance:outbox",
      ok: !unhealthy,
      level: unhealthy ? "fail" : lagging ? "warn" : "pass",
      message: unhealthy
        ? `Cloud outbox needs operator attention: ${status.dead_letter} dead-letter and ${status.reconciliation_required} reconciliation-required event(s). Run ${cliCommandName()} cloud outbox inspect latest.`
        : lagging
          ? `Cloud outbox has ${status.pending} pending and ${status.leased} leased event(s); source writes remain blocked until Cloud governance completes.`
          : "Cloud outbox has no pending, leased, dead-letter, or reconciliation-required events.",
    });
    return { ...status, queue_when_unavailable: config.governance.queue_when_unavailable !== false };
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "CLOUD_LINKED_DOCTOR_FAILED") : "CLOUD_LINKED_DOCTOR_FAILED";
    checks.push({
      name: "governance:cloud-connection",
      ok: false,
      level: "fail",
      message: `Cloud-linked governance configuration could not be opened (${errorCode}). Check the reviewed connection file and Runner credential environment; no local approval fallback is allowed.`,
    });
    return {
      authority_mode: "cloud_linked",
      evidence_residency: "metadata_only",
      queue_when_unavailable: config.governance.queue_when_unavailable !== false,
      connection_error_code: errorCode,
    };
  } finally {
    await synchronizer?.stop();
    await store?.close();
  }
}

function graduatedTrustDoctorChecks(config: RuntimeConfig): DoctorCheck[] {
  const trust = config.graduated_trust;
  if (trust?.enabled !== true) {
    return [{
      name: "graduated-trust:mode",
      ok: true,
      level: "pass",
      message: "Graduated trust is disabled by default; Runner will not create policy recommendations.",
    }];
  }
  if (trust.kill_switch === true) {
    return [{
      name: "graduated-trust:kill-switch",
      ok: true,
      level: "warn",
      message: "Graduated-trust kill switch is active; no recommendations can be created.",
    }];
  }
  const checks: DoctorCheck[] = [{
    name: "graduated-trust:mode",
    ok: true,
    level: "pass",
    message: `Graduated trust is enabled for ${trust.criteria?.length ?? 0} reviewed criterion/criteria. It can recommend only; it cannot approve, export, push, or activate a contract automatically.`,
  }];
  const verifiedIdentity = config.operator_identity?.provider === "signed_key" || config.operator_identity?.provider === "jwt_oidc";
  checks.push({
    name: "graduated-trust:operator-identity",
    ok: verifiedIdentity,
    level: verifiedIdentity ? "pass" : "fail",
    message: verifiedIdentity
      ? `Policy recommendation decisions require configured ${config.operator_identity?.provider} operator identity.`
      : "Enabled graduated trust requires signed_key or jwt_oidc operator_identity before any recommendation can be approved or rejected.",
  });
  for (const criterion of trust.criteria ?? []) {
    const capability = (config.capabilities ?? []).find((item) => item.name === criterion.capability);
    const policy = (config.policies ?? []).find((item) => item.name === criterion.policy && item.kind === "approval");
    const rule = policy?.rules?.find((item) => item.field === criterion.field);
    const current = typeof rule?.max === "number" ? rule.max : undefined;
    const resolvable = capability?.kind === "proposal" && capability.approval?.mode === "policy" && capability.approval.policy === criterion.policy && current !== undefined;
    checks.push({
      name: `graduated-trust:${criterion.capability}:${criterion.policy}:${criterion.field}`,
      ok: resolvable,
      level: resolvable ? "pass" : "fail",
      message: resolvable
        ? `Reviewed threshold ${current}; minimum ${criterion.minimum_human_reviews} human reviews over ${criterion.window_days} days; increment <= ${criterion.maximum_threshold_increase}; ceiling ${criterion.absolute_ceiling}.`
        : `Criterion does not resolve to a policy-approved proposal capability and numeric approval rule for ${criterion.field}.`,
    });
  }
  return checks;
}

async function directSqlWritebackDoctorChecks(
  config: RuntimeConfig,
  sourceName: string,
  source: RunnerSourceConfig,
  writeUrl: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const result = await adapters[source.engine].doctor({
      controlPlaneUrl: "local",
      runnerToken: "local",
      runnerId: "doctor",
      sourceId: sourceName,
      databaseUrl: writeUrl,
      engine: source.engine,
      pollIntervalMs: 0,
      statementTimeoutMs: writebackTimeoutMs(source),
      logLevel: "error",
      dryRun: true,
      stateDir: "./state",
      receipts: runnerReceiptConfig(source),
    } satisfies RunnerConfig);
    const receiptMode = formatSourceReceiptMode(source);
    checks.push({
      name: `source:${sourceName}:receipt-table-probe`,
      ok: result.ok,
      level: result.ok ? "pass" : "fail",
      message: result.ok
        ? source.receipts?.authority === "runner_ledger"
          ? `Writer credential can reach the source; ${receiptMode} performed no source receipt DDL/DML.`
          : `Writer credential can reach the database and the ${receiptMode} SELECT/INSERT/UPDATE rollback probe succeeded.`
        : `Writer receipt-mode probe failed (${safeDatabaseProbeError(result.details)}). ${receiptTableGuidance(source.engine, source)}`,
    });
  } catch (error) {
    checks.push({
      name: `source:${sourceName}:receipt-table-probe`,
      ok: false,
      level: "fail",
      message: `Writer receipt-mode probe failed (${safeDatabaseProbeError(error)}). ${receiptTableGuidance(source.engine, source)}`,
    });
  }

  for (const capability of directSqlProposalCapabilities(config, sourceName)) {
    try {
      await rollbackOnlyTargetProbe(source.engine, writeUrl, capability);
      checks.push({
        name: `capability:${capability.name}:writeback-target-probe`,
        ok: true,
        level: "pass",
        message: `Rollback-only writer probe reached ${capability.target.schema}.${capability.target.table} and verified ${capabilityOperation(capability).toUpperCase()} authority without mutating business rows.`,
      });
    } catch (error) {
      checks.push({
        name: `capability:${capability.name}:writeback-target-probe`,
        ok: false,
        level: "fail",
        message: `Rollback-only writer probe failed for configured target ${capability.target.schema}.${capability.target.table} (${safeDatabaseProbeError(error)}). Verify writer SELECT/${capabilityOperation(capability).toUpperCase()} on the target table and configured columns.`,
      });
    }
  }
  return checks;
}

function directSqlProposalCapabilities(config: RuntimeConfig, sourceName: string): RunnerCapabilityConfig[] {
  return (config.capabilities ?? []).filter((capability) => {
    if (capability.kind !== "proposal" || capability.source !== sourceName) return false;
    return capabilityWritebackMode(capability) === "direct_sql";
  });
}

async function rollbackOnlyTargetProbe(engine: "postgres" | "mysql", databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  if (engine === "postgres") {
    await rollbackOnlyPostgresTargetProbe(databaseUrl, capability);
    return;
  }
  await rollbackOnlyMysqlTargetProbe(databaseUrl, capability);
}

async function rollbackOnlyPostgresTargetProbe(databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  const pg = await dynamicImportModule<{ Pool: new (options: { connectionString: string }) => { connect(): Promise<PostgresProbeClient>; end(): Promise<void> } }>("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const table = `${quotePostgresIdentifier(capability.target.schema)}.${quotePostgresIdentifier(capability.target.table)}`;
      const columns = proposalReadProbeColumns(capability).map(quotePostgresIdentifier).join(", ");
      await client.query(`SELECT ${columns} FROM ${table} WHERE false`);
      const operation = capabilityOperation(capability);
      const writeColumns = proposalWriteProbeColumns(capability);
      if (operation === "update") {
        for (const column of writeColumns) {
          const quoted = quotePostgresIdentifier(column);
          await client.query(`UPDATE ${table} SET ${quoted} = NULL WHERE false`);
        }
      } else if (operation === "insert") {
        const quotedColumns = writeColumns.map(quotePostgresIdentifier).join(", ");
        const nullValues = writeColumns.map(() => "NULL").join(", ");
        await client.query(`INSERT INTO ${table} (${quotedColumns}) SELECT ${nullValues} WHERE false`);
      } else {
        await client.query(`DELETE FROM ${table} WHERE false`);
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function rollbackOnlyMysqlTargetProbe(databaseUrl: string, capability: RunnerCapabilityConfig): Promise<void> {
  const mysql = await dynamicImportModule<{ createConnection(options: { uri: string; dateStrings: boolean }): Promise<MysqlProbeConnection> }>("mysql2/promise");
  const connection = await mysql.createConnection({ uri: databaseUrl, dateStrings: true });
  try {
    await connection.beginTransaction();
    try {
      const table = `${quoteMysqlIdentifier(capability.target.schema)}.${quoteMysqlIdentifier(capability.target.table)}`;
      const columns = proposalReadProbeColumns(capability).map(quoteMysqlIdentifier).join(", ");
      await connection.query(`SELECT ${columns} FROM ${table} WHERE 1 = 0`);
      const operation = capabilityOperation(capability);
      const writeColumns = proposalWriteProbeColumns(capability);
      if (operation === "update") {
        for (const column of writeColumns) {
          const quoted = quoteMysqlIdentifier(column);
          await connection.query(`UPDATE ${table} SET ${quoted} = NULL WHERE 1 = 0`);
        }
      } else if (operation === "insert") {
        const quotedColumns = writeColumns.map(quoteMysqlIdentifier).join(", ");
        const nullValues = writeColumns.map(() => "NULL").join(", ");
        await connection.query(`INSERT INTO ${table} (${quotedColumns}) SELECT ${nullValues} FROM DUAL WHERE 1 = 0`);
      } else {
        await connection.query(`DELETE FROM ${table} WHERE 1 = 0`);
      }
      await connection.rollback();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end();
  }
}

async function dynamicImportModule<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return importer(specifier);
}

type PostgresProbeClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
};

type MysqlProbeConnection = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
};

function proposalReadProbeColumns(capability: RunnerCapabilityConfig): string[] {
  const columns = new Set<string>();
  columns.add(capability.target.primary_key);
  const operation = capabilityOperation(capability);
  if (operation === "insert") {
    for (const component of capability.operation?.deduplication?.components ?? []) columns.add(component.column);
  } else {
    if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
    if (capability.conflict_guard?.column) columns.add(capability.conflict_guard.column);
  }
  return [...columns];
}

function proposalWriteProbeColumns(capability: RunnerCapabilityConfig): string[] {
  const columns = new Set<string>();
  for (const column of capability.allowed_columns ?? []) columns.add(column);
  for (const column of Object.keys(capability.patch ?? {})) columns.add(column);
  if (capabilityOperation(capability) === "insert") {
    if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
    for (const component of capability.operation?.deduplication?.components ?? []) columns.add(component.column);
  }
  return [...columns];
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function safeDatabaseProbeError(error: unknown): string {
  const raw = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : JSON.stringify(error ?? {});
  const message = raw.toLowerCase();
  if (/permission|denied|not authorized|insufficient|42501|er_tableaccess_denied|er_dbaccess_denied/.test(message)) return "permission denied";
  if (/authentication|password|28p01|access denied for user|invalid authorization/.test(message)) return "authentication failed";
  if (/timeout|timed out|etimedout/.test(message)) return "timeout";
  if (/econnrefused|enotfound|eai_again|network|connection terminated|connection failed/.test(message)) return "connection failed";
  if (/does not exist|unknown database|no such table|undefined_table|er_no_such_table|42p01/.test(message)) return "configured object not found";
  return "database probe failed";
}

function receiptTableGuidance(engine: "postgres" | "mysql", source?: RunnerSourceConfig): string {
  if (source?.receipts?.authority === "runner_ledger") {
    return "Verify the authoritative Runner ledger and minimum business-table writer grants; runner_ledger never creates or writes a receipt table in the source database.";
  }
  const schema = source?.receipts?.schema ?? (engine === "postgres" ? "synapsor" : "<database_name>");
  const table = source?.receipts?.table ?? "synapsor_writeback_receipts";
  if (engine === "postgres") {
    return `Prepare ${schema}.${table} with "${cliCommandName()} writeback migration --engine postgres --schema ${schema} --table ${table}" and grant it with "${cliCommandName()} writeback grants --engine postgres --schema ${schema} --table ${table} --writer-role <writer_role>", or use runner_ledger/app-owned writeback.`;
  }
  return `Prepare ${schema}.${table} with "${cliCommandName()} writeback migration --engine mysql --schema ${schema} --table ${table}" and grant it with "${cliCommandName()} writeback grants --engine mysql --schema ${schema} --table ${table} --writer-role \\"'<writer>'@'%'\\"", or use runner_ledger/app-owned writeback.`;
}

function capabilityOperation(capability: RunnerCapabilityConfig): "update" | "insert" | "delete" {
  return capability.operation?.kind ?? "update";
}

function formatSourceReceiptMode(source: RunnerSourceConfig | undefined): string {
  const receipts = runnerReceiptConfig(source);
  if (receipts?.authority === "runner_ledger") return "runner_ledger (zero source receipt schema)";
  const provisioning = receipts?.provisioning ?? "precreated";
  const schema = receipts?.schema;
  const table = receipts?.table ?? "synapsor_writeback_receipts";
  return `source_db/${provisioning} (${schema ? `${schema}.` : ""}${table})`;
}

function sourceReceiptModeDoctorCheck(config: RuntimeConfig, sourceName: string, source: RunnerSourceConfig): DoctorCheck {
  const receipts = runnerReceiptConfig(source);
  if (receipts?.authority !== "runner_ledger") {
    return {
      name: `source:${sourceName}:receipt-mode`,
      ok: true,
      level: receipts?.provisioning === "auto_migrate" ? "warn" : "pass",
      message: receipts?.provisioning === "auto_migrate"
        ? `${formatSourceReceiptMode(source)} is active; Runner may execute only its fixed idempotent receipt-table migration and the writer needs CREATE for that table.`
        : `${formatSourceReceiptMode(source)} is active; Runner will not execute source DDL and requires the pre-created table with SELECT/INSERT/UPDATE.`,
    };
  }
  const shared = config.storage?.shared_postgres;
  const local = Boolean(config.storage?.sqlite_path);
  const authoritative = shared?.mode === "runtime_store" || (!shared && local);
  return {
    name: `source:${sourceName}:receipt-mode`,
    ok: authoritative,
    level: authoritative ? "pass" : "fail",
    message: authoritative
      ? `${formatSourceReceiptMode(source)} is active; durable intents use ${shared?.mode === "runtime_store" ? "the authoritative shared Postgres runtime store" : "single-process local SQLite"} and no source receipt DDL/DML is allowed.`
      : "runner_ledger requires single-process local SQLite or storage.shared_postgres.mode runtime_store before source mutation.",
  };
}

async function localDoctorStoreStats(storePath?: string): Promise<LocalDoctorReport["store_stats"]> {
  if (!storePath || storePath === ":memory:") return { path: storePath ?? "not configured", exists: storePath === ":memory:" };
  if (!await fileExists(storePath)) return { path: storePath, exists: false };
  const store = new ProposalStore(storePath);
  try {
    return {
      path: storePath,
      exists: true,
      proposals: store.listProposals({ limit: 1_000_000 }).length,
      evidence: store.listEvidenceBundles({ limit: 1_000_000 }).length,
      query_audit: store.listQueryAudit({ limit: 1_000_000 }).length,
      receipts: store.listReceipts({ limit: 1_000_000 }).length,
    };
  } finally {
    store.close();
  }
}

async function validate(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (target) {
    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    if (isSynapsorContractLike(parsed)) {
      const result = validateContract(parsed);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        process.stdout.write(`contract valid: ${target}\n`);
        for (const warning of result.warnings) process.stdout.write(`warning ${warning.path} ${warning.code}: ${warning.message}\n`);
      } else {
        process.stdout.write(`contract invalid: ${target}\n`);
        for (const error of result.errors) process.stdout.write(`error ${error.path} ${error.code}: ${error.message}\n`);
      }
      return result.ok ? 0 : 1;
    }
  }
  const job = await readJob(args);
  parseWritebackJob(job);
  process.stdout.write("job valid\n");
  return 0;
}

async function revert(args: string[]): Promise<number> {
  const requested = positional(args, 0);
  if (!requested) throw new Error("revert requires an applied proposal id or latest");
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `revert ${requested}`, (bridgeStorePath) => revert(argsWithRuntimeStoreBridge([...args, "--store", bridgeStorePath], bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "revert", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `revert ${requested}`, () => revert(withoutSharedPostgresLedgerMirror(args)), config);
  }
  if (config.mode !== "review") throw new Error(`revert requires review mode, got ${config.mode}`);
  if (storePath !== ":memory:") await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  const store = new ProposalStore(storePath);
  try {
    const proposalId = resolveProposalIdFromStore(requested, store);
    const forward = requireLocalProposal(store, proposalId);
    const capability = findProposalCapability(config, forward);
    if (capabilityWritebackMode(capability) !== "direct_sql") throw new Error(`REVERSAL_APP_EXECUTOR_UNSUPPORTED: ${capability.name} does not use Runner-owned direct SQL writeback`);
    if (capability.reversibility?.mode !== "reviewed_inverse") throw new Error(`REVERSIBILITY_NOT_REVIEWED: capability ${capability.name} does not declare reviewed inverse authority`);
    const trusted = trustedCliContext(config, capability, process.env);
    if (trusted.tenant_id !== forward.tenant_id) throw new Error("REVERSAL_TENANT_MISMATCH: current trusted tenant does not own the forward proposal");
    const forwardPrincipalScope = forward.change_set.guards.principal_scope;
    if (capability.target.principal_scope_key) {
      if (!forwardPrincipalScope?.value || forwardPrincipalScope.column !== capability.target.principal_scope_key) throw new Error("REVERSAL_PRINCIPAL_SCOPE_MISSING: forward proposal does not preserve reviewed principal authority");
      if (String(forwardPrincipalScope.value) !== trusted.principal) throw new Error("REVERSAL_PRINCIPAL_MISMATCH: current trusted principal does not own the forward proposal");
    }
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal: forward, action: "revert", reason: optionalArg(args, "--reason") });
    const receipt = [...store.receipts(forward.proposal_id)].reverse().find((item) => item.status === "applied" || item.status === "already_applied");
    if (!receipt) {
      if (forward.state === "reconciliation_required") throw new Error("REVERSAL_RECONCILIATION_REQUIRED: reconcile the ambiguous forward write before creating a revert proposal");
      throw new Error(`REVERSAL_APPLIED_RECEIPT_REQUIRED: proposal ${forward.proposal_id} has no successful writeback receipt`);
    }
    const inverse = inverseFromStoredReceipt(receipt);
    if (!inverse) throw new Error("REVERSAL_INVERSE_MISSING: the applied receipt predates or did not request reviewed inverse capture");
    if (inverse.availability !== "available") throw new Error(`REVERSAL_UNAVAILABLE: ${inverse.reason_codes.join(", ") || "the receipt has no safe inverse"}`);
    if (inverse.lineage.depth > 16) throw new Error("REVERSAL_CHAIN_DEPTH_EXHAUSTED");
    if (!receipt.receipt.receipt_hash.startsWith("sha256:")) throw new Error("REVERSAL_RECEIPT_INTEGRITY_REQUIRED");
    const forwardReceiptHash = receipt.receipt.receipt_hash as `sha256:${string}`;
    const duplicate = store.listProposals().find((candidate) => candidate.change_set.schema_version === protocolVersions.compensationChangeSet
      && candidate.change_set.compensation.forward_receipt_hash === forwardReceiptHash);
    if (duplicate) throw new Error(`REVERSAL_ALREADY_PROPOSED: ${duplicate.proposal_id} already compensates receipt ${forwardReceiptHash}`);
    const created = createCompensationProposal({ store, forward, receiptHash: forwardReceiptHash, inverse, actor: identity.subject, identity });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    else {
      process.stdout.write([
        `Revert proposal created: ${created.proposal_id}`,
        `Forward proposal: ${forward.proposal_id}`,
        `Forward receipt: ${forwardReceiptHash}`,
        `Operation: ${inverse.operation}`,
        `Rows bounded: ${inverse.members.length} of ${inverse.max_rows}`,
        "Source database changed: no",
        "Approval: required outside MCP",
        "",
        "Next:",
        `  ${cliCommandName()} proposals show ${created.proposal_id} --details --store ${storePath}`,
        `  ${cliCommandName()} proposals approve ${created.proposal_id} --yes --config ${configPath} --store ${storePath}`,
        `  ${cliCommandName()} apply ${created.proposal_id} --config ${configPath} --store ${storePath}`,
        "",
      ].join("\n"));
    }
    return 0;
  } finally {
    store.close();
  }
}

function inverseFromStoredReceipt(receipt: StoredWritebackReceipt): InverseDescriptorV1 | undefined {
  const value = receipt.receipt;
  if (value.schema_version === protocolVersions.executionReceiptV2
    || value.schema_version === protocolVersions.executionReceiptV3
    || value.schema_version === protocolVersions.executionReceiptV4) return value.inverse;
  return undefined;
}

function trustedCliContext(config: RuntimeConfig, capability: RunnerCapabilityConfig, env: NodeJS.ProcessEnv): { tenant_id: string; principal: string } {
  const context = capability.context ? config.contexts?.[capability.context] : config.trusted_context;
  if (!context) throw new Error(`TRUSTED_CONTEXT_MISSING: capability ${capability.name} has no trusted context`);
  const values = context.values ?? {};
  if (context.provider !== "environment" && context.provider !== "static_dev") throw new Error(`TRUSTED_CONTEXT_UNAVAILABLE: ${context.provider} requires a verified MCP/Cloud session and cannot authorize a local CLI revert`);
  const tenantEnv = String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = String(values.principal_env ?? "SYNAPSOR_PRINCIPAL");
  const tenant = context.provider === "environment"
    ? envValue(env, tenantEnv)
    : envValue(env, tenantEnv) ?? (typeof values.tenant_id === "string" ? values.tenant_id.trim() : undefined);
  const principal = context.provider === "environment"
    ? envValue(env, principalEnv)
    : envValue(env, principalEnv) ?? (typeof values.principal === "string" ? values.principal.trim() : undefined);
  if (!tenant || !principal) throw new Error(`TRUSTED_BINDING_MISSING: ${tenantEnv} and ${principalEnv} must resolve before creating a revert proposal`);
  return { tenant_id: tenant, principal };
}

function createCompensationProposal(input: {
  store: ProposalStore;
  forward: StoredProposal;
  receiptHash: `sha256:${string}`;
  inverse: InverseDescriptorV1;
  actor: string;
  identity: { provider: string; verified: boolean; subject: string; roles: string[]; decision_hash: string };
}): StoredProposal {
  const proposalId = `wrp_revert_${crypto.randomBytes(10).toString("hex")}`;
  const evidenceId = `ev_revert_${crypto.randomBytes(10).toString("hex")}`;
  const createdAt = new Date().toISOString();
  const one = input.inverse.members.length === 1 ? input.inverse.members[0] : undefined;
  const before = one ? one.expected_state : { row_count: input.inverse.members.length };
  const patch = one?.restore_values ?? { operation: input.inverse.operation, row_count: input.inverse.members.length };
  const after = input.inverse.operation === "remove_insert"
    ? { row_count: 0 }
    : one?.restore_values ?? { row_count: input.inverse.members.length };
  const evidenceItems = input.inverse.members.map((member) => ({
    schema_version: "synapsor.revert-evidence.v1",
    primary_key: member.primary_key,
    expected_state_digest: hashReceipt(member.expected_state),
    restore_values_digest: hashReceipt(member.restore_values ?? {}),
  }));
  const queryFingerprint = hashReceipt({ forward_receipt_hash: input.receiptHash, inverse: input.inverse });
  const originalApproval = input.forward.change_set.approval;
  const core = {
    schema_version: protocolVersions.compensationChangeSet,
    proposal_id: proposalId,
    proposal_version: 1,
    action: input.forward.action,
    ...(input.forward.change_set.contract ? { contract: input.forward.change_set.contract } : {}),
    mode: "review_required" as const,
    principal: { id: input.actor, source: input.identity.verified ? "trusted_session" as const : "environment" as const },
    scope: { tenant_id: input.forward.tenant_id, business_object: input.forward.business_object, object_id: input.forward.object_id },
    source: {
      kind: input.forward.source_kind === "external_mysql" ? "external_mysql" as const : "external_postgres" as const,
      source_id: input.forward.source_id,
      schema: input.forward.source_schema,
      table: input.forward.source_table,
      primary_key: {
        column: input.inverse.target.primary_key_column,
        ...(one ? { value: one.primary_key.value } : {}),
      },
    },
    before,
    patch,
    after,
    compensation: { descriptor: input.inverse, forward_receipt_hash: input.receiptHash },
    guards: { tenant: input.inverse.tenant_guard, ...(input.inverse.principal_scope ? { principal_scope: input.inverse.principal_scope } : {}), allowed_columns: input.inverse.allowed_columns },
    evidence: { bundle_id: evidenceId, query_fingerprint: queryFingerprint, items: evidenceItems },
    approval: {
      status: "pending" as const,
      mode: originalApproval.mode === "operator" ? "operator" as const : "human" as const,
      ...(originalApproval.required_role ? { required_role: originalApproval.required_role } : {}),
      ...(originalApproval.required_approvals ? { required_approvals: originalApproval.required_approvals } : {}),
    },
    writeback: { status: "not_applied" as const, mode: "trusted_worker_required" as const, executor: "sql_update" as const },
    source_database_mutated: false as const,
    created_at: createdAt,
  };
  const changeSet: CompensationChangeSetV1 = { ...core, integrity: { proposal_hash: hashReceipt(core) } };
  const proposal = input.store.createProposal(changeSet);
  input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceId,
    proposal_id: proposalId,
    tenant_id: input.forward.tenant_id,
    payload: {
      schema_version: "synapsor.revert-evidence.v1",
      capability: input.forward.action,
      principal: input.actor,
      business_object: input.forward.business_object,
      object_id: input.forward.object_id,
      forward_proposal_id: input.forward.proposal_id,
      forward_receipt_hash: input.receiptHash,
      requested_by: { provider: input.identity.provider, verified: input.identity.verified, subject: input.identity.subject, roles: input.identity.roles, decision_hash: input.identity.decision_hash },
    },
    items: evidenceItems,
  });
  input.store.replay(proposalId);
  return proposal;
}

async function apply(args: string[]): Promise<number> {
  if (args.includes("--all-approved")) return applyAllApproved(args);
  const directProposalId = positional(args, 0);
  const proposalId = optionalArg(args, "--proposal") ?? (directProposalId && !directProposalId.endsWith(".json") ? directProposalId : undefined);
  if (proposalId) return applyProposal(args, proposalId);

  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const configPath = optionalArg(args, "--config") ?? (await fileExists("synapsor.runner.json") ? "synapsor.runner.json" : undefined);
  const runtimeConfig = configPath ? await optionalRuntimeConfig(configPath) : undefined;
  if (!dryRun) assertLocalGovernanceMutationAllowed(runtimeConfig, "apply --job");
  if (runtimeConfig && runtimeStoreBridgeRequired(args, runtimeConfig)) {
    return withSharedPostgresRuntimeStoreBridge(args, runtimeConfig, "apply --job", (bridgeStorePath) => apply(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(runtimeConfig, "apply --job", args);
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  const mirrorStorePath = storePath ?? runtimeConfig?.storage?.sqlite_path;
  if (mirrorStorePath && sharedPostgresLedgerMirrorRequested(args, runtimeConfig)) {
    return withSharedPostgresLedgerMirror(args, mirrorStorePath, "apply --job", () => apply(withoutSharedPostgresLedgerMirror(args)), runtimeConfig);
  }

  const raw = await readJob(args);
  const job = parseWritebackJob(raw);
  if (configPath) {
    if (!dryRun && !storePath) {
      throw new Error("local config writeback apply requires --store so proposal approval and digest can be verified");
    }
    await verifyLocalWritebackAuthority(job, configPath, storePath);
    await authorizeConfiguredJobApply(args, job, configPath, storePath);
  }
  const databaseUrl = configPath
    ? await resolveSqlWriteDatabaseUrl(job, configPath, process.env)
    : process.env.SYNAPSOR_DATABASE_URL || "";
  const config: RunnerConfig = {
    controlPlaneUrl: process.env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: process.env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: process.env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: process.env.SYNAPSOR_SOURCE_ID || job.source_id,
    databaseUrl,
    engine: job.engine,
    pollIntervalMs: Number(process.env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    statementTimeoutMs: writebackTimeoutMs(runtimeConfig?.sources?.[job.source_id], process.env),
    logLevel: (process.env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: process.env.SYNAPSOR_STATE_DIR || "./state",
    receipts: runnerReceiptConfig(runtimeConfig?.sources?.[job.source_id]),
  };
  let localStore: ProposalStore | undefined;
  if (storePath) {
    if (storePath !== ":memory:") {
      await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
    }
    localStore = new ProposalStore(storePath);
  }
  const intentAuthority = createWritebackIntentAuthority(runtimeConfig, job.source_id, process.env, localStore);
  if (intentAuthority.store) config.writebackIntentStore = intentAuthority.store;
  let result: WritebackResult;
  try {
    result = await adapters[job.engine].apply(job, config);
    localStore?.recordExecutionReceipt(toExecutionReceipt(job, result, config.dryRun));
  } finally {
    await intentAuthority.close();
    localStore?.close();
  }
  operationalLog("info", "writeback_outcome", {
    proposal_id: job.proposal_id,
    tenant: logIdentifier(job.target.tenant_guard.value),
    source: job.source_id,
    runner_id: config.runnerId,
    executor: "sql_update",
    status: writebackResultStatus(result),
    rows_affected: writebackAffectedRows(result),
    error_code: writebackErrorCode(result),
    dry_run: dryRun,
    source_database_changed: writebackResultStatus(result) === "applied" && !dryRun && writebackAffectedRows(result) > 0,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "failed" || result.status === "reconciliation_required" ? 1 : 0;
}

async function authorizeConfiguredJobApply(
  args: string[],
  job: WritebackJob,
  configPath: string,
  storePath: string | undefined,
): Promise<void> {
  const config = await readRuntimeConfig(configPath);
  if (!config.operator_identity) return;
  if (!storePath) {
    throw new Error("operator_identity requires --store for apply so the signed authorization can be bound to the proposal ledger");
  }
  const store = new ProposalStore(storePath);
  try {
    const proposal = requireLocalProposal(store, job.proposal_id);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "apply" });
    store.recordOperatorAuthorization(job.proposal_id, identity, config.operator_identity.provider !== "dev_env");
    operationalLog("info", "operator_decision", {
      action: "apply",
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant: proposal.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: config.operator_identity.apply_roles?.join(",") || undefined,
    });
  } finally {
    store.close();
  }
}

type BatchApplyResult = {
  proposal_id: string;
  capability: string;
  tenant: string;
  status: "applied" | "conflict" | "skipped";
  detail: string;
};

async function applyAllApproved(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    throw new Error("apply --all-approved requires --yes because it can commit multiple approved proposals");
  }
  if (positional(args, 0)) throw new Error("apply --all-approved does not accept a proposal id or --job");
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "apply --all-approved");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, "apply --all-approved", (bridgeStorePath) => applyAllApproved(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "apply --all-approved", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, "apply --all-approved", () => applyAllApproved(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const capability = optionalArg(args, "--capability");
  const tenant = optionalArg(args, "--tenant");
  const max = optionalPositiveIntegerArg(args, "--max");
  const store = new ProposalStore(storePath);
  let selected: StoredProposal[];
  try {
    const filters = { capability, tenant };
    selected = [
      ...store.listProposals({ ...filters, state: "approved" }),
      ...store.listProposals({ ...filters, state: "pending_worker" }),
    ]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, max ?? Number.POSITIVE_INFINITY);
  } finally {
    store.close();
  }

  const results: BatchApplyResult[] = [];
  for (const proposal of selected) {
    try {
      await applyProposal([
        proposal.proposal_id,
        "--config", configPath,
        "--store", storePath,
        "--yes",
        "--batch-quiet",
        ...(args.includes("--dry-run") ? ["--dry-run"] : []),
        ...(optionalArg(args, "--runner") ? ["--runner", optionalArg(args, "--runner")!] : []),
        ...(optionalArg(args, "--project") ? ["--project", optionalArg(args, "--project")!] : []),
        ...(optionalArg(args, "--lease-seconds") ? ["--lease-seconds", optionalArg(args, "--lease-seconds")!] : []),
        ...(optionalArg(args, "--identity") ? ["--identity", optionalArg(args, "--identity")!] : []),
        ...(optionalArg(args, "--identity-key") ? ["--identity-key", optionalArg(args, "--identity-key")!] : []),
        ...(optionalArg(args, "--actor") ? ["--actor", optionalArg(args, "--actor")!] : []),
        ...(args.includes(runtimeStoreBridgeFlag) ? [runtimeStoreBridgeFlag] : []),
      ], proposal.proposal_id);
      const afterStore = new ProposalStore(storePath);
      try {
        const after = afterStore.getProposal(proposal.proposal_id);
        const status = after?.state === "conflict" ? "conflict" : after?.state === "applied" ? "applied" : "skipped";
        results.push({
          proposal_id: proposal.proposal_id,
          capability: proposal.action,
          tenant: proposal.tenant_id,
          status,
          detail: after
            ? status === "skipped"
              ? `not applied; proposal remained ${after.state}`
              : `proposal state: ${after.state}`
            : "not applied; proposal no longer exists",
        });
      } finally {
        afterStore.close();
      }
    } catch (error) {
      operationalLog("warn", "writeback_outcome", {
        proposal_id: proposal.proposal_id,
        capability: proposal.action,
        tenant: proposal.tenant_id,
        status: "skipped",
        error_code: safeOperationalErrorCode(error),
        source_database_changed: false,
      });
      results.push({
        proposal_id: proposal.proposal_id,
        capability: proposal.action,
        tenant: proposal.tenant_id,
        status: "skipped",
        detail: safeErrorMessage(error),
      });
    }
  }

  const summary = {
    selected: selected.length,
    applied: results.filter((result) => result.status === "applied").length,
    conflict: results.filter((result) => result.status === "conflict").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    filters: { capability: capability ?? null, tenant: tenant ?? null, max: max ?? null },
    results,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatBatchApplySummary(summary));
  }
  return summary.skipped > 0 ? 1 : 0;
}

function formatBatchApplySummary(summary: {
  selected: number;
  applied: number;
  conflict: number;
  skipped: number;
  results: BatchApplyResult[];
}): string {
  const lines = [
    "Synapsor approved proposal batch",
    "",
    ...summary.results.map((result) => `${result.status.toUpperCase()} ${result.proposal_id}  ${result.capability}  tenant=${result.tenant}  ${result.detail}`),
    ...(summary.results.length === 0 ? ["No approved or pending-worker proposals matched."] : []),
    "",
    `Summary: ${summary.applied} applied / ${summary.conflict} conflict / ${summary.skipped} skipped (${summary.selected} selected)`,
    "",
  ];
  return lines.join("\n");
}

async function applyProposal(args: string[], proposalId: string): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const dryRun = args.includes("--dry-run") || process.env.SYNAPSOR_DRY_RUN === "true";
  const runnerId = optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner";
  const workerAttempt = Number(optionalArg(args, "--worker-attempt") ?? "1");
  const config = await readRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "apply");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `apply ${proposalId}`, (bridgeStorePath) => applyProposal(argsWithRuntimeStoreBridge(args, bridgeStorePath), proposalId));
  }
  assertNoRuntimeStoreForLocalMutation(config, "apply", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `apply ${proposalId}`, () => applyProposal(withoutSharedPostgresLedgerMirror(args), proposalId), config);
  }
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
    await verifyStoredApprovalAuthority(config, configPath, store, proposal, capability);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "apply" });
    store.recordOperatorAuthorization(resolvedProposalId, identity, Boolean(config.operator_identity && config.operator_identity.provider !== "dev_env"));
    operationalLog("info", "operator_decision", {
      action: "apply",
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant: proposal.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: config.operator_identity?.apply_roles?.join(",") || undefined,
    });
    const proposalScope = proposal.change_set.guards.principal_scope;
    if (capability.target.principal_scope_key) {
      if (!proposalScope || proposalScope.column !== capability.target.principal_scope_key || proposalScope.value === undefined) {
        throw new Error(`proposal ${proposal.proposal_id} is missing its reviewed principal scope`);
      }
      if (proposalScope.provider === "environment" || proposalScope.provider === "static_dev") {
        const current = trustedCliContext(config, capability, process.env);
        if (current.tenant_id !== proposal.tenant_id || current.principal !== String(proposalScope.value)) {
          throw new Error("current trusted tenant/principal cannot apply this proposal");
        }
      }
    } else if (proposalScope) {
      throw new Error(`proposal ${proposal.proposal_id} carries unreviewed principal scope`);
    }
    const executorName = proposalExecutorName(proposal, capability);
    if (executorName === "none" || executorName === "cloud_worker") {
      throw new Error(`proposal ${resolvedProposalId} is not locally applyable; capability ${capability.name} declares ${executorName === "none" ? "no local writeback" : "cloud-worker writeback"}.`);
    }
    if (executorName === "sql_update") {
      const job = store.createWritebackJobFromProposal(resolvedProposalId, {
        project_id: optionalArg(args, "--project") ?? "local",
        runner_id: runnerId,
        lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
        attempt: workerAttempt,
      });
      const result = await applySqlJob(job, configPath, storePath, dryRun, envWithDemoDefaults(config, configPath));
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!args.includes("--batch-quiet")) process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : formatApplyResult(parseWritebackJob(job), result, dryRun, storePath));
      return result.status === "failed" || result.status === "reconciliation_required" ? 1 : 0;
    }
    const executor = executorConfig(config, executorName);
    if (executor.type === "http_handler") {
      const result = await applyHttpHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, workerAttempt, env: envWithDemoDefaults(config, configPath) });
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!args.includes("--batch-quiet")) process.stdout.write(args.includes("--json") ? `${JSON.stringify(redactConfig(result), null, 2)}\n` : formatHandlerApplyResult(result, resolvedProposalId, storePath));
      return result.status === "failed" ? 1 : 0;
    }
    if (executor.type === "command_handler") {
      const result = await applyCommandHandlerProposal({ store, proposalId: resolvedProposalId, proposal, executorName, executor, runnerId, dryRun, workerAttempt, env: envWithDemoDefaults(config, configPath) });
      logProposalWritebackOutcome(proposal, runnerId, executorName, result, dryRun);
      if (!args.includes("--batch-quiet")) process.stdout.write(args.includes("--json") ? `${JSON.stringify(redactConfig(result), null, 2)}\n` : formatHandlerApplyResult(result, resolvedProposalId, storePath));
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
  const runtimeConfig = await readRuntimeConfig(configPath);
  const databaseUrl = await resolveSqlWriteDatabaseUrl(parsedJob, configPath, env);
  const config: RunnerConfig = {
    controlPlaneUrl: env.SYNAPSOR_CONTROL_PLANE_URL || "http://localhost:8000",
    runnerToken: env.SYNAPSOR_RUNNER_TOKEN || "local-dry-run-token",
    runnerId: env.SYNAPSOR_RUNNER_ID || "local-runner",
    sourceId: env.SYNAPSOR_SOURCE_ID || parsedJob.source_id,
    databaseUrl,
    engine: parsedJob.engine,
    pollIntervalMs: Number(env.SYNAPSOR_POLL_INTERVAL_MS || "5000"),
    statementTimeoutMs: writebackTimeoutMs(runtimeConfig.sources?.[parsedJob.source_id], env),
    logLevel: (env.SYNAPSOR_LOG_LEVEL || "info") as RunnerConfig["logLevel"],
    dryRun,
    stateDir: env.SYNAPSOR_STATE_DIR || "./state",
    receipts: runnerReceiptConfig(runtimeConfig.sources?.[parsedJob.source_id]),
  };
  const store = storePath ? new ProposalStore(storePath) : undefined;
  const intentAuthority = createWritebackIntentAuthority(runtimeConfig, parsedJob.source_id, env, store);
  if (config.receipts?.authority === "runner_ledger" && !intentAuthority.store) throw new Error("runner_ledger receipt authority requires --store or an authoritative shared runtime store");
  if (intentAuthority.store) config.writebackIntentStore = intentAuthority.store;
  try {
    const result = await adapters[parsedJob.engine].apply(parsedJob, config);
    store?.recordExecutionReceipt(toExecutionReceipt(parsedJob, result, config.dryRun));
    return result;
  } finally {
    await intentAuthority.close();
    store?.close();
  }
}

function createWritebackIntentAuthority(
  config: RuntimeConfig | undefined,
  sourceId: string,
  env: NodeJS.ProcessEnv,
  localStore: ProposalStore | undefined,
): { store?: WritebackIntentStore; close(): Promise<void> } {
  if (runnerReceiptConfig(config?.sources?.[sourceId])?.authority !== "runner_ledger") return { close: async () => undefined };
  const shared = config?.storage?.shared_postgres;
  if (shared?.mode === "runtime_store") {
    const databaseUrl = envValue(env, shared.url_env);
    if (!databaseUrl) throw new Error(`${shared.url_env} is required for authoritative runner_ledger intents`);
    const store = new PostgresWritebackIntentStore({
      pool: createPostgresPool(databaseUrl),
      schema: shared.schema ?? "synapsor_runner",
      autoMigrate: true,
      closePool: true,
    });
    return { store, close: () => store.close() };
  }
  return { store: localStore, close: async () => undefined };
}

function runnerReceiptConfig(source: RunnerSourceConfig | undefined): RunnerConfig["receipts"] {
  const receipts = source?.receipts;
  if (!receipts) return { authority: "source_db", provisioning: "precreated" };
  return receipts.authority === "runner_ledger"
    ? { authority: "runner_ledger" }
    : {
      authority: "source_db",
      provisioning: receipts.provisioning ?? "precreated",
      schema: receipts.schema,
      table: receipts.table,
    };
}

function writebackTimeoutMs(source: RunnerSourceConfig | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (source?.statement_timeout_ms !== undefined) return source.statement_timeout_ms;
  const raw = envValue(env, "SYNAPSOR_WRITEBACK_TIMEOUT_MS");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("SYNAPSOR_WRITEBACK_TIMEOUT_MS must be a positive integer");
  return parsed;
}

export async function resolveSqlWriteDatabaseUrl(job: WritebackJob, configPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const config = await readRuntimeConfig(configPath);
  const source = config.sources?.[job.source_id];
  const writeUrlEnv = source?.write_url_env;
  if (writeUrlEnv) {
    const value = envValue(env, writeUrlEnv);
    if (value) return value;
  }
  return envValue(env, "SYNAPSOR_DATABASE_URL") || "";
}

type HttpHandlerExecutor = {
  type: "http_handler";
  url_env: string;
  method?: "POST" | "PUT" | "PATCH";
  auth?: { type: "bearer_env"; token_env: string };
  signing_secret_env?: string;
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
    return capabilityWritebackMode(capability) === "direct_sql";
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
  const mode = capabilityWritebackMode(capability);
  if (mode === "none") return "none";
  if (mode === "cloud_worker") return "cloud_worker";
  if (mode === "direct_sql") return "sql_update";
  const writeback = proposal.change_set.writeback as { executor?: unknown };
  return capabilityWritebackExecutor(capability) ?? (typeof writeback.executor === "string" ? writeback.executor : undefined) ?? "sql_update";
}

function executorConfig(config: RuntimeConfig, executorName: string): LocalExecutor {
  const raw = config.executors?.[executorName];
  if (!isRecord(raw)) throw new Error(`executor ${executorName} is not configured`);
  if (raw.type === "http_handler") return raw as HttpHandlerExecutor;
  if (raw.type === "command_handler") return raw as CommandHandlerExecutor;
  if (raw.type === "sql_update") return { type: "sql_update" };
  throw new Error(`executor ${executorName} has unsupported type`);
}

function signHandlerRequestBody(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function applyHttpHandlerProposal(input: {
  store: ProposalStore;
  proposalId: string;
  proposal: StoredProposal;
  executorName: string;
  executor: HttpHandlerExecutor;
  runnerId: string;
  dryRun: boolean;
  workerAttempt: number;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId, input.workerAttempt);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const url = envValue(input.env, input.executor.url_env);
  if (!url) throw new Error(`${input.executor.url_env} is not set`);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": prepared.request.idempotency_key,
  };
  if (input.executor.auth) {
    const token = envValue(input.env, input.executor.auth.token_env);
    if (!token) throw new Error(`${input.executor.auth.token_env} is not set`);
    headers.authorization = `Bearer ${token}`;
  }
  const issuedAt = new Date().toISOString();
  const requestBody = JSON.stringify({
    protocol_version: "1.0",
    ...prepared.request,
    issued_at: issuedAt,
    executor: input.executorName,
    dry_run: input.dryRun,
  });
  headers["x-synapsor-issued-at"] = issuedAt;
  headers["x-synapsor-proposal-id"] = prepared.proposal.proposal_id;
  if (input.executor.signing_secret_env) {
    const signingSecret = envValue(input.env, input.executor.signing_secret_env);
    if (!signingSecret) throw new Error(`${input.executor.signing_secret_env} is not set`);
    headers["x-synapsor-signature"] = signHandlerRequestBody(requestBody, signingSecret);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, input.executor.timeout_ms ?? 5000));
  let receipt: ExecutionReceiptV1;
  try {
    const response = await fetch(url, {
      method: input.executor.method ?? "POST",
      headers,
      body: requestBody,
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
  workerAttempt: number;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutionReceiptV1> {
  const duplicate = duplicateHandlerReceipt(input.store, input.proposalId);
  if (duplicate) return alreadyAppliedReceipt(duplicate.receipt, input.runnerId);
  const prepared = prepareHandlerProposal(input.store, input.proposal, input.runnerId, input.workerAttempt);
  input.store.recordHandlerWritebackJob({
    writeback_job_id: prepared.request.writeback_job_id,
    proposal_id: prepared.proposal.proposal_id,
    proposal_hash: prepared.proposal.proposal_hash,
    runner_id: input.runnerId,
    executor: input.executorName,
    request: prepared.request,
  });
  const commandText = envValue(input.env, input.executor.command_env);
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

function prepareHandlerProposal(store: ProposalStore, proposal: StoredProposal, runnerId: string, workerAttempt = 1): {
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
  const writebackJobId = `hwb_${prepared.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}${workerAttempt > 1 ? `_a${workerAttempt}` : ""}`;
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
      ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
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
  const existing = receipts.find((receipt) => receipt.writeback_job_id.startsWith("hwb_") && (receipt.status === "applied" || receipt.status === "already_applied"));
  if (!existing || existing.receipt.schema_version !== protocolVersions.executionReceipt) return undefined;
  return { receipt: existing.receipt };
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

function formatApplyResult(job: WritebackJob, result: WritebackResult, dryRun: boolean, storePath: string): string {
  const status = writebackResultStatus(result);
  const affectedRows = writebackAffectedRows(result);
  const errorCode = writebackErrorCode(result);
  const receiptHash = writebackReceiptHash(result);
  const conflictGuardPassed = status === "conflict" && errorCode === "VERSION_CONFLICT" ? "no" : status === "applied" ? "yes" : "not completed";
  const title = status === "conflict"
    ? "Guarded writeback returned conflict."
    : status === "failed"
      ? "Guarded writeback failed."
      : dryRun
        ? "Guarded writeback dry run passed."
        : affectedRows === 0
          ? "Guarded writeback already applied."
          : "Guarded writeback applied.";
  const lines = [
    title,
    "",
    "Checks:",
    "* proposal approved: yes",
    `* primary key matched: ${status === "conflict" && errorCode === "ROW_NOT_FOUND" ? "no" : status === "failed" ? "not completed" : "yes"}`,
    `* tenant guard matched: ${status === "conflict" && errorCode === "ROW_NOT_FOUND" ? "no" : status === "failed" ? "not completed" : "yes"}`,
    "* allowed columns only: yes",
    `* conflict guard passed: ${conflictGuardPassed}`,
    `* affected rows: ${affectedRows}`,
    `* idempotency key: ${job.idempotency_key}`,
    "",
  ];
  if (status === "conflict") {
    lines.push(
      errorCode === "VERSION_CONFLICT" ? "The row changed after the agent saw it." : "The target row was not available under the primary-key and tenant guard.",
      "",
      "Result:",
      "conflict",
      "",
      "Source DB changed by Synapsor:",
      "no",
      "",
      "Why:",
      errorCode === "VERSION_CONFLICT" ? "conflict/version guard did not match" : errorCode || "guarded writeback returned conflict",
      "",
      "Next:",
      "Re-inspect the current source row and create a fresh proposal. The conflicted proposal and receipt remain in replay history.",
      "",
    );
  }
  if (status === "failed") {
    lines.push("Error:", errorCode || "writeback failed", "");
  }
  lines.push(
    "Receipt:",
    receiptHash || "(stored locally)",
    "",
    "Replay:",
    `${cliCommandName()} replay ${job.proposal_id} --store ${storePath}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatHandlerApplyResult(receipt: ExecutionReceiptV1, proposalId: string, storePath: string): string {
  const title = receipt.status === "conflict"
    ? "App-owned writeback returned conflict."
    : receipt.status === "failed"
      ? "App-owned writeback failed."
      : receipt.status === "already_applied"
        ? "App-owned writeback already applied."
        : "App-owned writeback applied.";
  const lines = [
    title,
    "",
    "Checks:",
    "* proposal approved: yes",
    "* execution authority: app-owned handler outside MCP",
    `* source database changed by handler: ${receipt.source_database_mutated ? "yes" : "no"}`,
    `* affected rows: ${receipt.rows_affected}`,
    `* idempotency key: ${receipt.idempotency_key}`,
    "",
  ];
  if (receipt.status === "conflict") {
    lines.push(
      "Result:",
      "conflict",
      "",
      "Why:",
      receipt.safe_error_code || "handler returned conflict",
      "",
    );
  }
  if (receipt.status === "failed") {
    lines.push("Error:", receipt.safe_error_code || "handler writeback failed", "");
  }
  lines.push(
    "Receipt:",
    receipt.receipt_hash,
    "",
    "Replay:",
    `${cliCommandName()} replay ${proposalId} --store ${storePath}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function writebackResultStatus(result: WritebackResult | ExecutionReceiptV1): string {
  return String((result as { status?: unknown }).status ?? "unknown");
}

function writebackAffectedRows(result: WritebackResult | ExecutionReceiptV1): number {
  const value = (result as { affected_rows?: unknown; rows_affected?: unknown }).affected_rows
    ?? (result as { affected_rows?: unknown; rows_affected?: unknown }).rows_affected
    ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function writebackErrorCode(result: WritebackResult | ExecutionReceiptV1): string | undefined {
  const value = (result as { error_code?: unknown; safe_error_code?: unknown }).error_code
    ?? (result as { error_code?: unknown; safe_error_code?: unknown }).safe_error_code;
  return typeof value === "string" && value ? value : undefined;
}

function writebackReceiptHash(result: WritebackResult | ExecutionReceiptV1): string | undefined {
  const value = (result as { result_hash?: unknown; receipt_hash?: unknown }).result_hash
    ?? (result as { result_hash?: unknown; receipt_hash?: unknown }).receipt_hash;
  return typeof value === "string" && value ? value : undefined;
}

function logProposalWritebackOutcome(
  proposal: StoredProposal,
  runnerId: string,
  executor: string,
  result: WritebackResult | ExecutionReceiptV1,
  dryRun: boolean,
): void {
  const status = writebackResultStatus(result);
  const rowsAffected = writebackAffectedRows(result);
  operationalLog(status === "failed" ? "error" : status === "conflict" ? "warn" : "info", "writeback_outcome", {
    proposal_id: proposal.proposal_id,
    capability: proposal.action,
    tenant: proposal.tenant_id,
    runner_id: runnerId,
    executor,
    status,
    rows_affected: rowsAffected,
    error_code: writebackErrorCode(result),
    receipt_hash: writebackReceiptHash(result),
    dry_run: dryRun,
    source_database_changed: status === "applied" && !dryRun && rowsAffected > 0,
  });
}

function operationalLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  const safeFields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") safeFields[key] = logIdentifier(value);
    else if (typeof value === "number" && Number.isFinite(value)) safeFields[key] = value;
    else if (typeof value === "boolean") safeFields[key] = value;
  }
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  })}\n`);
}

function logIdentifier(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200 || /[\r\n\u0000-\u001f]/.test(text)) return "<redacted>";
  return text;
}

function safeOperationalErrorCode(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return code && /^[A-Z][A-Z0-9_:-]{1,79}$/.test(code) ? code : "COMMAND_REJECTED";
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

export async function verifyLocalWritebackAuthority(
  job: WritebackJob,
  configPath: string,
  storePath?: string,
  options: { cloudApproved?: boolean } = {},
): Promise<void> {
  const config = await readRuntimeConfig(configPath);
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
  const proposalCapabilities = (config.capabilities ?? []).filter((capability) => capability.kind === "proposal" && capability.source === job.source_id && capabilityWritebackMode(capability) === "direct_sql");
  const matching = proposalCapabilities.find((capability) => capabilityMatchesJob(capability, job));
  if (!matching) {
    throw new Error("writeback job does not match any reviewed proposal capability in local config");
  }
  const reviewedPrincipalColumn = matching.target.principal_scope_key;
  const jobPrincipalScope = job.target.principal_scope;
  if (reviewedPrincipalColumn) {
    if (!jobPrincipalScope || jobPrincipalScope.column !== reviewedPrincipalColumn) {
      throw new Error("writeback job is missing or changes the reviewed principal scope");
    }
  } else if (jobPrincipalScope) {
    throw new Error("writeback job adds principal scope not present in the reviewed capability");
  }
  if (options.cloudApproved) {
    const leasedContract = "contract" in job ? job.contract : undefined;
    if (!leasedContract?.digest) throw new Error("Cloud writeback job is missing its immutable contract digest");
    if (!matching.contract_provenance || matching.contract_provenance.digest !== leasedContract.digest) {
      throw new Error("Cloud writeback job contract digest does not match the reviewed local contract");
    }
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
      const allowedStates = options.cloudApproved
        ? new Set(["pending_review", "approved", "pending_worker", "applied"])
        : new Set(["approved", "pending_worker", "applied"]);
      if (!allowedStates.has(proposal.state)) {
        throw new Error(`local proposal ${job.proposal_id} is ${proposal.state}, not eligible for ${options.cloudApproved ? "Cloud-approved" : "local-approved"} writeback`);
      }
      if (proposal.proposal_hash !== job.approval_id) {
        throw new Error("writeback approval/proposal digest does not match local proposal");
      }
      const proposalPrincipalScope = proposal.change_set.guards.principal_scope;
      if (reviewedPrincipalColumn) {
        if (!proposalPrincipalScope || proposalPrincipalScope.column !== reviewedPrincipalColumn || proposalPrincipalScope.value === undefined) {
          throw new Error("local proposal is missing its immutable principal scope");
        }
        if (!jobPrincipalScope || jobPrincipalScope.value_fingerprint !== proposalPrincipalScope.value_fingerprint
          || jobPrincipalScope.binding !== proposalPrincipalScope.binding
          || jobPrincipalScope.provider !== proposalPrincipalScope.provider) {
          throw new Error("writeback principal scope does not match the immutable local proposal");
        }
        if (jobPrincipalScope.value !== undefined && jobPrincipalScope.value !== proposalPrincipalScope.value) {
          throw new Error("writeback principal scope value does not match the immutable local proposal");
        }
        jobPrincipalScope.value = proposalPrincipalScope.value;
        if (!options.cloudApproved && (proposalPrincipalScope.provider === "environment" || proposalPrincipalScope.provider === "static_dev")) {
          const current = trustedCliContext(config, matching, process.env);
          if (current.tenant_id !== proposal.tenant_id || current.principal !== String(proposalPrincipalScope.value)) {
            throw new Error("current trusted tenant/principal cannot apply this proposal");
          }
        }
      } else if (proposalPrincipalScope) {
        throw new Error("local proposal carries principal scope outside the reviewed capability");
      }
      if (!options.cloudApproved) await verifyStoredApprovalAuthority(config, configPath, store, proposal, matching);
    } finally {
      store.close();
    }
  }
}

async function verifyStoredApprovalAuthority(
  config: RuntimeConfig,
  configPath: string,
  store: ProposalStore,
  proposal: StoredProposal,
  capability: NonNullable<RuntimeConfig["capabilities"]>[number],
): Promise<void> {
  if (!config.operator_identity || config.operator_identity.provider === "dev_env") return;
  const approval = [...store.approvals(proposal.proposal_id)]
    .reverse()
    .find((item) => item.status === "approved" && item.proposal_hash === proposal.proposal_hash && item.proposal_version === proposal.proposal_version);
  if (!approval) throw new Error(`proposal ${proposal.proposal_id} has no approval matching its immutable hash and version`);

  const reviewedPolicy = capability.approval?.mode === "policy" ? capability.approval.policy : undefined;
  if (reviewedPolicy && approval.approver === `policy:${reviewedPolicy}`) return;

  const identity = approval.identity;
  if (!identity || identity.provider !== config.operator_identity.provider || !identity.verified) {
    throw new Error(`proposal ${proposal.proposal_id} does not have a verified ${config.operator_identity.provider} human approval`);
  }
  if (
    approval.approver !== identity.subject
    || approval.decision_hash !== identity.decision_hash
    || approval.signature !== identity.signature
    || approval.integrity_hash !== identity.integrity_hash
    || identity.decision.action !== "approve"
    || identity.decision.proposal_id !== proposal.proposal_id
    || identity.decision.proposal_hash !== proposal.proposal_hash
    || identity.decision.proposal_version !== proposal.proposal_version
  ) {
    throw new Error(`proposal ${proposal.proposal_id} approval identity record failed integrity checks`);
  }
  const requiredRole = capability.approval?.required_role;
  if (requiredRole && !identity.roles.includes(requiredRole)) {
    throw new Error(`approval operator ${identity.subject} lacks required role ${requiredRole}`);
  }
  if (identity.provider === "signed_key") {
    const operator = config.operator_identity.operators?.[identity.subject];
    if (!operator) throw new Error(`approval operator ${identity.subject} is no longer registered`);
    if (requiredRole && !operator.roles.includes(requiredRole)) throw new Error(`approval operator ${identity.subject} lacks currently registered role ${requiredRole}`);
    const publicKeyPath = path.resolve(path.dirname(path.resolve(configPath)), operator.public_key_path);
    const publicKey = await fs.readFile(publicKeyPath, "utf8");
    if (!verifySignedOperatorProof(identity, publicKey)) {
      throw new Error(`proposal ${proposal.proposal_id} approval signature verification failed`);
    }
  } else {
    const secretEnv = config.operator_identity.attestation_secret_env ?? "SYNAPSOR_OPERATOR_ATTESTATION_SECRET";
    const secret = trimmedEnvValue(process.env, secretEnv);
    if (!secret || Buffer.byteLength(secret) < 32 || !verifyJwtOperatorProof(identity, secret)) {
      throw new Error(`proposal ${proposal.proposal_id} approval attestation verification failed`);
    }
  }
}

function capabilityMatchesJob(capability: NonNullable<RuntimeConfig["capabilities"]>[number], job: WritebackJob): boolean {
  if (capability.target.schema !== job.target.schema) return false;
  if (capability.target.table !== job.target.table) return false;
  if (capability.target.primary_key !== job.target.primary_key.column) return false;
  if (!capability.target.tenant_key || capability.target.tenant_key !== job.target.tenant_guard.column) return false;
  if ((capability.target.principal_scope_key ?? undefined) !== (job.target.principal_scope?.column ?? undefined)) return false;
  const reviewedOperation = capability.operation?.kind ?? "update";
  if (job.protocol_version === protocolVersions.normalizedWritebackJobV4) {
    if (capability.reversibility?.mode !== "reviewed_inverse") return false;
    const originalOperation = job.operation === "restore_update" ? "update" : "insert";
    if (reviewedOperation !== originalOperation) return false;
    if ((capability.operation?.cardinality ?? "single") !== job.compensation.cardinality) return false;
    if (job.compensation.cardinality === "set" && capability.operation?.max_rows !== job.compensation.max_rows) return false;
    if (reviewedOperation === "update" && (
      capability.operation?.version_advance?.column !== job.compensation.version_advance?.column
      || capability.operation?.version_advance?.strategy !== job.compensation.version_advance?.strategy
    )) return false;
    const reviewedAllowed = new Set(capability.allowed_columns ?? []);
    return job.allowed_columns.every((column) => reviewedAllowed.has(column));
  }
  const setJob = job.protocol_version === protocolVersions.normalizedWritebackJobV3;
  const jobOperation = (job.operation ?? "single_row_update").replace("single_row_", "").replace("set_", "").replace("batch_", "");
  if (reviewedOperation !== jobOperation) return false;
  if ((capability.operation?.cardinality === "set") !== setJob) return false;
  const reviewedAllowed = new Set(capability.allowed_columns ?? []);
  if (reviewedOperation !== "delete" && reviewedAllowed.size === 0) return false;
  if (reviewedOperation === "delete" && (reviewedAllowed.size !== 0 || Object.keys(job.patch).length !== 0)) return false;
  if (reviewedOperation === "insert") {
    const reviewedDedup = capability.operation?.deduplication?.components ?? [];
    if (setJob) {
      if (reviewedDedup.length < 1 || job.frozen_set.members.some((member) => {
        const resolved = member.deduplication?.components ?? [];
        return reviewedDedup.length !== resolved.length || reviewedDedup.some((component) => !resolved.some((item) => item.column === component.column));
      })) return false;
    } else {
      if (job.protocol_version !== protocolVersions.normalizedWritebackJobV2 || !job.deduplication) return false;
      if (reviewedDedup.length !== job.deduplication.components.length) return false;
      for (const component of reviewedDedup) {
        if (!job.deduplication.components.some((resolved) => resolved.column === component.column && resolved.source === component.source)) return false;
      }
    }
  }
  if (setJob) {
    if (capability.operation?.max_rows !== job.frozen_set.max_rows) return false;
    const reviewedBounds = capability.operation?.aggregate_bounds ?? [];
    if (reviewedBounds.length !== job.frozen_set.aggregate_bounds.length) return false;
    for (const bound of reviewedBounds) {
      if (!job.frozen_set.aggregate_bounds.some((resolved) => resolved.column === bound.column && resolved.measure === bound.measure && resolved.maximum === bound.maximum)) return false;
    }
    if (reviewedOperation === "update" && (
      capability.operation?.version_advance?.column !== job.version_advance?.column
      || capability.operation?.version_advance?.strategy !== job.version_advance?.strategy
    )) return false;
  }
  return Object.keys(job.patch).every((column) => reviewedAllowed.has(column));
}

async function start(args: string[] = []): Promise<number> {
  if (args.includes("--from-env") || args.includes("--schema") || args.includes("--mode") || args.includes("--engine")) {
    if (args.length > 0) {
      return onboard(["db", ...args]);
    }
  }
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

async function up(args: string[] = []): Promise<number> {
  const allowed = new Set([
    "--config",
    "--store",
    "--transport",
    "--serve",
    "--with-handler",
    "--host",
    "--port",
    "--auth-token-env",
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
    "--allow-concurrent-store",
  ]);
  assertKnownOptions(args, allowed, "up");
  const configPath = optionalArg(args, "--config") ?? defaultConfigPath;
  const config = await readRuntimeConfig(configPath);
  const storePath = optionalArg(args, "--store") ?? config.storage?.sqlite_path ?? defaultStorePath;
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
    authTokenEnv: optionalArg(args, "--auth-token-env") ?? "SYNAPSOR_RUNNER_HTTP_TOKEN",
    boundary,
    config,
    configPath,
    dryRun: args.includes("--dry-run"),
    host: optionalArg(args, "--host") ?? "127.0.0.1",
    openUi: args.includes("--open-ui"),
    port,
    resultFormat,
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
    "--auth-token-env", optionalArg(args, "--auth-token-env") ?? "SYNAPSOR_RUNNER_HTTP_TOKEN",
    "--alias-mode", aliasMode,
    ...(resultFormat ? ["--result-format", String(resultFormat)] : []),
    ...(args.includes("--dev-no-auth") ? ["--dev-no-auth"] : []),
    ...(optionalArg(args, "--cors-origin") ? ["--cors-origin", optionalArg(args, "--cors-origin") as string] : []),
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
    lines.push(
      `  Streamable HTTP endpoint: http://${input.host}:${input.port}/mcp`,
      `  Auth token env: ${input.authTokenEnv} (${envValue(process.env, input.authTokenEnv) ? "set" : "missing"})`,
      input.serveRequested
        ? input.dryRun
          ? "  Status: dry run only; server not started."
          : "  Status: starting after this checklist."
        : `  Start command: ${cliCommandName()} up --serve --config ${input.configPath} --store ${input.storePath} --port ${input.port} --auth-token-env ${input.authTokenEnv} --alias-mode ${input.aliasMode}`,
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

async function runnerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "start") return start(rest);
  if (subcommand === "up") return up(rest);
  if (subcommand === "doctor") return doctor(rest);
  usage();
  return 2;
}

async function cloud(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "connect") return cloudConnect(rest);
  if (subcommand === "sync") return cloudSync(rest);
  if (subcommand === "sync-activity") return cloudSyncActivity(rest);
  if (subcommand === "push") return cloudPush(rest);
  if (subcommand === "outbox") return cloudOutbox(rest);
  usage();
  return 2;
}

async function cloudOutbox(args: string[]): Promise<number> {
  const [action = "status", ...rest] = args;
  const configPath = optionalArg(rest, "--config") ?? "synapsor.runner.json";
  const storePath = optionalArg(rest, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const runtimeConfig = loadRuntimeConfigFromFile(configPath);
  if (runtimeConfig.governance?.mode !== "cloud_linked") throw new Error("cloud outbox requires governance.mode cloud_linked");
  const store = createDefaultRuntimeStore(runtimeConfig, process.env, storePath);
  const synchronizer = new CloudLinkedSynchronizer(runtimeConfig, store, process.env);
  try {
    if (action === "status") {
      const status = await synchronizer.status();
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, ...status }, null, 2)}\n`);
      else process.stdout.write([
        "Synapsor Cloud outbox",
        `Authority: ${status.authority_mode}`,
        `Evidence residency: ${status.evidence_residency}`,
        `Pending: ${status.pending}`,
        `Leased: ${status.leased}`,
        `Acknowledged: ${status.acknowledged}`,
        `Dead letter: ${status.dead_letter}`,
        `Reconciliation required: ${status.reconciliation_required}`,
        status.last_reconciliation_error_code ? `Last reconciliation error: ${status.last_reconciliation_error_code}` : "",
      ].filter(Boolean).join("\n") + "\n");
      return 0;
    }
    if (action === "inspect") {
      const requested = firstPositional(rest);
      const entries = await store.listCloudOutbox?.({ limit: 10_000 }) ?? [];
      const selected = requested === "latest" || !requested ? entries.at(-1) : entries.find((entry) => entry.event_id === requested);
      if (!selected) throw new Error(`cloud outbox event not found: ${requested || "latest"}`);
      const governance = selected.proposal_id ? await store.listCloudGovernanceEvents?.(selected.proposal_id) ?? [] : [];
      const safe = { ok: true, outbox: selected, governance };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
      else process.stdout.write(`Cloud outbox event: ${selected.event_id}\nStatus: ${selected.status}\nKind: ${selected.kind}\nAttempts: ${selected.attempts}/${selected.max_attempts}\nLast error: ${selected.last_error_code ?? "none"}\nGovernance events: ${governance.length}\n`);
      return 0;
    }
    if (action === "reconcile") {
      if (!rest.includes("--yes")) throw new Error("cloud outbox reconcile requires --yes after inspecting local and Cloud state");
      const drained = await synchronizer.drainOnce();
      const reconciled = await synchronizer.reconcileOnce();
      const status = await synchronizer.status();
      const result = { ok: true, drained, reconciled, status };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`Cloud outbox reconciliation complete.\nAcknowledged: ${drained.acknowledged}\nFailed: ${drained.failed}\nGovernance updates: ${reconciled.recorded}\n`);
      return status.dead_letter || status.reconciliation_required ? 1 : 0;
    }
    if (action === "retry") {
      const eventId = firstPositional(rest);
      if (!eventId) throw new Error("cloud outbox retry requires <event-id>");
      if (!rest.includes("--yes")) throw new Error("cloud outbox retry requires --yes after resolving the reported permanent cause");
      if (!store.requeueCloudOutbox) throw new Error("configured runtime store does not support Cloud outbox repair");
      const requeued = await store.requeueCloudOutbox(eventId);
      const drained = await synchronizer.drainOnce();
      const result = { ok: true, requeued, drained, status: await synchronizer.status() };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`Requeued ${eventId}.\nAcknowledged: ${drained.acknowledged}\nFailed: ${drained.failed}\n`);
      return drained.failed ? 1 : 0;
    }
    throw new Error("cloud outbox supports status, inspect, reconcile, and retry");
  } finally {
    await synchronizer.stop();
    await store.close();
  }
}

type CloudConnectionFile = {
  cloud?: {
    protocol_version?: string;
    base_url?: string;
    base_url_env?: string;
    runner_token_env?: string;
    runner_id?: string;
    runner_version?: string;
    project_id?: string;
    source_id?: string;
    /** Portable source alias named by the reviewed contract and local runner config. */
    runner_source_id?: string;
    mapping_id?: string;
    contract_id?: string;
    contract_version_id?: string;
    contract_digest?: string;
    engines?: string[];
    capabilities?: string[];
  };
};

async function loadCloudConnection(configPath: string): Promise<{
  file: NonNullable<CloudConnectionFile["cloud"]>;
  baseUrl: string;
  runnerToken: string;
  runnerId: string;
  runnerVersion: string;
  sourceId: string;
}> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as CloudConnectionFile;
  if (!parsed.cloud) throw new Error(`cloud config missing in ${configPath}`);
  const baseUrlEnv = parsed.cloud.base_url_env || "SYNAPSOR_CLOUD_BASE_URL";
  const tokenEnv = parsed.cloud.runner_token_env || "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = envValue(process.env, baseUrlEnv) || String(parsed.cloud.base_url || "").trim();
  const runnerToken = envValue(process.env, tokenEnv);
  const missing = [baseUrl ? "" : baseUrlEnv, runnerToken ? "" : tokenEnv].filter(Boolean);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const sourceId = String(parsed.cloud.source_id || process.env.SYNAPSOR_SOURCE_ID || "").trim();
  if (!sourceId || sourceId === "src_replace_me") throw new Error("cloud.source_id is required and must match the scoped Cloud Runner token source");
  return {
    file: parsed.cloud,
    baseUrl: baseUrl!,
    runnerToken: runnerToken!,
    sourceId,
    runnerId: String(parsed.cloud.runner_id || process.env.SYNAPSOR_RUNNER_ID || "synapsor_runner_local").trim(),
    runnerVersion: String(parsed.cloud.runner_version || process.env.npm_package_version || runnerPackage.version).trim(),
  };
}

function stripPrincipalScopeFromCloudRows(changeSet: ChangeSet, column: string): void {
  const stripRecord = (value: unknown): void => {
    if (isRecord(value)) delete value[column];
  };
  stripRecord(changeSet.before);
  stripRecord(changeSet.after);
  if ("frozen_set" in changeSet && isRecord(changeSet.frozen_set) && Array.isArray(changeSet.frozen_set.members)) {
    for (const member of changeSet.frozen_set.members) {
      if (!isRecord(member)) continue;
      stripRecord(member.before);
      stripRecord(member.after);
    }
  }
  if (changeSet.schema_version === protocolVersions.compensationChangeSet) {
    for (const member of changeSet.compensation.descriptor.members) {
      stripRecord(member.expected_state);
      stripRecord(member.restore_values);
    }
  }
}

async function cloudSync(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.cloud.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const requested = firstPositional(args);
  const connection = await loadCloudConnection(configPath);
  const contractId = String(connection.file.contract_id || "").trim();
  const contractVersionId = String(connection.file.contract_version_id || "").trim();
  const contractDigest = String(connection.file.contract_digest || "").trim();
  const runnerSourceId = String(connection.file.runner_source_id || connection.sourceId).trim();
  if (!contractId || !contractVersionId || !/^sha256:[0-9a-f]{16,}$/i.test(contractDigest)) {
    throw new Error("cloud sync requires contract_id, contract_version_id, and contract_digest in synapsor.cloud.json");
  }
  const client = new ControlPlaneClient({
    baseUrl: connection.baseUrl,
    runnerToken: connection.runnerToken,
    sourceId: connection.sourceId,
    runnerId: connection.runnerId,
  });
  const store = new ProposalStore(storePath);
  try {
    const candidates = store.listProposals({ state: "pending_review", source: runnerSourceId, limit: 100 });
    const selected = requested
      ? [requested === "latest" ? candidates[0] : store.getProposal(requested)].filter((value): value is StoredProposal => value !== undefined)
      : candidates;
    if (requested && selected.length === 0) throw new Error(`local pending proposal not found: ${requested}`);
    let synced = 0;
    for (const proposal of selected) {
      if (proposal.state !== "pending_review") throw new Error(`proposal ${proposal.proposal_id} is ${proposal.state}; only pending_review proposals can enter Cloud approval`);
      if (proposal.source_id !== runnerSourceId) {
        throw new Error(`proposal ${proposal.proposal_id} uses local source ${proposal.source_id}; Cloud source ${connection.sourceId} is mapped to reviewed local source ${runnerSourceId}`);
      }
      const evidence = store.listEvidenceBundles({ proposal: proposal.proposal_id, limit: 100 });
      const queryAudit = store.listQueryAudit({ proposal: proposal.proposal_id, limit: 100 });
      const sanitizedChangeSet = JSON.parse(JSON.stringify(proposal.change_set)) as ChangeSet;
      sanitizedChangeSet.evidence.items = [];
      if (sanitizedChangeSet.guards.principal_scope) {
        stripPrincipalScopeFromCloudRows(sanitizedChangeSet, sanitizedChangeSet.guards.principal_scope.column);
        sanitizedChangeSet.principal.id = sanitizedChangeSet.guards.principal_scope.value_fingerprint;
        delete sanitizedChangeSet.guards.principal_scope.value;
      }
      const payload: RunnerProposalV1 = {
        schema_version: protocolVersions.runnerProposal,
        runner_id: connection.runnerId,
        source_id: connection.sourceId,
        ...(connection.file.mapping_id ? { mapping_id: connection.file.mapping_id } : {}),
        contract: {
          contract_id: contractId,
          contract_version_id: contractVersionId,
          digest: contractDigest as `sha256:${string}`,
        },
        change_set: sanitizedChangeSet,
        evidence_metadata: {
          bundle_ids: evidence.map((item) => item.evidence_bundle_id),
          count: evidence.length,
          query_fingerprints: [...new Set(evidence.map((item) => item.query_fingerprint).filter(Boolean))],
          payload_uploaded: false,
        },
        query_audit: {
          audit_ids: queryAudit.map((item) => item.audit_id).filter((value) => value !== undefined),
          count: queryAudit.length,
          query_fingerprints: [...new Set(queryAudit.map((item) => item.query_fingerprint).filter(Boolean))],
          tables: [...new Set(queryAudit.map((item) => item.table_name).filter(Boolean))],
          payload_uploaded: false,
        },
      };
      await client.submitProposal(payload);
      synced += 1;
    }
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, synced, source_id: connection.sourceId, contract_version_id: contractVersionId }, null, 2)}\n`);
    } else {
      process.stdout.write(`Synced ${synced} pending proposal${synced === 1 ? "" : "s"} to Cloud for ${connection.sourceId}.\n`);
      process.stdout.write("Only proposal diffs and bounded evidence/query-audit metadata were sent; database credentials and source rows stayed local.\n");
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cloudSyncActivity(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.cloud.json";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const requested = firstPositional(args) ?? "latest";
  const connection = await loadCloudConnection(configPath);
  const runnerSourceId = String(connection.file.runner_source_id || connection.sourceId).trim();
  const client = new ControlPlaneClient({
    baseUrl: connection.baseUrl,
    runnerToken: connection.runnerToken,
    sourceId: connection.sourceId,
    runnerId: connection.runnerId,
  });
  const store = new ProposalStore(storePath);
  try {
    const proposal = requested === "latest"
      ? store.listProposals({ source: runnerSourceId, limit: 1 })[0]
      : store.getProposal(requested);
    if (!proposal) throw new Error(`local proposal not found: ${requested}`);
    if (proposal.source_id !== runnerSourceId) {
      throw new Error(`proposal ${proposal.proposal_id} uses local source ${proposal.source_id}; Cloud source ${connection.sourceId} is mapped to reviewed local source ${runnerSourceId}`);
    }
    const evidence = store.listEvidenceBundles({ proposal: proposal.proposal_id, limit: 100 });
    const queryAudit = store.listQueryAudit({ proposal: proposal.proposal_id, limit: 100 });
    const replay = store.replay(proposal.proposal_id);
    const principalScope = proposal.change_set.guards.principal_scope;
    const common = {
      schema_version: protocolVersions.runnerActivity,
      runner_id: connection.runnerId,
      source_id: connection.sourceId,
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant_id: proposal.tenant_id,
      principal: principalScope?.value_fingerprint ?? proposal.principal,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      status: proposal.state,
    } as const;
    const events: RunnerActivityV1[] = [
      ...evidence.map((item) => ({
        ...common,
        event_id: `evidence:${item.evidence_bundle_id}`,
        event_type: "evidence.recorded" as const,
        evidence_ids: [item.evidence_bundle_id],
        detail: { stored_locally: true, payload_uploaded: false },
        occurred_at: item.created_at,
      })),
      ...queryAudit.map((item) => ({
        ...common,
        event_id: `query-audit:${String(item.audit_id)}`,
        event_type: "query_audit.recorded" as const,
        query_audit_ids: [String(item.audit_id)],
        ...(typeof item.evidence_bundle_id === "string" ? { evidence_ids: [item.evidence_bundle_id] } : {}),
        detail: { stored_locally: true, payload_uploaded: false },
        occurred_at: typeof item.created_at === "string" ? item.created_at : undefined,
      })),
      {
        ...common,
        event_id: `replay:${replay.replay_id}`,
        event_type: "replay.recorded",
        replay_id: replay.replay_id,
        detail: { stored_locally: true, payload_uploaded: false },
      },
    ];
    for (const event of events) await client.submitActivity(event);
    const output = {
      ok: true,
      synced: events.length,
      proposal_id: proposal.proposal_id,
      evidence_references: evidence.length,
      query_audit_references: queryAudit.length,
      replay_id: replay.replay_id,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(`Synced ${events.length} local activity reference${events.length === 1 ? "" : "s"} to Cloud for ${proposal.proposal_id}.\n`);
      process.stdout.write("Evidence contents, source rows, database credentials, and local replay payloads stayed local.\n");
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cloudPush(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("cloud push requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const contract = normalizeContract(parsed);
  const workspace = (optionalArg(args, "--workspace") ?? optionalArg(args, "--project") ?? process.env.SYNAPSOR_CLOUD_WORKSPACE ?? process.env.SYNAPSOR_WORKSPACE_ID ?? process.env.SYNAPSOR_PROJECT_ID ?? "").trim();
  const name = (optionalArg(args, "--name") ?? contract.metadata?.name ?? "").trim();
  const description = (optionalArg(args, "--description") ?? contract.metadata?.description ?? "").trim();
  const idempotencyKey = optionalArg(args, "--idempotency-key");
  const payload = {
    schema_version: "synapsor.cloud-contract-push.v0.1",
    contract,
    summary: contractSummary(contract),
    workspace,
    name,
    description,
    source: "runner",
    source_versions: {
      "@synapsor/spec": specPackage.version,
      "@synapsor/dsl": dslPackage.version,
      "@synapsor/runner": process.env.npm_package_version ?? runnerPackage.version,
    },
    activate: args.includes("--activate"),
    idempotency_key: idempotencyKey,
    pushed_at: new Date().toISOString(),
  };
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  if (dryRun && json) {
    process.stdout.write(`${JSON.stringify({ ok: dryRun, dry_run: dryRun, payload }, null, 2)}\n`);
    return 0;
  }
  if (dryRun) {
    process.stdout.write("Synapsor Cloud contract push preview\n");
    process.stdout.write(`Contract: ${target}\n`);
    process.stdout.write(`Contexts: ${payload.summary.contexts}\n`);
    process.stdout.write(`Capabilities: ${payload.summary.capabilities}\n`);
    process.stdout.write(`Workflows: ${payload.summary.workflows}\n`);
    process.stdout.write(`Proposal capabilities: ${payload.summary.proposal_capabilities}\n`);
    process.stdout.write(`Approval policies: ${payload.summary.approval_policies}\n`);
    process.stdout.write(`Kept-out fields: ${payload.summary.kept_out_fields}\n`);
    process.stdout.write("Dry run only. No Cloud upload attempted.\n");
    return 0;
  }
  const apiUrl = (optionalArg(args, "--api-url") ?? process.env.SYNAPSOR_CLOUD_BASE_URL ?? "").trim();
  if (args.includes("--token")) {
    throw new Error("cloud push does not accept secrets through --token. Set SYNAPSOR_API_KEY for automation or SYNAPSOR_CLOUD_ACCESS_TOKEN for an authenticated human session.");
  }
  const apiKey = (process.env.SYNAPSOR_API_KEY ?? "").trim();
  const humanAccessToken = (process.env.SYNAPSOR_CLOUD_ACCESS_TOKEN ?? "").trim();
  const credential = apiKey || humanAccessToken;
  if (!workspace) {
    throw new Error("cloud push upload requires --workspace <project_id> or SYNAPSOR_CLOUD_WORKSPACE/SYNAPSOR_WORKSPACE_ID/SYNAPSOR_PROJECT_ID.");
  }
  if (!apiUrl || !credential) {
    throw new Error("cloud push upload requires --api-url/SYNAPSOR_CLOUD_BASE_URL plus SYNAPSOR_API_KEY or SYNAPSOR_CLOUD_ACCESS_TOKEN. Use --dry-run for local validation without a network call.");
  }
  let response: Record<string, unknown>;
  try {
    response = await new CloudControlClient({
      baseUrl: apiUrl,
      credential,
      credentialKind: apiKey ? "service" : "human",
      userAgent: "synapsor-runner-cloud-push",
    }).pushContract({
      projectId: workspace,
      contract: contract as unknown as Record<string, unknown>,
      name,
      description,
      source: "runner",
      sourceVersions: payload.source_versions,
      activate: args.includes("--activate"),
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof CloudControlError) {
      const request = error.request_id ? ` Request: ${error.request_id}.` : "";
      const issues = Array.isArray(error.details?.errors)
        ? error.details.errors.slice(0, 3).map((issue) => isRecord(issue)
          ? `${String(issue.path || "$")} ${String(issue.code || "validation_error")}: ${String(issue.message || "")}`
          : String(issue)).join("; ")
        : "";
      if (error.status === 422 && issues) {
        throw new Error(`Cloud rejected the contract: ${issues}.${request}`);
      }
      throw new Error(`cloud push upload failed: ${error.message} (${error.error_code}).${issues ? ` ${issues}` : ""}${request}`);
    }
    throw error;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const contractId = cloudStringField(response, "contract_id") || cloudStringField(response.contract, "contract_id");
  const versionId = cloudStringField(response, "contract_version_id") || cloudStringField(response.version, "contract_version_id");
  const digest = cloudStringField(response, "digest") || cloudStringField(response.version, "digest");
  const status = cloudStringField(response, "status") || cloudStringField(response.version, "status") || "stored";
  process.stdout.write("Synapsor Cloud contract push complete\n");
  process.stdout.write(`Workspace: ${workspace}\n`);
  if (contractId) process.stdout.write(`Contract id: ${contractId}\n`);
  if (versionId) process.stdout.write(`Version id: ${versionId}\n`);
  if (digest) process.stdout.write(`Digest: ${digest}\n`);
  process.stdout.write(`Status: ${status}\n`);
  const registryUrl = cloudStringField(response, "registry_url");
  if (registryUrl) process.stdout.write(`Registry: ${registryUrl}\n`);
  return 0;
}

function contractSummary(contract: SynapsorContract): Record<string, number> {
  const keptOutFields = new Set<string>();
  for (const capability of contract.capabilities) {
    for (const field of capability.kept_out_fields ?? []) keptOutFields.add(field);
  }
  return {
    contexts: contract.contexts.length,
    capabilities: contract.capabilities.length,
    workflows: contract.workflows?.length ?? 0,
    proposal_capabilities: contract.capabilities.filter((capability) => capability.kind === "proposal").length,
    approval_policies: contract.policies?.filter((policy) => policy.kind === "approval").length ?? 0,
    kept_out_fields: keptOutFields.size,
  };
}

function cloudStringField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

async function cloudConnect(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG ?? "synapsor.cloud.json";
  let connection;
  try {
    connection = await loadCloudConnection(configPath);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { baseUrl, runnerToken, sourceId, runnerId, runnerVersion } = connection;
  const engines = normalizeEngines(connection.file.engines);
  const capabilities = normalizeCapabilities(connection.file.capabilities);
  const client = new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId,
    runnerId,
  });
  const report = await client.doctor();
  if (!report.ok || !report.authenticated) {
    const reason = report.authenticated
      ? `status ${report.status}`
      : "the endpoint did not authenticate the Runner protocol; upgrade Cloud or use its supported API URL";
    process.stdout.write(`cloud connection failed: ${reason}\n`);
    return 1;
  }
  const registration: RunnerRegistrationV1 = {
    schema_version: protocolVersions.runnerRegistration,
    protocol_version: protocolVersions.runnerControl,
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    capabilities,
    scope: {
      project_id: String(connection.file.project_id || "token_scope"),
      source_ids: [sourceId],
    },
    contracts: connection.file.contract_id && connection.file.contract_version_id && connection.file.contract_digest
      ? [{
          contract_id: connection.file.contract_id,
          contract_version_id: connection.file.contract_version_id,
          digest: connection.file.contract_digest,
        }]
      : undefined,
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
  if (subcommand === "serve-http") return mcpServeHttp(rest);
  if (subcommand === "serve-streamable-http") return mcpServeStreamableHttp(rest);
  if (subcommand === "audit") return mcpAudit(rest);
  if (subcommand === "config") return mcpConfig(rest);
  if (subcommand === "client-config") return mcpConfigure(rest);
  if (subcommand === "configure") return mcpConfigure(rest);
  if (subcommand === "smoke") return mcpSmoke(rest);
  usage(["mcp"]);
  return 2;
}

async function tools(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "preview") return toolsPreview(rest);
  if (subcommand === "list") return toolsPreview(rest);
  usage(["tools"]);
  return 2;
}

async function smoke(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "call") return smokeCall(rest);
  if (subcommand === "boundary") return mcpSmoke(rest);
  usage(["smoke"]);
  return 2;
}

async function writeback(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "doctor") return writebackDoctor(rest);
  if (subcommand === "migration") return writebackMigration(rest);
  if (subcommand === "grants") return writebackGrants(rest);
  if (subcommand === "reconcile") return writebackReconcile(rest);
  usage(["writeback"]);
  return 2;
}

async function writebackReconcile(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || !["list", "inspect", "resolve"].includes(subcommand)) {
    throw new Error("writeback reconcile requires list, inspect, or resolve");
  }
  const configPath = optionalArg(rest, "--config") ?? defaultConfigPath;
  const storePath = optionalArg(rest, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const config = await readRuntimeConfig(configPath);
  if (runtimeStoreBridgeRequired(rest, config)) {
    return withSharedPostgresRuntimeStoreBridge(rest, config, `writeback reconcile ${subcommand}`, (bridgeStorePath) =>
      writebackReconcile([subcommand, ...argsWithRuntimeStoreBridge(rest, bridgeStorePath)]));
  }
  assertNoRuntimeStoreForLocalMutation(config, `writeback reconcile ${subcommand}`, rest);
  if (subcommand === "list") return writebackReconcileList(rest, storePath);
  if (subcommand === "inspect") return writebackReconcileInspect(rest, configPath, storePath, config);
  return writebackReconcileResolve(rest, configPath, storePath, config);
}

function writebackReconcileList(args: string[], storePath: string): number {
  assertKnownOptions(args, new Set(["--config", "--store", "--status", "--proposal", "--limit", "--json", runtimeStoreBridgeFlag]), "writeback reconcile list");
  const status = optionalArg(args, "--status") as StoredWritebackIntent["status"] | undefined;
  if (status && !["intent_recorded", "applying", "applied", "already_applied", "conflict", "failed", "reconciliation_required"].includes(status)) {
    throw new Error(`unsupported writeback intent status: ${status}`);
  }
  const store = new ProposalStore(storePath);
  try {
    const intents = store.listWritebackIntents({ status, proposal_id: optionalArg(args, "--proposal"), limit: optionalPositiveIntegerArg(args, "--limit") });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ intents: intents.map(publicWritebackIntent) }, null, 2)}\n`);
    else process.stdout.write(formatWritebackIntentList(intents));
    return 0;
  } finally {
    store.close();
  }
}

async function writebackReconcileInspect(args: string[], configPath: string, storePath: string, config: RuntimeConfig): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--store", "--json", runtimeStoreBridgeFlag]), "writeback reconcile inspect");
  const context = await inspectWritebackIntentContext(args, configPath, storePath, config);
  const payload = { intent: publicWritebackIntent(context.intent), observation: context.observation };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(formatReconciliationInspection(context.intent, context.observation));
  return 0;
}

async function writebackReconcileResolve(args: string[], configPath: string, storePath: string, config: RuntimeConfig): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--store", "--outcome", "--reason", "--yes", "--json", "--actor", "--identity", "--identity-key", runtimeStoreBridgeFlag]), "writeback reconcile resolve");
  if (!args.includes("--yes")) throw new Error("writeback reconcile resolve requires --yes after inspecting the source observation");
  const outcome = optionalArg(args, "--outcome") as "applied" | "conflict" | "failed" | undefined;
  if (!outcome || !["applied", "conflict", "failed"].includes(outcome)) throw new Error("--outcome must be applied, conflict, or failed");
  const reason = optionalArg(args, "--reason")?.trim();
  if (!reason) throw new Error("writeback reconcile resolve requires --reason");
  const context = await inspectWritebackIntentContext(args, configPath, storePath, config);
  const supportedOutcome = reconciliationSupportedOutcome(context.observation);
  if (outcome !== supportedOutcome) {
    throw new Error(`live source observation ${context.observation.classification} supports outcome ${supportedOutcome}, not ${outcome}; re-inspect and investigate instead of overriding the guard`);
  }
  const identity = await operatorIdentityForDecision({
    args,
    config,
    configPath,
    proposal: context.proposal,
    action: "reconcile",
    reason,
  });
  const receipt = reconciliationReceipt(context.intent, context.observation, outcome, identity.subject, reason);
  const store = new ProposalStore(storePath);
  try {
    const resolved = store.reconcileWritebackIntent({
      intent_id: context.intent.intent_id,
      receipt,
      actor: identity.subject,
      reason,
      observation: context.observation,
      identity,
      require_verified_identity: Boolean(config.operator_identity && config.operator_identity.provider !== "dev_env"),
    });
    operationalLog("info", "writeback_reconciled", {
      proposal_id: resolved.proposal_id,
      operation: resolved.operation,
      status: resolved.status,
      source_database_changed: false,
    });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ intent: publicWritebackIntent(resolved), receipt }, null, 2)}\n`);
    else process.stdout.write(`Reconciled ${resolved.intent_id} as ${resolved.status}.\nReason: ${reason}\nReceipt: ${receipt.receipt_hash}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function inspectWritebackIntentContext(
  args: string[],
  configPath: string,
  storePath: string,
  config: RuntimeConfig,
): Promise<{ intent: StoredWritebackIntent; proposal: StoredProposal; observation: ReconciliationObservation }> {
  const requested = positional(args, 0) ?? "latest";
  const store = new ProposalStore(storePath);
  let intent: StoredWritebackIntent;
  let proposal: StoredProposal;
  try {
    intent = requested === "latest"
      ? store.listWritebackIntents({ status: "reconciliation_required", limit: 1 })[0] ?? (() => { throw new Error("no writeback intents require reconciliation"); })()
      : store.getWritebackIntent(requested) ?? (() => { throw new Error(`writeback intent not found: ${requested}`); })();
    if (intent.status !== "reconciliation_required" && intent.status !== "applying") throw new Error(`writeback intent ${intent.intent_id} is ${intent.status}, not reconcilable`);
    proposal = requireLocalProposal(store, intent.proposal_id);
  } finally {
    store.close();
  }
  const source = config.sources?.[intent.intent.source_id];
  if (runnerReceiptConfig(source)?.authority !== "runner_ledger") throw new Error(`source ${intent.intent.source_id} does not use runner_ledger receipt authority`);
  const databaseUrl = await resolveSqlWriteDatabaseUrl(intent.intent, configPath, process.env);
  const observation = intent.intent.engine === "postgres"
    ? await inspectPostgresWritebackSource(intent.intent, databaseUrl)
    : await inspectMysqlWritebackSource(intent.intent, databaseUrl);
  return { intent, proposal, observation };
}

export function reconciliationSupportedOutcome(observation: ReconciliationObservation): "applied" | "conflict" | "failed" {
  if (observation.classification === "matches_proposed") return "applied";
  if ((observation.operation === "single_row_delete" || observation.operation === "set_delete") && observation.classification === "target_absent") return "applied";
  if (observation.classification === "matches_reviewed_before" || observation.classification === "not_observed") return "failed";
  return "conflict";
}

export function reconciliationReceipt(
  intent: StoredWritebackIntent,
  observation: ReconciliationObservation,
  outcome: "applied" | "conflict" | "failed",
  runnerId: string,
  reason: string,
): ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4 {
  const job = intent.intent;
  if (job.protocol_version === protocolVersions.normalizedWritebackJobV4) {
    const executedAt = new Date().toISOString();
    const memberEffects: ExecutionReceiptV4["member_effects"] = outcome === "applied"
      ? job.compensation.members.map((member) => ({
        primary_key: member.primary_key,
        ...(job.operation === "remove_insert"
          ? { before_digest: hashReceipt(member.expected_state), tombstone_digest: hashReceipt({ primary_key: member.primary_key, deleted: true }) }
          : { before_digest: hashReceipt(member.expected_state), after_digest: hashReceipt(job.operation === "restore_insert" ? member.restore_values : { ...member.restore_values, [job.compensation.version_advance!.column]: Number(member.expected_state[job.compensation.version_advance!.column]) + 1 }) }),
      }))
      : [];
    const base = {
      schema_version: protocolVersions.executionReceiptV4,
      writeback_job_id: intent.writeback_job_id,
      proposal_id: intent.proposal_id,
      proposal_hash: intent.proposal_hash as `sha256:${string}`,
      approval_id: job.approval_id,
      runner_id: runnerId,
      operation: job.operation,
      receipt_authority: "runner_ledger" as const,
      status: outcome,
      target: { source_id: job.source_id, schema: job.target.schema, table: job.target.table, identities: job.compensation.members.map((member) => member.primary_key) },
      rows_affected: outcome === "applied" ? job.compensation.members.length : 0,
      idempotency_key: intent.idempotency_key,
      forward_receipt_hash: job.forward_receipt_hash,
      member_effects: memberEffects,
      ...(outcome === "applied" ? { inverse: compensationInverseFromJob(job) } : {}),
      source_database_mutated: outcome === "applied",
      safe_outcome_code: `RECONCILED_${outcome.toUpperCase()}`,
      ...(outcome === "applied" ? {} : { safe_error_code: `RECONCILED_${outcome.toUpperCase()}` }),
      executed_at: executedAt,
      reconciliation: { intent_id: intent.intent_id, reason: reason.slice(0, 500) },
    };
    return { ...base, receipt_hash: hashReceipt(base) };
  }
  if (intent.operation === "set_update" || intent.operation === "set_delete" || intent.operation === "batch_insert") {
    if (job.protocol_version !== protocolVersions.normalizedWritebackJobV3) throw new Error("bounded-set reconciliation requires a writeback-job v3");
    const executedAt = new Date().toISOString();
    const memberEffects: ExecutionReceiptV3["member_effects"] = outcome === "applied"
      ? job.frozen_set.members.map((member) => {
        if (job.operation === "set_update") {
          if (!member.before_digest || !member.after_digest) throw new Error("set UPDATE reconciliation requires exact before and after digests");
          return { primary_key: member.primary_key, before_digest: member.before_digest, after_digest: member.after_digest };
        }
        if (job.operation === "set_delete") {
          if (!member.before_digest || !member.tombstone_digest) throw new Error("set DELETE reconciliation requires exact before and tombstone digests");
          return { primary_key: member.primary_key, before_digest: member.before_digest, tombstone_digest: member.tombstone_digest };
        }
        if (!member.after_digest) throw new Error("batch INSERT reconciliation requires exact after digests");
        return { primary_key: member.primary_key, after_digest: member.after_digest };
      })
      : [];
    const base = {
      schema_version: protocolVersions.executionReceiptV3,
      writeback_job_id: intent.writeback_job_id,
      proposal_id: intent.proposal_id,
      proposal_hash: intent.proposal_hash as `sha256:${string}`,
      approval_id: job.approval_id,
      runner_id: runnerId,
      operation: job.operation,
      receipt_authority: "runner_ledger" as const,
      status: outcome,
      target: {
        source_id: job.source_id,
        schema: job.target.schema,
        table: job.target.table,
        identities: job.frozen_set.members.map((member) => member.primary_key),
        set_digest: job.frozen_set.set_digest,
      },
      rows_affected: outcome === "applied" ? job.frozen_set.row_count : 0,
      idempotency_key: intent.idempotency_key,
      member_effects: memberEffects,
      source_database_mutated: outcome === "applied",
      safe_outcome_code: `RECONCILED_${outcome.toUpperCase()}`,
      ...(outcome === "applied" ? {} : { safe_error_code: `RECONCILED_${outcome.toUpperCase()}` }),
      executed_at: executedAt,
      reconciliation: { intent_id: intent.intent_id, reason: reason.slice(0, 500) },
    };
    return {
      ...base,
      receipt_hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex")}`,
    };
  }
  if (job.protocol_version !== protocolVersions.normalizedWritebackJobV2) throw new Error("single-row reconciliation requires a writeback-job v2");
  const executedAt = new Date().toISOString();
  const base = {
    schema_version: protocolVersions.executionReceiptV2,
    writeback_job_id: intent.writeback_job_id,
    proposal_id: intent.proposal_id,
    proposal_hash: intent.proposal_hash as `sha256:${string}`,
    approval_id: job.approval_id,
    runner_id: runnerId,
    operation: job.operation,
    receipt_authority: "runner_ledger" as const,
    status: outcome,
    target: { source_id: job.source_id, schema: job.target.schema, table: job.target.table, identity: observation.target_identity },
    rows_affected: 0,
    idempotency_key: intent.idempotency_key,
    source_database_mutated: outcome === "applied",
    safe_outcome_code: `RECONCILED_${outcome.toUpperCase()}`,
    ...(outcome === "applied" ? {} : { safe_error_code: `RECONCILED_${outcome.toUpperCase()}` }),
    executed_at: executedAt,
    reconciliation: { intent_id: intent.intent_id, reason: reason.slice(0, 500) },
    ...(outcome === "applied" && intent.operation === "single_row_delete"
      ? { tombstone_digest: observation.observed_digest }
      : { after_digest: observation.observed_digest }),
  };
  return {
    ...base,
    receipt_hash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex")}`,
  };
}

function publicWritebackIntent(intent: StoredWritebackIntent): Record<string, unknown> {
  return {
    intent_id: intent.intent_id,
    proposal_id: intent.proposal_id,
    writeback_job_id: intent.writeback_job_id,
    operation: intent.operation,
    status: intent.status,
    reconciliation_reason: intent.reconciliation_reason,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
  };
}

function formatWritebackIntentList(intents: StoredWritebackIntent[]): string {
  if (intents.length === 0) return "No writeback intents found.\n";
  return ["Synapsor writeback intents", "", ...intents.map((intent) => `${intent.intent_id}  ${intent.status}  ${intent.operation}  proposal=${intent.proposal_id}`), ""].join("\n");
}

function formatReconciliationInspection(intent: StoredWritebackIntent, observation: ReconciliationObservation): string {
  const setSummary = observation.member_observations
    ? [
      `Frozen members observed: ${observation.member_observations.length}`,
      `Member classifications: ${JSON.stringify(Object.fromEntries(
        [...new Set(observation.member_observations.map((member) => member.classification))]
          .map((classification) => [classification, observation.member_observations!.filter((member) => member.classification === classification).length]),
      ))}`,
    ]
    : [];
  return [
    `Writeback reconciliation: ${intent.intent_id}`,
    `Proposal: ${intent.proposal_id}`,
    `Operation: ${intent.operation}`,
    `Intent state: ${intent.status}`,
    `Live observation: ${observation.classification}`,
    ...setSummary,
    `Supported resolution: ${reconciliationSupportedOutcome(observation)}`,
    `Expected safe metadata: ${JSON.stringify(observation.expected)}`,
    `Observed allowlisted metadata: ${JSON.stringify(observation.observed)}`,
    `Observation digest: ${observation.observed_digest}`,
    "",
    "Runner has not resolved this outcome automatically.",
    `After investigation: ${cliCommandName()} writeback reconcile resolve ${intent.intent_id} --outcome <applied|conflict|failed> --reason \"...\" --yes`,
    "",
  ].join("\n");
}

async function handler(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "template") return handlerTemplate(rest);
  usage(["handler"]);
  return 2;
}

async function handlerTemplate(args: string[]): Promise<number> {
  const allowed = new Set(["--list", "--output", "--out", "--stdout", "--force"]);
  assertKnownOptions(args, allowed, "handler template");
  if (args.includes("--list")) {
    process.stdout.write(formatHandlerTemplateList());
    return 0;
  }
  const requested = positional(args, 0);
  if (!requested) throw new Error("handler template requires <node-fastify|python-fastapi|command>, or use --list");
  const name = resolveHandlerTemplateName(requested);
  const definition = handlerTemplateDefinitions[name];
  const content = definition.content;
  if (args.includes("--stdout")) {
    process.stdout.write(content);
    return 0;
  }
  const output = outputArg(args) ?? definition.fileName;
  await writeHandlerTemplateFile(name, output, args.includes("--force"));
  process.stdout.write(`created ${output}\n`);
  process.stdout.write(`${handlerSecurityWarning}\n`);
  return 0;
}

async function writeHandlerTemplateFile(name: HandlerTemplateName, output: string, force: boolean): Promise<void> {
  const definition = handlerTemplateDefinitions[name];
  await writeFileGuarded(output, definition.content, force);
  if (name === "command" || output.endsWith(".mjs") || output.endsWith(".js")) {
    await fs.chmod(path.resolve(output), 0o755).catch(() => undefined);
  }
}

function formatHandlerTemplateList(): string {
  return [
    "Synapsor app-owned writeback handler templates",
    "",
    ...Object.entries(handlerTemplateDefinitions).map(([name, definition]) => `- ${name}: ${definition.description}`),
    "",
    handlerSecurityWarning,
    "",
    "Examples:",
    `  ${cliCommandName()} handler template node-fastify --output ./synapsor-writeback-handler.mjs`,
    `  ${cliCommandName()} handler template python-fastapi --output ./synapsor_writeback_handler.py`,
    `  ${cliCommandName()} handler template command --output ./synapsor-command-handler.mjs`,
    "",
  ].join("\n");
}

function resolveHandlerTemplateName(value: string): HandlerTemplateName {
  const normalized = value.trim().toLowerCase();
  for (const [name, definition] of Object.entries(handlerTemplateDefinitions) as Array<[HandlerTemplateName, typeof handlerTemplateDefinitions[HandlerTemplateName]]>) {
    if (normalized === name || (definition.aliases as readonly string[]).includes(normalized)) return name;
  }
  throw new Error(`unknown handler template: ${value}. Use ${cliCommandName()} handler template --list`);
}

async function writebackDoctor(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? defaultConfigPath;
  const config = await readRuntimeConfig(configPath);
  const checkDb = args.includes("--check-db");
  const sqlSources = Object.entries(config.sources ?? {})
    .filter(([sourceName]) => sourceNeedsSqlWriteback(config, sourceName));
  const lines = [
    "Synapsor writeback doctor",
    `Config: ${configPath}`,
    "",
  ];
  if (sqlSources.length === 0) {
    lines.push("No direct SQL writeback sources found.", "Rich writes can use app-owned http_handler or command_handler executors without Runner creating receipt tables.", "");
    process.stdout.write(lines.join("\n"));
    return 0;
  }
  let ok = true;
  for (const [sourceName, source] of sqlSources) {
    const writeEnv = source.write_url_env;
    const writeUrl = writeEnv ? envValue(process.env, writeEnv) : undefined;
    const receipts = runnerReceiptConfig(source);
    lines.push(`Source: ${sourceName}`);
    lines.push(`  engine: ${source.engine}`);
    lines.push(`  writer env: ${writeEnv ?? "(missing write_url_env)"}`);
    lines.push(`  env status: ${writeUrl ? "set" : "missing"}`);
    lines.push(`  receipt mode: ${formatSourceReceiptMode(source)}`);
    if (receipts?.authority === "runner_ledger") {
      lines.push("  source receipt table: not used");
    }
    if (!writeEnv || !writeUrl) ok = false;
    if (checkDb && writeUrl) {
      const result = await adapters[source.engine].doctor({
        controlPlaneUrl: "local",
        runnerToken: "local",
        runnerId: "writeback-doctor",
        sourceId: sourceName,
        databaseUrl: writeUrl,
        engine: source.engine,
        pollIntervalMs: 0,
        statementTimeoutMs: writebackTimeoutMs(source),
        logLevel: "error",
        dryRun: true,
        stateDir: "./state",
        receipts,
      } satisfies RunnerConfig);
      lines.push(`  db check: ${result.ok ? "ok" : "failed"}`);
      lines.push(`  details: ${JSON.stringify(redactConfig(result.details ?? {}))}`);
      if (!result.ok) ok = false;
    } else if (checkDb) {
      lines.push("  db check: skipped because writer env is missing");
    }
    lines.push(`  guidance: ${receiptTableGuidance(source.engine, source)}`);
    lines.push("");
  }
  if (sqlSources.some(([, source]) => runnerReceiptConfig(source)?.authority === "source_db")) {
    lines.push("Source-receipt setup commands are shown per source above. Runner-ledger sources do not need these commands.", "");
  }
  process.stdout.write(lines.join("\n"));
  return ok ? 0 : 1;
}

async function writebackMigration(args: string[]): Promise<number> {
  const engine = requiredWritebackEngine(args);
  const schema = optionalArg(args, "--schema");
  const table = optionalArg(args, "--table") ?? "synapsor_writeback_receipts";
  if (engine === "postgres") {
    process.stdout.write(formatPostgresReceiptMigration(schema, table));
    return 0;
  }
  process.stdout.write(formatMysqlReceiptMigration(schema, table));
  return 0;
}

async function writebackGrants(args: string[]): Promise<number> {
  const engine = requiredWritebackEngine(args);
  const writerRole = optionalArg(args, "--writer-role") ?? "<writer_role>";
  const schema = optionalArg(args, "--schema") ?? (engine === "postgres" ? "public" : "<database_name>");
  const table = optionalArg(args, "--table") ?? "synapsor_writeback_receipts";
  if (engine === "postgres") {
    process.stdout.write(formatPostgresReceiptGrants(schema, writerRole, table));
    return 0;
  }
  process.stdout.write(formatMysqlReceiptGrants(schema, writerRole, table));
  return 0;
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
  const scripted = isScriptedOnboardingArgs(rest);
  const result = scripted ? await init(["--non-interactive", ...rest]) : await runInitWizard(["--wizard", ...rest]);
  if (result !== 0) return result;
  if (rest.includes("--dry-run")) return 0;
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
  process.stdout.write(`2. Open local UI:\n   ${cliCommandName()} ui --open --tour --config ${outputPath} --store ${storePath}\n`);
  process.stdout.write("3. Approve/apply only after setting a trusted write credential and reviewing the proposal.\n");
  return configCode === 0 && smokeCode === 0 ? 0 : 1;
}

async function demo(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "inspect") return demoInspect(args.slice(1));
  if (subcommand && !subcommand.startsWith("-") && subcommand !== "reference-support-billing") {
    usage(["demo"]);
    return 2;
  }
  if (args.includes("--quick")) return quickDemo(args);
  return prepareReferenceDemo(args);
}

async function quickDemo(args: string[]): Promise<number> {
  const allowed = new Set(["--quick", "--guided", "--no-interactive", "--details", "--json"]);
  assertKnownOptions(args, allowed, "demo --quick");
  const seeded = await seedQuickDemoStore(quickDemoStorePath);
  const summary = quickDemoSummary(seeded);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (args.includes("--details")) {
    process.stdout.write(formatQuickDemoDetails(seeded));
    return 0;
  }
  const canPauseForInput = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && !process.env.VITEST);
  const forceConcise = args.includes("--no-interactive");
  const forceGuided = args.includes("--guided") && !forceConcise;
  const shouldGuide = forceGuided || (canPauseForInput && !forceConcise);
  if (shouldGuide) {
    await runGuidedQuickDemo(seeded, { pause: canPauseForInput });
    return 0;
  }
  process.stdout.write(formatQuickDemoConcise(seeded));
  return 0;
}

async function demoInspect(args: string[]): Promise<number> {
  const allowed = new Set(["--npx", "--json"]);
  assertKnownOptions(args, allowed, "demo inspect");
  const seeded = await seedQuickDemoStore(quickDemoStorePath);
  const commands = quickDemoInspectCommands(args.includes("--npx"));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...quickDemoSummary(seeded), commands }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatQuickDemoInspect(commands));
  return 0;
}

function quickDemoSummary(seeded: { proposal_id: string; evidence_bundle_id: string; replay_id: string }): Record<string, unknown> {
  return {
    mode: "fixture_only",
    store: quickDemoStorePath,
    proposal_id: seeded.proposal_id,
    evidence_bundle_id: seeded.evidence_bundle_id,
    replay_id: seeded.replay_id,
    model_tool: "billing.propose_late_fee_waiver",
    business_object: "invoice:INV-3001",
    proposed_change: { late_fee_cents: { before: 5500, after: 0 } },
    source_database_changed: false,
    approval: "required outside MCP",
  };
}

function formatQuickDemoConcise(seeded: { proposal_id: string; evidence_bundle_id: string; replay_id: string }): string {
  void seeded;
  return [
    "Synapsor quick demo complete.",
    "",
    "The model asked to waive a late fee:",
    "billing.propose_late_fee_waiver(invoice_id=\"INV-3001\")",
    "",
    "Result:",
    "* proposal created",
    "* source DB changed: no",
    "* approval required outside MCP",
    "* evidence + replay saved locally",
    "",
    "Local ledger:",
    quickDemoStorePath,
    "",
    "Next:",
    `${cliCommandName()} demo inspect`,
    "",
  ].join("\n");
}

function formatQuickDemoDetails(seeded: { proposal_id: string; evidence_bundle_id: string; replay_id: string }): string {
  return [
    "Synapsor Runner quick demo is ready.",
    "",
    "This is a fixture-only first look. It does not start Docker, connect a database,",
    "or require an MCP client. It writes an inspectable local ledger fixture to:",
    quickDemoStorePath,
    "",
    "If you ran this through one-off npx and did not install the package, prefix",
    "follow-up commands with: npx -y -p @synapsor/runner synapsor-runner",
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
    "billing.propose_late_fee_waiver(invoice_id=\"INV-3001\", reason=\"approved support waiver\")",
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
    `${seeded.replay_id} captures the local proposal, evidence handle, query audit, and events.`,
    `Proposal id: ${seeded.proposal_id}`,
    `Evidence id: ${seeded.evidence_bundle_id}`,
    "",
    "What this proves:",
    "* The model gets a business tool, not raw SQL.",
    "* The model created a proposal, not a write.",
    "* Source DB changed: no.",
    "* You can inspect evidence and replay locally.",
    "",
    "Try:",
    `1. ${cliCommandName()} proposals show latest --store ${quickDemoStorePath}`,
    `2. ${cliCommandName()} activity search --object invoice:INV-3001 --store ${quickDemoStorePath}`,
    `3. ${cliCommandName()} replay show latest --store ${quickDemoStorePath}`,
    "",
    "For full reviewer detail:",
    `${cliCommandName()} replay show latest --details --store ${quickDemoStorePath}`,
    "",
    "For real guarded writeback against disposable Postgres:",
    `${cliCommandName()} demo`,
    "",
  ].join("\n");
}

async function runGuidedQuickDemo(seeded: { proposal_id: string; evidence_bundle_id: string; replay_id: string }, options: { pause: boolean }): Promise<void> {
  const screens = quickDemoGuidedScreens(seeded);
  for (const [index, screen] of screens.entries()) {
    printStep(screen.title, screen.body, index + 1, screens.length);
    if (index < screens.length - 1) {
      await waitForEnter("Press Enter to continue...", options);
    }
  }
}

function quickDemoGuidedScreens(seeded: { proposal_id: string; evidence_bundle_id: string; replay_id: string }): Array<{ title: string; body: string[] }> {
  return [
    {
      title: "Synapsor Runner quick demo",
      body: [
        "This teaches the Synapsor safety model without Docker, a database, or an MCP client.",
        "",
        "It also creates a local fixture ledger you can inspect.",
      ],
    },
    {
      title: "The risky default",
      body: [
        "Many database MCP demos expose this:",
        "",
        "execute_sql(sql: string)",
        "",
        "That means the model can receive database authority directly.",
      ],
    },
    {
      title: "The Synapsor boundary",
      body: [
        "Synapsor gives the model business tools instead:",
        "",
        "billing.inspect_invoice(invoice_id)",
        "billing.propose_late_fee_waiver(invoice_id, reason)",
        "",
        "The model can ask for a business change.",
        "It cannot commit the write.",
      ],
    },
    {
      title: "What the agent requested",
      body: [
        "billing.propose_late_fee_waiver(invoice_id=\"INV-3001\")",
        "",
        "Proposed change:",
        "late_fee_cents: 5500 -> 0",
        "",
        "Source DB changed:",
        "no",
      ],
    },
    {
      title: "What Synapsor saved",
      body: [
        "Synapsor saved:",
        "",
        "- proposal: what the model requested",
        "- evidence: what data supported it",
        "- query audit: what was read",
        "- replay: what happened later",
        "",
        `Proposal: ${seeded.proposal_id}`,
        `Evidence: ${seeded.evidence_bundle_id}`,
        `Replay: ${seeded.replay_id}`,
        "",
        "Local ledger:",
        quickDemoStorePath,
      ],
    },
    {
      title: "Inspect it",
      body: [
        "Run this next:",
        "",
        "npx -y -p @synapsor/runner synapsor-runner demo inspect",
        "",
        "demo inspect shows the proposal, evidence, activity search, and replay commands.",
        "",
        "If installed globally, use:",
        "synapsor-runner demo inspect",
      ],
    },
    {
      title: "Next paths",
      body: [
        "Full disposable Postgres demo:",
        `${cliCommandName()} demo`,
        "",
        "Audit risky MCP database tools:",
        `${cliCommandName()} audit --example dangerous-db-mcp`,
        "",
        "Use your own staging DB:",
        "export DATABASE_URL=\"postgres://...\"",
        `${cliCommandName()} onboard db --from-env DATABASE_URL`,
        "",
        "Done. You just saw Synapsor's core boundary: business tools for the model, approval/writeback outside the model, and replay for inspection.",
      ],
    },
  ];
}

function printStep(title: string, body: string[], index: number, total: number): void {
  const divider = "------------------------------------------------------------";
  process.stdout.write([
    "",
    divider,
    `Step ${index}/${total}: ${title}`,
    divider,
    "",
    ...body,
    "",
  ].join("\n"));
}

async function waitForEnter(message: string, options: { pause: boolean }): Promise<void> {
  if (!options.pause) {
    process.stdout.write(`${message}\n`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message} `);
  } finally {
    rl.close();
  }
}

function quickDemoInspectCommands(useNpx: boolean): Array<{ label: string; command: string; description: string }> {
  const cmd = useNpx ? "npx -y -p @synapsor/runner synapsor-runner" : cliCommandName();
  return [
    {
      label: "Proposal summary",
      description: "See what the model asked to change.",
      command: `${cmd} proposals show latest --store ${quickDemoStorePath}`,
    },
    {
      label: "Evidence",
      description: "Inspect rows and evidence items captured for the proposal.",
      command: `${cmd} evidence show ev_quick_INV_3001 --store ${quickDemoStorePath}`,
    },
    {
      label: "Activity search",
      description: "Find the local ledger records for invoice INV-3001.",
      command: `${cmd} activity search --object invoice:INV-3001 --store ${quickDemoStorePath}`,
    },
    {
      label: "Replay",
      description: "Replay the local proposal/evidence/audit story.",
      command: `${cmd} replay show latest --store ${quickDemoStorePath}`,
    },
    {
      label: "Approve outside MCP",
      description: "Approve the proposal through the local operator boundary.",
      command: `${cmd} proposals approve latest --yes --store ${quickDemoStorePath}`,
    },
    {
      label: "Full Docker-backed demo",
      description: "Run the disposable Postgres-backed proof.",
      command: `${cmd} demo`,
    },
    {
      label: "Audit risky MCP database tools",
      description: "Review common dangerous MCP tool shapes.",
      command: `${cmd} audit --example dangerous-db-mcp`,
    },
  ];
}

function formatQuickDemoInspect(commands: Array<{ label: string; command: string; description: string }>): string {
  return [
    "Quick demo inspection",
    "",
    "Local ledger:",
    quickDemoStorePath,
    "",
    ...commands.flatMap((item, index) => [
      `${index + 1}. ${item.label}`,
      `   ${item.description}`,
      `   ${item.command}`,
      "",
    ]),
  ].join("\n");
}

async function seedQuickDemoStore(storePath: string): Promise<{ proposal_id: string; evidence_bundle_id: string; replay_id: string }> {
  const resolved = path.resolve(storePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.rm(resolved, { force: true });
  const store = new ProposalStore(resolved);
  try {
    const changeSet = quickDemoChangeSet();
    const proposal = store.createProposal(changeSet);
    store.recordEvidenceBundle({
      evidence_bundle_id: changeSet.evidence.bundle_id,
      proposal_id: proposal.proposal_id,
      tenant_id: changeSet.scope.tenant_id,
      payload: {
        capability: changeSet.action,
        proposal_id: proposal.proposal_id,
        source_id: changeSet.source.source_id,
        target: `${changeSet.source.schema}.${changeSet.source.table}`,
        principal: changeSet.principal.id,
        tenant_id: changeSet.scope.tenant_id,
        business_object: changeSet.scope.business_object,
        object_id: changeSet.scope.object_id,
        query_fingerprint: changeSet.evidence.query_fingerprint,
        source_database_changed: false,
      },
      items: [
        {
          kind: "external_row",
          source_id: changeSet.source.source_id,
          table: `${changeSet.source.schema}.${changeSet.source.table}`,
          primary_key: changeSet.source.primary_key,
          tenant: changeSet.guards.tenant,
          visible_row: changeSet.before,
        },
        {
          kind: "proposal_diff",
          before: changeSet.before,
          patch: changeSet.patch,
          after: changeSet.after,
        },
      ],
    });
    store.recordQueryAudit({
      proposal_id: proposal.proposal_id,
      evidence_bundle_id: changeSet.evidence.bundle_id,
      source_id: changeSet.source.source_id,
      query_fingerprint: changeSet.evidence.query_fingerprint,
      table_name: `${changeSet.source.schema}.${changeSet.source.table}`,
      row_count: 1,
      payload: {
        capability: changeSet.action,
        tenant_bound: true,
        statement_template: "SELECT id, tenant_id, updated_at, late_fee_cents FROM invoices WHERE id = ? AND tenant_id = ? LIMIT 1",
        parameters_redacted: true,
      },
    });
    store.replay(proposal.proposal_id);
    return {
      proposal_id: proposal.proposal_id,
      evidence_bundle_id: changeSet.evidence.bundle_id,
      replay_id: `replay_${proposal.proposal_id}`,
    };
  } finally {
    store.close();
  }
}

function quickDemoChangeSet(): ChangeSetV1 {
  const base = {
    schema_version: protocolVersions.changeSet,
    proposal_id: "wrp_quick_INV_3001",
    proposal_version: 1,
    action: "billing.propose_late_fee_waiver",
    mode: "review_required",
    principal: {
      id: "support.agent",
      source: "trusted_session",
    },
    scope: {
      tenant_id: "acme",
      business_object: "invoice",
      object_id: "INV-3001",
    },
    source: {
      kind: "external_postgres",
      source_id: "app_postgres",
      schema: "public",
      table: "invoices",
      primary_key: {
        column: "id",
        value: "INV-3001",
      },
    },
    before: {
      id: "INV-3001",
      tenant_id: "acme",
      updated_at: "2026-06-23T09:00:00Z",
      late_fee_cents: 5500,
    },
    patch: {
      late_fee_cents: 0,
    },
    after: {
      id: "INV-3001",
      tenant_id: "acme",
      updated_at: "2026-06-23T09:00:00Z",
      late_fee_cents: 0,
    },
    guards: {
      tenant: {
        column: "tenant_id",
        value: "acme",
      },
      allowed_columns: ["late_fee_cents"],
      expected_version: {
        column: "updated_at",
        value: "2026-06-23T09:00:00Z",
      },
    },
    evidence: {
      bundle_id: "ev_quick_INV_3001",
      query_fingerprint: "sha256:quick-demo-invoice-read",
      items: [
        {
          kind: "external_row",
          source_id: "app_postgres",
          table: "public.invoices",
          primary_key: { column: "id", value: "INV-3001" },
        },
      ],
    },
    approval: {
      status: "pending",
      required_role: "local_operator",
    },
    writeback: {
      status: "not_applied",
      mode: "trusted_worker_required",
    },
    source_database_mutated: false,
    integrity: {
      proposal_hash: "sha256:placeholder",
    },
    created_at: "2026-06-23T09:00:00Z",
  } satisfies Omit<ChangeSetV1, "integrity"> & { integrity: { proposal_hash: `sha256:${string}` } };
  return {
    ...base,
    integrity: {
      proposal_hash: hashReceipt({ ...base, integrity: undefined }),
    },
  };
}

async function mcpServe(args: string[]): Promise<number> {
  const transport = optionalArg(args, "--transport") ?? "stdio";
  if (transport === "streamable-http") return mcpServeStreamableHttp(args);
  if (transport === "http" || transport === "json-rpc-http" || transport === "jsonrpc-http") return mcpServeHttp(args);
  if (transport !== "stdio") throw new Error("--transport must be stdio, streamable-http, or http");
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG;
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath ?? defaultConfigPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  const toolNameStyle = toolNameStyleOption(args);
  const resultFormat = resultFormatOption(args);
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "stdio", args.includes("--allow-concurrent-store"));
  try {
    await serveStdio({
      configPath,
      storePath,
      config,
      toolNameStyle,
      resultFormat,
    });
    return 0;
  } finally {
    await releaseLease();
  }
}

async function mcpServeHttp(args: string[]): Promise<number> {
  process.stderr.write([
    "Warning: mcp serve-http is a legacy JSON-RPC bridge, not spec MCP Streamable HTTP.",
    `For OpenAI Agents SDK or standard HTTP MCP clients, use: ${cliCommandName()} mcp serve --transport streamable-http`,
    "",
  ].join("\n"));
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG;
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath ?? defaultConfigPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  assertReceiptTopologyForTransport(config, "http");
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8765");
  const resultFormat = resultFormatOption(args);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (host === "0.0.0.0") {
    process.stderr.write("Warning: binding Synapsor Runner HTTP MCP to 0.0.0.0 exposes model-facing tools on the network. Use TLS, private networking, authentication, and rate limits.\n");
  }
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "legacy-jsonrpc", args.includes("--allow-concurrent-store"));
  let server: Awaited<ReturnType<typeof startHttpMcpServer>>;
  try {
    server = await startHttpMcpServer({
      configPath,
      config,
      storePath,
      host,
      port,
      authTokenEnv: optionalArg(args, "--auth-token-env") ?? "SYNAPSOR_RUNNER_HTTP_TOKEN",
      devNoAuth: args.includes("--dev-no-auth"),
      corsOrigin: optionalArg(args, "--cors-origin"),
      resultFormat,
    });
  } catch (error) {
    await releaseLease();
    throw error;
  }
  process.stderr.write("Press Ctrl+C to stop.\n");
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      await releaseLease();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function mcpServeStreamableHttp(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG;
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath ?? defaultConfigPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  assertReceiptTopologyForTransport(config, "streamable-http");
  const toolNameStyle = toolNameStyleOption(args);
  const resultFormat = resultFormatOption(args);
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8766");
  const tls = streamableHttpTlsOptions(args, process.env);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (host === "0.0.0.0") {
    process.stderr.write("Warning: binding Synapsor Runner Streamable HTTP MCP to 0.0.0.0 exposes model-facing tools on the network. Use TLS, private networking, authentication, and rate limits.\n");
  }
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE;
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "streamable-http", args.includes("--allow-concurrent-store"));
  let server: Awaited<ReturnType<typeof startStreamableHttpMcpServer>>;
  try {
    server = await startStreamableHttpMcpServer({
      configPath,
      config,
      storePath,
      host,
      port,
      toolNameStyle,
      authTokenEnv: optionalArg(args, "--auth-token-env") ?? "SYNAPSOR_RUNNER_HTTP_TOKEN",
      devNoAuth: args.includes("--dev-no-auth"),
      corsOrigin: optionalArg(args, "--cors-origin"),
      resultFormat,
      tls,
    });
  } catch (error) {
    await releaseLease();
    throw error;
  }
  process.stderr.write("Press Ctrl+C to stop.\n");
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      await releaseLease();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function mcpServeLeaseStorePath(config: RuntimeConfig, storePath: string | undefined): string | undefined {
  // In runtime_store mode, the MCP server never opens the local SQLite ledger.
  // Holding a SQLite lease would be misleading and can block unrelated local
  // inspection/reset commands for a file the server is not using.
  return config.storage?.shared_postgres?.mode === "runtime_store" ? ":memory:" : storePath;
}

function assertReceiptTopologyForTransport(config: RuntimeConfig, transport: string): void {
  if (transport === "stdio" || config.mode !== "review") return;
  const runnerLedgerSources = Object.entries(config.sources ?? {}).filter(([sourceName, source]) =>
    source.receipts?.authority === "runner_ledger" && sourceNeedsSqlWriteback(config, sourceName));
  if (runnerLedgerSources.length === 0) return;
  if (config.storage?.shared_postgres?.mode !== "runtime_store") {
    throw new Error(`Networked MCP with runner_ledger writeback requires storage.shared_postgres.mode runtime_store. Local SQLite is supported only for one local stdio/operator process. Unsafe sources: ${runnerLedgerSources.map(([name]) => name).join(", ")}.`);
  }
}

function streamableHttpTlsOptions(args: string[], env: NodeJS.ProcessEnv): StreamableHttpTlsOptions | undefined {
  const certEnv = optionalArg(args, "--tls-cert-env");
  const keyEnv = optionalArg(args, "--tls-key-env");
  const caEnv = optionalArg(args, "--tls-ca-env");
  const requestClientCert = args.includes("--require-client-cert");
  if (!certEnv && !keyEnv && !caEnv && !requestClientCert) return undefined;
  if (!certEnv || !keyEnv) throw new Error("Streamable HTTP TLS requires both --tls-cert-env and --tls-key-env.");
  const cert = envValue(env, certEnv);
  const key = envValue(env, keyEnv);
  const ca = caEnv ? envValue(env, caEnv) : undefined;
  if (!cert) throw new Error(`${certEnv} is not set or is empty.`);
  if (!key) throw new Error(`${keyEnv} is not set or is empty.`);
  if (requestClientCert && !ca) throw new Error("--require-client-cert requires --tls-ca-env with the trusted client CA bundle.");
  return { cert, key, ca, requestClientCert };
}

type StoreLease = {
  pid: number;
  mode: string;
  transport: string;
  store_path: string;
  started_at: string;
};

async function writeStoreLease(storePath: string | undefined, mode: string, transport: string, allowConcurrent: boolean): Promise<() => Promise<void>> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return async () => undefined;
  await assertNoActiveStoreLease(resolved, allowConcurrent, "serve");
  const leasePath = storeLeasePath(resolved);
  const lease: StoreLease = {
    pid: process.pid,
    mode,
    transport,
    store_path: resolved,
    started_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return async () => {
    const current = await readStoreLease(resolved);
    if (current?.pid === process.pid && current.transport === transport) {
      await fs.rm(leasePath, { force: true });
    }
  };
}

async function assertNoActiveStoreLease(storePath: string | undefined, force: boolean, operation: string): Promise<void> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return;
  const lease = await readStoreLease(resolved);
  if (!lease) return;
  if (!pidIsActive(lease.pid)) {
    await fs.rm(storeLeasePath(resolved), { force: true });
    return;
  }
  const message = `Local store appears active for ${lease.mode}/${lease.transport} (pid ${lease.pid}, started ${lease.started_at}). Refusing ${operation}. Stop the server or rerun with --allow-concurrent-store/--force if you have verified it is safe.`;
  if (!force) throw new Error(message);
  process.stderr.write(`Warning: ${message}\n`);
}

function resolveStorePathForLease(storePath: string | undefined): string | undefined {
  const value = storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  if (value === ":memory:") return undefined;
  return path.resolve(value);
}

function storeLeasePath(resolvedStorePath: string): string {
  return `${resolvedStorePath}.lease.json`;
}

async function readStoreLease(storePath: string | undefined): Promise<StoreLease | undefined> {
  const resolved = resolveStorePathForLease(storePath);
  if (!resolved) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(storeLeasePath(resolved), "utf8")) as Partial<StoreLease>;
    if (typeof parsed.pid !== "number" || typeof parsed.mode !== "string" || typeof parsed.transport !== "string" || typeof parsed.started_at !== "string") {
      return undefined;
    }
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      transport: parsed.transport,
      store_path: typeof parsed.store_path === "string" ? parsed.store_path : resolved,
      started_at: parsed.started_at,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function pidIsActive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function toolNameStyleOption(args: string[]): ToolNameStyle {
  const requestedStyle = optionalArg(args, "--tool-name-style");
  const requestedAliasMode = optionalArg(args, "--alias-mode");
  if (requestedStyle && requestedAliasMode && requestedStyle !== requestedAliasMode) {
    throw new Error("--tool-name-style and --alias-mode must match when both are provided");
  }
  const requested = requestedAliasMode ?? requestedStyle;
  if (args.includes("--openai-tool-aliases")) {
    if (requested && requested !== "openai") throw new Error("--openai-tool-aliases cannot be combined with a non-openai alias mode");
    return "openai";
  }
  if (!requested) return "canonical";
  if (requested === "canonical" || requested === "openai" || requested === "both") return requested;
  throw new Error("--alias-mode must be canonical, openai, or both");
}

function resultFormatOption(args: string[]): ResultFormat | undefined {
  const requested = optionalArg(args, "--result-format");
  if (!requested) return undefined;
  if (requested === "1" || requested === "v1") return 1;
  if (requested === "2" || requested === "v2") return 2;
  throw new Error("--result-format must be v1, 1, v2, or 2");
}

function normalizeResultFormatAnswer(value: string): "default" | "v1" | "v2" {
  if (value === "1" || value === "v1") return "v1";
  if (value === "2" || value === "v2") return "v2";
  if (value === "default") return "default";
  throw new Error("--result-format must be default, v1, 1, v2, or 2");
}

async function mcpAudit(args: string[]): Promise<number> {
  const format = optionalArg(args, "--format") ?? (args.includes("--json") ? "json" : "text");
  if (!["text", "json", "markdown"].includes(format)) {
    throw new Error("audit --format must be text, json, or markdown");
  }
  const example = optionalArg(args, "--example");
  const target = example ? `example:${example}` : firstPositional(args);
  if (!target) {
    throw new Error("mcp audit requires <target> or --example dangerous-db-mcp");
  }
  const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "5000");
  const payload = example ? builtInMcpAuditExample(example) : await readMcpAuditTarget(target, args, timeoutMs);
  const report = auditMcpManifest(payload, { target });
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(formatMcpAuditMarkdown(report));
  else process.stdout.write(formatMcpAuditReport(report));
  return 0;
}

async function propose(args: string[]): Promise<number> {
  const capabilityName = firstPositional(args);
  if (!capabilityName) throw new Error("propose requires <capability-name>");
  const configPath = optionalArg(args, "--config") ?? defaultConfigPath;
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? defaultStorePath;
  const config = await readRuntimeConfig(configPath);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `propose ${capabilityName}`, () => propose(withoutSharedPostgresLedgerMirror(args)), config);
  }
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
    await runtime.close();
  }
}

async function audit(args: string[]): Promise<number> {
  const url = optionalArg(args, "--url");
  const stdio = optionalArg(args, "--stdio");
  const mcpConfig = optionalArg(args, "--mcp-config");
  const example = optionalArg(args, "--example");
  const target = example ? `example:${example}` : url ?? (stdio ? `stdio:${stdio}` : mcpConfig ?? firstPositional(args));
  if (!target) throw new Error("audit requires <target>, --example dangerous-db-mcp, --mcp-config <path>, --stdio <command>, or --url <url>");
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
    if (spec.type === "object_array") {
      input[name] = [Object.fromEntries(Object.entries(spec.fields).map(([fieldName, fieldSpec]) => [fieldName, sampleScalarArg(fieldName, fieldSpec)]))];
      continue;
    }
    if (name === capability.lookup.id_from_arg) input[name] = sampleIdForCapability(capability, name);
    else if (/reason/i.test(name)) input[name] = sampleReasonForCapability(capability);
    else if (/resolution/i.test(name)) input[name] = "Resolved after reviewing policy evidence.";
    else if (spec.enum?.length) input[name] = spec.enum[0];
    else if (/status/i.test(name)) input[name] = "pending_review";
    else if (/amount|cents|fee|credit|balance/i.test(name)) input[name] = typeof spec.maximum === "number" ? Math.min(spec.maximum, 1000) : 0;
    else if (spec.type === "number") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
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

function sampleScalarArg(name: string, spec: Exclude<RuntimeCapabilityConfig["args"][string], { type: "object_array" }>): unknown {
  if (spec.enum?.length) return spec.enum[0];
  if (/reason/i.test(name)) return "Reviewed sample reason.";
  if (/status/i.test(name)) return "pending_review";
  if (spec.type === "number") return spec.minimum ?? (typeof spec.maximum === "number" ? Math.min(spec.maximum, 1000) : 1);
  if (spec.type === "boolean") return true;
  return `sample_${name}`;
}

function sampleIdForCapability(capability: RuntimeCapabilityConfig, argName: string): string {
  const text = `${capability.name} ${capability.target.table} ${argName}`.toLowerCase();
  const arg = argName.toLowerCase();
  if (/invoice|billing/.test(text)) return "INV-3001";
  if (/account|customer/.test(arg) || /accounts|customers/.test(text)) return "cust_acme_1";
  if (/ticket|support/.test(text)) return "T-1042";
  if (/order/.test(text)) return "O-1001";
  return "sample_1";
}

function sampleReasonForCapability(capability: RuntimeCapabilityConfig): string {
  const text = `${capability.name} ${capability.target.table}`.toLowerCase();
  if (/order|status_change/.test(text)) return "payment cleared and ready for the next status";
  if (/credit|customer|account/.test(text)) return "support goodwill credit";
  if (/late_fee|waiver|billing|invoice/.test(text)) return "approved support waiver";
  return "reviewed and approved by support";
}

function formatProposeResult(capabilityName: string, result: Record<string, unknown>, storePath: string): string {
  const proposalId = String(result.proposal_id ?? "");
  const evidenceId = String(result.evidence_bundle_id ?? "");
  const sourceChanged = result.source_database_changed === true || result.source_database_mutated === true;
  const status = String(result.status ?? "review_required");
  const approval = isRecord(result.approval) ? result.approval : undefined;
  const autoApproved = status === "approved" && approval?.mode === "policy";
  const lines = [
    autoApproved ? "Proposal created and policy-approved." : "Proposal created.",
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
    "Approval:",
    autoApproved ? `approved by policy ${String(approval?.policy ?? "")}` : "required outside MCP",
    "",
    "Review:",
    `${cliCommandName()} proposals show ${proposalId || "latest"} --store ${storePath}`,
    ...(autoApproved ? [] : [`${cliCommandName()} proposals approve ${proposalId || "latest"} --store ${storePath}`]),
    `${cliCommandName()} apply ${proposalId || "latest"} --store ${storePath}`,
    `${cliCommandName()} replay ${proposalId || "latest"} --store ${storePath}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function mcpConfigure(args: string[]): Promise<number> {
  const client = normalizeMcpClientName(optionalArg(args, "--client"));
  if (!client) throw new Error("mcp configure requires --client generic-stdio|claude|claude-desktop|cursor|vscode|openai-agents");
  const useAbsolutePaths = args.includes("--absolute-paths");
  const rawConfigPath = optionalArg(args, "--config") ?? "./synapsor.runner.json";
  const rawStorePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const configPath = useAbsolutePaths ? path.resolve(rawConfigPath) : rawConfigPath;
  const storePath = useAbsolutePaths ? path.resolve(rawStorePath) : rawStorePath;
  const transport = mcpClientConfigTransport(args, client);
  const aliasMode = mcpClientConfigAliasMode(args, client);
  const includeInstructions = args.includes("--include-instructions");
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8766");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  const authTokenEnv = optionalArg(args, "--auth-token-env") ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  if (!await fileExists(rawConfigPath)) {
    process.stderr.write(`Warning: config path does not exist yet: ${rawConfigPath}\n`);
  }
  if (transport === "stdio" && (!path.isAbsolute(configPath) || !path.isAbsolute(storePath))) {
    process.stderr.write("Warning: relative paths are resolved by the MCP client working directory. Use --absolute-paths if the client runs from another directory.\n");
  }
  const snippet = mcpClientSnippet(client, configPath, storePath, { transport, aliasMode, host, port, authTokenEnv });
  if (includeInstructions) {
    snippet.agent_instructions = mcpAgentInstructions(client, aliasMode);
  }
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
  return mcpConfigure(["--client", normalizeMcpClientName(client) ?? client, ...rest]);
}

function normalizeMcpClientName(client: string | undefined): string | undefined {
  if (client === "claude") return "claude-desktop";
  return client;
}

type McpClientSnippetOptions = {
  transport: "stdio" | "streamable-http";
  aliasMode: ToolNameStyle;
  host: string;
  port: number;
  authTokenEnv: string;
};

function mcpClientConfigTransport(args: string[], client: string): "stdio" | "streamable-http" {
  const requested = optionalArg(args, "--transport") ?? (client === "openai-agents" ? "streamable-http" : "stdio");
  if (requested === "stdio" || requested === "streamable-http") return requested;
  if (requested === "http" || requested === "json-rpc-http" || requested === "jsonrpc-http") {
    throw new Error("mcp config uses stdio or streamable-http. The lightweight JSON-RPC HTTP bridge is not a standard MCP client transport.");
  }
  throw new Error("--transport must be stdio or streamable-http");
}

function mcpClientConfigAliasMode(args: string[], client: string): ToolNameStyle {
  const requested = optionalArg(args, "--alias-mode");
  const aliasMode = requested ?? (args.includes("--openai-tool-aliases") ? "openai" : client === "openai-agents" ? "openai" : "canonical");
  if (aliasMode === "canonical" || aliasMode === "openai" || aliasMode === "both") return aliasMode;
  throw new Error("--alias-mode must be canonical, openai, or both");
}

function serveArgsForClient(configPath: string, storePath: string, options: McpClientSnippetOptions): string[] {
  const args = options.transport === "streamable-http"
    ? [
      "mcp",
      "serve-streamable-http",
      "--config",
      configPath,
      "--store",
      storePath,
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--auth-token-env",
      options.authTokenEnv,
    ]
    : ["mcp", "serve", "--config", configPath, "--store", storePath];
  if (options.aliasMode !== "canonical") args.push("--alias-mode", options.aliasMode);
  return args;
}

function mcpClientSnippet(client: string, configPath: string, storePath: string, options: McpClientSnippetOptions): Record<string, unknown> {
  const command = cliCommandName();
  const args = serveArgsForClient(configPath, storePath, options);
  if (client === "generic" || client === "generic-stdio") return { command, args };
  if (client === "claude-desktop" || client === "cursor") {
    if (options.transport !== "stdio") throw new Error(`${client} config output currently supports stdio. Use --transport stdio.`);
    return { mcpServers: { synapsor: { command, args } } };
  }
  if (client === "vscode") {
    if (options.transport !== "stdio") throw new Error("vscode config output currently supports stdio. Use --transport stdio.");
    return { servers: { synapsor: { type: "stdio", command, args } } };
  }
  if (client === "openai-agents") {
    if (options.transport !== "streamable-http") throw new Error("openai-agents config output uses Streamable HTTP. Use --transport streamable-http.");
    const url = `http://${options.host}:${options.port}/mcp`;
    return {
      transport: "streamable-http",
      start_server: {
        command,
        args,
        env: {
          [options.authTokenEnv]: "<set-a-random-local-token>",
        },
      },
      openai_agents_sdk: {
        package: "openai-agents",
        url,
        headers_from_env: {
          Authorization: `Bearer $${options.authTokenEnv}`,
        },
        python: [
          "import os",
          "from agents.mcp import MCPServerStreamableHttp",
          "",
          "synapsor_mcp = MCPServerStreamableHttp(",
          `    params={`,
          `        "url": "${url}",`,
          `        "headers": {"Authorization": f"Bearer {os.environ['${options.authTokenEnv}']}"},`,
          "    }",
          ")",
        ].join("\n"),
      },
      tool_names: {
        canonical: "billing.inspect_invoice",
        model_visible_with_alias_mode_openai: "billing__inspect_invoice",
        alias_mode: options.aliasMode,
      },
      notes: [
        "Start the local Streamable HTTP MCP server before creating the OpenAI Agents SDK server.",
        "OpenAI-facing configs should use --alias-mode openai because OpenAI function names cannot contain dots.",
        "Runner maps aliases back to canonical Synapsor capability names and includes the canonical name in MCP tool metadata.",
        "This config contains no database URLs, write credentials, API keys, or bearer token values.",
      ],
    };
  }
  throw new Error(`unsupported MCP client: ${client}`);
}

function mcpAgentInstructions(client: string, aliasMode: ToolNameStyle): Record<string, unknown> {
  const toolNameNote = aliasMode === "openai"
    ? "OpenAI-facing tool names may use aliases such as billing__inspect_invoice. Treat the canonical Synapsor capability name in tool metadata/results as the audit name."
    : "Use the model-visible Synapsor tool names exactly as listed by the MCP client.";
  return {
    target_client: client,
    alias_mode: aliasMode,
    recommended_system_prompt: [
      "Use Synapsor Runner tools in a propose-first pattern.",
      "Inspect relevant records, policy rows, and other evidence before proposing a change.",
      "Do not claim a database change was committed unless a result says source_database_changed: true.",
      "Proposal tools create reviewable proposals only; they do not commit writes.",
      "You cannot approve, apply, commit, or write back through model-facing MCP tools.",
      "On VERSION_CONFLICT, re-inspect the record before proposing again.",
      "Evidence handles are audit/replay handles; you do not need to call them during the turn.",
      toolNameNote,
    ].join(" "),
    checklist: [
      "Inspect evidence before proposing.",
      "Use trusted session scope; never ask the user/model for tenant or principal values.",
      "Report proposal ids and source_database_changed exactly from the tool result.",
      "If ok is false, follow error.code. On TEMPORARILY_UNAVAILABLE, retry later. On NOT_FOUND_IN_TENANT, do not infer cross-tenant existence.",
    ],
  };
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

async function smokeCall(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? defaultConfigPath;
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? defaultStorePath;
  const config = await readRuntimeConfig(configPath);
  const env = envWithDemoDefaults(config, configPath);
  const runtime = createMcpRuntime(config, { storePath, env });
  try {
    const tools = runtime.listTools();
    const requestedTool = firstPositional(args);
    const toolName = requestedTool ?? (tools.length === 1 ? tools[0]?.name : undefined);
    if (!toolName) {
      throw new Error(`smoke call needs <capability-name> because ${tools.length} tools are exposed: ${tools.map((tool) => tool.name).join(", ") || "none"}`);
    }
    const capability = (config.capabilities ?? []).find((item) => item.name === toolName);
    if (!capability && config.mode !== "cloud") throw new Error(`capability not found in ${configPath}: ${toolName}`);
    const input = capability ? await smokeToolInput(args, capability) : await smokeInputFromArgs(args);
    const result = await runtime.callTool(toolName, input);
    const ok = result.ok !== false;
    const storeAuthority = config.storage?.shared_postgres?.mode === "runtime_store" ? "shared_postgres" : "local_sqlite";
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ok,
        tool: toolName,
        input,
        result,
        store_path: storePath,
        store_authority: storeAuthority,
        ...(storeAuthority === "shared_postgres"
          ? { shared_postgres_schema: config.storage?.shared_postgres?.schema ?? "synapsor_runner" }
          : {}),
      }, null, 2)}\n`);
    } else {
      process.stdout.write(formatSmokeCallResult(toolName, input, result, {
        configPath,
        storePath,
        storeAuthority,
        sharedPostgresSchema: config.storage?.shared_postgres?.schema ?? "synapsor_runner",
      }));
    }
    return ok ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

async function toolsPreview(args: string[]): Promise<number> {
  const boundary = await inspectMcpToolBoundary(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: boundary.ok,
      config_path: boundary.configPath,
      store_path: boundary.storePath,
      alias_mode: boundary.aliasMode,
      auto_approval: boundary.autoApprovalDisabled ? "disabled" : "enabled",
      exposed_to_mcp: boundary.names,
      alias_mappings: boundary.exposures,
      approval_policies: boundary.approvalPolicies,
      capability_details: boundary.capabilityDetails,
      not_exposed_to_mcp: defaultBlockedToolSurface(),
      graduated_trust: boundary.graduatedTrust,
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
  aliasMode: ToolNameStyle;
  names: string[];
  exposures: Array<{ canonicalName: string; exposedName: string; isAlias: boolean; style: ToolNameStyle }>;
  autoApprovalDisabled: boolean;
  approvalPolicies: Array<{ capability: string; policy: string; limits: unknown[] }>;
  capabilityDetails: ToolPreviewCapabilityDetail[];
  governance: LocalDoctorGovernance;
  graduatedTrust: { enabled: boolean; kill_switch: boolean; criteria: number; model_facing: false };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const configPath = optionalArg(args, "--config") ?? "./synapsor.runner.json";
  const storePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const aliasMode = args.includes("--aliases") && !optionalArg(args, "--alias-mode") && !optionalArg(args, "--tool-name-style")
    ? "both"
    : toolNameStyleOption(args);
  if (!await fileExists(configPath)) {
    throw new Error(`MCP tool preview could not find ${configPath}.\n\nWhy it matters:\nThe MCP server needs a reviewed config before it can expose semantic tools.\n\nFix:\nRun ${cliCommandName()} onboard db --from-env DATABASE_URL, or pass --config <path>.`);
  }
  const parsed = await readRuntimeConfig(configPath);
  const runtime = createMcpRuntime(parsed, { storePath });
  try {
    const tools = runtime.listTools();
    const autoApprovalDisabled = parsed.approvals?.disable_auto_approval === true;
    const approvalPolicies = approvalPolicySummaries(parsed);
    const capabilityDetails = toolPreviewCapabilityDetails(parsed);
    const cloudSync = await runtime.cloudSyncStatus();
    const governance: LocalDoctorGovernance = {
      ...cloudSync,
      queue_when_unavailable: parsed.governance?.mode === "cloud_linked" && parsed.governance.queue_when_unavailable !== false,
    };
    const graduatedTrust = {
      enabled: parsed.graduated_trust?.enabled === true,
      kill_switch: parsed.graduated_trust?.kill_switch === true,
      criteria: parsed.graduated_trust?.criteria?.length ?? 0,
      model_facing: false as const,
    };
    const exposures = toolNameExposures(tools.map((tool) => tool.name), aliasMode);
    const names = exposures.map((item) => item.exposedName);
    const serialized = JSON.stringify(tools);
    const checks = [
      { name: "semantic tools present", ok: names.length > 0, detail: names.join(", ") || "none" },
      { name: "execute_sql absent", ok: !names.some((name) => /execute_sql|run_query|query_database/i.test(name)), detail: "model does not receive raw SQL tools" },
      { name: "approval tools absent", ok: !names.some((name) => /approve/i.test(name)), detail: "approval stays outside MCP" },
      { name: "policy recommendation tools absent", ok: !names.some((name) => /policy.*recommend|recommend.*policy|activate.*policy/i.test(name)), detail: "graduated-trust evaluation, review, export, and activation stay outside MCP" },
      { name: "commit tools absent", ok: !names.some((name) => /commit|apply_writeback/i.test(name)), detail: "commit stays outside MCP" },
      { name: "database_url absent", ok: !/postgres(?:ql)?:\/\/|mysql:\/\//i.test(serialized), detail: "MCP config uses env var names, not connection strings" },
      { name: "write credentials absent", ok: !/(password|secret|bearer|private[_-]?key|token)/i.test(serialized), detail: "MCP tools do not include write credentials" },
    ];
    const ok = checks.every((check) => check.ok);
    return { ok, configPath, storePath, aliasMode, names, exposures, autoApprovalDisabled, approvalPolicies, capabilityDetails, governance, graduatedTrust, checks };
  } finally {
    await runtime.close();
  }
}

function defaultBlockedToolSurface(): string[] {
  return [
    "execute_sql / raw query tools",
    "approval tools",
    "policy recommendation/review/activation tools",
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
  aliasMode: ToolNameStyle;
  names: string[];
  exposures: Array<{ canonicalName: string; exposedName: string; isAlias: boolean; style: ToolNameStyle }>;
  autoApprovalDisabled: boolean;
  approvalPolicies: Array<{ capability: string; policy: string; limits: unknown[] }>;
  capabilityDetails: ToolPreviewCapabilityDetail[];
  governance: LocalDoctorGovernance;
  graduatedTrust: { enabled: boolean; kill_switch: boolean; criteria: number; model_facing: false };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): string {
  const exposedLines = input.exposures.length > 0
    ? input.exposures.map((item) => item.isAlias ? `  - ${item.exposedName} -> ${item.canonicalName}` : `  - ${item.exposedName}`)
    : ["  - (none)"];
  const lines = [
    `Synapsor tools preview: ${input.ok ? "ok" : "failed"}`,
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    `Alias mode: ${input.aliasMode}`,
    `Governance authority: ${input.governance.authority_mode}`,
    `Evidence residency: ${input.governance.evidence_residency}`,
    ...(input.governance.authority_mode === "cloud_linked"
      ? [`Queue proposals while Cloud is unavailable: ${input.governance.queue_when_unavailable ? "yes" : "no"}`]
      : []),
    `auto-approval: ${input.autoApprovalDisabled ? "disabled" : "enabled"}`,
    `graduated trust: ${input.graduatedTrust.enabled ? input.graduatedTrust.kill_switch ? "enabled, kill switch active" : `enabled (${input.graduatedTrust.criteria} reviewed criteria)` : "disabled"}; operator-only, never MCP-facing`,
    ...formatApprovalPolicyPreview(input.approvalPolicies),
    "",
    "Exposed to MCP:",
    ...exposedLines,
    "",
    "Reviewed capability boundary:",
    ...formatToolPreviewCapabilityDetails(input.capabilityDetails),
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

type ToolPreviewCapabilityDetail = {
  name: string;
  kind: "read" | "aggregate_read" | "proposal";
  operation?: "update" | "insert" | "delete";
  cardinality?: "single" | "set";
  target: string;
  tenant_source: string;
  principal_source?: string;
  writable_columns: string[];
  dedup_columns: string[];
  fixed_selection: string[];
  aggregate_bounds: string[];
  version_guard?: string;
  version_advance?: string;
  receipt_mode?: string;
  reversibility?: string;
  approval: string;
  max_rows: number;
  aggregate?: string;
  minimum_group_size?: number;
};

function toolPreviewCapabilityDetails(config: RuntimeConfig): ToolPreviewCapabilityDetail[] {
  return (config.capabilities ?? []).map((capability) => {
    const context = capability.context ? config.contexts?.[capability.context] : config.trusted_context;
    const operation = capability.kind === "proposal" ? capabilityOperation(capability) : undefined;
    const cardinality = capability.kind === "proposal" ? capability.operation?.cardinality ?? "single" : undefined;
    return {
      name: capability.name,
      kind: capability.kind,
      operation,
      cardinality,
      target: `${capability.target.schema}.${capability.target.table}`,
      tenant_source: capability.target.single_tenant_dev
        ? "explicit single-tenant development acknowledgement"
        : `${capability.target.tenant_key ?? "missing tenant key"} from trusted ${context?.provider ?? "context"}`,
      ...(capability.target.principal_scope_key ? {
        principal_source: `${capability.target.principal_scope_key} from required trusted ${context?.provider ?? "context"} binding ${context?.principal_binding ?? "principal"}`,
      } : {}),
      writable_columns: capability.allowed_columns ?? [],
      dedup_columns: capability.operation?.deduplication?.components.map((component) => component.column) ?? [],
      fixed_selection: (capability.operation?.selection?.all ?? capability.aggregate?.selection?.all)?.map((term) => `${term.column} ${term.operator} ${formatScalar(term.value)}`) ?? [],
      aggregate_bounds: capability.operation?.aggregate_bounds?.map((bound) => `${bound.measure}(${bound.column}) <= ${bound.maximum}`) ?? [],
      version_guard: capability.conflict_guard?.column,
      version_advance: capability.operation?.version_advance
        ? `${capability.operation.version_advance.column}:${capability.operation.version_advance.strategy}`
        : undefined,
      receipt_mode: capability.kind === "proposal" ? formatSourceReceiptMode(config.sources?.[capability.source]) : undefined,
      reversibility: capability.kind === "proposal"
        ? capability.reversibility?.mode === "reviewed_inverse"
          ? capabilityOperation(capability) === "delete"
            ? "best-effort unavailable for hard DELETE"
            : "reviewed compensation proposal available after an unambiguous applied receipt"
          : "not configured"
        : undefined,
      approval: capability.kind === "proposal"
        ? `${capability.approval?.mode ?? "human"}${capability.approval?.required_role ? ` role=${capability.approval.required_role}` : ""} quorum=${capability.approval?.required_approvals ?? 1}`
        : "not applicable",
      max_rows: capability.kind === "aggregate_read" ? 0 : cardinality === "set" ? capability.operation?.max_rows ?? 0 : capability.max_rows ?? 1,
      aggregate: capability.aggregate
        ? `${capability.aggregate.function.toUpperCase()}(${capability.aggregate.function === "count" && capability.aggregate.count_mode !== "non_null" ? "*" : capability.aggregate.column})`
        : undefined,
      minimum_group_size: capability.aggregate?.minimum_group_size,
    };
  });
}

function formatToolPreviewCapabilityDetails(details: ToolPreviewCapabilityDetail[]): string[] {
  if (details.length === 0) return ["  - (none)"];
  return details.flatMap((detail) => [
    `  - ${detail.name}: ${detail.kind}${detail.operation ? ` ${detail.cardinality === "set" ? "BOUNDED SET " : "SINGLE-ROW "}${detail.operation.toUpperCase()}` : ""}`,
    detail.kind === "aggregate_read"
      ? `    target: ${detail.target}; output: one ${detail.aggregate} scalar; minimum group size: ${detail.minimum_group_size}`
      : `    target: ${detail.target}; max rows: ${detail.max_rows}`,
    `    tenant: ${detail.tenant_source}`,
    ...(detail.principal_source ? [`    principal row lock: ${detail.principal_source} (AND tenant)`] : []),
    ...(detail.kind === "aggregate_read" ? [
      `    fixed selection: ${detail.fixed_selection.join(" AND ") || "tenant scope only"}`,
      "    privacy: member rows and identities are never returned or stored as evidence items",
    ] : []),
    ...(detail.kind === "proposal" ? [
      `    writable columns: ${detail.writable_columns.join(", ") || "none"}`,
      `    dedup: ${detail.dedup_columns.join(", ") || "not applicable"}`,
      ...(detail.cardinality === "set" ? [
        `    fixed selection: ${detail.fixed_selection.join(" AND ") || "exact reviewed batch items"}`,
        `    aggregate bounds: ${detail.aggregate_bounds.join("; ") || "missing"}`,
        "    set approval: human/operator required; policy auto-approval unavailable",
      ] : []),
      `    version guard: ${detail.version_guard ?? "not applicable"}${detail.version_advance ? `; advance: ${detail.version_advance}` : ""}`,
      `    receipts: ${detail.receipt_mode ?? "not configured"}; approval: ${detail.approval}`,
      `    reversibility: ${detail.reversibility ?? "not applicable"}`,
    ] : []),
  ]);
}

function approvalPolicySummaries(config: RuntimeConfig): Array<{ capability: string; policy: string; limits: unknown[] }> {
  const policies = new Map((config.policies ?? []).map((policy) => [policy.name, policy]));
  return (config.capabilities ?? []).flatMap((capability) => {
    const policyName = capability.approval?.mode === "policy" ? capability.approval.policy : undefined;
    if (!policyName) return [];
    return [{ capability: capability.name, policy: policyName, limits: policies.get(policyName)?.limits ?? [] }];
  });
}

function formatApprovalPolicyPreview(policies: Array<{ capability: string; policy: string; limits: unknown[] }>): string[] {
  if (policies.length === 0) return [];
  const lines = ["", "Reviewed auto-approval policies:"];
  for (const item of policies) {
    lines.push(`  - ${item.capability}: ${item.policy}`);
    if (item.limits.length === 0) lines.push("    aggregate limits: none (do not schedule unattended batch apply)");
    for (const raw of item.limits) {
      if (!isRecord(raw)) continue;
      const scope = raw.scope === "tenant_policy_object" ? "tenant + policy + object" : "tenant + policy";
      const description = raw.kind === "total"
        ? `total ${String(raw.field)} <= ${String(raw.max)}`
        : `count <= ${String(raw.max)}`;
      lines.push(`    ${description} per ${String(raw.period)} (${scope})`);
    }
  }
  return lines;
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

async function smokeToolInput(args: string[], capability: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  if (!args.includes("--sample") && !optionalArg(args, "--input") && !optionalArg(args, "--json")) {
    return sampleInputForCapability(capability);
  }
  return await smokeInputFromArgs(args, capability);
}

async function smokeInputFromArgs(args: string[], capability?: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  const jsonInput = optionalArg(args, "--json");
  const inputPath = optionalArg(args, "--input");
  const sample = args.includes("--sample");
  const selected = [Boolean(jsonInput), Boolean(inputPath), sample].filter(Boolean).length;
  if (selected > 1) throw new Error("smoke call accepts only one of --sample, --input, or --json");
  if (jsonInput) {
    const parsed = JSON.parse(jsonInput);
    if (!isRecord(parsed)) throw new Error("smoke call --json must be a JSON object");
    return parsed;
  }
  if (inputPath) {
    const parsed = JSON.parse(await fs.readFile(inputPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("smoke call --input must point to a JSON object");
    return parsed;
  }
  if (sample && capability) return sampleInputForCapability(capability);
  if (sample) return {};
  return {};
}

function formatSmokeCallResult(
  toolName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  topology: {
    configPath: string;
    storePath: string;
    storeAuthority: "local_sqlite" | "shared_postgres";
    sharedPostgresSchema: string;
  },
): string {
  const proposal = isRecord(result.proposal) ? result.proposal : undefined;
  const evidence = isRecord(result.evidence) ? result.evidence : undefined;
  const error = isRecord(result.error) ? result.error : undefined;
  const evidenceId = stringField(result, "evidence_bundle_id") ?? (evidence ? stringField(evidence, "bundle_id") : undefined);
  const proposalId = stringField(result, "proposal_id") ?? (proposal ? stringField(proposal, "id") : undefined);
  const replayResource = stringField(result, "replay_resource");
  const sourceChanged = result.source_database_changed === true || result.source_database_mutated === true;
  const ok = result.ok !== false;
  const storeLines = topology.storeAuthority === "shared_postgres"
    ? [
      "Authoritative ledger:",
      `shared Postgres (${topology.sharedPostgresSchema})`,
      "",
      "Local --store path:",
      `${topology.storePath} (compatibility path only; no authoritative smoke records are written here)`,
      "",
    ]
    : ["Local ledger:", topology.storePath, ""];
  const lines = [
    `Synapsor smoke call: ${ok ? "ok" : "failed"}`,
    "",
    "Tool:",
    toolName,
    "",
    "Input:",
    JSON.stringify(input, null, 2),
    "",
    "Source DB changed:",
    sourceChanged ? "yes" : "no",
    "",
    "Evidence:",
    evidenceId || "(not returned)",
    "",
    ...storeLines,
  ];
  if (!ok) {
    lines.push("Error:", error ? stringField(error, "code") ?? "UNCLASSIFIED" : "UNCLASSIFIED");
    if (error?.retryable === true) {
      lines.push("Retryable:", "yes");
      const retryAfter = error.retry_after_ms;
      if (typeof retryAfter === "number") lines.push("Retry after:", `${retryAfter} ms`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (proposalId) {
    lines.push("Proposal:", proposalId, "", "Replay:", replayResource || `synapsor://replay/replay_${proposalId}`, "");
  }
  const storeSuffix = topology.storeAuthority === "shared_postgres"
    ? ` --config ${topology.configPath} --store ${topology.storePath}`
    : ` --store ${topology.storePath}`;
  lines.push("Next:");
  if (evidenceId) lines.push(`  ${cliCommandName()} evidence show ${evidenceId}${storeSuffix}`);
  if (proposalId) {
    lines.push(`  ${cliCommandName()} proposals show ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} proposals approve ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} apply ${proposalId}${storeSuffix}`);
    lines.push(`  ${cliCommandName()} replay show --proposal ${proposalId}${storeSuffix}`);
  } else if (evidenceId) {
    lines.push(`  ${cliCommandName()} query-audit list --evidence ${evidenceId}${storeSuffix}`);
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
    const runtime = createMcpRuntime(loadRuntimeConfigFromFile(target), { storePath: ":memory:" });
    try {
      return { tools: runtime.listTools() };
  } finally {
    await runtime.close();
  }
}
  return parsed;
}

function builtInMcpAuditExample(example: string): unknown {
  if (example === "dangerous-db-mcp") return dangerousDatabaseMcpAuditExample;
  throw new Error(`unknown audit example: ${example}. Available examples: dangerous-db-mcp`);
}

function isRunnerConfigLike(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && Array.isArray(value.capabilities);
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
  if (subcommand === "list") return replayList(rest);
  if (subcommand && !["show", "export"].includes(subcommand)) return replayShow(args);
  if (subcommand === "show") return replayShow(rest);
  if (subcommand === "export") return replayExport(rest);
  usage(["replay"]);
  return 2;
}

async function evidence(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "show") return evidenceShow(rest);
  if (subcommand === "list") return evidenceList(rest);
  if (subcommand === "export") return evidenceExport(rest);
  usage(["evidence"]);
  return 2;
}

async function queryAudit(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return queryAuditList(rest);
  if (subcommand === "show") return queryAuditShow(rest);
  if (subcommand === "export") return queryAuditExport(rest);
  usage(["query-audit"]);
  return 2;
}

async function receipts(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return receiptsList(rest);
  if (subcommand === "show") return receiptsShow(rest);
  usage(["receipts"]);
  return 2;
}

async function activity(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "search") return activitySearch(rest);
  usage(["activity"]);
  return 2;
}

async function events(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "tail") return eventsTail(rest);
  if (subcommand === "webhook" || subcommand === "push") return eventsWebhook(rest);
  usage(["events"]);
  return 2;
}

async function metrics(args: string[]): Promise<number> {
  const rest = args[0] === "show" ? args.slice(1) : args;
  const bridged = await maybeSharedPostgresRuntimeStoreRead(rest, "metrics show", (bridgeStorePath) => metrics(argsWithRuntimeStoreBridge(rest, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  const store = await openLocalStore(rest);
  try {
    const rows = store.operationalMetrics({
      tenant: optionalArg(rest, "--tenant"),
      capability: optionalArg(rest, "--capability"),
    });
    const format = optionalArg(rest, "--format") ?? (rest.includes("--json") ? "json" : "prometheus");
    if (format === "json") process.stdout.write(`${JSON.stringify({ metrics: rows }, null, 2)}\n`);
    else if (format === "prometheus" || format === "openmetrics") process.stdout.write(formatPrometheusMetrics(rows));
    else throw new Error("metrics --format must be prometheus, openmetrics, or json");
    return 0;
  } finally {
    store.close();
  }
}

async function workerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "run") return workerRun(rest);
  if (subcommand === "status" || subcommand === "list") return workerStatus(rest);
  if (subcommand === "dead-letter") return workerDeadLetter(rest);
  usage(["worker"]);
  return 2;
}

async function workerStatus(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreReadBridge(args, config, "worker status", (bridgeStorePath) => workerStatus(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const store = await openLocalStore(args);
  try {
    const status = optionalArg(args, "--status") as Parameters<ProposalStore["listWorkerQueue"]>[0];
    const items = store.listWorkerQueue(status);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ worker_queue: items }, null, 2)}\n`);
    else if (items.length === 0) process.stdout.write("Worker queue is empty.\n");
    else for (const item of items) process.stdout.write(`${item.status.toUpperCase()} ${item.proposal_id} attempt=${item.attempts}/${item.max_attempts}${item.last_error_code ? ` error=${item.last_error_code}` : ""}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function workerDeadLetter(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return workerStatus([...rest, "--status", "dead_letter"]);
  if (subcommand === "show") return workerDeadLetterShow(rest);
  if (subcommand === "requeue") return workerDeadLetterMutate("requeue", rest);
  if (subcommand === "discard") return workerDeadLetterMutate("discard", rest);
  usage(["worker"]);
  return 2;
}

async function workerDeadLetterShow(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("worker dead-letter show requires <proposal_id>");
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `worker dead-letter show ${proposalId}`, (bridgeStorePath) => workerDeadLetterShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  const store = await openLocalStore(args);
  try {
    const item = store.getWorkerQueueItem(proposalId);
    if (!item) throw new Error(`worker queue item not found for ${proposalId}`);
    const proposal = requireLocalProposal(store, proposalId);
    const payload = { worker_queue: item, proposal, receipts: store.receipts(proposalId), events: store.events(proposalId) };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write([
      `${item.status.toUpperCase()} ${item.proposal_id}`,
      `Attempts: ${item.attempts}/${item.max_attempts}`,
      `Last safe error: ${item.last_error_code ?? "none"}`,
      `Proposal state: ${proposal.state}`,
      `Receipts retained: ${payload.receipts.length}`,
      `Events retained: ${payload.events.length}`,
      "",
    ].join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

async function workerDeadLetterMutate(action: "requeue" | "discard", args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error(`worker dead-letter ${action} requires <proposal_id>`);
  const reason = optionalArg(args, "--reason");
  if (action === "discard" && !reason) throw new Error("worker dead-letter discard requires --reason <text>");
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `worker dead-letter ${action} ${proposalId}`, (bridgeStorePath) => workerDeadLetterMutate(action, argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, `worker dead-letter ${action}`, args);
  const store = await openLocalStore(args);
  try {
    const proposal = requireLocalProposal(store, proposalId);
    await confirmDangerousAction(args, `${action === "requeue" ? "Requeue" : "Discard"} dead-letter item ${proposalId}?`);
    const identity = await operatorIdentityForDecision({
      args,
      config,
      configPath,
      proposal,
      action: action === "requeue" ? "worker_requeue" : "worker_discard",
      reason,
    });
    if (!identity.verified) throw new Error(`worker dead-letter ${action} requires a verified signed_key or jwt_oidc operator identity`);
    const item = action === "requeue"
      ? store.requeueDeadLetter({
        proposalId,
        retryBudget: positiveIntOption(args, "--retry-budget", 3, 1, 100),
        identity,
        reason,
      })
      : store.discardDeadLetter({ proposalId, identity, reason: reason! });
    operationalLog("warn", `worker_dead_letter_${action === "requeue" ? "requeued" : "discarded"}`, {
      proposal_id: proposalId,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      retry_budget: action === "requeue" ? item.max_attempts : undefined,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify({ worker_queue: item }, null, 2)}\n` : `${item.status} ${item.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function workerRun(args: string[]): Promise<number> {
  if (!args.includes("--yes")) throw new Error("worker run requires --yes because it applies approved proposals");
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await readRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      return workerRunSharedRuntimeStoreDaemon(args, config);
    }
    return withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => workerRun(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "worker run", args);
  const storePath = optionalArg(args, "--store") ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    if (!args.includes("--once") && !args.includes("--drain")) {
      throw new Error("shared Postgres ledger mirror for worker run requires --once or --drain. Use storage.shared_postgres.mode=runtime_store for long-running shared worker loops.");
    }
    return withSharedPostgresLedgerMirror(args, storePath, "worker run", () => workerRun(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const workerId = optionalArg(args, "--worker-id") ?? process.env.SYNAPSOR_RUNNER_ID ?? `worker_${process.pid}`;
  const maxAttempts = positiveIntOption(args, "--max-attempts", 5, 1, 100);
  const retryBaseMs = positiveIntOption(args, "--retry-base-ms", 1000, 1, 3_600_000);
  const retryMaxMs = positiveIntOption(args, "--retry-max-ms", 60_000, retryBaseMs, 86_400_000);
  const leaseSeconds = positiveIntOption(args, "--lease-seconds", 60, 15, 3600);
  const pollMs = positiveIntOption(args, "--poll-ms", 5000, 10, 3_600_000);
  const once = args.includes("--once");
  const drain = args.includes("--drain");
  const capability = optionalArg(args, "--capability");
  const tenant = optionalArg(args, "--tenant");
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const store = new ProposalStore(storePath);
      let item;
      try {
        store.enqueueApprovedForWorker({ capability, tenant, maxAttempts });
        item = store.claimWorkerItem({ workerId, leaseSeconds });
      } finally {
        store.close();
      }
      if (!item) {
        if (once || drain) return 0;
        await waitFor(pollMs);
        continue;
      }

      let executionCode = "WORKER_EXECUTION_ERROR";
      try {
        await applyProposal([
          item.proposal_id,
          "--config", configPath,
          "--store", storePath,
          "--runner", workerId,
          "--worker-attempt", String(item.attempts),
          "--batch-quiet",
          "--yes",
          ...(args.includes(runtimeStoreBridgeFlag) ? [runtimeStoreBridgeFlag] : []),
          ...(optionalArg(args, "--identity") ? ["--identity", optionalArg(args, "--identity")!] : []),
          ...(optionalArg(args, "--identity-key") ? ["--identity-key", optionalArg(args, "--identity-key")!] : []),
          ...(optionalArg(args, "--actor") ? ["--actor", optionalArg(args, "--actor")!] : []),
        ], item.proposal_id);
        const afterStore = new ProposalStore(storePath);
        try {
          const proposal = requireLocalProposal(afterStore, item.proposal_id);
          const receipt = afterStore.receipts(item.proposal_id).at(-1)?.receipt;
          executionCode = receipt?.safe_error_code ?? (proposal.state === "failed" ? "WRITEBACK_FAILED" : "WORKER_STATE_INVALID");
          if (proposal.state === "applied") {
            afterStore.completeWorkerItem(item.proposal_id, workerId, receipt?.status === "already_applied" ? "already_applied" : "applied");
            operationalLog("info", "worker_item_completed", { proposal_id: item.proposal_id, worker_id: workerId, status: proposal.state, attempt: item.attempts });
          } else if (proposal.state === "conflict") {
            afterStore.completeWorkerItem(item.proposal_id, workerId, "conflict");
            operationalLog("warn", "worker_item_completed", { proposal_id: item.proposal_id, worker_id: workerId, status: proposal.state, attempt: item.attempts });
          } else if (proposal.state === "failed") {
            finishWorkerFailure(afterStore, item, workerId, executionCode, retryBaseMs, retryMaxMs);
          } else {
            finishWorkerFailure(afterStore, item, workerId, "WORKER_STATE_INVALID", retryBaseMs, retryMaxMs);
          }
        } finally {
          afterStore.close();
        }
      } catch (error) {
        executionCode = workerErrorCode(error);
        const failureStore = new ProposalStore(storePath);
        try {
          finishWorkerFailure(failureStore, item, workerId, executionCode, retryBaseMs, retryMaxMs);
        } finally {
          failureStore.close();
        }
      }
      if (once) return 0;
    } while (!stopped);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function workerRunSharedRuntimeStoreDaemon(args: string[], config: RuntimeConfig): Promise<number> {
  const pollMs = positiveIntOption(args, "--poll-ms", 5000, 10, 3_600_000);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await withSharedPostgresRuntimeStoreBridge(args, config, "worker run", (bridgeStorePath) => {
        return workerRun(argsWithRuntimeStoreBridge([...args, "--drain"], bridgeStorePath));
      });
      if (!stopped) await waitFor(pollMs);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function finishWorkerFailure(
  store: ProposalStore,
  item: WorkerQueueItem,
  workerId: string,
  errorCode: string,
  retryBaseMs: number,
  retryMaxMs: number,
): void {
  const retryable = isRetryableWritebackCode(errorCode);
  if (!retryable) {
    store.deadLetterWorkerItem({ proposalId: item.proposal_id, workerId, errorCode });
    operationalLog("error", "worker_item_dead_lettered", { proposal_id: item.proposal_id, worker_id: workerId, error_code: errorCode, attempt: item.attempts });
    return;
  }
  const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, item.attempts - 1));
  const updated = store.retryWorkerItem({
    proposalId: item.proposal_id,
    workerId,
    errorCode,
    retryAt: new Date(Date.now() + delay).toISOString(),
  });
  operationalLog(updated.status === "dead_letter" ? "error" : "warn", updated.status === "dead_letter" ? "worker_item_dead_lettered" : "worker_retry_scheduled", {
    proposal_id: item.proposal_id,
    worker_id: workerId,
    error_code: errorCode,
    attempt: updated.attempts,
    max_attempts: updated.max_attempts,
  });
}

function isRetryableWritebackCode(code: string): boolean {
  return /^(DATABASE_UNAVAILABLE|TRANSACTION_FAILED|HANDLER_TIMEOUT|HANDLER_REQUEST_FAILED|HANDLER_HTTP_(429|5\d\d)|IDEMPOTENCY_RECEIPT_IN_PROGRESS|WORKER_EXECUTION_ERROR)$/.test(code);
}

function workerErrorCode(error: unknown): string {
  const safe = safeOperationalErrorCode(error);
  if (safe !== "COMMAND_REJECTED") return safe;
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) return "HANDLER_TIMEOUT";
  return "WORKER_EXECUTION_ERROR";
}

function positiveIntOption(args: string[], flag: string, fallback: number, minimum: number, maximum: number): number {
  const raw = optionalArg(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

async function waitFor(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatPrometheusMetrics(rows: OperationalMetricRow[]): string {
  const definitions = [
    ["synapsor_proposals_total", "proposals", "Proposals created by trusted tenant and capability."],
    ["synapsor_approvals_total", "approvals", "Approved decisions by trusted tenant and capability."],
    ["synapsor_rejections_total", "rejections", "Rejected decisions by trusted tenant and capability."],
    ["synapsor_applies_total", "applies", "Successful or idempotently completed writebacks."],
    ["synapsor_conflicts_total", "conflicts", "Guarded writeback conflicts."],
    ["synapsor_writeback_failures_total", "failures", "Failed writeback outcomes."],
    ["synapsor_revert_proposals_total", "revert_proposals", "Reviewed compensation proposals created."],
    ["synapsor_revert_applies_total", "revert_applies", "Successfully applied reviewed compensations."],
  ] as const;
  const lines: string[] = [];
  for (const [name, field, help] of definitions) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const row of rows) {
      lines.push(`${name}{tenant="${prometheusLabel(row.tenant_id)}",capability="${prometheusLabel(row.capability)}"} ${row[field]}`);
    }
  }
  lines.push("# EOF", "");
  return lines.join("\n");
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

async function storeCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "stats") return storeStats(rest);
  if (subcommand === "vacuum") return storeVacuum(rest);
  if (subcommand === "prune") return storePrune(rest);
  if (subcommand === "reset") return storeReset(rest);
  if (subcommand === "shared-postgres") return storeSharedPostgres(rest);
  usage(["store"]);
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
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  const configuredStorePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const storeAccess: LocalUiStoreAccess | undefined = config?.storage?.shared_postgres?.mode === "runtime_store"
    ? async (mode, operation, callback) => (mode === "read" ? withSharedPostgresRuntimeStoreReadBridge : withSharedPostgresRuntimeStoreBridge)(args, config, `ui ${operation}`, async (bridgeStorePath) => {
      const store = new ProposalStore(bridgeStorePath);
      try {
        return callback(store);
      } finally {
        store.close();
      }
    })
    : undefined;
  const server = await startLocalUiServer({
    configPath,
    storePath: configuredStorePath,
    storeAccess,
    host: optionalArg(args, "--host") ?? "127.0.0.1",
    port: portArg ? Number(portArg) : 0,
    allowRemoteBind: args.includes("--allow-remote-bind"),
    tour: args.includes("--tour"),
  });
  process.stdout.write(`Synapsor Runner local UI: ${server.url}\n`);
  if (args.includes("--open")) {
    openBrowser(server.url);
    process.stdout.write("Opening the local review UI in your browser when a desktop opener is available.\n");
  }
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

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
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
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "proposals list", (bridgeStorePath) => proposalsList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, proposalListAllowedOptions, "proposals list");
  const store = await openLocalStore(args);
  try {
    const filters = proposalFiltersFromArgs(args);
    const rows = store.listProposals(filters);
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
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "proposals show", (bridgeStorePath) => proposalsShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "proposals show");
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = store.getProposal(resolvedProposalId);
    if (!proposal) throw new Error(`proposal not found: ${resolvedProposalId}`);
    const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
    const approvalProgress = store.approvalProgress(resolvedProposalId);
    const payload = { proposal, approval_progress: approvalProgress, events: store.events(resolvedProposalId), receipts: store.receipts(resolvedProposalId), evidence };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (showDetails(args)) {
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
      process.stdout.write(`Approval progress: ${approvalProgress.approved}/${approvalProgress.required}${approvalProgress.rejected ? " (rejected)" : ""}\n`);
      process.stdout.write(formatProposalEventDetail(payload.events));
      if (args.includes("--debug")) process.stdout.write(formatProposalDebug(proposal, optionalArg(args, "--store")));
    } else {
      process.stdout.write(formatProposalFirstLook(proposal, evidence?.items.length, proposalId, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function proposalsApprove(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals approve requires <proposal_id>");
  const storePath = localStorePath(args);
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "proposals approve");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `proposals approve ${proposalId}`, (bridgeStorePath) => proposalsApprove(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "proposals approve", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `proposals approve ${proposalId}`, () => proposalsApprove(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!args.includes("--json")) {
      const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
    }
    await confirmDangerousAction(args, `Approve proposal ${resolvedProposalId} for guarded writeback?`);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "approve", reason: optionalArg(args, "--reason") });
    const updated = store.approveProposal(resolvedProposalId, {
      approver: identity.subject,
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason: optionalArg(args, "--reason") ?? undefined,
      identity,
      require_verified_identity: Boolean(config?.operator_identity && config.operator_identity.provider !== "dev_env"),
    });
    operationalLog("info", "operator_decision", {
      action: "approve",
      proposal_id: updated.proposal_id,
      capability: updated.action,
      tenant: updated.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: proposal.change_set.approval.required_role,
      approval_progress: `${store.approvalProgress(resolvedProposalId).approved}/${store.approvalProgress(resolvedProposalId).required}`,
    });
    const progress = store.approvalProgress(resolvedProposalId);
    const approvalResult = { ...updated, approval_progress: progress };
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(approvalResult, null, 2)}\n`
      : progress.complete
        ? `approved ${updated.proposal_id} (${progress.approved}/${progress.required})\n`
        : `approval recorded for ${updated.proposal_id} (${progress.approved}/${progress.required}); awaiting ${progress.remaining} more verified reviewer${progress.remaining === 1 ? "" : "s"}\n`);
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
  const storePath = localStorePath(args);
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "proposals reject");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `proposals reject ${proposalId}`, (bridgeStorePath) => proposalsReject(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "proposals reject", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `proposals reject ${proposalId}`, () => proposalsReject(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!args.includes("--json")) {
      const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
    }
    await confirmDangerousAction(args, `Reject proposal ${resolvedProposalId}?`);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "reject", reason });
    const updated = store.rejectProposal(resolvedProposalId, {
      actor: identity.subject,
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason,
      identity,
      require_verified_identity: Boolean(config?.operator_identity && config.operator_identity.provider !== "dev_env"),
    });
    operationalLog("info", "operator_decision", {
      action: "reject",
      proposal_id: updated.proposal_id,
      capability: updated.action,
      tenant: updated.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: proposal.change_set.approval.required_role,
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

async function evidenceList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "evidence list", (bridgeStorePath) => evidenceList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, evidenceListAllowedOptions, "evidence list");
  const store = await openLocalStore(args);
  try {
    const rows = store.listEvidenceBundles(evidenceFiltersFromArgs(args));
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ evidence: rows }, null, 2)}\n`);
    } else if (rows.length === 0) {
      process.stdout.write("No evidence bundles found.\n");
    } else {
      for (const bundle of rows) process.stdout.write(formatEvidenceSummary(bundle));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function evidenceShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "evidence show", (bridgeStorePath) => evidenceShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "evidence show");
  const evidenceId = positional(args, 0);
  if (!evidenceId) throw new Error("evidence show requires <evidence_bundle_id>");
  const store = await openLocalStore(args);
  try {
    const evidence = store.getEvidenceBundle(evidenceId);
    if (!evidence) throw new Error(`evidence bundle not found: ${evidenceId}`);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    else if (showDetails(args)) process.stdout.write(formatEvidenceDetail(evidence));
    else process.stdout.write(formatEvidenceFirstLook(evidence, storeOptionSuffix(args)));
    return 0;
  } finally {
    store.close();
  }
}

async function evidenceExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "evidence export", (bridgeStorePath) => evidenceExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, exportAllowedOptions, "evidence export");
  const evidenceId = positional(args, 0) ?? optionalArg(args, "--evidence");
  if (!evidenceId) throw new Error("evidence export requires <evidence_bundle_id>");
  const output = outputArg(args);
  if (!output) throw new Error("evidence export requires --output <path>");
  const format = exportFormat(args);
  const store = await openLocalStore(args);
  try {
    const evidence = store.getEvidenceBundle(evidenceId);
    if (!evidence) throw new Error(`evidence bundle not found: ${evidenceId}`);
    const text = format === "json" ? `${JSON.stringify(evidence, null, 2)}\n` : formatEvidenceMarkdown(evidence);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`exported ${evidence.evidence_bundle_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function queryAuditList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "query-audit list", (bridgeStorePath) => queryAuditList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, queryAuditListAllowedOptions, "query-audit list");
  const store = await openLocalStore(args);
  try {
    const rows = store.listQueryAudit(queryAuditFiltersFromArgs(args));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ query_audit: rows }, null, 2)}\n`);
    else if (rows.length === 0) process.stdout.write("No query audit records found.\n");
    else for (const row of rows) process.stdout.write(formatQueryAuditSummary(row, showDetails(args), storeOptionSuffix(args)));
    return 0;
  } finally {
    store.close();
  }
}

async function queryAuditShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "query-audit show", (bridgeStorePath) => queryAuditShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "query-audit show");
  const auditId = Number(positional(args, 0));
  if (!Number.isInteger(auditId) || auditId <= 0) throw new Error("query-audit show requires <audit_id>");
  const store = await openLocalStore(args);
  try {
    const row = store.getQueryAudit(auditId);
    if (!row) throw new Error(`query audit record not found: ${auditId}`);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    else process.stdout.write(showDetails(args) ? formatQueryAuditDetail(row) : formatQueryAuditFirstLook(row, storeOptionSuffix(args)));
    return 0;
  } finally {
    store.close();
  }
}

async function queryAuditExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "query-audit export", (bridgeStorePath) => queryAuditExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, exportAllowedOptions, "query-audit export");
  const auditId = Number(positional(args, 0) ?? optionalArg(args, "--audit"));
  if (!Number.isInteger(auditId) || auditId <= 0) throw new Error("query-audit export requires <audit_id>");
  const output = outputArg(args);
  if (!output) throw new Error("query-audit export requires --output <path>");
  const format = exportFormat(args, ["json"]);
  const store = await openLocalStore(args);
  try {
    const row = store.getQueryAudit(auditId);
    if (!row) throw new Error(`query audit record not found: ${auditId}`);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(row, null, 2)}\n`, "utf8");
    process.stdout.write(`exported query audit ${auditId} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function receiptsList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "receipts list", (bridgeStorePath) => receiptsList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, receiptListAllowedOptions, "receipts list");
  const store = await openLocalStore(args);
  try {
    const rows = store.listReceipts(receiptFiltersFromArgs(args));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ receipts: rows }, null, 2)}\n`);
    else if (rows.length === 0) process.stdout.write("No writeback receipts found.\n");
    else for (const receipt of rows) process.stdout.write(formatReceiptSummary(receipt));
    return 0;
  } finally {
    store.close();
  }
}

async function receiptsShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "receipts show", (bridgeStorePath) => receiptsShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "receipts show");
  const receiptId = Number(positional(args, 0));
  if (!Number.isInteger(receiptId) || receiptId <= 0) throw new Error("receipts show requires <receipt_id>");
  const store = await openLocalStore(args);
  try {
    const receipt = store.getReceipt(receiptId);
    if (!receipt) throw new Error(`writeback receipt not found: ${receiptId}`);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else process.stdout.write(showDetails(args) ? formatReceiptDetail(receipt) : formatReceiptFirstLook(receipt, storeOptionSuffix(args)));
    return 0;
  } finally {
    store.close();
  }
}

async function replayList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay list", (bridgeStorePath) => replayList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayListAllowedOptions, "replay list");
  const store = await openLocalStore(args);
  try {
    const filters = proposalFiltersFromReplayArgs(args, store);
    const proposals = store.listProposals(filters);
    const rows = proposals.map((proposal) => ({
      replay_id: `replay_${proposal.proposal_id}`,
      proposal_id: proposal.proposal_id,
      created_at: proposal.created_at,
      state: proposal.state,
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.action,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
    }));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ replays: rows }, null, 2)}\n`);
    else if (rows.length === 0) process.stdout.write("No replay records found.\n");
    else for (const row of rows) process.stdout.write(formatReplaySummary(row));
    return 0;
  } finally {
    store.close();
  }
}

async function replayShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay show", (bridgeStorePath) => replayShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayShowAllowedOptions, "replay show");
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveReplayProposalId(args, store);
    const replayRecord = store.replay(resolvedProposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(replayRecord, null, 2)}\n`);
    } else if (showDetails(args)) {
      process.stdout.write(formatReplayDetail(replayRecord));
      if (args.includes("--debug")) process.stdout.write(formatReplayDebug(replayRecord, optionalArg(args, "--store")));
    } else {
      process.stdout.write(formatReplayFirstLook(replayRecord, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function replayExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay export", (bridgeStorePath) => replayExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayExportAllowedOptions, "replay export");
  const output = outputArg(args);
  if (!output) throw new Error("replay export requires --output <path>");
  const format = exportFormat(args);
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveReplayProposalId(args, store);
    const replayRecord = store.replay(resolvedProposalId);
    const text = format === "json" ? `${JSON.stringify(replayRecord, null, 2)}\n` : formatReplayMarkdown(replayRecord);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(`exported ${replayRecord.replay_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function activitySearch(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "activity search", (bridgeStorePath) => activitySearch(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, activitySearchAllowedOptions, "activity search");
  const store = await openLocalStore(args);
  try {
    const proposalFilters = proposalFiltersFromActivityArgs(args, store);
    const evidenceFilters = evidenceFiltersFromActivityArgs(args, store);
    const queryAuditFilters = queryAuditFiltersFromActivityArgs(args, store);
    const receiptFilters = receiptFiltersFromActivityArgs(args, store);
    const proposals = store.listProposals(proposalFilters);
    const evidenceRows = store.listEvidenceBundles(evidenceFilters);
    const queryAuditRows = store.listQueryAudit(queryAuditFilters);
    const receiptsRows = store.listReceipts(receiptFilters);
    const proposalIds = new Set(proposals.map((proposal) => proposal.proposal_id));
    const evidenceIds = new Set(evidenceRows.map((evidence) => evidence.evidence_bundle_id));
    const results: Record<string, unknown>[] = proposals.map((proposal) => activityFromProposal(proposal));
    for (const evidence of evidenceRows) {
      if (evidence.proposal_id && proposalIds.has(evidence.proposal_id)) continue;
      results.push(activityFromEvidence(evidence));
    }
    for (const audit of queryAuditRows) {
      const proposalId = stringField(audit, "proposal_id");
      const evidenceId = stringField(audit, "evidence_bundle_id");
      if (proposalId && proposalIds.has(proposalId)) continue;
      if (evidenceId && evidenceIds.has(evidenceId)) continue;
      results.push(activityFromQueryAudit(audit));
    }
    for (const receipt of receiptsRows) {
      if (proposalIds.has(receipt.proposal_id)) continue;
      results.push(activityFromReceipt(receipt));
    }
    const sorted = results
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
      .slice(0, limitFromArgs(args));
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ interactions: sorted }, null, 2)}\n`);
    } else if (sorted.length === 0) {
      process.stdout.write("No local interactions found.\n");
    } else {
      process.stdout.write(`Found ${sorted.length} local interaction${sorted.length === 1 ? "" : "s"}\n\n`);
      sorted.forEach((item, index) => process.stdout.write(formatActivityItem(item, index + 1, showDetails(args))));
      process.stdout.write(formatActivityNext(sorted, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function eventsTail(args: string[]): Promise<number> {
  assertKnownOptions(args, eventTailAllowedOptions, "events tail");
  const follow = args.includes("--follow");
  if (follow && args.includes("--json")) throw new Error("events tail --follow does not support --json yet");
  const storePath = optionalArg(args, "--store");
  const intervalMs = Number(optionalArg(args, "--interval-ms") ?? "1000");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error("--interval-ms must be at least 250");
  const filters = eventFiltersFromArgs(args);
  const printOnce = async (seen?: Set<number>): Promise<number> => {
    const store = await openLocalStore(["--store", storePath ?? "./.synapsor/local.db"]);
    try {
      const rows = store.listEvents(filters)
        .sort((left, right) => left.event_id - right.event_id)
        .filter((event) => !seen?.has(event.event_id));
      if (seen) rows.forEach((event) => seen.add(event.event_id));
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ events: rows }, null, 2)}\n`);
      } else if (rows.length === 0 && !follow) {
        process.stdout.write("No local events found.\n");
      } else {
        for (const event of rows) process.stdout.write(formatEventLine(event, showDetails(args)));
      }
      return rows.length;
    } finally {
      store.close();
    }
  };

  if (!follow) {
    await printOnce();
    return 0;
  }

  const seen = new Set<number>();
  await printOnce(seen);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void printOnce(seen).catch((error) => {
        process.stderr.write(`events tail error: ${safeErrorMessage(error)}\n`);
      });
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function eventsWebhook(args: string[]): Promise<number> {
  assertKnownOptions(args, eventWebhookAllowedOptions, "events webhook");
  const url = optionalArg(args, "--url") ?? envValue(optionalArg(args, "--url-env"));
  if (!url) throw new Error("events webhook requires --url <https://...> or --url-env <ENV>");
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("events webhook URL must use http or https");

  const follow = args.includes("--follow");
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  if (follow && jsonOutput) throw new Error("events webhook --follow does not support --json");
  const storePath = optionalArg(args, "--store");
  const intervalMs = Number(optionalArg(args, "--interval-ms") ?? "1000");
  const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "5000");
  const sinceEventId = optionalPositiveIntegerArg(args, "--since-event-id");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error("--interval-ms must be at least 250");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250) throw new Error("--timeout-ms must be at least 250");
  const token = envValue(optionalArg(args, "--auth-token-env"));
  const filters = eventFiltersFromArgs(args);
  const seen = new Set<number>();

  const pushOnce = async (): Promise<{ delivered: number; payloads: Record<string, unknown>[] }> => {
    const store = await openLocalStore(["--store", storePath ?? "./.synapsor/local.db"]);
    try {
      const rows = store.listEvents(filters)
        .filter((event) => sinceEventId === undefined || event.event_id > sinceEventId)
        .sort((left, right) => left.event_id - right.event_id)
        .filter((event) => !seen.has(event.event_id));
      rows.forEach((event) => seen.add(event.event_id));
      let delivered = 0;
      const payloads: Record<string, unknown>[] = [];
      for (const event of rows) {
        const payload = localEventWebhookPayload(event, store.path);
        payloads.push(payload);
        if (dryRun) {
          if (!jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          await postLocalEventWebhook(endpoint, payload, { token, timeoutMs });
          if (!jsonOutput) process.stdout.write(`pushed event ${event.event_id} ${event.kind} for ${event.proposal_id} to ${redactWebhookUrl(endpoint)}\n`);
        }
        delivered += 1;
      }
      if (rows.length === 0 && !follow && !jsonOutput) process.stdout.write(dryRun ? "No local events matched for dry-run.\n" : "No local events matched.\n");
      return { delivered, payloads };
    } finally {
      store.close();
    }
  };

  const first = await pushOnce();
  if (jsonOutput && !follow) {
    process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, delivered: first.delivered, webhook: redactWebhookUrl(endpoint), events: first.payloads }, null, 2)}\n`);
  }
  if (!follow) return 0;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void pushOnce().catch((error) => {
        process.stderr.write(`events webhook error: ${safeErrorMessage(error)}\n`);
      });
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function storeStats(args: string[]): Promise<number> {
  assertKnownOptions(args, storeStatsAllowedOptions, "store stats");
  const store = await openLocalStore(args);
  try {
    const stats = store.stats();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    else process.stdout.write(formatStoreStats(stats));
    return 0;
  } finally {
    store.close();
  }
}

async function storeVacuum(args: string[]): Promise<number> {
  assertKnownOptions(args, storeVacuumAllowedOptions, "store vacuum");
  const store = await openLocalStore(args);
  try {
    const before = store.stats();
    store.vacuum();
    const after = store.stats();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ before, after }, null, 2)}\n`);
    else process.stdout.write(`vacuumed local store ${before.path}\napprox bytes: ${before.approx_bytes} -> ${after.approx_bytes}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function storePrune(args: string[]): Promise<number> {
  assertKnownOptions(args, storePruneAllowedOptions, "store prune");
  const olderThan = optionalArg(args, "--older-than");
  if (!olderThan) throw new Error("store prune requires --older-than <duration>, for example --older-than 30d");
  if (args.includes("--yes") && args.includes("--dry-run")) throw new Error("store prune accepts either --dry-run or --yes, not both");
  const cutoff = cutoffFromOlderThan(olderThan);
  const dryRun = !args.includes("--yes");
  if (!dryRun) await assertNoActiveStoreLease(optionalArg(args, "--store"), args.includes("--force"), "store prune");
  const store = await openLocalStore(args);
  try {
    const result = store.pruneBefore(cutoff, { dryRun });
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(formatStorePrune(result));
    return 0;
  } finally {
    store.close();
  }
}

async function storeReset(args: string[]): Promise<number> {
  assertKnownOptions(args, storeResetAllowedOptions, "store reset");
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  if (storePath === ":memory:") throw new Error("store reset does not apply to :memory: stores");
  if (!args.includes("--yes")) {
    throw new Error("store reset is destructive for the local ledger. Rerun with --yes after backing up anything you need.");
  }
  await assertNoActiveStoreLease(storePath, args.includes("--force"), "store reset");
  const resolved = path.resolve(storePath);
  const candidates = [resolved, `${resolved}-wal`, `${resolved}-shm`, storeLeasePath(resolved)];
  const removed: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.rm(candidate, { force: true });
      removed.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const result = {
    ok: true,
    store: resolved,
    removed,
    source_database_changed: false,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(formatStoreReset(result));
  return 0;
}

async function storeSharedPostgres(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "migration") return storeSharedPostgresMigration(rest);
  if (subcommand === "apply-migration") return storeSharedPostgresApplyMigration(rest);
  if (subcommand === "status") return storeSharedPostgresStatus(rest);
  if (subcommand === "sync") return storeSharedPostgresSync(rest);
  if (subcommand === "restore") return storeSharedPostgresRestore(rest);
  if (subcommand === "backup" || subcommand === "export") return storeSharedPostgresBackup(rest);
  if (subcommand === "verify-backup") return storeSharedPostgresVerifyBackup(rest);
  if (subcommand === "restore-backup") return storeSharedPostgresRestoreBackup(rest);
  if (subcommand === "retention") return storeSharedPostgresRetention(rest);
  usage(["store"]);
  return 2;
}

async function storeSharedPostgresMigration(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres migration");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const sql = sharedPostgresRuntimeStoreMigration(schema);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, engine: "postgres", schema, sql }, null, 2)}\n`);
  } else {
    process.stdout.write(`${sql}\n`);
  }
  return 0;
}

async function storeSharedPostgresApplyMigration(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres apply-migration");
  if (!args.includes("--yes")) throw new Error("store shared-postgres apply-migration requires --yes.");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(sharedPostgresRuntimeStoreMigration(schema));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, engine: "postgres", schema, url_env: urlEnv }, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger migration applied in schema ${schema} using ${urlEnv}\n`);
  } finally {
    await pool.end();
  }
  return 0;
}

async function storeSharedPostgresStatus(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres status");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    const counts = await sharedPostgresLedgerTableCounts(pool, schema);
    const ok = Object.values(counts).every((count) => typeof count === "number");
    const payload = { ok, engine: "postgres", schema, url_env: urlEnv, tables: counts };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(formatSharedPostgresStatus(payload));
  } finally {
    await pool.end();
  }
  return 0;
}

const sharedPostgresLedgerTables = ["ledger_entries", "proposal_locks", "worker_leases", "rate_limit_buckets"] as const;

async function sharedPostgresLedgerTableCounts(
  pool: ReturnType<typeof createPostgresPool>,
  schema: string,
): Promise<Record<typeof sharedPostgresLedgerTables[number], number | null>> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.`;
  const counts: Record<typeof sharedPostgresLedgerTables[number], number | null> = {
    ledger_entries: null,
    proposal_locks: null,
    worker_leases: null,
    rate_limit_buckets: null,
  };
  for (const table of sharedPostgresLedgerTables) {
    try {
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${qualified}${quoteSqlIdentifier(table, "postgres")}`);
      counts[table] = Number(result.rows[0]?.count ?? 0);
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}

async function storeSharedPostgresSync(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres sync");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--yes")) throw new Error("store shared-postgres sync requires --yes unless --dry-run is set.");

  const entries = localSharedLedgerEntries(storePath);

  if (dryRun) {
    const payload = { ok: true, dry_run: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger sync dry-run: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${storePath} into schema ${schema} using ${urlEnv}\n`);
    return 0;
  }

  const result = await syncLocalStoreToSharedPostgres({ storePath, schema, urlEnv });
  const payload = { ok: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger sync complete: ${result.entries} entr${result.entries === 1 ? "y" : "ies"} from ${storePath} into schema ${schema} using ${urlEnv}\n`);
  return 0;
}

async function storeSharedPostgresRestore(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres restore");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const storePath = optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--yes")) throw new Error("store shared-postgres restore requires --yes unless --dry-run is set.");
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema);
  if (dryRun) {
    const payload = { ok: true, dry_run: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), entries: entries.length };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared Postgres ledger restore dry-run: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from schema ${schema} into ${storePath} using ${urlEnv}\n`);
    return 0;
  }
  const result = await restoreSharedPostgresToLocalStore({ storePath, schema, urlEnv, entries });
  const payload = { ok: true, engine: "postgres", schema, url_env: urlEnv, store: path.resolve(storePath), ...result };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger restore complete: imported ${result.imported}, skipped ${result.skipped}, source entries ${entries.length}, store ${storePath}, url env ${urlEnv}\n`);
  return 0;
}

type SharedLedgerArchive = {
  schema_version: "synapsor.shared-ledger-archive.v1";
  created_at: string;
  source: { engine: "postgres"; schema: string };
  entries: SharedLedgerEntry[];
  manifest: { entries: number; digest: `sha256:${string}` };
};

async function storeSharedPostgresBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres backup");
  const output = optionalArg(args, "--output");
  if (!output) throw new Error("store shared-postgres backup requires --output <archive.json>");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const maxEntries = positiveIntOption(args, "--max-entries", 10_000, 100, 100_000);
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema, maxEntries);
  const archive = createSharedLedgerArchive(schema, entries);
  const resolved = path.resolve(output);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(resolved, 0o600);
  const payload = { ok: true, archive: resolved, entries: archive.manifest.entries, digest: archive.manifest.digest };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared Postgres ledger backup written: ${resolved}\nentries: ${archive.manifest.entries}\ndigest: ${archive.manifest.digest}\n`);
  return 0;
}

async function storeSharedPostgresVerifyBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres verify-backup");
  const input = optionalArg(args, "--input");
  if (!input) throw new Error("store shared-postgres verify-backup requires --input <archive.json>");
  const archive = await readSharedLedgerArchive(input);
  const payload = { ok: true, archive: path.resolve(input), entries: archive.manifest.entries, digest: archive.manifest.digest };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared ledger backup verified: ${payload.archive}\nentries: ${payload.entries}\ndigest: ${payload.digest}\n`);
  return 0;
}

async function storeSharedPostgresRestoreBackup(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres restore-backup");
  const input = optionalArg(args, "--input");
  if (!input) throw new Error("store shared-postgres restore-backup requires --input <archive.json>");
  if (!args.includes("--yes")) throw new Error("store shared-postgres restore-backup requires --yes and restores only into an empty ledger schema.");
  const archive = await readSharedLedgerArchive(input);
  const schema = optionalArg(args, "--schema") ?? archive.source.schema;
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(sharedPostgresRuntimeStoreMigration(schema));
    const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
    const existing = await pool.query(`SELECT COUNT(*)::int AS count FROM ${qualified}`);
    if (Number(existing.rows[0]?.count ?? 0) !== 0) throw new Error(`restore target ${schema}.ledger_entries is not empty`);
    await pool.query("BEGIN");
    try {
      await upsertSharedPostgresEntries(pool, schema, archive.entries);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const restored = await fetchSharedPostgresLedgerEntries(pool, schema, archive.entries.length + 1);
    const verified = createSharedLedgerArchive(schema, restored);
    if (verified.manifest.digest !== archive.manifest.digest || restored.length !== archive.entries.length) {
      throw new Error("restored shared ledger failed manifest verification");
    }
    const payload = { ok: true, schema, url_env: urlEnv, entries: restored.length, digest: archive.manifest.digest };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared ledger backup restored and verified in schema ${schema}\nentries: ${restored.length}\ndigest: ${archive.manifest.digest}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function storeSharedPostgresRetention(args: string[]): Promise<number> {
  assertKnownOptions(args, storeSharedPostgresAllowedOptions, "store shared-postgres retention");
  const olderThan = optionalArg(args, "--older-than");
  if (!olderThan) throw new Error("store shared-postgres retention requires --older-than <duration>");
  const dryRun = !args.includes("--yes");
  if (!dryRun && args.includes("--dry-run")) throw new Error("store shared-postgres retention accepts either --dry-run or --yes, not both");
  const output = optionalArg(args, "--output");
  if (!dryRun && !output) throw new Error("store shared-postgres retention requires --output <archive.json> before --yes deletion");
  const schema = optionalArg(args, "--schema") ?? "synapsor_runner";
  const urlEnv = optionalArg(args, "--url-env") ?? "SYNAPSOR_LEDGER_DATABASE_URL";
  const maxEntries = positiveIntOption(args, "--max-entries", 10_000, 100, 100_000);
  const cutoff = cutoffFromOlderThan(olderThan);
  const entries = await fetchSharedPostgresEntriesFromEnv(urlEnv, schema, maxEntries);
  const store = new ProposalStore();
  let archivedEntries: SharedLedgerEntry[];
  let deleted: Record<string, number>;
  try {
    store.importSharedLedgerEntries(entries);
    const before = new Map(store.sharedLedgerEntries().map((entry) => [entry.entry_key, entry]));
    const result = store.pruneBefore(cutoff, { dryRun: false });
    deleted = result.deleted;
    const retained = new Set(store.sharedLedgerEntries().map((entry) => entry.entry_key));
    archivedEntries = [...before.values()].filter((entry) => !retained.has(entry.entry_key));
  } finally {
    store.close();
  }
  if (dryRun) {
    const payload = { ok: true, dry_run: true, schema, url_env: urlEnv, cutoff, archive_entries: archivedEntries.length, deleted };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`shared ledger retention dry-run\ncutoff: ${cutoff}\narchive entries: ${archivedEntries.length}\nno rows deleted\n`);
    return 0;
  }

  const archive = createSharedLedgerArchive(schema, archivedEntries);
  const archivePath = path.resolve(output!);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(archivePath, 0o600);
  await readSharedLedgerArchive(archivePath);

  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  try {
    await pool.query("BEGIN");
    try {
      if (archivedEntries.length > 0) {
        await pool.query(`DELETE FROM ${qualified} WHERE entry_key = ANY($1::text[])`, [archivedEntries.map((entry) => entry.entry_key)]);
      }
      const retentionEntry: SharedLedgerEntry = {
        entry_key: `retention:${crypto.randomUUID()}`,
        kind: "retention_event",
        payload: {
          cutoff,
          archive_digest: archive.manifest.digest,
          archived_entries: archivedEntries.length,
          deleted,
        },
        created_at: new Date().toISOString(),
      };
      await upsertSharedPostgresEntries(pool, schema, [retentionEntry]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await pool.end();
  }
  const payload = { ok: true, dry_run: false, schema, url_env: urlEnv, cutoff, archive: archivePath, archive_entries: archivedEntries.length, archive_digest: archive.manifest.digest, deleted };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`shared ledger retention complete\narchive: ${archivePath}\ndigest: ${archive.manifest.digest}\narchived entries: ${archivedEntries.length}\n`);
  return 0;
}

function createSharedLedgerArchive(schema: string, entries: SharedLedgerEntry[]): SharedLedgerArchive {
  const body = {
    schema_version: "synapsor.shared-ledger-archive.v1" as const,
    created_at: new Date().toISOString(),
    source: { engine: "postgres" as const, schema },
    entries,
  };
  return { ...body, manifest: { entries: entries.length, digest: hashReceipt({ schema_version: body.schema_version, entries }) } };
}

async function readSharedLedgerArchive(input: string): Promise<SharedLedgerArchive> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(input), "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schema_version !== "synapsor.shared-ledger-archive.v1" || !isRecord(parsed.source)
    || parsed.source.engine !== "postgres" || typeof parsed.source.schema !== "string" || !Array.isArray(parsed.entries) || !isRecord(parsed.manifest)) {
    throw new Error("invalid shared ledger backup envelope");
  }
  const entries = parsed.entries as SharedLedgerEntry[];
  const digest = hashReceipt({ schema_version: parsed.schema_version, entries });
  if (parsed.manifest.entries !== entries.length || parsed.manifest.digest !== digest) throw new Error("shared ledger backup manifest digest mismatch");
  return parsed as SharedLedgerArchive;
}

function localSharedLedgerEntries(storePath: string): SharedLedgerEntry[] {
  const store = new ProposalStore(storePath);
  try {
    return store.sharedLedgerEntries();
  } finally {
    store.close();
  }
}

type SharedPostgresLedgerMirror = {
  schema: string;
  urlEnv: string;
  lockTimeoutMs: number;
  maxEntries: number;
};

type SharedPostgresLedgerClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

function assertNoRuntimeStoreForLocalMutation(config: RuntimeConfig | undefined, command: string, args: string[] = []): void {
  if (config?.storage?.shared_postgres?.mode !== "runtime_store") return;
  if (args.includes(runtimeStoreBridgeFlag)) return;
  throw new Error(`${command} cannot run directly against the local SQLite path when storage.shared_postgres.mode=runtime_store. Use the built-in runtime-store bridge or switch to local SQLite/mirror mode.`);
}

function assertLocalGovernanceMutationAllowed(config: RuntimeConfig | undefined, command: string): void {
  if (config?.governance?.mode !== "cloud_linked") return;
  throw new Error(`${command} is disabled for cloud_linked governance. Record human decisions through Synapsor Cloud; only a Cloud-approved leased job may reach the trusted Runner writeback path.`);
}

function runtimeStoreBridgeRequired(args: string[], config: RuntimeConfig | undefined): boolean {
  return config?.storage?.shared_postgres?.mode === "runtime_store" && !args.includes(runtimeStoreBridgeFlag);
}

function argsWithRuntimeStoreBridge(args: string[], storePath: string): string[] {
  const result: string[] = [];
  const flagsWithValues = new Set(["--shared-ledger-url-env", "--shared-ledger-schema", "--shared-ledger-lock-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === runtimeStoreBridgeFlag) continue;
    if (arg === "--shared-ledger-mirror" || arg === "--no-shared-ledger-mirror") continue;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--store") {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  result.push("--store", storePath, runtimeStoreBridgeFlag);
  return result;
}

async function withSharedPostgresRuntimeStoreBridge<T>(
  args: string[],
  config: RuntimeConfig,
  command: string,
  callback: (storePath: string) => Promise<T>,
): Promise<T> {
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runtime-store-bridge-"));
  const storePath = path.join(tempDir, "local.db");
  try {
    return await withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
      const before = await restoreSharedPostgresToLocalStore({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
      operationalLog("info", "shared_runtime_store_restore", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: before.entries,
        imported: before.imported,
        skipped: before.skipped,
        source_database_changed: false,
      });
      let result: T | undefined;
      let originalError: unknown;
      try {
        result = await callback(storePath);
      } catch (error) {
        originalError = error;
      }

      try {
        const after = await syncLocalStoreToSharedPostgres({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
        operationalLog("info", "shared_runtime_store_sync", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          entries: after.entries,
          source_database_changed: false,
          command_failed: originalError !== undefined,
        });
      } catch (syncError) {
        operationalLog("error", "shared_runtime_store_sync_failed", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          error_code: safeOperationalErrorCode(syncError),
          source_database_changed: false,
          command_failed: originalError !== undefined,
        });
        if (originalError === undefined) throw syncError;
      }
      if (originalError !== undefined) throw originalError;
      return result as T;
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withSharedPostgresRuntimeStoreReadBridge<T>(
  args: string[],
  config: RuntimeConfig,
  command: string,
  callback: (storePath: string) => Promise<T>,
): Promise<T> {
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-runtime-store-read-"));
  const storePath = path.join(tempDir, "local.db");
  try {
    return await withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
      const restored = await restoreSharedPostgresToLocalStore({
        storePath,
        schema: mirror.schema,
        urlEnv: mirror.urlEnv,
        maxEntries: mirror.maxEntries,
      });
      operationalLog("info", "shared_runtime_store_read", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: restored.entries,
        imported: restored.imported,
        skipped: restored.skipped,
        source_database_changed: false,
      });
      return callback(storePath);
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function maybeSharedPostgresRuntimeStoreRead(
  args: string[],
  command: string,
  callback: (storePath: string) => Promise<number>,
): Promise<number | undefined> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.runner.json";
  const config = await optionalRuntimeConfig(configPath);
  if (!config || !runtimeStoreBridgeRequired(args, config)) return undefined;
  return withSharedPostgresRuntimeStoreReadBridge(args, config, command, callback);
}

function sharedPostgresLedgerMirrorRequested(args: string[], config?: RuntimeConfig): boolean {
  if (args.includes("--no-shared-ledger-mirror")) return false;
  return args.includes("--shared-ledger-mirror")
    || Boolean(optionalArg(args, "--shared-ledger-url-env"))
    || process.env.SYNAPSOR_SHARED_LEDGER_MIRROR === "true"
    || config?.storage?.shared_postgres?.mode === "mirror";
}

function sharedPostgresLedgerMirrorOptions(args: string[], config?: RuntimeConfig): SharedPostgresLedgerMirror {
  const configured = config?.storage?.shared_postgres;
  return {
    schema: optionalArg(args, "--shared-ledger-schema")
      ?? process.env.SYNAPSOR_SHARED_LEDGER_SCHEMA
      ?? configured?.schema
      ?? "synapsor_runner",
    urlEnv: optionalArg(args, "--shared-ledger-url-env")
      ?? process.env.SYNAPSOR_SHARED_LEDGER_URL_ENV
      ?? configured?.url_env
      ?? "SYNAPSOR_LEDGER_DATABASE_URL",
    lockTimeoutMs: optionalNonNegativeIntegerArg(args, "--shared-ledger-lock-timeout-ms")
      ?? optionalNonNegativeIntegerEnv("SYNAPSOR_SHARED_LEDGER_LOCK_TIMEOUT_MS")
      ?? configured?.lock_timeout_ms
      ?? 10_000,
    maxEntries: configured?.max_entries ?? 10_000,
  };
}

function withoutSharedPostgresLedgerMirror(args: string[]): string[] {
  const result: string[] = [];
  const flagsWithValues = new Set(["--shared-ledger-url-env", "--shared-ledger-schema", "--shared-ledger-lock-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--shared-ledger-mirror" || arg === "--no-shared-ledger-mirror") continue;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  result.push("--no-shared-ledger-mirror");
  return result;
}

async function withSharedPostgresLedgerMirror<T>(
  args: string[],
  storePath: string,
  command: string,
  callback: () => Promise<T>,
  config?: RuntimeConfig,
): Promise<T> {
  if (storePath === ":memory:") {
    throw new Error("shared Postgres ledger mirror requires a durable --store path, not :memory:");
  }
  const mirror = sharedPostgresLedgerMirrorOptions(args, config);
  return withSharedPostgresLedgerMirrorLock(mirror, command, async () => {
    const before = await restoreSharedPostgresToLocalStore({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
    operationalLog("info", "shared_ledger_mirror_restore", {
      command,
      schema: mirror.schema,
      url_env: mirror.urlEnv,
      entries: before.entries,
      imported: before.imported,
      skipped: before.skipped,
      source_database_changed: false,
    });
    let result: T | undefined;
    let originalError: unknown;
    try {
      result = await callback();
    } catch (error) {
      originalError = error;
    }

    try {
      const after = await syncLocalStoreToSharedPostgres({ storePath, schema: mirror.schema, urlEnv: mirror.urlEnv, maxEntries: mirror.maxEntries });
      operationalLog("info", "shared_ledger_mirror_sync", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        entries: after.entries,
        source_database_changed: false,
        command_failed: originalError !== undefined,
      });
    } catch (syncError) {
      operationalLog("error", "shared_ledger_mirror_sync_failed", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        error_code: safeOperationalErrorCode(syncError),
        source_database_changed: false,
        command_failed: originalError !== undefined,
      });
      if (originalError === undefined) throw syncError;
    }
    if (originalError !== undefined) throw originalError;
    return result as T;
  });
}

async function withSharedPostgresLedgerMirrorLock<T>(
  mirror: SharedPostgresLedgerMirror,
  command: string,
  callback: () => Promise<T>,
): Promise<T> {
  const databaseUrl = envValue(mirror.urlEnv);
  if (!databaseUrl) throw new Error(`${mirror.urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  const client = await pool.connect();
  const lockKey = `synapsor-runner:${mirror.schema}:shared-ledger-mirror`;
  let locked = false;
  try {
    locked = await acquirePostgresAdvisoryLock(client, lockKey, mirror.lockTimeoutMs);
    if (!locked) {
      operationalLog("warn", "shared_ledger_mirror_lock_timeout", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        lock_timeout_ms: mirror.lockTimeoutMs,
        source_database_changed: false,
      });
      throw new Error(`shared Postgres ledger mirror lock is held for schema ${mirror.schema}; retry later or increase --shared-ledger-lock-timeout-ms`);
    }
    operationalLog("info", "shared_ledger_mirror_lock_acquired", {
      command,
      schema: mirror.schema,
      url_env: mirror.urlEnv,
      lock_timeout_ms: mirror.lockTimeoutMs,
      source_database_changed: false,
    });
    return await callback();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS unlocked", [lockKey]).catch((error: unknown) => {
        operationalLog("error", "shared_ledger_mirror_lock_release_failed", {
          command,
          schema: mirror.schema,
          url_env: mirror.urlEnv,
          error_code: safeOperationalErrorCode(error),
          source_database_changed: false,
        });
      });
      operationalLog("info", "shared_ledger_mirror_lock_released", {
        command,
        schema: mirror.schema,
        url_env: mirror.urlEnv,
        source_database_changed: false,
      });
    }
    client.release();
    await pool.end();
  }
}

async function acquirePostgresAdvisoryLock(
  client: SharedPostgresLedgerClient,
  lockKey: string,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await waitFor(Math.min(250, Math.max(25, timeoutMs - (Date.now() - started))));
  }
}

async function fetchSharedPostgresEntriesFromEnv(urlEnv: string, schema: string, maxEntries = 10_000): Promise<SharedLedgerEntry[]> {
  const databaseUrl = envValue(urlEnv);
  if (!databaseUrl) throw new Error(`${urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    return await fetchSharedPostgresLedgerEntries(pool, schema, maxEntries);
  } finally {
    await pool.end();
  }
}

async function syncLocalStoreToSharedPostgres(input: { storePath: string; schema: string; urlEnv: string; maxEntries?: number }): Promise<{ entries: number }> {
  const entries = localSharedLedgerEntries(input.storePath);
  const maxEntries = input.maxEntries ?? 10_000;
  if (entries.length > maxEntries) throw new Error(`shared Postgres ledger sync exceeds configured ${maxEntries}-entry safety bound`);
  const databaseUrl = envValue(input.urlEnv);
  if (!databaseUrl) throw new Error(`${input.urlEnv} is not set.`);
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query("BEGIN");
    await pool.query(sharedPostgresRuntimeStoreMigration(input.schema));
    await upsertSharedPostgresEntries(pool, input.schema, entries);
    await pool.query("COMMIT");
    return { entries: entries.length };
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

async function restoreSharedPostgresToLocalStore(input: { storePath: string; schema: string; urlEnv: string; entries?: SharedLedgerEntry[]; maxEntries?: number }): Promise<{ entries: number; imported: number; skipped: number }> {
  if (input.storePath !== ":memory:") {
    await fs.mkdir(path.dirname(path.resolve(input.storePath)), { recursive: true });
  }
  const maxEntries = input.maxEntries ?? 10_000;
  const entries = input.entries ?? await fetchSharedPostgresEntriesFromEnv(input.urlEnv, input.schema, maxEntries);
  if (entries.length > maxEntries) throw new Error(`shared Postgres ledger restore exceeds configured ${maxEntries}-entry safety bound`);
  const store = new ProposalStore(input.storePath);
  try {
    const result = store.importSharedLedgerEntries(entries);
    return { entries: entries.length, imported: result.imported, skipped: result.skipped };
  } finally {
    store.close();
  }
}

async function fetchSharedPostgresLedgerEntries(pool: ReturnType<typeof createPostgresPool>, schema: string, maxEntries = 10_000): Promise<SharedLedgerEntry[]> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  const result = await pool.query(`
    SELECT entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at::text AS created_at
    FROM ${qualified}
    ORDER BY entry_id ASC
    LIMIT $1
  `, [maxEntries + 1]);
  if (result.rows.length > maxEntries) throw new Error(`shared Postgres ledger exceeds configured ${maxEntries}-entry safety bound`);
  return result.rows.map((row) => {
    const rawPayload = row.payload_json;
    let payload: Record<string, unknown>;
    if (isRecord(rawPayload)) payload = rawPayload;
    else {
      const parsed = JSON.parse(String(rawPayload ?? "{}")) as unknown;
      payload = isRecord(parsed) ? parsed : {};
    }
    return {
      entry_key: String(row.entry_key),
      kind: String(row.kind),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
      capability: row.capability == null ? undefined : String(row.capability),
      payload,
      created_at: String(row.created_at),
    };
  });
}

async function upsertSharedPostgresEntries(
  pool: Pick<ReturnType<typeof createPostgresPool>, "query">,
  schema: string,
  entries: SharedLedgerEntry[],
): Promise<void> {
  const qualified = `${quoteSqlIdentifier(schema, "postgres")}.ledger_entries`;
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET
  kind = EXCLUDED.kind,
  proposal_id = EXCLUDED.proposal_id,
  tenant_id = EXCLUDED.tenant_id,
  capability = EXCLUDED.capability,
  payload_json = EXCLUDED.payload_json,
  created_at = EXCLUDED.created_at`,
      [entry.entry_key, entry.kind, entry.proposal_id ?? null, entry.tenant_id ?? null, entry.capability ?? null, JSON.stringify(entry.payload), entry.created_at],
    );
  }
}

function formatSharedPostgresStatus(payload: { ok: boolean; schema: string; url_env: string; tables: Record<string, number | null> }): string {
  const lines = [
    `Shared Postgres ledger: ${payload.ok ? "ready" : "not initialized"}`,
    `Schema: ${payload.schema}`,
    `URL env: ${payload.url_env}`,
  ];
  for (const [table, count] of Object.entries(payload.tables)) {
    lines.push(`- ${table}: ${count === null ? "missing" : count}`);
  }
  return `${lines.join("\n")}\n`;
}

const commonReadOptions = new Set(["--store", "--config", "--json", "--details", "--debug", runtimeStoreBridgeFlag]);
const showAllowedOptions = new Set([...commonReadOptions]);
const exportAllowedOptions = new Set([...commonReadOptions, "--output", "--out", "--format", "--evidence", "--audit"]);
const proposalListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--action",
  "--object",
  "--object-type",
  "--object-id",
  "--status",
  "--state",
  "--source",
  "--table",
  "--from",
  "--to",
  "--limit",
]);
const evidenceListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--proposal",
  "--object",
  "--object-type",
  "--object-id",
  "--source",
  "--table",
  "--query-fingerprint",
  "--from",
  "--to",
  "--limit",
]);
const queryAuditListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--proposal",
  "--evidence",
  "--source",
  "--table",
  "--primary-key",
  "--query-fingerprint",
  "--from",
  "--to",
  "--limit",
]);
const receiptListAllowedOptions = new Set([
  ...commonReadOptions,
  "--proposal",
  "--writeback-job",
  "--idempotency-key",
  "--status",
  "--from",
  "--to",
  "--limit",
]);
const eventTailAllowedOptions = new Set([
  ...commonReadOptions,
  "--proposal",
  "--kind",
  "--actor",
  "--from",
  "--to",
  "--limit",
  "--follow",
  "--interval-ms",
]);
const eventWebhookAllowedOptions = new Set([
  ...eventTailAllowedOptions,
  "--url",
  "--url-env",
  "--auth-token-env",
  "--timeout-ms",
  "--since-event-id",
  "--dry-run",
]);
const replayShowAllowedOptions = new Set([...commonReadOptions, "--proposal", "--replay", "--evidence"]);
const replayExportAllowedOptions = new Set([...replayShowAllowedOptions, "--output", "--out", "--format"]);
const replayListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--proposal",
  "--evidence",
  "--receipt",
  "--object",
  "--object-type",
  "--object-id",
  "--status",
  "--state",
  "--from",
  "--to",
  "--limit",
]);
const activitySearchAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--object",
  "--object-type",
  "--object-id",
  "--proposal",
  "--evidence",
  "--replay",
  "--receipt",
  "--source",
  "--table",
  "--query-fingerprint",
  "--status",
  "--state",
  "--from",
  "--to",
  "--limit",
]);
const storeStatsAllowedOptions = new Set([...commonReadOptions]);
const storeVacuumAllowedOptions = new Set([...commonReadOptions]);
const storePruneAllowedOptions = new Set([...commonReadOptions, "--older-than", "--dry-run", "--yes", "--force"]);
const storeResetAllowedOptions = new Set([...commonReadOptions, "--yes", "--force"]);
const storeSharedPostgresAllowedOptions = new Set(["--schema", "--url-env", "--store", "--dry-run", "--yes", "--json", "--output", "--input", "--max-entries", "--older-than"]);

function assertKnownOptions(args: string[], allowed: Set<string>, commandName: string): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (option === "--help" || option === "-h") continue;
    if (!allowed.has(option)) throw new Error(`Unknown option for ${commandName}: ${option}`);
  }
}

function proposalFiltersFromArgs(args: string[]): ProposalSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    proposal: optionalArg(args, "--proposal"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    action: optionalArg(args, "--action"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    status: optionalArg(args, "--status") as LocalProposalState | undefined,
    state: optionalArg(args, "--state") as LocalProposalState | undefined,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function evidenceFiltersFromArgs(args: string[]): EvidenceSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    evidence: optionalArg(args, "--evidence"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function queryAuditFiltersFromArgs(args: string[]): QueryAuditSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal"),
    evidence: optionalArg(args, "--evidence"),
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    primaryKey: optionalArg(args, "--primary-key"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function receiptFiltersFromArgs(args: string[]): ReceiptSearchFilters {
  return {
    receipt: optionalArg(args, "--receipt"),
    proposal: optionalArg(args, "--proposal"),
    writebackJob: optionalArg(args, "--writeback-job"),
    idempotencyKey: optionalArg(args, "--idempotency-key"),
    status: optionalArg(args, "--status"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function proposalFiltersFromReplayArgs(args: string[], store: ProposalStore): ProposalSearchFilters {
  return proposalFiltersFromActivityArgs(args, store);
}

function proposalFiltersFromActivityArgs(args: string[], store?: ProposalStore): ProposalSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store);
  return {
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    action: optionalArg(args, "--capability"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    status: optionalArg(args, "--status") as LocalProposalState | undefined,
    state: optionalArg(args, "--state") as LocalProposalState | undefined,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function evidenceFiltersFromActivityArgs(args: string[], store?: ProposalStore): EvidenceSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeEvidence: false });
  return {
    evidence: optionalArg(args, "--evidence"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function queryAuditFiltersFromActivityArgs(args: string[], store?: ProposalStore): QueryAuditSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeEvidence: false });
  return {
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    evidence: optionalArg(args, "--evidence"),
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function receiptFiltersFromActivityArgs(args: string[], store?: ProposalStore): ReceiptSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeReceipt: false });
  return {
    receipt: optionalArg(args, "--receipt"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    status: optionalArg(args, "--status") ?? optionalArg(args, "--state"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function eventFiltersFromArgs(args: string[]): EventSearchFilters {
  return {
    proposal: optionalArg(args, "--proposal"),
    kind: optionalArg(args, "--kind"),
    actor: optionalArg(args, "--actor"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}

function optionalPositiveIntegerArg(args: string[], flag: string): number | undefined {
  const value = optionalArg(args, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function optionalNonNegativeIntegerArg(args: string[], flag: string): number | undefined {
  return optionalPositiveIntegerArg(args, flag);
}

function optionalNonNegativeIntegerEnv(name: string): number | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function envValue(name: string | undefined): string | undefined;
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined;
function envValue(first: NodeJS.ProcessEnv | string | undefined, second?: string): string | undefined {
  if (typeof first === "string" || first === undefined) {
    if (!first) return undefined;
    return trimmedEnvValue(process.env, first);
  }
  if (!second) return undefined;
  return trimmedEnvValue(first, second);
}

function trimmedEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function linkedProposalFilter(
  args: string[],
  store?: ProposalStore,
  options: { includeEvidence?: boolean; includeReceipt?: boolean } = {},
): string | undefined {
  const noLinkedProposal = "__synapsor_no_linked_proposal__";
  const replay = optionalArg(args, "--replay");
  if (replay) return proposalIdFromReplayId(replay);
  if (!store) return undefined;
  if (options.includeEvidence !== false) {
    const evidence = optionalArg(args, "--evidence");
    if (evidence) return store.proposalIdForEvidence(evidence) ?? noLinkedProposal;
  }
  if (options.includeReceipt !== false) {
    const receiptValue = optionalArg(args, "--receipt");
    if (receiptValue) {
      const receiptId = Number(receiptValue);
      if (!Number.isInteger(receiptId) || receiptId <= 0) throw new Error("--receipt must be a positive receipt id");
      return store.getReceipt(receiptId)?.proposal_id ?? noLinkedProposal;
    }
  }
  return undefined;
}

function objectFilterFromArgs(args: string[]): { type?: string; id?: string } {
  const value = optionalArg(args, "--object");
  if (!value) return {};
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--object must use type:id, for example invoice:INV-3001");
  }
  return { type: value.slice(0, separator), id: value.slice(separator + 1) };
}

function limitFromArgs(args: string[]): number {
  const value = optionalArg(args, "--limit");
  if (!value) return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
  return Math.min(parsed, 200);
}

function exportFormat(args: string[], supported = ["json", "markdown"]): "json" | "markdown" {
  const format = optionalArg(args, "--format") ?? "json";
  if (!supported.includes(format)) {
    throw new Error(`unsupported export format: ${format}. Supported formats: ${supported.join(", ")}`);
  }
  return format as "json" | "markdown";
}

function resolveReplayProposalId(args: string[], store: ProposalStore): string {
  const explicitProposal = optionalArg(args, "--proposal");
  if (explicitProposal) return resolveProposalIdFromStore(explicitProposal, store);
  const explicitReplay = optionalArg(args, "--replay");
  if (explicitReplay) return proposalIdFromReplayId(explicitReplay);
  const explicitEvidence = optionalArg(args, "--evidence");
  if (explicitEvidence) {
    const proposalId = store.proposalIdForEvidence(explicitEvidence);
    if (!proposalId) throw new Error(`evidence bundle ${explicitEvidence} is not linked to a replayable proposal`);
    return proposalId;
  }
  const value = positional(args, 0);
  if (!value) throw new Error("replay show requires <proposal_id>, --proposal <proposal_id>, --replay <replay_id>, or --evidence <evidence_bundle_id>");
  if (value === "latest") return resolveProposalIdFromStore(value, store);
  if (value.startsWith("replay_")) return proposalIdFromReplayId(value);
  if (value.startsWith("ev_")) throw new Error(`Use --evidence ${value} to replay from an evidence bundle.`);
  return resolveProposalIdFromStore(value, store);
}

function proposalIdFromReplayId(replayId: string): string {
  if (!replayId.startsWith("replay_")) throw new Error(`invalid replay id: ${replayId}`);
  const proposalId = replayId.slice("replay_".length);
  if (!proposalId) throw new Error(`invalid replay id: ${replayId}`);
  return proposalId;
}

async function openLocalStore(args: string[]): Promise<ProposalStore> {
  const storePath = localStorePath(args);
  if (storePath !== ":memory:") {
    if (!await fileExists(storePath)) throw missingLocalStoreError(storePath);
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  return new ProposalStore(storePath);
}

function localStorePath(args: string[]): string {
  return optionalArg(args, "--store") ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db";
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

async function optionalRuntimeConfig(configPath: string): Promise<RuntimeConfig | undefined> {
  return await fileExists(configPath) ? await readRuntimeConfig(configPath) : undefined;
}

async function operatorIdentityForDecision(input: {
  args: string[];
  config: RuntimeConfig | undefined;
  configPath: string;
  proposal: StoredProposal;
  action: "approve" | "reject" | "apply" | "revert" | "reconcile" | "worker_requeue" | "worker_discard";
  reason?: string;
}) {
  const applyAuthorityAction = ["apply", "reconcile", "worker_requeue", "worker_discard"].includes(input.action);
  const requiredRole = applyAuthorityAction ? undefined : input.proposal.change_set.approval.required_role;
  const identity = await resolveOperatorIdentity({
    config: input.config?.operator_identity as OperatorIdentityConfig | undefined,
    configPath: input.configPath,
    proposal: input.proposal,
    action: input.action,
    reason: input.reason,
    actor: optionalArg(input.args, "--actor"),
    identity: optionalArg(input.args, "--identity"),
    privateKeyPath: optionalArg(input.args, "--identity-key"),
    requiredRole,
  });
  const applyRoles = input.config?.operator_identity?.apply_roles ?? [];
  if (applyAuthorityAction && applyRoles.length > 0 && !applyRoles.some((role) => identity.roles.includes(role))) {
    throw new Error(`operator ${identity.subject} lacks an apply role; requires one of: ${applyRoles.join(", ")}`);
  }
  return identity;
}

function requireLocalProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}

async function resolveProposalId(proposalId: string, storePath: string): Promise<string> {
  if (proposalId !== "latest") return proposalId;
  if (storePath !== ":memory:" && !await fileExists(storePath)) throw missingLocalStoreError(storePath);
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

function missingLocalStoreError(storePath: string): Error {
  return new Error([
    `No local Synapsor proposal store was found at ${storePath}.`,
    "Run:",
    `${cliCommandName()} demo`,
    "or pass:",
    "--store /path/to/local.db",
  ].join("\n"));
}

async function readRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  return loadRuntimeConfigFromFile(configPath);
}

function isSynapsorContractLike(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    ((value as { kind?: unknown }).kind === "SynapsorContract" || (value as { spec_version?: unknown }).spec_version === "0.1");
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
  const demoDir = await resolveAssetPath(referenceDemoDir);
  const composePath = path.join(demoDir, "docker-compose.yml");
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
  await fs.copyFile(path.join(demoDir, "synapsor.runner.json"), configPath);
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
    `${cliCommandName()} ui --open --tour`,
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
  const fromEnv = optionalArg(args, "--from-env") ?? optionalArg(args, "--url-env") ?? optionalArg(args, "--database-url-env");
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
    "--api-url",
    "--actor",
    "--action",
    "--auth-token-env",
    "--audit",
    "--bearer-env",
    "--capability",
    "--config",
    "--contract",
    "--conflict-column",
    "--cors-origin",
    "--database-url-env",
    "--description",
    "--destination",
    "--engine",
    "--evidence",
    "--example",
    "--fail-on",
    "--format",
    "--from",
    "--from-env",
    "--url-env",
    "--host",
    "--idempotency-key",
    "--input",
    "--job",
    "--lease-seconds",
    "--limit",
    "--lookup-arg",
    "--mode",
    "--mcp-config",
    "--namespace",
    "--numeric-bound",
    "--now",
    "--object",
    "--object-id",
    "--object-type",
    "--object-name",
    "--older-than",
    "--output",
    "--out",
    "--patch-fixed",
    "--patch-from-arg",
    "--port",
    "--primary-key",
    "--principal-env",
    "--principal",
    "--policy",
    "--proposal",
    "--public-key",
    "--project",
    "--query-fingerprint",
    "--reason",
    "--recipe",
    "--receipt",
    "--read-tool",
    "--inspect-tool-name",
    "--proposal-tool",
    "--proposal-tool-name",
    "--replay",
    "--runner",
    "--schema",
    "--signing-key",
    "--source-name",
    "--source",
    "--state",
    "--status",
    "--stdio",
    "--store",
    "--shared-ledger-schema",
    "--shared-ledger-lock-timeout-ms",
    "--shared-ledger-url-env",
    "--table",
    "--tenant",
    "--tenant-env",
    "--tenant-key",
    "--tests",
    "--timeout-ms",
    "--token",
    "--to",
    "--transition-guard",
    "--url",
    "--visible-columns",
    "--workspace",
    "--writeback-job",
    "--write-url-env",
    "--key-id",
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
    `${proposal.created_at}  ${proposal.proposal_id}  ${proposal.state}  ${proposal.action}`,
    `  object: ${proposal.business_object}:${proposal.object_id}`,
    `  target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `  tenant: ${proposal.tenant_id}  source changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}

function formatProposalFirstLook(proposal: StoredProposal, storedEvidenceItemCount: number | undefined, proposalRef: string, storeSuffix: string): string {
  const evidenceItems = storedEvidenceItemCount ?? proposal.change_set.evidence.items?.length ?? 0;
  return [
    `Proposal ${proposal.proposal_id}`,
    `Status: ${humanStatus(proposal.state)}`,
    "",
    "Agent requested:",
    proposal.action,
    "",
    "Business object:",
    `${proposal.business_object} ${proposal.object_id}`,
    ...boundedSetReviewLines(proposal.change_set),
    "",
    "Proposed change:",
    ...formatChangeLines(proposal).map((line) => line.replace(/^  /, "")),
    "",
    "Source DB changed:",
    proposal.source_database_mutated ? "yes" : "no",
    "",
    "Approval:",
    approvalBoundary(proposal),
    "",
    "Evidence:",
    `${proposal.change_set.evidence.bundle_id}${evidenceItems > 0 ? ` (${plural(evidenceItems, "item")})` : ""}`,
    "",
    "Next:",
    ...proposalNextCommands(proposal, proposalRef, storeSuffix).map((command) => `${command}`),
    "",
    "More detail:",
    `${cliCommandName()} proposals show ${proposalRef} --details${storeSuffix}`,
    "",
  ].join("\n");
}

function formatProposalDetail(proposal: StoredProposal, storedEvidenceItemCount?: number): string {
  const changeSet = proposal.change_set;
  const conflictGuard = "expected_version" in changeSet.guards ? changeSet.guards.expected_version : undefined;
  const evidenceItems = storedEvidenceItemCount ?? changeSet.evidence.items?.length ?? 0;
  const approvalStatus = currentApprovalStatus(proposal);
  const writebackStatus = currentWritebackStatus(proposal);
  return [
    `Proposal details: ${proposal.proposal_id}`,
    "",
    "Review details:",
    `principal: ${changeSet.principal.id} (${changeSet.principal.source})`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `primary key: ${changeSet.source.primary_key.column}${changeSet.source.primary_key.value === undefined ? " (exact identities frozen below)" : `=${formatScalar(changeSet.source.primary_key.value)}`}`,
    `status: ${proposal.state}`,
    `action: ${proposal.action}`,
    `approval: ${approvalStatus}${changeSet.approval.required_role ? ` required role ${changeSet.approval.required_role}` : ""}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `allowed columns: ${changeSet.guards.allowed_columns.join(", ")}`,
    `conflict guard: ${conflictGuard?.column || "none"}=${formatScalar(conflictGuard?.value)}`,
    `evidence: ${changeSet.evidence.bundle_id}  query ${changeSet.evidence.query_fingerprint}  items ${evidenceItems}`,
    `writeback: ${writebackStatus} via ${changeSet.writeback.mode}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    ...boundedSetReviewLines(changeSet, true),
    "",
    "Diff:",
    ...formatChangeLines(proposal, 100),
  ].join("\n") + "\n";
}

function formatProposalEventDetail(events: ProposalEvent[]): string {
  if (events.length === 0) return "Events:\n  none\n";
  return [
    "Events:",
    ...events.map((event) => `  event ${event.event_id}: ${event.kind} by ${event.actor} at ${event.created_at}`),
  ].join("\n") + "\n";
}

function formatProposalDebug(proposal: StoredProposal, storePath: string | undefined): string {
  return [
    "Debug:",
    `store: ${storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db"}`,
    `interaction id: ${proposal.interaction_id ?? "none"}`,
    `tool call id: ${proposal.tool_call_id ?? "none"}`,
    `source kind: ${proposal.source_kind}`,
    `writeback mode: ${proposal.change_set.writeback.mode}`,
    "",
  ].join("\n");
}

function formatEvidenceSummary(evidence: StoredEvidenceBundle): string {
  return [
    `${evidence.created_at}  ${evidence.evidence_bundle_id}`,
    `  tenant: ${evidence.tenant_id}  capability: ${evidence.capability ?? "unknown"}  proposal: ${evidence.proposal_id ?? "none"}`,
    `  source: ${evidence.source_id ?? "unknown"}/${evidence.source_table ?? "unknown"}  object: ${evidence.business_object ?? "object"}:${evidence.object_id ?? "unknown"}`,
  ].join("\n") + "\n";
}

function formatEvidenceFirstLook(evidence: StoredEvidenceBundle, storeSuffix: string): string {
  const object = evidence.business_object && evidence.object_id ? `${evidence.business_object} ${evidence.object_id}` : "not linked";
  const lines = [
    `Evidence ${evidence.evidence_bundle_id}`,
    "",
    "Used for:",
    evidence.capability ?? "unknown capability",
    object,
    "",
    "Captured:",
    plural(evidence.items.length, "evidence item"),
    plural(evidence.query_audit.length, "query audit record"),
    "",
    "Source:",
    `${evidence.source_id ?? "unknown"} / ${evidence.source_table ?? "unknown"}`,
    "",
    "Rows:",
    ...evidence.items.flatMap((item, index) => formatEvidenceItem(item, index + 1)),
    "",
    "Next:",
    `  ${cliCommandName()} query-audit list --evidence ${evidence.evidence_bundle_id}${storeSuffix}`,
    ...(evidence.proposal_id ? [`  ${cliCommandName()} replay show --proposal ${evidence.proposal_id}${storeSuffix}`] : []),
    "",
    "More detail:",
    `  ${cliCommandName()} evidence show ${evidence.evidence_bundle_id} --details${storeSuffix}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatEvidenceDetail(evidence: StoredEvidenceBundle): string {
  const audit = evidence.query_audit[0];
  const lines = [
    `Evidence bundle: ${evidence.evidence_bundle_id}`,
    `Tenant: ${evidence.tenant_id}`,
    `Proposal: ${evidence.proposal_id ?? "none"}`,
    `Principal: ${evidence.principal ?? "unknown"}`,
    `Capability: ${evidence.capability ?? "unknown"}`,
    `Source: ${evidence.source_id ?? "unknown"}`,
    `Table: ${evidence.source_table ?? "unknown"}`,
    `Query fingerprint: ${evidence.query_fingerprint ?? stringField(audit, "query_fingerprint") ?? "unknown"}`,
    `Rows captured: ${evidence.items.length}`,
    `Created at: ${evidence.created_at}`,
    "Projection: captured visible fields only; credentials and secret-looking values are rejected before persistence.",
    "",
    "Items:",
    ...evidence.items.flatMap((item, index) => formatEvidenceItem(item, index + 1)),
    "",
    "Related:",
    ...(evidence.proposal_id ? [`  ${cliCommandName()} proposals show ${evidence.proposal_id}`, `  ${cliCommandName()} replay show --proposal ${evidence.proposal_id}`] : []),
    `  ${cliCommandName()} query-audit list --evidence ${evidence.evidence_bundle_id}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatEvidenceItem(item: Record<string, unknown>, index: number): string[] {
  const payload = isRecord(item.item) ? item.item : item;
  const visibleRow = isRecord(payload.visible_row) ? payload.visible_row : payload;
  const title = stringField(payload, "kind") ?? "item";
  const primaryKey = isRecord(payload.primary_key) ? payload.primary_key : undefined;
  const heading = primaryKey
    ? `* ${title} ${formatScalar(primaryKey.value)}`
    : `* ${title} ${index}`;
  const rows = Object.entries(visibleRow)
    .filter(([key]) => !["kind", "source_id", "table", "primary_key", "tenant"].includes(key))
    .flatMap(([key, value]) => formatEvidenceFieldLines(key, value))
    .slice(0, 12);
  return [heading, ...(rows.length ? rows : ["  (no scalar preview fields)"])];
}

function formatEvidenceFieldLines(key: string, value: unknown): string[] {
  if (isRecord(value)) {
    const nested = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue === null || ["string", "number", "boolean"].includes(typeof nestedValue))
      .slice(0, 6)
      .map(([nestedKey, nestedValue]) => `  ${key}.${nestedKey}: ${formatScalar(nestedValue)}`);
    return nested.length ? nested : [`  ${key}: [object]`];
  }
  return [`  ${key}: ${formatScalar(value)}`];
}

function formatEvidenceMarkdown(evidence: StoredEvidenceBundle): string {
  return [
    `# Evidence ${evidence.evidence_bundle_id}`,
    "",
    `- Tenant: ${evidence.tenant_id}`,
    `- Proposal: ${evidence.proposal_id ?? "none"}`,
    `- Principal: ${evidence.principal ?? "unknown"}`,
    `- Capability: ${evidence.capability ?? "unknown"}`,
    `- Source: ${evidence.source_id ?? "unknown"}`,
    `- Table: ${evidence.source_table ?? "unknown"}`,
    `- Query fingerprint: ${evidence.query_fingerprint ?? "unknown"}`,
    `- Created at: ${evidence.created_at}`,
    "",
    "## Captured Items",
    "",
    "```json",
    JSON.stringify(evidence.items, null, 2),
    "```",
    "",
    "## Query Audit",
    "",
    "```json",
    JSON.stringify(evidence.query_audit, null, 2),
    "```",
  ].join("\n") + "\n";
}

function formatQueryAuditSummary(row: Record<string, unknown>, details = false, storeSuffix = ""): string {
  const lines = [
    `${row.created_at}  audit ${row.audit_id}`,
    `  source: ${row.source_id}/${row.table_name}  rows: ${row.row_count}`,
    `  proposal: ${row.proposal_id ?? "none"}  evidence: ${row.evidence_bundle_id ?? "none"}`,
    ...(details ? [`  query fingerprint: ${row.query_fingerprint}`] : []),
    `  detail: ${cliCommandName()} query-audit show ${row.audit_id}${details ? "" : " --details"}${storeSuffix}`,
  ];
  return lines.join("\n") + "\n";
}

function formatQueryAuditFirstLook(row: Record<string, unknown>, storeSuffix: string): string {
  return [
    `Query audit ${row.audit_id}`,
    "",
    "Read:",
    `${row.source_id}/${row.table_name}`,
    "",
    "Rows returned:",
    String(row.row_count ?? "unknown"),
    "",
    "Linked records:",
    `proposal: ${row.proposal_id ?? "none"}`,
    `evidence: ${row.evidence_bundle_id ?? "none"}`,
    "",
    "More detail:",
    `${cliCommandName()} query-audit show ${row.audit_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}

function formatQueryAuditDetail(row: Record<string, unknown>): string {
  const payload = isRecord(row.payload) ? row.payload : {};
  return [
    `Query audit: ${row.audit_id}`,
    `Created at: ${row.created_at}`,
    `Source: ${row.source_id}`,
    `Table: ${row.table_name}`,
    `Rows: ${row.row_count}`,
    `Query fingerprint: ${row.query_fingerprint}`,
    `Proposal: ${row.proposal_id ?? "none"}`,
    `Evidence: ${row.evidence_bundle_id ?? "none"}`,
    `Tenant: ${row.tenant_id ?? "unknown"}`,
    `Capability: ${row.capability ?? payload.capability ?? "unknown"}`,
    `Parameters redacted: ${payload.parameters_redacted === true ? "yes" : "unknown"}`,
    "",
    "Payload:",
    JSON.stringify(payload, null, 2),
  ].join("\n") + "\n";
}

function formatReceiptSummary(receipt: StoredWritebackReceipt): string {
  return [
    `${receipt.created_at}  receipt ${receipt.receipt_id}  ${receipt.status}`,
    `  proposal: ${receipt.proposal_id}  job: ${receipt.writeback_job_id}`,
    `  idempotency: ${receipt.idempotency_key}  source changed: ${receipt.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}

function formatReceiptFirstLook(receipt: StoredWritebackReceipt, storeSuffix: string): string {
  const setReceipt = receipt.receipt.schema_version === protocolVersions.executionReceiptV3 ? receipt.receipt : undefined;
  const checks = receipt.status === "applied"
    ? setReceipt
      ? ["every frozen identity matched", "trusted tenant matched", "allowed columns only", "every version guard passed", "one atomic set transaction"]
      : ["primary key matched", "tenant guard matched", "allowed columns only", "conflict guard passed"]
    : receipt.status === "conflict"
      ? ["primary key matched", "tenant guard matched", "conflict guard blocked stale write"]
      : ["guarded writeback did not apply"];
  return [
    `Receipt ${formatReceiptId(receipt.receipt_id)}`,
    `Status: ${humanStatus(receipt.status)}`,
    "",
    "Proposal:",
    receipt.proposal_id,
    "",
    "Writeback:",
    setReceipt ? `guarded bounded-set ${setReceipt.operation.replace(/^set_|^batch_/, "").toUpperCase()}` : `guarded ${receiptOperationLabel(receipt)}`,
    "",
    "Checks:",
    ...checks.map((check) => `${check}`),
    `affected rows: ${receipt.receipt.rows_affected}`,
    "",
    "Source DB changed:",
    receipt.source_database_mutated ? "yes" : "no",
    "",
    "Next:",
    `${cliCommandName()} replay show --proposal ${receipt.proposal_id}${storeSuffix}`,
    "",
    "More detail:",
    `${cliCommandName()} receipts show ${receipt.receipt_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}

function formatReceiptDetail(receipt: StoredWritebackReceipt): string {
  const setReceipt = receipt.receipt.schema_version === protocolVersions.executionReceiptV3 ? receipt.receipt : undefined;
  return [
    `Receipt: ${receipt.receipt_id}`,
    `Proposal: ${receipt.proposal_id}`,
    `Writeback job: ${receipt.writeback_job_id}`,
    `Runner: ${receipt.runner_id}`,
    `Status: ${receipt.status}`,
    `Idempotency key: ${receipt.idempotency_key}`,
    `Source database mutated: ${receipt.source_database_mutated ? "yes" : "no"}`,
    `Rows affected: ${receipt.receipt.rows_affected}`,
    ...(setReceipt ? [
      `Operation: ${setReceipt.operation}`,
      `Frozen set digest: ${setReceipt.target.set_digest}`,
      `Exact member effects: ${setReceipt.member_effects.length}`,
      ...setReceipt.member_effects.map((member) => `  ${member.primary_key.column}=${formatScalar(member.primary_key.value)} before=${member.before_digest ?? "none"} after=${member.after_digest ?? "none"} tombstone=${member.tombstone_digest ?? "none"}`),
    ] : []),
    `Safe error: ${receipt.receipt.safe_error_code ?? "none"}`,
    `Receipt hash: ${receipt.receipt.receipt_hash}`,
    `Created at: ${receipt.created_at}`,
    "",
    "Related:",
    `  ${cliCommandName()} replay show --proposal ${receipt.proposal_id}`,
  ].join("\n") + "\n";
}

function formatReplaySummary(row: Record<string, unknown>): string {
  return [
    `${row.created_at}  ${row.replay_id}`,
    `  proposal: ${row.proposal_id}  status: ${row.state}`,
    `  tenant: ${row.tenant_id}  capability: ${row.capability}  object: ${row.business_object}:${row.object_id}`,
  ].join("\n") + "\n";
}

function formatReplayFirstLook(replay: ProposalReplayRecord, storeSuffix: string): string {
  const proposal = replay.proposal;
  const evidenceItems = replay.evidence.reduce((count, item) => {
    const evidence = item as { items?: unknown };
    return count + (Array.isArray(evidence.items) ? evidence.items.length : 0);
  }, 0);
  const latestReceipt = replay.receipts.at(-1);
  const writebackStatus = latestReceipt ? humanStatus(latestReceipt.status) : humanStatus(currentWritebackStatus(proposal));
  const approvalLine = proposal.state === "pending_review"
    ? "Approval is still pending"
    : `Proposal is ${humanStatus(proposal.state)}`;
  return [
    `Replay ${replay.replay_id}`,
    "",
    "What happened:",
    `1. Agent called ${proposal.action}`,
    `2. Runner read ${proposal.business_object} ${proposal.object_id} under tenant ${proposal.tenant_id}`,
    `3. Runner created evidence bundle ${proposal.change_set.evidence.bundle_id}`,
    "4. Runner created a proposal",
    `5. Source DB changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    `6. ${approvalLine}`,
    "",
    "Proposed change:",
    ...formatChangeLines(proposal).map((line) => line.replace(/^  /, "")),
    "",
    "Evidence:",
    plural(replay.query_audit.length, "query audit record"),
    plural(evidenceItems, "evidence item"),
    "",
    "Writeback:",
    writebackStatus,
    ...(latestReceipt ? [`source DB changed after writeback: ${latestReceipt.source_database_mutated ? "yes" : "no"}`] : []),
    "",
    "Next:",
    `  ${cliCommandName()} evidence show ${proposal.change_set.evidence.bundle_id}${storeSuffix}`,
    ...(proposal.state === "pending_review" ? [`  ${cliCommandName()} proposals approve ${proposal.proposal_id} --yes${storeSuffix}`] : []),
    "",
    "More detail:",
    `  ${cliCommandName()} replay show --proposal ${proposal.proposal_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}

function formatReplayDetail(replay: ProposalReplayRecord): string {
  const evidenceItems = replay.evidence.reduce((count, item) => {
    const evidence = item as { items?: unknown };
    return count + (Array.isArray(evidence.items) ? evidence.items.length : 0);
  }, 0);
  return [
    `Replay details ${replay.replay_id}`,
    formatProposalDetail(replay.proposal, evidenceItems).trimEnd(),
    `events: ${replay.events.length}`,
    ...replay.events.map((event) => `  ${event.kind} by ${event.actor} at ${event.created_at}`),
    `receipts: ${replay.receipts.length}`,
    ...replay.receipts.map((receipt) => `  receipt ${receipt.receipt_id}: ${receipt.status} job ${receipt.writeback_job_id}`),
    `evidence bundles: ${replay.evidence.length}`,
    ...replay.evidence.map((evidence) => `  ${(evidence as { evidence_bundle_id?: string }).evidence_bundle_id ?? "unknown"}`),
    `query audit records: ${replay.query_audit.length}`,
    ...replay.query_audit.map((record) => `  audit ${(record as { audit_id?: unknown }).audit_id}: ${(record as { source_id?: unknown }).source_id}/${(record as { table_name?: unknown }).table_name} rows ${(record as { row_count?: unknown }).row_count}`),
  ].join("\n") + "\n";
}

function formatReplayDebug(replay: ProposalReplayRecord, storePath: string | undefined): string {
  return [
    "Debug:",
    `store: ${storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db"}`,
    `generated at: ${replay.generated_at}`,
    `event ids: ${replay.events.map((event) => event.event_id).join(", ") || "none"}`,
    `receipt ids: ${replay.receipts.map((receipt) => receipt.receipt_id).join(", ") || "none"}`,
    "",
  ].join("\n");
}

function formatReplayMarkdown(replay: ProposalReplayRecord): string {
  const proposal = replay.proposal;
  const principal = proposal.change_set.principal.id;
  const approvalEvents = replay.events.filter((event) => /approved|rejected|canceled/i.test(event.kind));
  const evidenceLines = replay.evidence.length > 0
    ? replay.evidence.flatMap((evidence) => {
      const record = evidence as {
        evidence_bundle_id?: string;
        payload?: Record<string, unknown>;
        items?: unknown[];
        query_audit?: unknown[];
      };
      const payload = isRecord(record.payload) ? record.payload : {};
      const sourceId = stringField(payload, "source_id") ?? proposal.source_id;
      const table = stringField(payload, "target") ?? `${proposal.source_schema}.${proposal.source_table}`;
      const queryFingerprint = stringField(payload, "query_fingerprint") ?? proposal.change_set.evidence.query_fingerprint;
      return [
        `- evidence: ${record.evidence_bundle_id ?? proposal.change_set.evidence.bundle_id}`,
        `  - source: ${sourceId}.${table}`,
        `  - query fingerprint: ${queryFingerprint}`,
        `  - rows captured: ${Array.isArray(record.items) ? record.items.length : 0}`,
      ];
    })
    : [`- evidence: ${proposal.change_set.evidence.bundle_id}`, `  - source: ${proposal.source_id}.${proposal.source_schema}.${proposal.source_table}`, `  - query fingerprint: ${proposal.change_set.evidence.query_fingerprint}`, "  - rows captured: 0"];
  const receiptLines = replay.receipts.length > 0
    ? replay.receipts.flatMap((receipt) => [
      `- receipt: ${receipt.receipt_id}`,
      `  - status: ${receipt.status}`,
      `  - affected rows: ${receipt.receipt.rows_affected}`,
      `  - idempotency key: ${receipt.idempotency_key}`,
      `  - source database mutated: ${receipt.source_database_mutated ? "yes" : "no"}`,
      ...(receipt.receipt.safe_error_code ? [`  - safe error: ${receipt.receipt.safe_error_code}`] : []),
    ])
    : ["- no writeback receipt recorded yet"];
  return [
    "# Synapsor Replay",
    "",
    `Proposal: ${proposal.proposal_id}`,
    `Capability: ${proposal.action}`,
    `Tenant: ${proposal.tenant_id}`,
    `Object: ${proposal.business_object}:${proposal.object_id}`,
    `Status: ${proposal.state}`,
    "",
    "## What The Agent Requested",
    "",
    `The model-facing capability requested \`${proposal.action}\` for ${proposal.business_object}:${proposal.object_id}.`,
    "The source database was not mutated when the proposal was created.",
    "",
    "## Trusted Context",
    "",
    `tenant_id = ${proposal.tenant_id}`,
    `principal = ${principal}`,
    `principal_source = ${proposal.change_set.principal.source}`,
    "",
    "## Evidence",
    "",
    ...evidenceLines,
    "",
    "## Proposed Diff",
    "",
    ...formatChangeLines(proposal, 100).map((line) => `- ${line.trim()}`),
    "",
    "## Approval",
    "",
    ...(approvalEvents.length > 0
      ? approvalEvents.map((event) => `- ${event.kind} by ${event.actor} at ${event.created_at}`)
      : [`- ${proposal.change_set.approval.status}${proposal.change_set.approval.required_role ? `; required role: ${proposal.change_set.approval.required_role}` : ""}`]),
    "",
    "## Guarded Writeback",
    "",
    ...receiptLines,
    "",
    "## Query Audit",
    "",
    ...replay.query_audit.map((record) => `- audit ${(record as { audit_id?: unknown }).audit_id}: ${(record as { source_id?: unknown }).source_id}/${(record as { table_name?: unknown }).table_name} rows ${(record as { row_count?: unknown }).row_count} fingerprint ${(record as { query_fingerprint?: unknown }).query_fingerprint}`),
    "",
    "## Replay Note",
    "",
    "This is local captured interaction replay, not external database time travel. It reconstructs what the runner recorded: trusted context, evidence handles, proposal diff, approval events, query audit, and writeback receipts.",
  ].join("\n") + "\n";
}

function activityFromProposal(proposal: StoredProposal): Record<string, unknown> {
  return {
    kind: "proposal",
    created_at: proposal.created_at,
    capability: proposal.action,
    tenant: proposal.tenant_id,
    principal: proposal.principal ?? proposal.change_set.principal.id,
    object: `${proposal.business_object}:${proposal.object_id}`,
    proposal: proposal.proposal_id,
    evidence: proposal.change_set.evidence.bundle_id,
    status: proposal.state,
    replay: `replay_${proposal.proposal_id}`,
    source: proposal.source_id,
    table: `${proposal.source_schema}.${proposal.source_table}`,
  };
}

function activityFromEvidence(evidence: StoredEvidenceBundle): Record<string, unknown> {
  return {
    kind: "evidence",
    created_at: evidence.created_at,
    capability: evidence.capability,
    tenant: evidence.tenant_id,
    principal: evidence.principal,
    object: evidence.business_object && evidence.object_id ? `${evidence.business_object}:${evidence.object_id}` : undefined,
    proposal: evidence.proposal_id,
    evidence: evidence.evidence_bundle_id,
    status: "evidence_recorded",
    source: evidence.source_id,
    table: evidence.source_table,
  };
}

function activityFromQueryAudit(audit: Record<string, unknown>): Record<string, unknown> {
  const businessObject = stringField(audit, "business_object");
  const objectId = stringField(audit, "object_id") ?? stringField(audit, "primary_key_value");
  return {
    kind: "query-audit",
    created_at: stringField(audit, "created_at"),
    capability: stringField(audit, "capability"),
    tenant: stringField(audit, "tenant_id"),
    principal: stringField(audit, "principal"),
    object: businessObject && objectId ? `${businessObject}:${objectId}` : undefined,
    proposal: stringField(audit, "proposal_id"),
    evidence: stringField(audit, "evidence_bundle_id"),
    status: "query_audited",
    source: stringField(audit, "source_id"),
    table: stringField(audit, "table_name"),
    query_audit: stringField(audit, "audit_id"),
    query_fingerprint: stringField(audit, "query_fingerprint"),
  };
}

function activityFromReceipt(receipt: StoredWritebackReceipt): Record<string, unknown> {
  return {
    kind: "receipt",
    created_at: receipt.created_at,
    capability: receipt.capability,
    tenant: receipt.tenant_id,
    principal: receipt.principal,
    object: receipt.business_object && receipt.object_id ? `${receipt.business_object}:${receipt.object_id}` : undefined,
    proposal: receipt.proposal_id,
    receipt: receipt.receipt_id,
    status: receipt.status,
    replay: `replay_${receipt.proposal_id}`,
    source: receipt.source_id,
    table: receipt.source_table,
    source_database_mutated: receipt.source_database_mutated,
  };
}

function formatActivityItem(item: Record<string, unknown>, index: number, details = false): string {
  const lines = [
    `${index}. ${item.created_at}`,
    `   kind: ${item.kind}`,
    ...(item.capability ? [`   capability: ${item.capability}`] : []),
    ...(item.tenant ? [`   tenant: ${item.tenant}`] : []),
    ...(item.object ? [`   object: ${item.object}`] : []),
    ...(item.proposal ? [`   proposal: ${item.proposal}`] : []),
    ...(item.evidence ? [`   evidence: ${item.evidence}`] : []),
    ...(item.query_audit ? [`   query audit: ${item.query_audit}`] : []),
    ...(details && item.query_fingerprint ? [`   query fingerprint: ${item.query_fingerprint}`] : []),
    ...(item.receipt ? [`   receipt: ${item.receipt}`] : []),
    ...(item.status ? [`   status: ${humanStatus(String(item.status))}`] : []),
    ...(item.replay ? [`   replay: ${item.replay}`] : []),
    "",
  ];
  return lines.join("\n");
}

function formatActivityNext(items: Record<string, unknown>[], storeSuffix: string): string {
  const first = items[0];
  if (!first) return "";
  const proposal = stringField(first, "proposal");
  const replayId = stringField(first, "replay");
  const evidence = stringField(first, "evidence");
  const lines = ["Next:"];
  if (proposal) {
    lines.push(`${cliCommandName()} proposals show ${proposal}${storeSuffix}`);
    lines.push(`${cliCommandName()} replay show --proposal ${proposal}${storeSuffix}`);
  } else if (replayId) {
    lines.push(`${cliCommandName()} replay show --replay ${replayId}${storeSuffix}`);
  } else if (evidence) {
    lines.push(`${cliCommandName()} evidence show ${evidence}${storeSuffix}`);
  } else {
    lines.push(`${cliCommandName()} activity search --details${storeSuffix}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatEventLine(event: ProposalEvent, details = false): string {
  const lines = [
    `${event.created_at}  ${event.kind}`,
    `  proposal: ${event.proposal_id}`,
    `  actor: ${event.actor}`,
  ];
  if (details && Object.keys(event.payload).length > 0) {
    lines.push(`  payload: ${JSON.stringify(event.payload)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function localEventWebhookPayload(event: ProposalEvent, storePath: string): Record<string, unknown> {
  return {
    schema_version: "synapsor.local-event-webhook.v1",
    delivered_at: new Date().toISOString(),
    source: {
      kind: "local_store",
      store_path: storePath,
    },
    event,
  };
}

async function postLocalEventWebhook(
  endpoint: URL,
  payload: Record<string, unknown>,
  options: { token?: string; timeoutMs: number },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "synapsor-runner-events-webhook",
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`webhook returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function redactWebhookUrl(endpoint: URL): string {
  const copy = new URL(endpoint.toString());
  copy.username = "";
  copy.password = "";
  copy.search = "";
  return copy.toString();
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatStoreStats(stats: StoreStats): string {
  return [
    `Local store: ${stats.path}`,
    `Approx size: ${stats.approx_bytes} bytes`,
    `Proposals: ${stats.proposals}`,
    `Evidence bundles: ${stats.evidence_bundles}`,
    `Evidence items: ${stats.evidence_items}`,
    `Query audit records: ${stats.query_audit}`,
    `Writeback receipts: ${stats.writeback_receipts}`,
    `Writeback jobs: ${stats.writeback_jobs}`,
    `Idempotency receipts: ${stats.idempotency_receipts}`,
    `Replay records: ${stats.replay_records}`,
    `Approvals: ${stats.approvals}`,
    `Proposal events: ${stats.proposal_events}`,
    `Shadow human actions: ${stats.shadow_human_actions}`,
    `Worker queue items: ${stats.worker_queue}`,
  ].join("\n") + "\n";
}

function formatStorePrune(result: StorePruneResult): string {
  const lines = [
    `Local store prune ${result.dry_run ? "dry run" : "complete"}`,
    `Cutoff: ${result.cutoff}`,
    "",
    "Rows:",
    ...Object.entries(result.deleted).map(([table, count]) => `  ${table}: ${count}`),
  ];
  if (result.dry_run) {
    lines.push("", "No rows were deleted. Rerun with --yes to apply this prune.");
  }
  return `${lines.join("\n")}\n`;
}

function formatStoreReset(result: { store: string; removed: string[]; source_database_changed: boolean }): string {
  const lines = [
    "Local store reset complete",
    `Store: ${result.store}`,
    `Source database changed: ${result.source_database_changed ? "yes" : "no"}`,
    "",
    "Removed:",
    ...(result.removed.length ? result.removed.map((entry) => `  - ${entry}`) : ["  - no local store files were present"]),
  ];
  return `${lines.join("\n")}\n`;
}

function cutoffFromOlderThan(value: string): string {
  const match = value.match(/^(\d+)([smhd])$/i);
  if (!match) throw new Error("--older-than must use a duration such as 30d, 12h, 90m, or 0d");
  const amount = Number(match[1]);
  const unit = (match[2] ?? "d").toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * multiplier).toISOString();
}

function formatMcpAuditMarkdown(report: McpAuditReport): string {
  const lines = [
    "# Synapsor MCP Database Risk Review",
    "",
    `- Target: ${report.target}`,
    `- Generated at: ${report.generated_at}`,
    `- Tools inspected: ${report.summary.tools_inspected}`,
    `- Findings: HIGH ${report.summary.high} | MEDIUM ${report.summary.medium} | LOW ${report.summary.low}`,
    `- Total findings: ${report.summary.total_findings}`,
    "",
    `> ${report.disclaimer}`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No obvious database-commit risks were detected in the static manifest.", "");
    lines.push("This does not prove the MCP server or its tools are secure.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of report.findings) {
      lines.push(`### ${finding.severity}: ${finding.code}${finding.tool ? ` (${finding.tool})` : ""}`);
      lines.push("");
      lines.push(finding.message);
      lines.push("");
      if (finding.evidence.length > 0) {
        lines.push("Evidence:");
        for (const evidence of finding.evidence) lines.push(`- ${evidence}`);
        lines.push("");
      }
      lines.push(`Recommendation: ${finding.recommendation}`);
      lines.push("");
    }
  }
  lines.push("## Safer Shape", "");
  lines.push("- expose semantic inspect/propose tools instead of raw SQL;");
  lines.push("- bind tenant/principal from trusted context;");
  lines.push("- keep approval outside MCP;");
  lines.push("- apply approved changes through guarded writeback;");
  lines.push("- keep replay/evidence handles for later review.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
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

function showDetails(args: string[]): boolean {
  return args.includes("--details") || args.includes("--debug");
}

function storeOptionSuffix(args: string[]): string {
  const storePath = optionalArg(args, "--store");
  return storePath ? ` --store ${storePath}` : "";
}

function humanStatus(value: string): string {
  const normalized = value.replace(/_/g, " ");
  if (normalized === "pending review") return "pending review";
  if (normalized === "not applied") return "not applied";
  return normalized;
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatReceiptId(receiptId: number): string {
  return `rct_${String(receiptId).padStart(6, "0")}`;
}

function approvalBoundary(proposal: StoredProposal): string {
  const approval = proposal.change_set.approval as Record<string, unknown>;
  const policy = typeof approval.policy === "string" ? approval.policy : undefined;
  const policyActor = policy ? `policy:${policy}` : undefined;
  if (proposal.state === "pending_review") return "required outside MCP";
  if (proposal.state === "approved" || proposal.state === "pending_worker") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; waiting for trusted worker`;
  if (proposal.state === "applied") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback applied`;
  if (proposal.state === "conflict") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback blocked by conflict guard`;
  if (proposal.state === "failed") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback failed safely`;
  if (proposal.state === "rejected") return "rejected outside MCP";
  return humanStatus(proposal.state);
}

function proposalNextCommands(proposal: StoredProposal, proposalRef: string, storeSuffix: string): string[] {
  if (proposal.state === "pending_review") {
    return [
      `${cliCommandName()} proposals approve ${proposalRef} --yes${storeSuffix}`,
      `${cliCommandName()} replay show ${proposalRef === "latest" ? "latest" : `--proposal ${proposal.proposal_id}`}${storeSuffix}`,
    ];
  }
  if (proposal.state === "approved" || proposal.state === "pending_worker") {
    return [
      `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
    ];
  }
  if (proposal.state === "conflict") {
    return [
      `${cliCommandName()} propose ${proposal.action} --json '<fresh reviewed input>'${storeSuffix}`,
      `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
    ];
  }
  return [
    `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
  ];
}

function boundedSetReviewLines(changeSet: ChangeSet, includeAllIdentities = false): string[] {
  if (changeSet.schema_version !== protocolVersions.changeSetV3) return [];
  const members = includeAllIdentities ? changeSet.frozen_set.members : changeSet.frozen_set.members.slice(0, 10);
  const remaining = changeSet.frozen_set.members.length - members.length;
  return [
    "",
    "Bounded set:",
    `operation: ${changeSet.operation}`,
    `exact rows frozen: ${changeSet.frozen_set.row_count} (reviewed maximum ${changeSet.frozen_set.max_rows})`,
    `aggregate bounds: ${changeSet.frozen_set.aggregate_bounds.map((bound) => `${bound.measure}(${bound.column}) ${bound.actual}/${bound.maximum}`).join("; ")}`,
    `set digest: ${changeSet.frozen_set.set_digest}`,
    "exact identities:",
    ...members.map((member) => `  ${member.primary_key.column}=${formatScalar(member.primary_key.value)}`),
    ...(remaining > 0 ? [`  ... ${remaining} more; use --details to review every identity`] : []),
    "approval: verified human/operator required; policy auto-approval unavailable",
  ];
}

function receiptOperationLabel(receipt: StoredWritebackReceipt): string {
  if (receipt.receipt.schema_version === protocolVersions.executionReceiptV2) {
    return receipt.receipt.operation.replaceAll("_", " ");
  }
  return "single-row update";
}

function formatChangeLines(proposal: StoredProposal, memberLimit = 10): string[] {
  const changeSet = proposal.change_set;
  if (changeSet.schema_version === protocolVersions.changeSetV3) {
    const members = changeSet.frozen_set.members.slice(0, memberLimit);
    const lines = members.flatMap((member) => {
      const identity = `${member.primary_key.column}=${formatScalar(member.primary_key.value)}`;
      if (changeSet.operation === "batch_insert") return [`  ${identity}: create ${JSON.stringify(member.after)}`];
      if (changeSet.operation === "set_delete") return [`  ${identity}: delete ${JSON.stringify(member.before)}`];
      return Object.keys(changeSet.patch).map((column) => `  ${identity} ${column}: ${formatScalar(member.before[column])} -> ${formatScalar(member.after[column])}`);
    });
    const remaining = changeSet.frozen_set.members.length - members.length;
    if (remaining > 0) lines.push(`  ... ${remaining} more exact members; use --details to review all`);
    return lines.length > 0 ? lines : ["  (no changed columns)"];
  }
  const columns = Object.keys(changeSet.patch);
  if (columns.length === 0) return ["  (no changed columns)"];
  return columns.map((column) => {
    const before = changeSet.before[column as keyof typeof changeSet.before];
    const proposed = changeSet.after[column as keyof typeof changeSet.after];
    return `  ${column}: ${formatScalar(before)} -> ${formatScalar(proposed)}`;
  });
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
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV4) {
    if (job.protocol_version !== protocolVersions.normalizedWritebackJobV4) throw new Error("compensation result does not match writeback job v4");
    const compensationStatus = dryRun ? "canceled" : terminalStatus;
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : compensationStatus === "applied" ? "APPLIED"
        : compensationStatus === "already_applied" ? "ALREADY_APPLIED"
          : compensationStatus === "conflict" ? "CONFLICT"
            : compensationStatus === "reconciliation_required" ? "RECONCILIATION_REQUIRED" : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV4,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: compensationStatus,
      target: { source_id: job.source_id, schema: job.target.schema, table: job.target.table, identities: result.target_identities },
      rows_affected: dryRun ? 0 : affectedRows,
      idempotency_key: job.idempotency_key,
      forward_receipt_hash: job.forward_receipt_hash,
      member_effects: dryRun ? [] : result.member_effects,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? { reconciliation: { intent_id: result.intent_id, reason: "source outcome requires operator reconciliation" } } : {}),
    };
  }
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV3) {
    const setStatus = dryRun ? "canceled" : terminalStatus;
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : setStatus === "applied" ? "APPLIED"
        : setStatus === "already_applied" ? "ALREADY_APPLIED"
          : setStatus === "conflict" ? "CONFLICT"
            : setStatus === "reconciliation_required" ? "RECONCILIATION_REQUIRED" : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV3,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: setStatus,
      target: {
        source_id: job.source_id,
        schema: job.target.schema,
        table: job.target.table,
        identities: result.target_identities,
        set_digest: result.set_digest,
      },
      rows_affected: dryRun ? 0 : affectedRows,
      idempotency_key: job.idempotency_key,
      member_effects: dryRun ? [] : result.member_effects,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? {
        reconciliation: { intent_id: result.intent_id, reason: "source outcome requires operator reconciliation" },
      } : {}),
    };
  }
  if (result.protocol_version === protocolVersions.normalizedWritebackJobV2) {
    const safeOutcomeCode = dryRun
      ? "DRY_RUN"
      : terminalStatus === "applied"
        ? "APPLIED"
        : terminalStatus === "already_applied"
          ? "ALREADY_APPLIED"
          : terminalStatus === "conflict"
            ? "CONFLICT"
            : terminalStatus === "reconciliation_required"
              ? "RECONCILIATION_REQUIRED"
              : "FAILED";
    return {
      schema_version: protocolVersions.executionReceiptV2,
      writeback_job_id: job.job_id,
      proposal_id: job.proposal_id,
      proposal_hash: job.approval_id,
      approval_id: job.approval_id,
      runner_id: result.runner_id,
      operation: result.operation,
      receipt_authority: result.receipt_authority,
      status: terminalStatus,
      target: {
        source_id: job.source_id,
        schema: job.target.schema,
        table: job.target.table,
        identity: result.target_identity,
      },
      rows_affected: affectedRows,
      idempotency_key: job.idempotency_key,
      before_digest: result.before_digest,
      after_digest: result.after_digest,
      tombstone_digest: result.tombstone_digest,
      ...(!dryRun && result.inverse ? { inverse: result.inverse } : {}),
      source_database_mutated: result.status === "applied" && !dryRun && affectedRows > 0,
      safe_outcome_code: safeOutcomeCode,
      safe_error_code: result.error_code,
      executed_at: result.completed_at,
      receipt_hash: receiptHash,
      ...(result.status === "reconciliation_required" ? {
        reconciliation: {
          intent_id: result.intent_id,
          reason: "source outcome requires operator reconciliation",
        },
      } : {}),
    };
  }
  return {
    schema_version: protocolVersions.executionReceipt,
    writeback_job_id: job.job_id,
    proposal_id: job.proposal_id,
    runner_id: result.runner_id,
    status: terminalStatus,
    rows_affected: affectedRows,
    idempotency_key: job.idempotency_key,
    previous_version: previousVersion,
    new_version: "result_version" in result ? result.result_version : undefined,
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
      runner_version: "0.1.0",
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

function isKnownTopLevelCommand(command: string): boolean {
  return new Set([
    "help",
    "init",
    "inspect",
    "config",
    "contract",
    "report",
    "policy",
    "dsl",
    "language-server",
    "doctor",
    "validate",
    "apply",
    "revert",
    "propose",
    "audit",
    "start",
    "up",
    "runner",
    "cloud",
    "mcp",
    "smoke",
    "tools",
    "writeback",
    "handler",
    "onboard",
    "demo",
    "recipes",
    "benchmark",
    "proposals",
    "replay",
    "evidence",
    "query-audit",
    "receipts",
    "activity",
    "events",
    "metrics",
    "worker",
    "store",
    "shadow",
    "ui",
  ]).has(command);
}

function cliCommandName(): string {
  if (process.env.SYNAPSOR_RUNNER_COMMAND_NAME) return process.env.SYNAPSOR_RUNNER_COMMAND_NAME;
  return "synapsor-runner";
}

async function runnerPackageVersion(): Promise<string> {
  if (typeof runnerPackage.version === "string" && runnerPackage.version.trim()) {
    return runnerPackage.version.trim();
  }
  const packageUrl = new URL("../package.json", import.meta.url);
  try {
    const parsed = JSON.parse(await fs.readFile(packageUrl, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // Keep --version best-effort for unusual bundled launch paths.
  }
  return "unknown";
}

function usage(args: string[] = []): void {
  const [command, subcommand] = args;
  const key = (command === "mcp" || command === "handler") && subcommand ? `${command} ${subcommand}` : command ?? "";
  const cmd = cliCommandName();
  const help: Record<string, string> = {
    "": `Synapsor Runner

Safe MCP tools for Postgres/MySQL-backed agent actions.

Usage:
  ${cmd} <command>

Commands:
  inspect      Inspect a Postgres/MySQL schema
  start        Start guided own-database setup, or no-arg legacy worker polling
  up           Bring up local review mode guidance/server
  init         Generate a Synapsor capability contract
  config       Validate local synapsor.runner.json wiring
  mcp          Serve safe semantic tools over MCP
  contract     Validate and normalize canonical Synapsor contract files
  report       Export and verify scoped tamper-evident ledger reports
  policy       Evaluate and review opt-in graduated-trust recommendations
  dsl          Compile SQL-like Synapsor authoring DSL to contract JSON
  language-server  Start the Synapsor contract LSP over stdio
  cloud        Register runner metadata or dry-run contract push to Cloud
  onboard      One-command own-database setup
  smoke        Test generated tool calls before wiring an MCP client
  tools        List model-facing MCP tools and aliases
  writeback    Print direct SQL writeback receipt DDL, grants, and checks
  handler      Create app-owned writeback handler templates
  propose      Create a local evidence-backed proposal
  audit        Review MCP/database tool risk
  proposals   Review, approve, or reject proposals
  evidence    Inspect local evidence bundles
  query-audit Inspect local query audit records
  receipts    Inspect guarded writeback receipts
  activity    Search local evidence/replay ledger
  events      Tail or push local proposal/writeback lifecycle events
  metrics     Export tenant/capability operational counters
  worker      Run or inspect the supervised local writeback queue
  store       Inspect and maintain the local SQLite ledger
  apply        Apply an approved proposal with guarded writeback
  revert       Create a reviewed compensation proposal for an applied write
  replay       Show what happened
  demo         Start the local commit-safety demo
  ui           Open the local review UI

Examples:
  ${cmd} start --from-env DATABASE_URL
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db --dry-run
  ${cmd} onboard db --from-env DATABASE_URL
  ${cmd} inspect --from-env DATABASE_URL
  ${cmd} init --wizard --from-env DATABASE_URL
  ${cmd} config validate --config ./synapsor.runner.json
  ${cmd} contract validate ./synapsor.contract.json
  ${cmd} contract normalize ./synapsor.contract.json --out ./synapsor.contract.normalized.json
  ${cmd} contract explain ./contract.synapsor.sql --format markdown
  ${cmd} contract lint ./contract.synapsor.sql --strict
  ${cmd} report --object invoice:INV-3001 --tenant tenant_acme --store ./.synapsor/local.db --format markdown
  ${cmd} policy recommend --contract ./synapsor.contract.json --config ./synapsor.runner.json --tenant tenant_acme --capability billing.propose_credit --policy low_risk_credit --store ./.synapsor/local.db
  ${cmd} dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json
  ${cmd} language-server --stdio
  ${cmd} cloud push ./synapsor.contract.json --dry-run
  ${cmd} smoke call --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools list --aliases --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} handler template node-fastify --output ./synapsor-writeback-handler.mjs
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} propose billing.propose_late_fee_waiver --sample
  ${cmd} audit ./synapsor.runner.json

Global options:
  --secrets-provider aws-secretsmanager-cli --secret-map-env SYNAPSOR_SECRET_MAP
  --secrets-provider env-json --secret-map-env SYNAPSOR_SECRET_MAP --secret-values-env SYNAPSOR_SECRET_VALUES
`,
    config: `Usage:
  ${cmd} config validate --config ./synapsor.runner.json
  ${cmd} config migrate --config ./synapsor.runner.json --out ./synapsor.runner.migrated.json

Validate local Runner wiring before tools preview, doctor, smoke, or MCP serve.
Contract paths are resolved relative to the config file. SQLite store paths are
resolved by the Runner process working directory.
`,
    contract: `Usage:
  ${cmd} contract validate ./synapsor.contract.json [--json]
  ${cmd} contract normalize ./synapsor.contract.json [--out ./synapsor.contract.normalized.json]
  ${cmd} contract explain ./contract.synapsor.sql [--format text|markdown|json] [--out explanation.md]
  ${cmd} contract lint ./contract.synapsor.sql [--config ./synapsor.runner.json] [--format text|json|sarif] [--fail-on error|warning]
  ${cmd} contract test --contract ./synapsor.contract.json --tests ./synapsor.contract-tests.json --config ./synapsor.runner.json [--live] [--format text|json|junit]

Validate or normalize canonical Synapsor contract files. Explain renders the
reviewed boundary in plain language. Lint reports stable objective rule IDs and
never claims to infer all sensitive columns. Test runs adopter-authored static
assertions and, with --live, calls the real MCP runtime against an explicitly
approved disposable database. Local database URLs, ports, and store paths stay
in runner config.
`,
    report: `Usage:
  ${cmd} report --object invoice:INV-3001 --tenant tenant_acme --store ./.synapsor/local.db [--config ./synapsor.runner.json] [--format markdown|json|pdf] [--out report.md]
  ${cmd} report --principal support.operator --tenant tenant_acme --store ./.synapsor/local.db [--config ./synapsor.runner.json] [--format markdown|json|pdf] [--out report.json]
  ${cmd} report verify ./report.json [--public-key ./operator.pub.pem] [--json]

Export a tenant-scoped chronology from proposal, evidence metadata, query audit,
approval, writeback, receipt, and replay records. Evidence rows and credentials
are never exported. Optional --signing-key adds an operator signature. Digest or
signature verification makes an export tamper-evident; it does not make a local
SQLite ledger immutable compliance storage.
`,
    policy: `Usage:
  ${cmd} policy recommend --contract ./synapsor.contract.json --config ./synapsor.runner.json --tenant <tenant> --capability <name> --policy <name> --store ./.synapsor/local.db
  ${cmd} policy recommendations list --tenant <tenant> --store ./.synapsor/local.db [--capability <name>] [--policy <name>] [--status pending_review|approved|rejected|exported]
  ${cmd} policy recommendations show <ptr_id> --tenant <tenant> --store ./.synapsor/local.db
  ${cmd} policy recommendations approve <ptr_id> --tenant <tenant> --config ./synapsor.runner.json --reason <text> --yes --store ./.synapsor/local.db
  ${cmd} policy recommendations reject <ptr_id> --tenant <tenant> --config ./synapsor.runner.json --reason <text> --yes --store ./.synapsor/local.db
  ${cmd} policy recommendations export <ptr_id> --tenant <tenant> --contract ./synapsor.contract.json --out ./synapsor.contract.recommended.json --actor <operator> --yes --store ./.synapsor/local.db

Graduated trust is disabled by default. It evaluates scoped, human-reviewed
history and can create a pending recommendation; it never auto-approves,
changes, pushes, or activates a contract. Approval/rejection requires a
cryptographically verified signed_key or jwt_oidc operator identity. Export
revalidates the active contract digest and writes a separate reviewable artifact.
`,
    "language-server": `Usage:
  ${cmd} language-server --stdio

Start the Synapsor contract Language Server Protocol endpoint. It supports
.synapsor.sql and legacy .synapsor files with diagnostics, completion, hover,
and formatting from the same parser used by dsl validate/compile.
`,
    dsl: `Usage:
  ${cmd} dsl validate ./contract.synapsor.sql [--json]
  ${cmd} dsl compile ./contract.synapsor.sql --out ./synapsor.contract.json

Both .synapsor.sql and legacy .synapsor source files are supported.

Compile the preview SQL-like Synapsor authoring DSL into canonical
@synapsor/spec JSON. Unsupported Cloud-only/generated clauses fail explicitly
instead of being ignored.
`,
    cloud: `Usage:
  ${cmd} cloud connect --config ./synapsor.cloud.json
  ${cmd} cloud sync latest --config ./synapsor.cloud.json --store ./.synapsor/local.db
  ${cmd} cloud sync-activity latest --config ./synapsor.cloud.json --store ./.synapsor/local.db
  ${cmd} cloud push ./synapsor.contract.json --dry-run [--workspace <id>] [--name <registry-name>]

cloud sync sends a pending proposal plus bounded evidence/query-audit metadata.
cloud sync-activity sends stable local evidence, query-audit, and replay ids;
record contents and database credentials stay local. cloud push validates and
normalizes the contract locally, then prints the
payload summary. With --dry-run it makes no network request. Without --dry-run
it uploads to the authenticated Cloud registry and reports the stored contract,
version, digest, and registry URL returned by the server.
`,
    up: `Usage:
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db [--transport stdio|streamable-http]
  ${cmd} up --serve --config ./synapsor.runner.json --store ./.synapsor/local.db --port 8766 --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} up --config ./synapsor.runner.json --store ./.synapsor/local.db --handler-check --dry-run

Validate the local Runner config and store, summarize model-facing tools,
explain direct SQL versus app-owned executor writeback, and print the next
smoke/approve/apply/replay commands.

With --transport stdio, \`${cmd} up\` prints MCP client wiring because stdio is
launched by the client. \`${cmd} up --serve\` starts the standard Streamable HTTP
MCP server after the checklist. Use --with-handler to run the handler doctor
before serving app-owned writeback configs.

Options:
  --serve
  --alias-mode canonical|openai|both
  --result-format v1|v2
  --handler-check
  --with-handler
  --open-ui
  --dry-run
`,
    start: `Usage:
  ${cmd} start --from-env DATABASE_URL [--schema public] [--mode read_only|shadow|review]
  ${cmd} start --from-env DATABASE_URL --mode review --writeback http_handler --handler-url-env APP_WRITEBACK_URL [--handler-signing-secret-env APP_WRITEBACK_SIGNING_SECRET]
  ${cmd} runner start --once --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} start

With --from-env, run the guided own-database setup: inspect schema, choose one
object, create trusted context, generate semantic MCP tools, run/print a smoke
call, and print MCP/UI next steps.

With no flags, start the legacy cloud-linked writeback polling worker from the
worker environment config. Prefer \`${cmd} runner start\` for that worker path
so it is not confused with first-run onboarding. Add \`--once\` with both
\`--config\` and \`--store\` for a bounded claim/apply cycle that still rechecks
the local reviewed contract and proposal before writeback.
`,
    inspect: `Usage:
  ${cmd} inspect --from-env DATABASE_URL [--engine auto|postgres|mysql] [--schema public] [--json]
  ${cmd} inspect --engine postgres --url-env DATABASE_URL
  ${cmd} inspect "<postgres-or-mysql-url>" [--engine auto|postgres|mysql] [--schema public] [--json]

Inspect schema metadata without mutating the database or printing credentials.
`,
    init: `Usage:
  ${cmd} init --wizard --from-env DATABASE_URL [--mode read_only|review|shadow] [--out synapsor.runner.json]
  ${cmd} init --engine postgres --url-env DATABASE_URL --mode review --table public.invoices --operation update
  ${cmd} init --inspection-json schema.json --table invoices --mode review --operation update --patch late_fee_cents=fixed:0,waiver_reason=arg:reason
  ${cmd} init --inspection-json schema.json --table account_credits --mode review --operation insert --dedup-columns request_id --receipt-mode runner_ledger --patch amount_cents=arg:amount_cents
  ${cmd} init --inspection-json schema.json --table sessions --mode review --operation delete
  ${cmd} init --answers answers.json --yes
  ${cmd} init --inspection-json schema.json --table invoices --mode review --writeback http_handler --handler-url-env APP_WRITEBACK_URL --emit-handler [--handler-signing-secret-env APP_WRITEBACK_SIGNING_SECRET]

Generate a reviewed Synapsor Runner contract. Defaults to read-only in the wizard.
Native direct SQL operations are update, insert, and delete. Existing configs default to update.
Receipt modes are source_auto_migrate, source_precreated, and runner_ledger.
Runner-ledger mode creates no Synapsor table in the source database, but an ambiguous
post-commit crash must be reconciled by an operator instead of retried automatically.
Rich or externally visible writes still use http_handler or command_handler.
If --namespace is omitted, init derives one from the table name instead of using source.*.
Use --read-tool and --proposal-tool to override the exact model-facing capability names.
The guided wizard shows a final preview and lets you revise visible fields or capability names before writing files.
Use --yes/--non-interactive plus explicit flags, or --answers, for script/agent-friendly setup without prompts.
	`,
    mcp: `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp serve --transport streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp serve-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
  ${cmd} mcp config --absolute-paths --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} mcp audit --example dangerous-db-mcp
  ${cmd} mcp audit ./tools-list.json

Use stdio for local MCP clients that launch the runner. Use Streamable HTTP for standard HTTP MCP clients. Use serve-http only when you explicitly want the lightweight JSON-RPC bridge.
MCP clients see semantic tools. They do not receive raw SQL, write credentials, approval tools, or commit tools.
`,
    tools: `Usage:
  ${cmd} tools list --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools list --aliases --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db

List the model-facing MCP tools generated from a reviewed Runner config.
Use --aliases to show canonical Synapsor names and OpenAI-safe aliases.
This command never prints database URLs or write credentials.
`,
    "mcp serve": `Usage:
  ${cmd} mcp serve --config ./synapsor.runner.json --store ./.synapsor/local.db [--transport stdio] [--read-only] [--local] [--alias-mode canonical|openai|both] [--result-format v1|v2]
  ${cmd} mcp serve --transport streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN [--result-format v2]

Start the stdio MCP server for local MCP clients such as Claude Desktop, Cursor, or local agent tools. Startup logs stay off stdout so the MCP protocol remains clean.
Use --alias-mode openai, or --openai-tool-aliases, for clients that reject dotted tool names. Use --alias-mode both to expose canonical and alias names.
Use --result-format v2 to return one stable ok/summary/data/proposal/error envelope from every tool call.
`,
    "mcp serve-streamable-http": `Usage:
  export SYNAPSOR_RUNNER_HTTP_TOKEN=...
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db [--host 127.0.0.1] [--port 8766] [--auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN] [--alias-mode canonical|openai|both] [--result-format v1|v2]
  ${cmd} mcp serve-streamable-http --config ./synapsor.runner.json --store ./.synapsor/local.db --tls-cert-env SYNAPSOR_TLS_CERT_PEM --tls-key-env SYNAPSOR_TLS_KEY_PEM --tls-ca-env SYNAPSOR_TLS_CA_PEM --require-client-cert

Start the spec-compatible MCP Streamable HTTP endpoint for clients and SDKs that support HTTP MCP.
Bearer auth is required by default.
TLS and mTLS are opt-in through environment variables; do not put PEM contents on the command line or in config JSON.

Alpha scope:
  - Supports MCP initialize/session behavior through the official MCP Streamable HTTP transport.
  - Use --alias-mode openai, or --openai-tool-aliases, for clients that reject dotted tool names.
  - Use --alias-mode both to expose canonical names and aliases.
  - Use --result-format v2 for the stable ok/summary/data/proposal/error envelope.
  - OpenAI aliases expose names such as billing__inspect_invoice while preserving the canonical Synapsor name in _meta.
  - Use /mcp for the MCP endpoint and /healthz for service health.
  - Sessions are in-memory. Restarting the runner clears active HTTP MCP sessions.

Security:
  - Defaults to 127.0.0.1:8766.
  - Refuses to start if the auth token env var is missing.
  - Use --dev-no-auth only for localhost development.
  - If binding to 0.0.0.0, use TLS, private networking, authentication, and rate limits.
  - Optional CORS: --cors-origin http://localhost:3000
`,
    "mcp serve-http": `Usage:
  export SYNAPSOR_RUNNER_HTTP_TOKEN=...
  ${cmd} mcp serve-http --config ./synapsor.runner.json --store ./.synapsor/local.db [--host 127.0.0.1] [--port 8765] [--auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN] [--result-format v1|v2]

Start the lightweight HTTP JSON-RPC bridge for app/server deployments that want simple POST calls.
Bearer auth is required by default.

Alpha scope: supports POST /mcp methods tools/list, tools/call, and resources/read.
It does not implement MCP Streamable HTTP initialize/session behavior. Use ${cmd} mcp serve-streamable-http for standard HTTP MCP clients.

Security:
  - Defaults to 127.0.0.1:8765.
  - Refuses to start if the auth token env var is missing.
  - Use --dev-no-auth only for localhost development.
  - If binding to 0.0.0.0, use TLS, private networking, authentication, and rate limits.
  - Optional CORS: --cors-origin http://localhost:3000
`,
    "mcp config": `Usage:
  ${cmd} mcp config [claude-desktop|cursor|generic|vscode|openai-agents] [--absolute-paths] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client openai-agents [--transport streamable-http] [--port 8766] [--alias-mode openai] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Print MCP client configuration that references the local runner command, not database URLs. Defaults to claude-desktop.
OpenAI Agents SDK output uses Streamable HTTP and OpenAI-safe aliases by default.
`,
    "mcp client-config": `Usage:
  ${cmd} mcp client-config --client claude-desktop [--absolute-paths] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client cursor [--absolute-paths] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} mcp client-config --client openai-agents [--transport streamable-http] [--port 8766] [--alias-mode openai] [--include-instructions] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Print MCP client configuration that references the local runner command, not database URLs.
OpenAI Agents SDK output uses Streamable HTTP and OpenAI-safe aliases by default.
Use --include-instructions to include the recommended propose-first agent prompt.
`,
    smoke: `Usage:
  ${cmd} smoke call [capability-name] [--sample] [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} smoke call [capability-name] --json '{"record_id":"..."}'
  ${cmd} smoke boundary [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]

Call a generated semantic tool locally before wiring Claude, Cursor, or another MCP client. The call uses the same runtime as MCP, records evidence/query audit/proposals in the local store, and does not expose raw SQL or write credentials.
`,
    writeback: `Usage:
  ${cmd} writeback doctor --config ./synapsor.runner.json [--check-db]
  ${cmd} writeback migration --engine postgres [--schema synapsor] [--table synapsor_writeback_receipts]
  ${cmd} writeback migration --engine mysql [--schema appdb] [--table synapsor_writeback_receipts]
  ${cmd} writeback grants --engine postgres --writer-role app_writer [--schema synapsor] [--table synapsor_writeback_receipts]
  ${cmd} writeback grants --engine mysql --writer-role "'app_writer'@'%'" [--schema appdb] [--table synapsor_writeback_receipts]
  ${cmd} writeback reconcile list --status reconciliation_required --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} writeback reconcile inspect latest --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} writeback reconcile resolve wbi:... --outcome applied --reason "verified source state" --yes --config ./synapsor.runner.json --store ./.synapsor/local.db

Print and verify receipt setup for direct writeback. source_db + auto_migrate
creates the fixed receipt table idempotently; source_db + precreated verifies
rollback-only permissions and never runs DDL. runner_ledger creates no receipt
table in the source database and sends ambiguous post-commit outcomes to the
operator reconciliation queue. Reconciliation re-reads only reviewed,
tenant-scoped metadata and never retries or guesses an ambiguous source commit.
Rich or externally visible writes should use app-owned handlers.
`,
    handler: `Usage:
  ${cmd} handler template --list
  ${cmd} handler template node-fastify [--output ./synapsor-writeback-handler.mjs] [--force]
  ${cmd} handler template python-fastapi [--output ./synapsor_writeback_handler.py] [--force]
  ${cmd} handler template command [--output ./synapsor-command-handler.mjs] [--force]

Write starter app-owned writeback handlers for approved proposals. Use these when rich writes should run through your application service instead of Runner-managed SQL.
`,
    "handler template": `Usage:
  ${cmd} handler template --list
  ${cmd} handler template node-fastify [--output ./synapsor-writeback-handler.mjs] [--force]
  ${cmd} handler template python-fastapi [--output ./synapsor_writeback_handler.py] [--force]
  ${cmd} handler template command [--output ./synapsor-command-handler.mjs] [--force]
  ${cmd} handler template node-fastify --stdout

Templates:
  node-fastify    HTTP handler for a Node/Fastify application service
  python-fastapi  HTTP handler for a Python/FastAPI application service
  command         Local command handler for scripts or job runners

The template receives an approved proposal writeback request and must return an applied/conflict/failed receipt. Re-check tenant, principal, idempotency, row/version guards, and business policy before mutating state.
`,
    onboard: `Usage:
  ${cmd} onboard db --from-env DATABASE_URL [--schema public] [--mode read_only|shadow|review]
  ${cmd} onboard db --from-env DATABASE_URL --table invoices --mode review --operation update --patch late_fee_cents=fixed:0 --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes
  ${cmd} onboard db --from-env DATABASE_URL --table account_credits --mode review --operation insert --dedup-columns request_id --receipt-mode runner_ledger --patch amount_cents=arg:amount_cents --write-url-env SYNAPSOR_DATABASE_WRITE_URL --yes
  ${cmd} onboard db --from-env DATABASE_URL --table invoices --mode review --writeback http_handler --handler-url-env APP_WRITEBACK_URL --emit-handler --yes
  ${cmd} onboard db --answers answers.json --yes

Guided own-database setup: inspect schema, choose one object, create trusted
context, choose read-only/shadow/review mode, select guarded single-row
INSERT/UPDATE/DELETE or an app-owned handler, select receipt authority, generate
semantic tools, validate config, and run a tool-boundary smoke check.
Use --yes/--non-interactive with explicit flags, or --answers, when CI or an LLM agent must run without prompts.
`,
    propose: `Usage:
  ${cmd} propose <capability-name> --sample [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} propose <capability-name> --input ./input.json
  ${cmd} propose <capability-name> --json '{"invoice_id":"INV-3001","reason":"support-approved waiver"}'
  ${cmd} propose <capability-name> --sample --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL

Examples after running ${cmd} demo:
  ${cmd} propose billing.propose_late_fee_waiver --sample
  ${cmd} propose support.propose_plan_credit --sample
  ${cmd} propose orders.propose_status_change --sample

Create the same evidence-backed proposal the MCP tool would create. The source database is not mutated.
Use --shared-ledger-mirror only when the shared Postgres ledger migration has
been applied; it restores the shared ledger before mutation and syncs after
mutation while the local SQLite store remains the live runtime store. Mirror
mode holds a schema-scoped Postgres advisory lock while it runs; adjust the
default 10000ms wait with --shared-ledger-lock-timeout-ms.
`,
    audit: `Usage:
  ${cmd} audit --example dangerous-db-mcp
  ${cmd} audit --example dangerous-db-mcp --format json
  ${cmd} audit --example dangerous-db-mcp --format markdown
  ${cmd} audit ./synapsor.runner.json
  ${cmd} audit --mcp-config ./claude_desktop_config.json
  ${cmd} audit --stdio "node ./server.js"
  ${cmd} audit --url http://localhost:3000/mcp

Static MCP/database risk review only. This is not a security guarantee.
`,
    doctor: `Usage:
  ${cmd} doctor --config synapsor.runner.json
  ${cmd} doctor --config synapsor.runner.json --json
  ${cmd} doctor --config synapsor.runner.json --check-handlers
  ${cmd} doctor --config synapsor.runner.json --check-writeback
  ${cmd} doctor --config synapsor.runner.json --report --redact --output synapsor-doctor.md
  ${cmd} doctor --first-run

Validate local config, environment bindings, semantic tool boundary, source metadata when reachable, handler signing/reachability, operation-specific direct SQL writeback readiness, receipt authority, and local store stats. Reports are redacted; do not paste secrets into issues.
Use --check-writeback to verify the configured receipt mode. source_db/precreated uses rollback-only probes and never runs CREATE; source_db/auto_migrate verifies the fixed migration; runner_ledger verifies its durable intent store and requires no source receipt table.
Without --config, doctor is the legacy Cloud worker check and requires SYNAPSOR_CONTROL_PLANE_URL plus the scoped worker environment.
`,
    proposals: `Usage:
	  ${cmd} proposals list [--tenant acme] [--capability billing.propose_late_fee_waiver] [--object invoice:INV-3001] [--status applied]
	  ${cmd} proposals show latest
	  ${cmd} proposals show latest --details
	  ${cmd} proposals approve latest --yes
	  ${cmd} proposals reject latest --reason "..."
	  ${cmd} proposals approve latest --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL

	Review decisions happen outside the model-facing MCP tool surface. Human output is concise by default; use --details for reviewer metadata or --json for complete records.
	`,
    evidence: `Usage:
	  ${cmd} evidence list [--tenant acme] [--capability billing.inspect_invoice] [--object invoice:INV-3001]
	  ${cmd} evidence show ev_...
	  ${cmd} evidence show ev_... --details
	  ${cmd} evidence export ev_... --format json --output evidence.json
  ${cmd} evidence export ev_... --format markdown --output evidence.md

Inspect captured local evidence bundles and query-audit links without rerunning external DB reads.
`,
    "query-audit": `Usage:
	  ${cmd} query-audit list [--evidence ev_...] [--source app_postgres] [--table invoices]
	  ${cmd} query-audit show <audit_id>
	  ${cmd} query-audit show <audit_id> --details
	  ${cmd} query-audit export <audit_id> --format json --output audit.json

Inspect local query fingerprints, table names, row counts, and redacted-parameter metadata.
`,
    receipts: `Usage:
	  ${cmd} receipts list [--proposal wrp_...] [--status applied]
	  ${cmd} receipts show <receipt_id>
	  ${cmd} receipts show <receipt_id> --details

	Inspect guarded writeback receipts recorded by the trusted runner path. Use --details for idempotency keys, receipt hashes, and runner metadata.
`,
    apply: `Usage:
  ${cmd} apply <proposal-id> [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} apply latest [--config ./synapsor.runner.json] [--store ./.synapsor/local.db]
  ${cmd} apply --all-approved --yes [--capability name] [--tenant id] [--max N] --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} apply --all-approved --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL
  ${cmd} apply --job job.json --config ./synapsor.runner.json --store ./.synapsor/local.db

Apply an approved proposal through guarded writeback. Requires a trusted write credential.

With --config, the writer connection comes from source.write_url_env, such as
SYNAPSOR_DATABASE_WRITE_URL. SYNAPSOR_DATABASE_URL is only the legacy fallback
for direct worker/apply flows without a local config.

Direct SQL writeback supports reviewed single-row INSERT, UPDATE, and DELETE.
With source_db receipt authority, mutation and receipt commit atomically; the
trusted writer needs receipt-table permissions and auto_migrate additionally
needs CREATE. With runner_ledger authority, no Synapsor source table is created,
but a crash after source commit can require explicit operator reconciliation.

When operator_identity.provider is signed_key, pass --identity <operator> and
--identity-key <private-key.pem>. Batch apply handles each approved proposal
independently; conflicts do not abort the remaining queue.
Shared-ledger mirror mode is opt-in. It restores from Postgres before the local
mutation and syncs back after while holding a schema-scoped Postgres advisory
lock. For MCP serving with Postgres as the primary proposal/evidence/replay
store, configure storage.shared_postgres.mode = "runtime_store".
`,
    revert: `Usage:
  ${cmd} revert <applied-proposal-id> --config ./synapsor.runner.json --store ./.synapsor/local.db --reason "..."
  ${cmd} revert latest --config ./synapsor.runner.json --store ./.synapsor/local.db --reason "..."

Create a new review-required compensation proposal from an unambiguous applied
receipt with an available bounded inverse. This command never approves or
mutates the source database. The new proposal inherits the original reviewer
role/quorum and must pass normal approval and guarded apply.

Only opt-in direct SQL capabilities are supported. Hard DELETE, app-owned
executors, external effects, stale rows, ambiguous outcomes, duplicate active
compensations, and invalid lineage fail closed. Revert is operator-only and is
never exposed as a model-facing MCP tool.
`,
    replay: `Usage:
  ${cmd} replay list [--tenant acme] [--object invoice:INV-3001]
	  ${cmd} replay show latest
	  ${cmd} replay show latest --details
	  ${cmd} replay show --proposal wrp_...
  ${cmd} replay show --replay replay_wrp_...
  ${cmd} replay show --evidence ev_...
  ${cmd} replay export --proposal wrp_... --format json --output replay.json
  ${cmd} replay export --proposal wrp_... --format markdown --output replay.md

	Show evidence, proposal events, receipts, and replay state without rerunning side effects. Human output is concise by default; use --details for reviewer metadata or --json for complete records.
`,
    activity: `Usage:
	  ${cmd} activity search --tenant acme --object invoice:INV-3001
	  ${cmd} activity search --tenant acme --object invoice:INV-3001 --details
	  ${cmd} activity search --capability billing.propose_late_fee_waiver --from 2026-06-01 --to 2026-06-23

Search the local SQLite evidence/replay ledger across proposals, evidence, query audit, receipts, and replay records.
`,
    events: `Usage:
  ${cmd} events tail --store ./.synapsor/local.db
	  ${cmd} events tail --proposal wrp_...
	  ${cmd} events tail --kind writeback_applied
	  ${cmd} events tail --follow --interval-ms 1000
  ${cmd} events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created
  ${cmd} events webhook --url-env SYNAPSOR_EVENT_WEBHOOK_URL --auth-token-env SYNAPSOR_EVENT_WEBHOOK_TOKEN --follow
  ${cmd} events webhook --url http://127.0.0.1:8788/synapsor/events --dry-run

Show or push local proposal/writeback lifecycle events such as proposal_created, proposal_approved, writeback_applied, writeback_conflict, and writeback_failed. Webhook delivery POSTs one local event envelope per event and never exposes database credentials.
	`,
    metrics: `Usage:
  ${cmd} metrics show --store ./.synapsor/local.db
  ${cmd} metrics show --tenant acme --capability billing.propose_credit
  ${cmd} metrics show --format json

Export Prometheus/OpenMetrics counters for proposals, approvals, rejections,
successful applies, conflicts, and failures, grouped by trusted tenant and
reviewed capability. No database credentials or business-row values are emitted.
`,
    worker: `Usage:
  ${cmd} worker run --yes --config ./synapsor.runner.json --store ./.synapsor/local.db
  ${cmd} worker run --once --yes --max-attempts 5 --retry-base-ms 1000
  ${cmd} worker run --drain --yes --capability support.propose_plan_credit --tenant acme
  ${cmd} worker run --once --yes --shared-ledger-mirror --shared-ledger-url-env SYNAPSOR_LEDGER_DATABASE_URL
  ${cmd} worker run --yes --config ./synapsor.runner.json
  ${cmd} worker status --store ./.synapsor/local.db [--status dead_letter] [--json]
  ${cmd} worker dead-letter list --config ./synapsor.runner.json
  ${cmd} worker dead-letter show wrp_... --config ./synapsor.runner.json
  ${cmd} worker dead-letter requeue wrp_... --retry-budget 3 --yes --config ./synapsor.runner.json --identity alice --identity-key ./alice.pem
  ${cmd} worker dead-letter discard wrp_... --reason "closed by operator" --yes --config ./synapsor.runner.json --identity alice --identity-key ./alice.pem

Run a supervised local writeback worker over approved proposals. Queue claims
use leases, transient failures use bounded exponential retries, terminal or
exhausted failures enter the dead-letter queue, and durable idempotency receipts
prevent duplicate effects. Signed-key configs still require a writeback operator
identity through --identity/--identity-key or their documented environment vars.
Shared-ledger mirror mode is only allowed for finite worker runs (--once or
--drain). It holds a schema-scoped Postgres advisory lock during the bounded
run. With storage.shared_postgres.mode=runtime_store, worker runs use repeated
bounded drain cycles through the Postgres-backed bridge and release the advisory
lock while idle, so multiple workers can share one runtime ledger safely.
Dead-letter requeue and discard require verified operator identity, preserve all
receipts/events, and refuse requeue when a durable receipt already proves the
database effect completed.
`,
    store: `Usage:
  ${cmd} store stats --store ./.synapsor/local.db
  ${cmd} store vacuum --store ./.synapsor/local.db
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --dry-run
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --yes
  ${cmd} store prune --store ./.synapsor/local.db --older-than 30d --yes --force
  ${cmd} store reset --store ./.synapsor/local.db --yes
  ${cmd} store shared-postgres migration --schema synapsor_runner
  ${cmd} store shared-postgres apply-migration --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres status --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner
  ${cmd} store shared-postgres sync --store ./.synapsor/local.db --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres restore --store ./.synapsor/restored.db --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes
  ${cmd} store shared-postgres backup --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --output ./ledger-backup.json
  ${cmd} store shared-postgres verify-backup --input ./ledger-backup.json
  ${cmd} store shared-postgres restore-backup --input ./ledger-backup.json --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner_restore --yes
  ${cmd} store shared-postgres retention --older-than 30d --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --dry-run
  ${cmd} store shared-postgres retention --older-than 30d --output ./ledger-archive.json --url-env SYNAPSOR_LEDGER_DATABASE_URL --schema synapsor_runner --yes

Local store maintenance only. Prune defaults to dry-run and reset requires --yes. These commands never touch your source Postgres/MySQL database. Destructive operations refuse while an active server lease exists unless --force is provided.
Shared Postgres commands create, inspect, sync, and restore the schema used by a shared ledger deployment; they never print the database URL.
Backups include a manifest digest. Retention archives terminal proposal graphs
before deletion and never removes pending review, approved, pending-worker,
failed/retry, or dead-letter records.
	`,
	    demo: `Usage:
	  ${cmd} demo [--force]
	  ${cmd} demo --quick
	  ${cmd} demo --quick --guided
	  ${cmd} demo --quick --no-interactive
	  ${cmd} demo --quick --details
	  ${cmd} demo inspect
	  ${cmd} demo inspect --npx

	Start a disposable local Postgres demo and write ./synapsor.runner.json for the first-run flow.
	Use --quick for a fixture-only guided walkthrough and local ledger seed with no Docker startup. Use demo inspect to print follow-up commands for the quick-demo fixture.
	`,
    ui: `Usage:
  ${cmd} ui [--open] [--tour] [--config synapsor.runner.json] [--store ./.synapsor/local.db]

Open the localhost review UI for proposals, diffs, evidence, receipts, and replay.
Use --open to launch the URL in your browser when a desktop opener is available.
`,
  };
  process.stdout.write(help[key] ?? help[command ?? ""] ?? help[""] ?? "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      operationalLog("warn", "cli_rejected", {
        command: process.argv[2] ?? "unknown",
        error_code: safeOperationalErrorCode(error),
      });
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
