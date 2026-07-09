import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPoint = resolve(root, "apps/runner/src/cli.ts");
const outfile = resolve(root, "apps/runner/dist/runner.mjs");
const binfile = resolve(root, "apps/runner/dist/cli.js");
const workspaceAliases = new Map([
  ["@synapsor-runner/config", "packages/config/src/index.ts"],
  ["@synapsor-runner/control-plane-client", "packages/control-plane-client/src/index.ts"],
  ["@synapsor-runner/mcp-server", "packages/mcp-server/src/index.ts"],
  ["@synapsor-runner/mysql", "packages/mysql/src/index.ts"],
  ["@synapsor-runner/postgres", "packages/postgres/src/index.ts"],
  ["@synapsor-runner/proposal-store", "packages/proposal-store/src/index.ts"],
  ["@synapsor-runner/protocol", "packages/protocol/src/index.ts"],
  ["@synapsor-runner/schema-inspector", "packages/schema-inspector/src/index.ts"],
  ["@synapsor-runner/worker-core", "packages/worker-core/src/index.ts"],
]);

const workspaceAliasPlugin = {
  name: "synapsor-runner-workspace-aliases",
  setup(build) {
    build.onResolve({ filter: /^@synapsor-runner\/[^/]+$/ }, (args) => {
      const target = workspaceAliases.get(args.path);
      if (!target) return undefined;
      return { path: resolve(root, target) };
    });
  },
};

// Docker-backed demos build with the repo bind-mounted. On GitHub Actions that
// can leave dist files owned by the container user, so remove old bundle files
// before esbuild tries to overwrite them.
await rm(outfile, { force: true });
await rm(binfile, { force: true });

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
  plugins: [workspaceAliasPlugin],
  logLevel: "info",
});

await chmod(outfile, 0o755);

await writeFile(
  binfile,
  [
    "#!/usr/bin/env node",
    "import { spawnSync } from 'node:child_process';",
    "import { dirname, basename, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const __dirname = dirname(fileURLToPath(import.meta.url));",
    "const invoked = basename(process.argv[1] || 'synapsor');",
    "const commandName = invoked === 'synapsor-runner' ? 'synapsor-runner' : 'synapsor';",
    "const [major, minor] = process.versions.node.split('.').map(Number);",
    "if (!(major > 22 || (major === 22 && minor >= 5))) {",
    "  console.error(`Synapsor Runner requires Node >= 22.5.0 because the local ledger uses Node's node:sqlite runtime. Current Node: ${process.versions.node}. Upgrade Node or use the Docker demo from a source checkout.`);",
    "  process.exit(1);",
    "}",
    "const result = spawnSync(process.execPath, ['--no-warnings', join(__dirname, 'runner.mjs'), ...process.argv.slice(2)], {",
    "  stdio: 'inherit',",
    "  env: { ...process.env, NODE_NO_WARNINGS: '1', SYNAPSOR_RUNNER_COMMAND_NAME: commandName },",
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

if (process.env.SYNAPSOR_RUNNER_SKIP_RELEASE_ASSETS === "1") {
  process.exit(0);
}

const packageRoot = resolve(root, "apps/runner");
await cp(resolve(root, "README.md"), resolve(packageRoot, "README.md"));

const publicDocs = [
  "README.md",
  "app-owned-executors.md",
  "capability-authoring.md",
  "cloud-mode.md",
  "cloud-push.md",
  "current-scope.md",
  "doctor.md",
  "getting-started-own-database.md",
  "handler-helper.md",
  "dependency-license-inventory.md",
  "http-mcp.md",
  "limitations.md",
  "licensing.md",
  "local-mode.md",
  "mcp-audit.md",
  "mcp-client-setup.md",
  "mcp-clients.md",
  "migrating-to-synapsor-spec.md",
  "openai-agents-sdk.md",
  "production.md",
  "release-notes.md",
  "release-policy.md",
  "result-envelope-v2.md",
  "runner-bundles.md",
  "conformance.md",
  "recipes.md",
  "security-boundary.md",
  "store-lifecycle.md",
  "troubleshooting-first-run.md",
  "writeback-executors.md",
  "use-your-own-database.md",
];
const releaseAssets = [
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["TRADEMARKS.md", "TRADEMARKS.md"],
  ...publicDocs.map((name) => [`docs/${name}`, `docs/${name}`]),
  ["docs/rfcs", "docs/rfcs"],
  ["recipes", "recipes"],
  ["examples/dangerous-mcp-tools.json", "examples/dangerous-mcp-tools.json"],
  ["examples/app-owned-writeback", "examples/app-owned-writeback"],
  ["examples/claude-desktop-postgres", "examples/claude-desktop-postgres"],
  ["examples/cursor-postgres", "examples/cursor-postgres"],
  ["examples/mcp-postgres-billing-app-handler", "examples/mcp-postgres-billing-app-handler"],
  ["examples/mysql-refund-agent", "examples/mysql-refund-agent"],
  ["examples/openai-agents-http", "examples/openai-agents-http"],
  ["examples/openai-agents-stdio", "examples/openai-agents-stdio"],
  ["examples/raw-sql-vs-synapsor", "examples/raw-sql-vs-synapsor"],
  ["examples/reference-support-billing-app", "examples/reference-support-billing-app"],
  ["examples/support-plan-credit", "examples/support-plan-credit"],
  ["examples/support-billing-agent", "examples/support-billing-agent"],
  ["fixtures", "fixtures"],
  ["schemas", "schemas"],
];

for (const destination of ["docs", "recipes", "examples", "fixtures", "schemas"]) {
  await rm(resolve(packageRoot, destination), { recursive: true, force: true });
}

for (const [source, destination] of releaseAssets) {
  const from = resolve(root, source);
  const to = resolve(packageRoot, destination);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

await cp(
  resolve(root, "packages/handler/dist/index.js"),
  resolve(packageRoot, "examples/mcp-postgres-billing-app-handler/synapsor-handler.mjs"),
);

await removePythonBytecode(resolve(packageRoot, "examples"));
await removeGeneratedRunnerStores(resolve(packageRoot, "examples"));

async function removePythonBytecode(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        await rm(entryPath, { recursive: true, force: true });
      } else {
        await removePythonBytecode(entryPath);
      }
    } else if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
      await rm(entryPath, { force: true });
    }
  }
}

async function removeGeneratedRunnerStores(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === ".synapsor") {
      await rm(entryPath, { recursive: true, force: true });
    } else {
      await removeGeneratedRunnerStores(entryPath);
    }
  }
}
