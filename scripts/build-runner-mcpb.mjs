import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packExtension,
  unpackExtension,
  validateManifest,
} from "@anthropic-ai/mcpb";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(root, "apps/runner/package.json"), "utf8"));
const outputDir = resolve(root, "dist/mcpb");
const stageDir = resolve(outputDir, "stage");
const verifyDir = resolve(outputDir, "verify");
const installRoot = resolve(outputDir, "install");
const archiveName = `synapsor-runner-${packageJson.version}-unsigned.mcpb`;
const archivePath = resolve(outputDir, archiveName);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

run("corepack", [
  "pnpm",
  "--filter",
  "@synapsor/runner",
  "deploy",
  "--prod",
  "--legacy",
  stageDir,
]);

// MCPB packers dereference symlinks, which breaks pnpm's isolated dependency
// layout after unpacking. Reinstall the same lockfile-selected production
// graph in a hoisted layout before packing so the artifact is self-contained.
await rm(resolve(stageDir, "node_modules"), { recursive: true, force: true });
await mkdir(resolve(installRoot, "apps/runner"), { recursive: true });
for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  await cp(resolve(root, name), resolve(installRoot, name));
}
await cp(
  resolve(root, "apps/runner/package.json"),
  resolve(installRoot, "apps/runner/package.json"),
);
run(
  "corepack",
  [
    "pnpm",
    "--config.node-linker=hoisted",
    "--filter",
    "@synapsor/runner",
    "install",
    "--prod",
    "--frozen-lockfile",
    "--ignore-scripts",
  ],
  { cwd: installRoot },
);
await rename(
  resolve(installRoot, "node_modules"),
  resolve(stageDir, "node_modules"),
);
await rm(installRoot, { recursive: true, force: true });

for (const removable of [
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "TRADEMARKS.md",
  "docs",
  "examples",
  "fixtures",
  "recipes",
  "schemas",
]) {
  await rm(resolve(stageDir, removable), { recursive: true, force: true });
}

const manifest = {
  manifest_version: "0.4",
  name: "synapsor-runner-standard-bundle",
  display_name: "Synapsor Runner",
  version: packageJson.version,
  description: "Local MCP runtime for reviewed Postgres/MySQL business capabilities, proposals, evidence, receipts, and replay.",
  long_description: "Runs a standard Synapsor contract bundle over stdio. Proposal tools may render a display-only MCP App, while approval and apply remain outside the model-facing MCP surface.",
  author: {
    name: "Synapsor",
    url: "https://synapsor.ai",
  },
  repository: {
    type: "git",
    url: "https://github.com/Synapsor/Synapsor-Runner.git",
  },
  homepage: "https://synapsor.ai",
  documentation: "https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/mcp-apps.md",
  support: "https://github.com/Synapsor/Synapsor-Runner/issues",
  server: {
    type: "node",
    entry_point: "dist/runner.mjs",
    mcp_config: {
      command: "node",
      args: [
        "${__dirname}/dist/runner.mjs",
        "mcp",
        "serve",
        "--config",
        "${user_config.runner_config}",
        "--store",
        "${user_config.state_directory}/local.db",
      ],
      env: {
        SYNAPSOR_DATABASE_READ_URL: "${user_config.database_read_url}",
        SYNAPSOR_DATABASE_WRITE_URL: "${user_config.database_write_url}",
        SYNAPSOR_TENANT_ID: "${user_config.tenant_id}",
        SYNAPSOR_PRINCIPAL: "${user_config.principal}",
      },
    },
  },
  tools_generated: true,
  keywords: [
    "mcp",
    "postgresql",
    "mysql",
    "agent-security",
    "proposal",
    "writeback",
  ],
  license: "Apache-2.0",
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: {
      node: ">=22.13.0",
    },
  },
  user_config: {
    runner_config: {
      type: "file",
      title: "Runner configuration",
      description: "Select synapsor.runner.json from a standard Synapsor contract bundle.",
      required: true,
    },
    state_directory: {
      type: "directory",
      title: "Local state directory",
      description: "Directory for the local Synapsor proposal/evidence/receipt ledger.",
      required: true,
      default: "${HOME}/.synapsor",
    },
    database_read_url: {
      type: "string",
      title: "Least-privilege database read URL",
      description: "Postgres/MySQL read URL used by SYNAPSOR_DATABASE_READ_URL.",
      required: true,
      sensitive: true,
    },
    database_write_url: {
      type: "string",
      title: "Least-privilege database write URL",
      description: "Optional separate URL used by SYNAPSOR_DATABASE_WRITE_URL for guarded direct writeback.",
      required: false,
      sensitive: true,
    },
    tenant_id: {
      type: "string",
      title: "Trusted tenant",
      description: "Process-bound tenant used by standard generated contracts.",
      required: true,
    },
    principal: {
      type: "string",
      title: "Trusted principal",
      description: "Process-bound principal used by standard generated contracts.",
      required: true,
    },
  },
  _meta: {
    "ai.synapsor.runner": {
      profile: "standard_contract_bundle",
      signed: false,
      approval_surface: "outside_mcp",
      custom_environment_names_supported: false,
    },
  },
};

const manifestPath = resolve(stageDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(
  resolve(stageDir, "MCPB-README.md"),
  [
    "# Synapsor Runner MCPB",
    "",
    "This is an unsigned installation artifact for standard Runner contract bundles.",
    "It does not contain a contract, database URL, token, tenant value, principal",
    "value, customer row, or approval authority.",
    "",
    "Select the generated `synapsor.runner.json` at install time. This profile",
    "expects the standard `SYNAPSOR_DATABASE_READ_URL`,",
    "`SYNAPSOR_DATABASE_WRITE_URL`, `SYNAPSOR_TENANT_ID`, and",
    "`SYNAPSOR_PRINCIPAL` names. For custom environment bindings, use",
    "`synapsor-runner mcp config` instead.",
    "",
    "Proposal cards are display-only. Review, approval, and apply remain in the",
    "standalone operator UI or terminal.",
    "",
  ].join("\n"),
  "utf8",
);

if (!validateManifest(manifestPath)) {
  throw new Error("generated MCPB manifest did not validate");
}
if (!await packExtension({ extensionPath: stageDir, outputPath: archivePath, silent: true })) {
  throw new Error("MCPB pack failed");
}
if (!await unpackExtension({ mcpbPath: archivePath, outputDir: verifyDir, silent: true })) {
  throw new Error("MCPB unpack verification failed");
}

for (const required of [
  "manifest.json",
  "MCPB-README.md",
  "LICENSE",
  "NOTICE",
  "dist/runner.mjs",
  "node_modules/@modelcontextprotocol/sdk/package.json",
]) {
  await access(resolve(verifyDir, required));
}

const versionResult = runCapture(
  process.execPath,
  ["dist/runner.mjs", "--version"],
  { cwd: verifyDir },
);
if (versionResult.stdout.trim() !== packageJson.version) {
  throw new Error(
    `unpacked MCPB reported Runner ${JSON.stringify(versionResult.stdout.trim())}; expected ${packageJson.version}`,
  );
}

const unpackedManifest = JSON.parse(await readFile(resolve(verifyDir, "manifest.json"), "utf8"));
if (unpackedManifest._meta?.["ai.synapsor.runner"]?.signed !== false) {
  throw new Error("unsigned MCPB must be labeled signed=false");
}
if (unpackedManifest.server?.mcp_config?.env?.SYNAPSOR_DATABASE_READ_URL !== "${user_config.database_read_url}") {
  throw new Error("MCPB read URL must remain a user-config placeholder");
}

const files = await listFiles(verifyDir);
const forbiddenPaths = files.filter((name) =>
  /^(?:\.env(?:\.|$)|development(?:\/|$)|examples(?:\/|$)|fixtures(?:\/|$))/.test(name)
  || /\.(?:pem|key|p12|pfx)$/i.test(name)
  || /(?:signature|cert-chain)\.json$/i.test(name));
if (forbiddenPaths.length) {
  throw new Error(`MCPB contains forbidden paths: ${forbiddenPaths.join(", ")}`);
}

const manifestText = await readFile(resolve(verifyDir, "manifest.json"), "utf8");
if (/(?:postgres|postgresql|mysql):\/\/[^${\s]/i.test(manifestText)
  || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(manifestText)
  || /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(manifestText)) {
  throw new Error("MCPB manifest contains a credential-like literal");
}

const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(resolve(outputDir, "SHA256SUMS"), `${digest}  ${archiveName}\n`, "utf8");
await writeFile(
  resolve(outputDir, "BUILD-INFO.json"),
  `${JSON.stringify({
    package: "@synapsor/runner",
    version: packageJson.version,
    mcpb_tool: "@anthropic-ai/mcpb@2.1.2",
    manifest_version: "0.4",
    signed: false,
    profile: "standard_contract_bundle",
    archive: archiveName,
    sha256: digest,
    deterministic_inputs: true,
    deterministic_archive_bytes: false,
    archive_note: "The pinned MCPB packer records build timestamps, so repeat builds validate the same inputs but may produce different archive digests.",
  }, null, 2)}\n`,
  "utf8",
);

await rm(stageDir, { recursive: true, force: true });
await rm(verifyDir, { recursive: true, force: true });

const size = (await stat(archivePath)).size;
process.stdout.write(`Built unsigned MCPB: ${archivePath}\n`);
process.stdout.write(`SHA-256: ${digest}\n`);
process.stdout.write(`Bytes: ${size}\n`);
process.stdout.write("Signing is a release-owner step; this build never self-signs.\n");

function run(command, args, { cwd = root } = {}) {
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function runCapture(command, args, { cwd = root } = {}) {
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}: ${result.stderr}`,
    );
  }
  return result;
}

async function listFiles(directory, prefix = "") {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...await listFiles(resolve(directory, entry.name), relative));
    } else {
      names.push(relative);
    }
  }
  return names.sort();
}
