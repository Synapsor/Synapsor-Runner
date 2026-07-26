import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildLocalActivationReport, formatLocalActivationReport } from "./activation-report.js";
import { cliCommandName } from "./cli-command-meta.js";
import { showDetails } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { activeProjectResolutionState, defaultConfigPath, defaultStorePath, openLocalStore, optionalRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { lifecycleFiltersFromArgs, lifecycleHandleFromArgs, lifecycleListAllowedOptions, lifecycleShowAllowedOptions, proposalFiltersFromArgs } from "./ledger-options.js";
import { buildLifecycleView, formatLifecycleDetails, formatLifecycleFirstLook, formatLifecycleList, listLifecycleSummaries, resolveLifecycleProposal } from "./lifecycle-view.js";
import { activitySearch, eventsTail, eventsWebhook, evidenceExport, evidenceList, evidenceShow, proposalsApprove, proposalsCheckFreshness, proposalsList, proposalsReject, proposalsShow, proposalsWritebackJob, queryAuditExport, queryAuditList, queryAuditShow, receiptsList, receiptsShow, replayExport, replayList, replayShow } from "./proposal-ledger.js";
import { argsWithRuntimeStoreBridge, maybeSharedPostgresRuntimeStoreRead, storePrune, storeReset, storeSharedPostgres, storeStats, storeVacuum } from "./store-shared.js";
import { formatPrometheusMetrics } from "./worker-runtime.js";


export async function proposals(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return proposalsList(rest);
  if (subcommand === "show") return proposalsShow(rest);
  if (subcommand === "check-freshness") return proposalsCheckFreshness(rest);
  if (subcommand === "approve") return proposalsApprove(rest);
  if (subcommand === "reject") return proposalsReject(rest);
  if (subcommand === "writeback-job") return proposalsWritebackJob(rest);
  usage(["proposals"]);
  return 2;
}


export async function lifecycle(args: string[]): Promise<number> {
  const [requested, ...tail] = args;
  if (!requested || requested.startsWith("-")) return lifecycleShow(args);
  if (requested === "show") return lifecycleShow(tail);
  if (requested === "list") return lifecycleList(tail);
  usage(["lifecycle"]);
  return 2;
}


async function lifecycleList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "lifecycle list", (bridgeStorePath) => lifecycleList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, lifecycleListAllowedOptions, "lifecycle list");
  const store = await openLocalStore(args);
  try {
    const payload = listLifecycleSummaries(store, proposalFiltersFromArgs(args));
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(payload, null, 2)}\n` : formatLifecycleList(payload));
    return 0;
  } finally {
    store.close();
  }
}


async function lifecycleShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "lifecycle show", (bridgeStorePath) => lifecycleShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, lifecycleShowAllowedOptions, "lifecycle show");
  const handle = lifecycleHandleFromArgs(args);
  const store = await openLocalStore(args);
  try {
    const resolved = resolveLifecycleProposal(store, { handle, filters: lifecycleFiltersFromArgs(args) });
    const payload = buildLifecycleView(store, resolved.proposal, resolved.selection, cliCommandName());
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else if (showDetails(args)) process.stdout.write(formatLifecycleDetails(payload));
    else process.stdout.write(formatLifecycleFirstLook(payload));
    return 0;
  } finally {
    store.close();
  }
}


export async function replay(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return replayList(rest);
  if (subcommand && !["show", "export"].includes(subcommand)) return replayShow(args);
  if (subcommand === "show") return replayShow(rest);
  if (subcommand === "export") return replayExport(rest);
  usage(["replay"]);
  return 2;
}


export async function evidence(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "show") return evidenceShow(rest);
  if (subcommand === "list") return evidenceList(rest);
  if (subcommand === "export") return evidenceExport(rest);
  usage(["evidence"]);
  return 2;
}


export async function queryAudit(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return queryAuditList(rest);
  if (subcommand === "show") return queryAuditShow(rest);
  if (subcommand === "export") return queryAuditExport(rest);
  usage(["query-audit"]);
  return 2;
}


export async function receipts(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return receiptsList(rest);
  if (subcommand === "show") return receiptsShow(rest);
  usage(["receipts"]);
  return 2;
}


export async function activity(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "search") return activitySearch(rest);
  usage(["activity"]);
  return 2;
}


export async function events(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "tail") return eventsTail(rest);
  if (subcommand === "webhook" || subcommand === "push") return eventsWebhook(rest);
  usage(["events"]);
  return 2;
}


export async function metrics(args: string[]): Promise<number> {
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


export async function activation(args: string[]): Promise<number> {
  const [requested, ...tail] = args;
  const subcommand = requested && !requested.startsWith("-") ? requested : "show";
  const rest = subcommand === "show" || subcommand === "export" ? (requested === subcommand ? tail : args) : args;
  if (subcommand !== "show" && subcommand !== "export") {
    usage(["activation"]);
    return 2;
  }
  assertKnownOptions(rest, new Set(["--project-root", "--config", "--store", "--try-state", "--format", "--json", "--out", "--output"]), `activation ${subcommand}`);
  const projectRoot = path.resolve(optionalArg(rest, "--project-root") ?? activeProjectResolutionState.current?.project_root ?? process.cwd());
  const selectedConfig = runnerConfigPath(rest, defaultConfigPath);
  const configPath = path.isAbsolute(selectedConfig) ? selectedConfig : path.resolve(projectRoot, selectedConfig);
  const config = await optionalRuntimeConfig(configPath);
  if (config?.storage?.shared_postgres?.mode === "runtime_store") {
    throw new Error("activation report is a local onboarding measurement and does not inspect a shared Cloud/Postgres runtime ledger");
  }
  const configuredStore = config?.storage?.sqlite_path;
  const storePath = resolvedLocalStorePath(rest, configuredStore, defaultStorePath);
  const report = await buildLocalActivationReport({
    projectRoot,
    storePath,
    ...(optionalArg(rest, "--try-state") ? { tryStateDir: optionalArg(rest, "--try-state") } : {}),
  });
  const format = optionalArg(rest, "--format") ?? (rest.includes("--json") || subcommand === "export" ? "json" : "text");
  if (format !== "text" && format !== "json") throw new Error("activation --format must be text or json");
  const output = optionalArg(rest, "--out") ?? optionalArg(rest, "--output");
  if (subcommand === "export" && !output) throw new Error("activation export requires --out <report.json>");
  const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatLocalActivationReport(report);
  if (output) {
    const destination = path.resolve(projectRoot, output);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, rendered, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Local activation report written to ${output}. No telemetry was transmitted.\n`);
  } else {
    process.stdout.write(rendered);
  }
  return 0;
}


export async function storeCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "stats") return storeStats(rest);
  if (subcommand === "vacuum") return storeVacuum(rest);
  if (subcommand === "prune") return storePrune(rest);
  if (subcommand === "reset") return storeReset(rest);
  if (subcommand === "shared-postgres") return storeSharedPostgres(rest);
  usage(["store"]);
  return 2;
}
