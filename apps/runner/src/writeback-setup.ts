import {
  buildAnalyticsCatalog,
  type ResultFormat,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import { inspectMysqlWritebackSource, mysqlReceiptMigration } from "@synapsor-runner/mysql";
import { createPostgresPool, inspectPostgresWritebackSource, postgresReceiptMigration } from "@synapsor-runner/postgres";
import {
  ProposalStore,
  type StoredProposal,
  type StoredWritebackIntent
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, protocolVersions, type ExecutionReceiptV2, type ExecutionReceiptV3, type ExecutionReceiptV4 } from "@synapsor-runner/protocol";
import {
  compensationInverseFromJob,
  type ReconciliationObservation,
  type RunnerConfig
} from "@synapsor-runner/worker-core";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { operationalLog } from "./cli-logging.js";
import { assertKnownOptions, envValue, optionalArg, optionalPositiveIntegerArg, outputArg, positional, runtimeStoreBridgeFlag } from "./cli-options.js";
import { defaultConfigPath, operatorIdentityForDecision, readRuntimeConfig, redactConfig, requireLocalProposal, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { adapters, RunnerSourceConfig } from "./cli-runtime.js";
import { formatHandlerTemplateList, handlerSecurityWarning, handlerTemplateDefinitions, resolveHandlerTemplateName, writeHandlerTemplateFile } from "./handler-templates.js";
import {
  type WorkbenchReconciliationView
} from "./local-ui.js";
import { mcpSmoke, smokeCall, toolsPreview } from "./mcp-runtime.js";
import { formatMysqlReceiptGrants, formatMysqlReceiptMigration, formatPostgresReceiptGrants, formatPostgresReceiptMigration, requiredWritebackEngine } from "./onboarding.js";
import { quoteSqlIdentifier } from "./sql-identifiers.js";
import { argsWithRuntimeStoreBridge, assertNoRuntimeStoreForLocalMutation, runtimeStoreBridgeRequired, withSharedPostgresRuntimeStoreBridge } from "./store-shared.js";
import { formatSourceReceiptMode, hashReceipt, receiptTableGuidance, runnerReceiptConfig, sourceNeedsSqlWriteback, writebackDatabaseScope, writebackTimeoutMs } from "./writeback-domain.js";
import { resolveSqlWriteDatabaseUrl } from "./writeback-execution.js";


export async function tools(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "preview") return toolsPreview(rest);
  if (subcommand === "list") return toolsPreview(rest);
  if (subcommand === "catalog") return toolsCatalog(rest);
  usage(["tools"]);
  return 2;
}

async function toolsCatalog(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--result-format", "--json"]), "tools catalog");
  const requestedFormat = optionalArg(args, "--result-format");
  if (requestedFormat && requestedFormat !== "v1" && requestedFormat !== "v2") {
    throw new Error("--result-format must be v1 or v2");
  }
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const config = await readRuntimeConfig(configPath);
  const resultFormat: ResultFormat = requestedFormat === "v2"
    ? 2
    : requestedFormat === "v1"
      ? 1
      : config.result_format ?? 1;
  const catalog = buildAnalyticsCatalog(config, resultFormat);
  process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
  return 0;
}


export async function smoke(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "call") return smokeCall(rest);
  if (subcommand === "boundary") return mcpSmoke(rest);
  usage(["smoke"]);
  return 2;
}


export async function writeback(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "setup") return writebackSetup(rest);
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
  const configPath = runnerConfigPath(rest, defaultConfigPath);
  const storePath = resolvedLocalStorePath(rest);
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
  const observation = await inspectWritebackSourceContext(intent, proposal, configPath, config);
  return { intent, proposal, observation };
}


export async function inspectWritebackSourceContext(
  intent: StoredWritebackIntent,
  proposal: StoredProposal,
  configPath: string,
  config: RuntimeConfig,
): Promise<ReconciliationObservation> {
  const source = config.sources?.[intent.intent.source_id];
  if (runnerReceiptConfig(source)?.authority !== "runner_ledger") throw new Error(`source ${intent.intent.source_id} does not use runner_ledger receipt authority`);
  const databaseUrl = await resolveSqlWriteDatabaseUrl(intent.intent, configPath, process.env);
  return intent.intent.engine === "postgres"
    ? await inspectPostgresWritebackSource(
      intent.intent,
      databaseUrl,
      writebackDatabaseScope(source, proposal, intent.intent),
    )
    : await inspectMysqlWritebackSource(intent.intent, databaseUrl);
}


export function reconciliationSupportedOutcome(observation: ReconciliationObservation): "applied" | "conflict" | "failed" {
  if (observation.classification === "matches_proposed") return "applied";
  if ((observation.operation === "single_row_delete" || observation.operation === "set_delete") && observation.classification === "target_absent") return "applied";
  if (observation.classification === "matches_reviewed_before" || observation.classification === "not_observed") return "failed";
  return "conflict";
}


export function workbenchReconciliationView(
  intent: StoredWritebackIntent,
  observation: ReconciliationObservation,
): WorkbenchReconciliationView {
  const memberClassifications: Record<string, number> = {};
  for (const member of observation.member_observations ?? []) {
    memberClassifications[member.classification] = (memberClassifications[member.classification] ?? 0) + 1;
  }
  return {
    intent_id: intent.intent_id,
    proposal_id: intent.proposal_id,
    operation: intent.operation,
    intent_status: intent.status,
    ...(intent.reconciliation_reason ? { reconciliation_reason: intent.reconciliation_reason } : {}),
    classification: observation.classification,
    supported_outcome: reconciliationSupportedOutcome(observation),
    observed_digest: observation.observed_digest,
    expected_fields: Object.keys(observation.expected).sort(),
    observed_fields: Object.keys(observation.observed).sort(),
    member_count: observation.member_observations?.length ?? 0,
    member_classifications: memberClassifications,
    source_database_changed: false,
  };
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


export async function handler(args: string[]): Promise<number> {
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


type WritebackSetupProfile = "development" | "staging" | "production" | "unknown";


type WritebackSetupPlan = {
  schema_version: "synapsor.writeback-setup.v1";
  digest: `sha256:${string}`;
  config_path: string;
  source: string | null;
  engine: "postgres" | "mysql" | null;
  profile: WritebackSetupProfile;
  executor: "direct_sql" | "app_owned_or_none";
  receipt_mode: "runner_ledger" | "source_auto_migrate" | "source_precreated" | "not_applicable";
  execution: "no_source_ddl" | "runtime_auto_migrate" | "precreated_source_receipt" | "not_applicable";
  source_objects: string[];
  writer_grants: string[];
  sql_preview: string;
  receipt_schema: string | null;
  receipt_table: string | null;
  writer_role: string | null;
  setup_connection_env: string | null;
  apply_allowed: boolean;
  source_database_changed: false;
  next_action: string;
};


async function writebackSetup(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set([
    "--config",
    "--source",
    "--profile",
    "--writer-role",
    "--setup-url-env",
    "--schema",
    "--table",
    "--apply",
    "--confirm",
    "--json",
  ]), "writeback setup");
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const config = await readRuntimeConfig(configPath);
  const profile = await writebackSetupProfile(args, configPath);
  const directSources = Object.entries(config.sources ?? {})
    .filter(([sourceName]) => sourceNeedsSqlWriteback(config, sourceName));
  const requestedSource = optionalArg(args, "--source");
  const selected = requestedSource
    ? directSources.find(([sourceName]) => sourceName === requestedSource)
    : directSources.length === 1
      ? directSources[0]
      : undefined;
  if (requestedSource && !selected) {
    throw new Error(`Writeback setup could not find direct-SQL source ${requestedSource}. State preserved: config and database unchanged. Next: run ${cliCommandName()} writeback doctor --config ${shellQuote(configPath)}.`);
  }
  if (!requestedSource && directSources.length > 1) {
    throw new Error(`Writeback setup found multiple direct-SQL sources: ${directSources.map(([name]) => name).join(", ")}. State preserved: config and database unchanged. Next: rerun with --source <name>.`);
  }

  const unsigned = selected
    ? buildWritebackSetupPlan({
      args,
      configPath,
      sourceName: selected[0],
      source: selected[1],
      profile,
    })
    : {
      schema_version: "synapsor.writeback-setup.v1" as const,
      config_path: configPath,
      source: null,
      engine: null,
      profile,
      executor: "app_owned_or_none" as const,
      receipt_mode: "not_applicable" as const,
      execution: "not_applicable" as const,
      source_objects: [],
      writer_grants: [],
      sql_preview: "",
      receipt_schema: null,
      receipt_table: null,
      writer_role: null,
      setup_connection_env: null,
      apply_allowed: false,
      source_database_changed: false as const,
      next_action: "No direct-SQL source needs receipt setup. Verify the app-owned executor or keep this project read-only.",
    };
  const digest = canonicalJsonDigest(unsigned);
  const plan: WritebackSetupPlan = { ...unsigned, digest };

  if (!args.includes("--apply")) {
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, applied: false, plan }, null, 2)}\n`);
    else process.stdout.write(formatWritebackSetupPlan(plan));
    return 0;
  }
  if (!selected) {
    throw new Error(`Writeback setup has no direct-SQL work to apply. State preserved: config and database unchanged. Next: inspect ${shellQuote(configPath)} for an app-owned executor or proposal capability.`);
  }
  if (profile !== "development" && profile !== "staging") {
    throw new Error(`Writeback setup refuses DDL for profile ${profile}. Production and unknown profiles are plan-only. State preserved: config and database unchanged. Next: rerun without --apply to export the reviewed plan.`);
  }
  if (optionalArg(args, "--confirm") !== `APPLY WRITEBACK SETUP ${digest}`) {
    throw new Error(`Writeback setup requires exact human confirmation. State preserved: config and database unchanged. Next: rerun with --confirm ${shellQuote(`APPLY WRITEBACK SETUP ${digest}`)}.`);
  }
  const applied = await applyWritebackSetupPlan(plan, selected[1], process.env);
  const statePath = path.join(path.dirname(configPath), ".synapsor/writeback-setup-state.json");
  await writeCliJsonAtomic(statePath, {
    schema_version: "synapsor.writeback-setup-state.v1",
    plan_digest: digest,
    config_path: path.basename(configPath),
    source: plan.source,
    profile,
    receipt_mode: plan.receipt_mode,
    status: "verified",
    source_database_changed: applied.source_database_changed,
    verified_at: new Date().toISOString(),
  });
  const payload = {
    ok: true,
    applied: true,
    plan,
    result: applied,
    state_path: statePath,
  };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write([
    formatWritebackSetupPlan(plan).trimEnd(),
    "",
    applied.message,
    `State: ${statePath}`,
    `Source database changed: ${applied.source_database_changed ? "yes, only the reviewed receipt setup" : "no"}`,
    "Next: Run writeback doctor with the trusted writer credential.",
    "",
  ].join("\n"));
  return 0;
}


function buildWritebackSetupPlan(input: {
  args: string[];
  configPath: string;
  sourceName: string;
  source: RunnerSourceConfig;
  profile: WritebackSetupProfile;
}): Omit<WritebackSetupPlan, "digest"> {
  const receipts = runnerReceiptConfig(input.source);
  const receiptMode = receipts?.authority === "runner_ledger"
    ? "runner_ledger"
    : receipts?.authority === "source_db" && receipts.provisioning === "precreated"
      ? "source_precreated"
      : "source_auto_migrate";
  const schema = optionalArg(input.args, "--schema")
    ?? receipts?.schema
    ?? (input.source.engine === "postgres" ? "public" : undefined);
  const table = optionalArg(input.args, "--table") ?? receipts?.table ?? "synapsor_writeback_receipts";
  if (schema) quoteSqlIdentifier(schema, input.source.engine);
  quoteSqlIdentifier(table, input.source.engine);
  const setupUrlEnv = optionalArg(input.args, "--setup-url-env") ?? null;
  if (setupUrlEnv && !/^[A-Z_][A-Z0-9_]*$/.test(setupUrlEnv)) {
    throw new Error("Writeback setup --setup-url-env must name an environment variable, not contain a URL.");
  }

  if (receiptMode === "runner_ledger") {
    return {
      schema_version: "synapsor.writeback-setup.v1",
      config_path: input.configPath,
      source: input.sourceName,
      engine: input.source.engine,
      profile: input.profile,
      executor: "direct_sql",
      receipt_mode: receiptMode,
      execution: "no_source_ddl",
      source_objects: [],
      writer_grants: [],
      sql_preview: "",
      receipt_schema: null,
      receipt_table: null,
      writer_role: null,
      setup_connection_env: null,
      apply_allowed: input.profile === "development" || input.profile === "staging",
      source_database_changed: false,
      next_action: "Confirm the runner ledger and reconciliation workflow; no source receipt table or grant is required.",
    };
  }

  if (receiptMode === "source_auto_migrate") {
    const migration = formatRuntimeReceiptMigration(input.source.engine, schema, table);
    return {
      schema_version: "synapsor.writeback-setup.v1",
      config_path: input.configPath,
      source: input.sourceName,
      engine: input.source.engine,
      profile: input.profile,
      executor: "direct_sql",
      receipt_mode: receiptMode,
      execution: "runtime_auto_migrate",
      source_objects: [`${schema ? `${schema}.` : ""}${table}`],
      writer_grants: ["The trusted writer must already have the minimum CREATE authority required by the configured first-use auto-migration."],
      sql_preview: migration,
      receipt_schema: schema ?? null,
      receipt_table: table,
      writer_role: null,
      setup_connection_env: input.source.write_url_env ?? null,
      apply_allowed: input.profile === "development" || input.profile === "staging",
      source_database_changed: false,
      next_action: "Verify the exact idempotent first-use migration using the separately configured trusted writer credential.",
    };
  }

  const writerRole = optionalArg(input.args, "--writer-role");
  if (!writerRole) {
    throw new Error("Precreated source receipts require --writer-role <role>. State preserved: config and database unchanged. Next: rerun the dry-run with the exact steady-state writer role.");
  }
  quoteSqlIdentifier(writerRole, input.source.engine);
  if (!setupUrlEnv) {
    throw new Error("Precreated source receipts require --setup-url-env <ADMIN_DATABASE_URL_ENV>. State preserved: config and database unchanged. Next: supply a separate setup/admin environment-variable name.");
  }
  if (setupUrlEnv === input.source.read_url_env || setupUrlEnv === input.source.write_url_env) {
    throw new Error("Writeback setup refuses to reuse the read or steady-state writer credential as the elevated setup connection. State preserved: config and database unchanged. Next: supply a separate setup/admin environment variable.");
  }
  const grants = input.source.engine === "postgres"
    ? formatPostgresReceiptGrants(schema ?? "public", writerRole, table)
    : formatMysqlReceiptGrantsForSetup(schema, writerRole, table);
  const migration = input.source.engine === "postgres"
    ? formatPostgresReceiptMigration(schema, table)
    : formatMysqlReceiptMigration(schema, table);
  return {
    schema_version: "synapsor.writeback-setup.v1",
    config_path: input.configPath,
    source: input.sourceName,
    engine: input.source.engine,
    profile: input.profile,
    executor: "direct_sql",
    receipt_mode: receiptMode,
    execution: "precreated_source_receipt",
    source_objects: [`${schema ? `${schema}.` : ""}${table}`],
    writer_grants: grants.split("\n").filter((line) => /^GRANT /.test(line)),
    sql_preview: `${migration.trimEnd()}\n\n${grants}`,
    receipt_schema: schema ?? null,
    receipt_table: table,
    writer_role: writerRole,
    setup_connection_env: setupUrlEnv,
    apply_allowed: input.profile === "development" || input.profile === "staging",
    source_database_changed: false,
    next_action: "Review the exact receipt object and least-privilege grants, then apply with the separate setup/admin connection.",
  };
}


async function writebackSetupProfile(args: string[], configPath: string): Promise<WritebackSetupProfile> {
  const explicit = optionalArg(args, "--profile");
  if (explicit) {
    if (!["development", "staging", "production"].includes(explicit)) {
      throw new Error("Writeback setup --profile must be development, staging, or production.");
    }
    return explicit as WritebackSetupProfile;
  }
  try {
    const active = JSON.parse(
      await fs.readFile(path.join(path.dirname(configPath), ".synapsor/exploration-boundary.active.json"), "utf8"),
    ) as Record<string, unknown>;
    return active.deployment_profile === "development" || active.deployment_profile === "staging"
      ? active.deployment_profile
      : "unknown";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unknown";
    throw error;
  }
}


function formatWritebackSetupPlan(plan: WritebackSetupPlan): string {
  const applyArguments = [
    "--config", shellQuote(plan.config_path),
    ...(plan.source ? ["--source", shellQuote(plan.source)] : []),
    "--profile", plan.profile,
    ...(plan.receipt_schema ? ["--schema", shellQuote(plan.receipt_schema)] : []),
    ...(plan.receipt_table ? ["--table", shellQuote(plan.receipt_table)] : []),
    ...(plan.writer_role ? ["--writer-role", shellQuote(plan.writer_role)] : []),
    ...(plan.setup_connection_env && plan.receipt_mode === "source_precreated"
      ? ["--setup-url-env", shellQuote(plan.setup_connection_env)]
      : []),
  ];
  return [
    "Synapsor writeback setup preview",
    `Digest: ${plan.digest}`,
    `Config: ${plan.config_path}`,
    `Profile: ${plan.profile}`,
    `Source: ${plan.source ?? "none"}`,
    `Executor: ${plan.executor}`,
    `Receipt mode: ${plan.receipt_mode}`,
    `Execution: ${plan.execution}`,
    `Source objects: ${plan.source_objects.join(", ") || "none"}`,
    `Setup connection env: ${plan.setup_connection_env ?? "not required"}`,
    "Source database changed: no",
    ...(plan.writer_grants.length ? ["", "Reviewed grants:", ...plan.writer_grants.map((grant) => `  ${grant}`)] : []),
    ...(plan.sql_preview ? ["", "Exact SQL preview:", plan.sql_preview.trimEnd()] : []),
    "",
    `Next: ${plan.next_action}`,
    ...(plan.apply_allowed
      ? [`Apply only after review: ${cliCommandName()} writeback setup ${applyArguments.join(" ")} --apply --confirm ${shellQuote(`APPLY WRITEBACK SETUP ${plan.digest}`)}`]
      : ["DDL apply is unavailable for this profile. Export the plan for external production review."]),
    "",
  ].join("\n");
}


function formatRuntimeReceiptMigration(
  engine: "postgres" | "mysql",
  schema: string | undefined,
  table: string,
): string {
  const quotedTable = table === "synapsor_writeback_receipts" ? table : quoteSqlIdentifier(table, engine);
  const qualified = schema ? `${quoteSqlIdentifier(schema, engine)}.${quotedTable}` : quotedTable;
  const migration = engine === "postgres" ? postgresReceiptMigration : mysqlReceiptMigration;
  return [
    "-- Exact idempotent receipt migration used by the configured Runner writer.",
    `${migration.replace("synapsor_writeback_receipts", qualified)};`,
    "",
  ].join("\n");
}


async function applyWritebackSetupPlan(
  plan: WritebackSetupPlan,
  source: RunnerSourceConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ source_database_changed: boolean; message: string }> {
  if (plan.receipt_mode === "runner_ledger") {
    return {
      source_database_changed: false,
      message: "Runner-ledger prerequisites verified. No source receipt DDL or receipt grants were executed.",
    };
  }
  const connectionEnv = plan.setup_connection_env;
  if (!connectionEnv) throw new Error("Writeback setup has no approved connection environment variable.");
  const databaseUrl = envValue(env, connectionEnv);
  if (!databaseUrl) {
    throw new Error(`Writeback setup connection environment ${connectionEnv} is missing. State preserved: config and database unchanged. Next: export the credential in the launching shell and rerun the exact confirmed command.`);
  }
  if (plan.receipt_mode === "source_auto_migrate" && connectionEnv !== source.write_url_env) {
    throw new Error("Auto-migrate verification must use the configured trusted writer credential so the first-use authority is tested exactly.");
  }
  if (plan.engine === "postgres") {
    const pool = createPostgresPool(databaseUrl, { max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(plan.sql_preview);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  } else if (plan.engine === "mysql") {
    const connection = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
    try {
      await connection.query(plan.sql_preview);
    } finally {
      await connection.end();
    }
  } else {
    throw new Error("Writeback setup engine is unavailable.");
  }
  return {
    source_database_changed: true,
    message: plan.receipt_mode === "source_auto_migrate"
      ? "The configured idempotent first-use receipt migration completed with the trusted writer credential."
      : "The reviewed receipt object and least-privilege grants were applied with the separate setup/admin credential.",
  };
}


function formatMysqlReceiptGrantsForSetup(database: string | undefined, writerRole: string, table: string): string {
  if (!database) throw new Error("MySQL precreated receipt setup requires --schema <database_name>.");
  const quotedDatabase = quoteSqlIdentifier(database, "mysql");
  const quotedTable = quoteSqlIdentifier(table, "mysql");
  const account = `'${writerRole.replace(/'/g, "''")}'@'%'`;
  return [
    "-- Least-privilege grants for a pre-created Synapsor Runner receipt table.",
    `GRANT SELECT, INSERT, UPDATE ON ${quotedDatabase}.${quotedTable} TO ${account};`,
    "",
  ].join("\n");
}


async function writeCliJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}


async function writebackDoctor(args: string[]): Promise<number> {
  const configPath = runnerConfigPath(args, defaultConfigPath);
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
