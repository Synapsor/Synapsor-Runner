#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";
import { parseWritebackJob } from "@synapsor-runner/protocol";
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
  if (command === "doctor") return doctor();
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "start") return start();
  if (command === "mcp") return mcp(rest);
  if (command === "proposals") return proposals(rest);
  if (command === "replay") return replay(rest);
  usage();
  return 2;
}

async function doctor(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);
  const report = await doctorChecks(config, adapters[config.engine]);
  logger.info("doctor checks", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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

async function mcp(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "audit") return mcpAudit(rest);
  usage();
  return 2;
}

async function mcpAudit(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    throw new Error("mcp audit requires <target>");
  }
  const manifest = JSON.parse(await fs.readFile(target, "utf8"));
  const report = auditMcpManifest(manifest, { target });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatMcpAuditReport(report));
  return 0;
}

async function proposals(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return proposalsList(rest);
  if (subcommand === "show") return proposalsShow(rest);
  if (subcommand === "approve") return proposalsApprove(rest);
  if (subcommand === "reject") return proposalsReject(rest);
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

function positional(args: string[], index: number): string | undefined {
  return args.filter((arg, argIndex) => {
    if (arg.startsWith("--")) return false;
    const previous = args[argIndex - 1];
    return previous === undefined || !previous.startsWith("--");
  })[index];
}

function formatProposalSummary(proposal: StoredProposal): string {
  return [
    `${proposal.proposal_id}  ${proposal.state}  ${proposal.action}`,
    `  target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `  tenant: ${proposal.tenant_id}  source changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}

function formatProposalDetail(proposal: StoredProposal): string {
  return [
    `proposal: ${proposal.proposal_id}`,
    `state: ${proposal.state}`,
    `action: ${proposal.action}`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    "diff:",
    ...Object.keys(proposal.change_set.patch).map((column) => {
      const before = proposal.change_set.before[column as keyof typeof proposal.change_set.before];
      const proposed = proposal.change_set.after[column as keyof typeof proposal.change_set.after];
      return `  ${column}: ${JSON.stringify(before)} -> ${JSON.stringify(proposed)}`;
    }),
  ].join("\n") + "\n";
}

async function readJob(args: string[]): Promise<unknown> {
  const index = args.indexOf("--job");
  const jobPath = index >= 0 ? args[index + 1] : undefined;
  if (!jobPath) {
    throw new Error("--job <path> is required");
  }
  return JSON.parse(await fs.readFile(jobPath, "utf8"));
}

function usage(): void {
  process.stdout.write(`synapsor-runner

Commands:
  doctor
  validate --job ./job.json
  apply --job ./job.json [--dry-run]
  start
  mcp audit ./tools-list.json [--json]
  proposals list [--store ./.synapsor/local.db] [--state pending_review] [--json]
  proposals show <proposal_id> [--store ./.synapsor/local.db] [--json]
  proposals approve <proposal_id> [--store ./.synapsor/local.db] [--actor local_user] [--yes]
  proposals reject <proposal_id> --reason "..." [--store ./.synapsor/local.db] [--yes]
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
