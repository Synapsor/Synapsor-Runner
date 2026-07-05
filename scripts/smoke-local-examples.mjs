#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("test:docker now runs the current MCP-backed local Docker examples.");
console.log("Delegating to scripts/smoke-mcp-local-examples.mjs.\n");

const result = spawnSync(process.execPath, ["scripts/smoke-mcp-local-examples.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
