#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runnerBundle = fileURLToPath(import.meta.resolve("@synapsor/runner/cli"));
const result = spawnSync(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  runnerBundle,
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  env: { ...process.env, SYNAPSOR_RUNNER_COMMAND_NAME: "synapsor-runner" },
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
