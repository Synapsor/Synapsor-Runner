#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { mysqlAdapter } from "@synapsor-runner/mysql";
import { postgresAdapter } from "@synapsor-runner/postgres";
import { parseWritebackJob } from "@synapsor-runner/protocol";
import { createLogger, doctorChecks, loadConfig, startPolling, type RunnerConfig } from "@synapsor-runner/worker-core";

const adapters = { postgres: postgresAdapter, mysql: mysqlAdapter };

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "doctor") return doctor();
  if (command === "validate") return validate(rest);
  if (command === "apply") return apply(rest);
  if (command === "start") return start();
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
`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
