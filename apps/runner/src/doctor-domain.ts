import { assertApprovalPolicyResolvable, assertProposalWritebackResolvable, capabilityWritebackExecutor, capabilityWritebackMode, createMcpRuntime, type ContextProvider, type RuntimeConfig, type SourceIsolationAssurance } from "@synapsor-runner/mcp-server";
import { createPostgresPool } from "@synapsor-runner/postgres";
import {
  assessDirectWritePrerequisites,
  inspectDatabase,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { envValue } from "./cli-options.js";
import { RunnerCapabilityConfig } from "./cli-runtime.js";
import { sharedPostgresLedgerMirrorOptions, sharedPostgresLedgerTableCounts } from "./shared-ledger-domain.js";
import { capabilityOperation } from "./writeback-domain.js";


type TrustedContextDoctorEntry = {
  name: string;
  provider: ContextProvider;
  values: Record<string, unknown>;
  principal_required: boolean;
};


export function trustedContextsForDoctor(config: RuntimeConfig): TrustedContextDoctorEntry[] {
  const contexts: TrustedContextDoctorEntry[] = [];
  const capabilities = config.capabilities ?? [];
  const globalCapabilities = capabilities.filter((capability) => !capability.context);
  if (config.trusted_context && (globalCapabilities.length > 0 || Object.keys(config.contexts ?? {}).length === 0)) {
    contexts.push({
      name: "trusted_context",
      provider: config.trusted_context.provider,
      values: config.trusted_context.values ?? {},
      principal_required: Boolean(
        config.trusted_context.principal_binding
        || config.trusted_context.values?.principal_env !== undefined
        || globalCapabilities.some((capability) => Boolean(capability.target.principal_scope_key)),
      ),
    });
  }
  for (const [name, context] of Object.entries(config.contexts ?? {})) {
    contexts.push({
      name: `contexts.${name}`,
      provider: context.provider,
      values: context.values ?? {},
      principal_required: Boolean(
        context.principal_binding
        || context.values?.principal_env !== undefined
        || capabilities.some((capability) => capability.context === name && Boolean(capability.target.principal_scope_key)),
      ),
    });
  }
  return contexts;
}


export function envPresenceCheck(
  envName: string,
  message: string,
  setup: "pending" | "required" = "required",
): DoctorCheck {
  const value = envValue(process.env, envName);
  return {
    name: `env:${envName}`,
    ok: Boolean(value),
    level: value ? "pass" : "fail",
    message: value ? `${envName} is set.` : message,
    ...(!value ? { setup } : {}),
  };
}


export function proposalWritebackResolutionDoctorCheck(config: RuntimeConfig, capability: RunnerCapabilityConfig): DoctorCheck {
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


export function proposalApprovalPolicyResolutionDoctorCheck(config: RuntimeConfig, capability: RunnerCapabilityConfig): DoctorCheck {
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


export function proposalReversibilityDoctorCheck(capability: RunnerCapabilityConfig): DoctorCheck {
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


export function proposalConflictGuardDoctorCheck(capability: RunnerCapabilityConfig): DoctorCheck | undefined {
  if (capability.kind !== "proposal" || capabilityOperation(capability) === "insert") return undefined;
  if (capability.conflict_guard?.column) {
    return {
      name: `capability:${capability.name}:conflict-guard`,
      ok: true,
      level: "pass",
      message: `Exact optimistic-concurrency guard uses reviewed version column ${capability.conflict_guard.column}.`,
    };
  }
  if (capability.conflict_guard?.weak_guard_ack === true) {
    return {
      name: `capability:${capability.name}:conflict-guard`,
      ok: true,
      level: "warn",
      message: "Weak row-hash guard was explicitly acknowledged. It hashes only the captured projection and may miss concurrent changes outside that projection; prefer an exact version column.",
    };
  }
  return {
    name: `capability:${capability.name}:conflict-guard`,
    ok: false,
    level: "fail",
    message: `${capabilityOperation(capability).toUpperCase()} requires an exact version-column guard or an explicitly acknowledged weak row-hash guard.`,
  };
}


export async function sharedPostgresLedgerDoctorChecks(config: RuntimeConfig): Promise<DoctorCheck[]> {
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


export async function httpHandlerReachabilityCheck(executorName: string, rawUrl: string, timeoutMs: number): Promise<DoctorCheck> {
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


export async function inspectConfiguredSource(input: {
  config: RuntimeConfig;
  sourceName: string;
  source: NonNullable<RuntimeConfig["sources"]>[string];
  checks: DoctorCheck[];
  additionalSchemas?: string[];
}): Promise<SchemaInspection[]> {
  if (!envValue(process.env, input.source.read_url_env)) return [];
  const capabilities = (input.config.capabilities ?? []).filter((capability) => capability.source === input.sourceName);
  const schemas = Array.from(new Set([
    ...capabilities.map((capability) => capability.target.schema),
    ...(input.additionalSchemas ?? []),
  ]));
  const inspections: SchemaInspection[] = [];
  for (const schema of schemas.length ? schemas : [undefined]) {
    try {
      const inspection = await inspectDatabase({
        engine: input.source.engine,
        databaseUrlEnv: input.source.read_url_env,
        schema,
      });
      inspections.push(inspection);
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
  return inspections;
}


export async function localToolNames(config: RuntimeConfig, checks: DoctorCheck[]): Promise<string[]> {
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


export function formatLocalDoctorReport(report: LocalDoctorReport): string {
  const lines = [
    `Synapsor Runner doctor: ${report.ok ? "ok" : "failed"}`,
    `Config: ${report.config_path}`,
    `Mode: ${report.mode}`,
    `Governance authority: ${report.governance.authority_mode}`,
    `Evidence residency: ${report.governance.evidence_residency}`,
  ];
  for (const assurance of report.isolation) {
    lines.push(`Isolation ${assurance.source}: ${assurance.mode} (${assurance.trusted_context.request_binding})`);
    lines.push(`  Remaining boundary: ${assurance.remaining_trust_boundary}`);
    if (assurance.warning) lines.push(`  WARNING: ${assurance.warning}`);
  }
  if (report.tools.length) {
    lines.push("Exposed MCP tools:");
    for (const tool of report.tools) lines.push(`  - ${tool}`);
  }
  for (const check of report.checks) {
    const prefix = check.advisory === "note"
      ? "i"
      : check.level === "pass" ? "✓" : check.level === "warn" ? "!" : "x";
    lines.push(`${prefix} ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}


export function localDoctorSetupStatus(report: LocalDoctorReport): "ready" | "incomplete" | "failed" {
  const failedChecks = report.checks.filter((check) => check.level === "fail");
  if (failedChecks.some((check) => check.setup !== "pending")) return "failed";
  return failedChecks.length > 0 ? "incomplete" : "ready";
}


export function formatLocalDoctorSetupReport(report: LocalDoctorReport): string {
  const status = localDoctorSetupStatus(report);
  const pendingEnvironment = [...new Set(report.checks
    .filter((check) => check.level === "fail" && check.name.startsWith("env:") && check.setup === "pending")
    .map((check) => check.name.slice("env:".length)))]
    .sort();
  const lines = [
    `Synapsor Runner setup: ${status}`,
    `Config: ${report.config_path}`,
  ];
  if (status === "incomplete") {
    lines.push(`Next: set ${pendingEnvironment.join(" and ")} from .env.example, then rerun ${cliCommandName()} doctor --config ${report.config_path}.`);
  } else if (status === "failed") {
    lines.push(`Fix the configuration errors below, then rerun ${cliCommandName()} doctor --config ${report.config_path}.`);
  } else {
    lines.push("The generated setup and required environment bindings are ready.");
  }
  for (const check of report.checks) {
    if (check.level === "fail" && check.name.startsWith("env:") && check.setup === "pending") {
      lines.push(`- ${check.name.slice("env:".length)} is not set yet.`);
      continue;
    }
    const prefix = check.advisory === "note"
      ? "i"
      : check.level === "pass" ? "✓" : check.level === "warn" ? "!" : "x";
    lines.push(`${prefix} ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}


export function formatLocalDoctorMarkdown(report: LocalDoctorReport): string {
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
    "## Tenant Isolation",
    "",
    ...report.isolation.flatMap((assurance) => [
      `### ${assurance.source}`,
      "",
      `- Assurance mode: \`${assurance.mode}\``,
      `- Trusted-context binding: \`${assurance.trusted_context.request_binding}\``,
      `- Providers: ${assurance.trusted_context.providers.map((provider) => `\`${provider}\``).join(", ") || "none"}`,
      `- Controls: ${assurance.controls.map((control) => `\`${control}\``).join(", ")}`,
      `- Remaining boundary: ${assurance.remaining_trust_boundary}`,
      ...(assurance.warning ? [`- Warning: ${assurance.warning}`] : []),
      "",
    ]),
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
    ...report.checks.map((check) => `- ${check.advisory === "note" ? "NOTE" : check.level.toUpperCase()} ${check.name}: ${check.message}`),
    "",
    "## Redaction Note",
    "",
    "This report is redacted by design. Do not attach raw database URLs, passwords, API keys, bearer tokens, private keys, cookies, or customer data when sharing diagnostics.",
  ];
  return `${lines.join("\n")}\n`;
}


export type DoctorCheck = {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  message: string;
  advisory?: "warning" | "note";
  setup?: "pending" | "required";
};


export type LocalDoctorGovernance = {
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


export type LocalDoctorReport = {
  ok: boolean;
  mode: string;
  config_path: string;
  checks: DoctorCheck[];
  tools: string[];
  governance: LocalDoctorGovernance;
  isolation: SourceIsolationAssurance[];
  store_stats?: {
    path: string;
    exists: boolean;
    proposals?: number;
    evidence?: number;
    query_audit?: number;
    receipts?: number;
  };
};
