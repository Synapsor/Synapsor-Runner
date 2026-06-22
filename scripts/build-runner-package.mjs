import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPoint = resolve(root, "apps/runner/src/cli.ts");
const outfile = resolve(root, "apps/runner/dist/cli.js");
const binfile = resolve(root, "apps/runner/dist/bin.cjs");

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.5",
  sourcemap: false,
  external: [
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "mysql2",
    "mysql2/*",
    "pg",
    "pg/*",
    "zod",
  ],
  logLevel: "info",
});

await chmod(outfile, 0o755);

await writeFile(
  binfile,
  [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('node:child_process');",
    "const { join } = require('node:path');",
    "const result = spawnSync(process.execPath, ['--no-warnings', join(__dirname, 'cli.js'), ...process.argv.slice(2)], {",
    "  stdio: 'inherit',",
    "  env: { ...process.env, NODE_NO_WARNINGS: '1', SYNAPSOR_RUNNER_COMMAND_NAME: 'synapsor-runner' },",
    "});",
    "if (result.error) {",
    "  console.error(result.error);",
    "  process.exit(1);",
    "}",
    "if (result.signal) process.kill(process.pid, result.signal);",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"),
);
await chmod(binfile, 0o755);
