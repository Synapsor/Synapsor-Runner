#!/usr/bin/env node
import {
  type DbRowReader,
  type RuntimeCapabilityConfig,
  type RuntimeConfig,
  type RuntimeSupervisedWorkerCapabilityPolicy,
} from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type PolicyApprovalLimit,
  type StoredProposal,
  type StoredWritebackIntent,
} from "@synapsor-runner/proposal-store";
import {
  type ExecutionReceiptV2,
  type ExecutionReceiptV3,
  type ExecutionReceiptV4,
  type WritebackJob,
} from "@synapsor-runner/protocol";
import {
  type inspectDatabase,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import { type ReconciliationObservation } from "@synapsor-runner/worker-core";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { apply, revert, validate } from "./apply-commands.js";
import {
  updateSupervisedProposalExpiryAttention as updateSupervisedProposalExpiryAttentionImpl,
} from "./attention-domain.js";
import { attentionCommand, notificationsCommand } from "./attention-notifications.js";
import {
  actionCommand,
  boundaryActivateCommand as boundaryActivateCommandImpl,
  boundaryReviewCommand as boundaryReviewCommandImpl,
} from "./boundary-commands.js";
import { cliCommandName, isHelpRequest, isKnownTopLevelCommand, runnerPackageVersion } from "./cli-command-meta.js";
import { usage } from "./cli-help.js";
import { errorNextAction, errorSourceDatabaseChanged, errorStatePreserved, formatCliErrorHint, operationalLog, redactCliErrorMessage, requestsJsonOutput, safeOperationalErrorCode } from "./cli-logging.js";
import { normalizeCliArgv, optionalArg } from "./cli-options.js";
import {
  activeProjectResolutionState,
  databaseInputFromArgs as databaseInputFromArgsImpl,
} from "./cli-project.js";
import { cloud, runnerCommand } from "./cloud-commands.js";
import { configCommand, inspect } from "./config-inspect.js";
import { contractCommand, dslCommand, effectCommand, policyCommand, reportCommand } from "./contract-commands.js";
import { doctor } from "./first-run-doctor.js";
import { boundaryCommand, onboard, start } from "./guided-start.js";
import { runLanguageServer } from "./language-server.js";
import { activation, activity, events, evidence, lifecycle, metrics, proposals, queryAudit, receipts, replay, storeCommand } from "./ledger-commands.js";
import { type WorkbenchDeploymentProfile } from "./local-ui.js";
import { audit, benchmark, recipes } from "./mcp-audit.js";
import { mcp } from "./mcp-project.js";
import { propose } from "./mcp-runtime.js";
import { init, runInitWizard as runInitWizardImpl } from "./onboarding.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import { up } from "./runtime-commands.js";
import { hydrateManagedSecrets, type ManagedSecretsProvider } from "./secrets-manager.js";
import { shadow } from "./shadow-commands.js";
import { demo, tryCommand } from "./try-commands.js";
import { ui, workbenchDeploymentProfileArg as workbenchDeploymentProfileArgImpl } from "./ui-command.js";
import {
  assertSupervisedPolicyApprovalCurrent as assertSupervisedPolicyApprovalCurrentImpl,
  assessSupervisedWriterPosture as assessSupervisedWriterPostureImpl,
} from "./worker-policy.js";
import { workerCommand } from "./worker-runtime.js";
import {
  resolveSqlWriteDatabaseUrl as resolveSqlWriteDatabaseUrlImpl,
  verifyLocalWritebackAuthority as verifyLocalWritebackAuthorityImpl,
} from "./writeback-execution.js";
import {
  handler,
  reconciliationReceipt as reconciliationReceiptImpl,
  reconciliationSupportedOutcome as reconciliationSupportedOutcomeImpl,
  smoke,
  tools,
  writeback,
} from "./writeback-setup.js";

type WizardAsk = (question: string, defaultValue?: string) => Promise<string>;

export type SupervisedWriterPostureAssessment = {
  ok: boolean;
  fingerprint: `sha256:${string}`;
  expected_fingerprint: `sha256:${string}` | null;
  reasons: string[];
  allowed_relations: string[];
  writable_relations: string[];
};

export function assertSupervisedPolicyApprovalCurrent(
  store: ProposalStore,
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  proposal: StoredProposal,
): { policy: string; limits: PolicyApprovalLimit[] } | undefined {
  return assertSupervisedPolicyApprovalCurrentImpl(store, config, capability, proposal);
}

export function assessSupervisedWriterPosture(
  config: RuntimeConfig,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
  inspection: SchemaInspection,
): SupervisedWriterPostureAssessment {
  return assessSupervisedWriterPostureImpl(config, policy, inspection);
}

export function boundaryActivateCommand(
  args: string[],
  schemaInspector?: typeof inspectDatabase,
): Promise<number> {
  return boundaryActivateCommandImpl(args, schemaInspector);
}

export function boundaryReviewCommand(args: string[]): Promise<number> {
  return boundaryReviewCommandImpl(args);
}

export function databaseInputFromArgs(
  args: string[],
  options: { implyDatabaseUrl?: boolean } = {},
): {
  explicit: boolean;
  inlineUrl: boolean;
  inspectionDatabaseUrlEnv: string;
  configDatabaseUrlEnv: string;
  env?: NodeJS.ProcessEnv;
} {
  return databaseInputFromArgsImpl(args, options);
}

export function reconciliationReceipt(
  intent: StoredWritebackIntent,
  observation: ReconciliationObservation,
  outcome: "applied" | "conflict" | "failed",
  runnerId: string,
  reason: string,
): ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4 {
  return reconciliationReceiptImpl(intent, observation, outcome, runnerId, reason);
}

export function reconciliationSupportedOutcome(
  observation: ReconciliationObservation,
): "applied" | "conflict" | "failed" {
  return reconciliationSupportedOutcomeImpl(observation);
}

export function resolveSqlWriteDatabaseUrl(
  job: WritebackJob,
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return resolveSqlWriteDatabaseUrlImpl(job, configPath, env);
}

export function runInitWizard(
  args: string[],
  options: {
    ask?: WizardAsk;
    env?: NodeJS.ProcessEnv;
    inspection?: SchemaInspection;
    readRow?: DbRowReader;
    stdout?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<number> {
  return runInitWizardImpl(args, options);
}

export function updateSupervisedProposalExpiryAttention(
  store: ProposalStore,
  config: RuntimeConfig,
  now?: string,
): void {
  updateSupervisedProposalExpiryAttentionImpl(store, config, now);
}

export function verifyLocalWritebackAuthority(
  job: WritebackJob,
  configPath: string,
  storePath?: string,
  options?: { cloudApproved?: boolean },
): Promise<void> {
  return verifyLocalWritebackAuthorityImpl(job, configPath, storePath, options);
}

export function workbenchDeploymentProfileArg(
  args: string[],
): WorkbenchDeploymentProfile | undefined {
  return workbenchDeploymentProfileArgImpl(args);
}

const projectAwareCommands = new Set([
  "activation",
  "attention",
  "activity",
  "apply",
  "config",
  "contract",
  "doctor",
  "events",
  "evidence",
  "handler",
  "mcp",
  "metrics",
  "notifications",
  "policy",
  "proposals",
  "propose",
  "query-audit",
  "receipts",
  "replay",
  "report",
  "revert",
  "runner",
  "shadow",
  "smoke",
  "store",
  "tools",
  "ui",
  "up",
  "worker",
  "writeback",
]);


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
  if (command === "lifecycle") return lifecycle(rest);
  const projectAware = projectAwareCommands.has(command)
    || (command === "try" && (rest[0] === "call" || rest[0] === "explore" || rest[0] === "protect"));
  activeProjectResolutionState.current = projectAware && !optionalArg(rest, "--config")
    ? await resolveSynapsorProject(process.cwd(), process.env)
    : undefined;
  await maybeHydrateManagedSecrets(rest);
  if (command === "init") return init(rest);
  if (command === "inspect") return inspect(rest);
  if (command === "config") return configCommand(rest);
  if (command === "contract") return contractCommand(rest);
  if (command === "effect") return effectCommand(rest);
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
  if (command === "boundary") return boundaryCommand(rest);
  if (command === "action") return actionCommand(rest);
  if (command === "up") return up(rest);
  if (command === "runner") return runnerCommand(rest);
  if (command === "cloud") return cloud(rest);
  if (command === "mcp") return mcp(rest);
  if (command === "smoke") return smoke(rest);
  if (command === "tools") return tools(rest);
  if (command === "writeback") return writeback(rest);
  if (command === "handler") return handler(rest);
  if (command === "onboard") return onboard(rest);
  if (command === "try") return tryCommand(rest);
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
  if (command === "activation") return activation(rest);
  if (command === "attention") return attentionCommand(rest);
  if (command === "notifications") return notificationsCommand(rest);
  if (command === "worker") return workerCommand(rest);
  if (command === "store") return storeCommand(rest);
  if (command === "shadow") return shadow(rest);
  if (command === "ui") return ui(rest);
  process.stderr.write(`Unknown command: ${cliCommandName()} ${command}\n\nTry:\n${cliCommandName()} --help\n`);
  return 2;
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


export async function runCliProcess(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactCliErrorMessage(rawMessage);
    const errorCode = safeOperationalErrorCode(error);
    operationalLog("warn", "cli_rejected", {
      command: normalizeCliArgv(argv)[0] ?? "unknown",
      error_code: errorCode,
    });
    if (requestsJsonOutput(argv)) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: {
          code: errorCode,
          message,
        },
        recovery: {
          state_preserved: errorStatePreserved(message),
          source_database_changed: errorSourceDatabaseChanged(message),
          next_action: errorNextAction(message, argv),
        },
      }, null, 2)}\n`);
    }
    process.stderr.write(`${message}${formatCliErrorHint(message)}\n`);
    return 1;
  }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCliProcess(process.argv.slice(2))
    .then((code) => process.exit(code));
}
