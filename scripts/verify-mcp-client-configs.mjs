import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(root, "examples", "mcp-client-configs");
const expectedFiles = ["generic-stdio.json", "claude-desktop.json", "cursor.json", "vscode.json"];
const unsafeToolName = /execute_sql|run_query|approve|commit/i;
const secretValue = /:\/\/[^/\s:@]+:[^@\s/]+@|syn_wbr_|bearer\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(configDir, file), "utf8"));
}

function serverEntry(config) {
  const servers = config.mcpServers || config.servers;
  if (!servers || typeof servers !== "object") {
    throw new Error("expected mcpServers or servers object");
  }
  const entry = servers["synapsor-runner"];
  if (!entry || typeof entry !== "object") {
    throw new Error("expected synapsor-runner server entry");
  }
  return entry;
}

function inspectSecretValues(value, pathParts = []) {
  if (typeof value === "string" && secretValue.test(value)) {
    throw new Error(`possible secret in ${pathParts.join(".") || "<root>"}: ${value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSecretValues(item, [...pathParts, String(index)]));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      inspectSecretValues(nested, [...pathParts, key]);
    }
  }
}

function normalizedArgs(entry, storePath) {
  if (!Array.isArray(entry.args)) throw new Error("server args must be an array");
  const args = entry.args.map(String);
  const joined = args.join(" ");
  for (const required of ["pnpm", "runner", "mcp", "serve", "--config", "--store"]) {
    if (!args.includes(required)) {
      throw new Error(`server args missing ${required}: ${joined}`);
    }
  }
  const storeIndex = args.indexOf("--store");
  if (storeIndex < 0 || storeIndex === args.length - 1) {
    throw new Error("--store requires a path");
  }
  args[storeIndex + 1] = storePath;
  return args;
}

async function verifyServer(file, entry) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-mcp-client-${path.basename(file, ".json")}-`));
  try {
    const storePath = path.join(tempDir, "local.db");
    const transport = new StdioClientTransport({
      command: String(entry.command),
      args: normalizedArgs(entry, storePath),
      cwd: root,
      env: {
        ...process.env,
        ...(entry.env || {}),
        BILLING_POSTGRES_READ_URL: process.env.BILLING_POSTGRES_READ_URL || "postgresql://localhost/not-used-for-tools-list",
        SYNAPSOR_TENANT_ID: process.env.SYNAPSOR_TENANT_ID || "acme",
        SYNAPSOR_PRINCIPAL: process.env.SYNAPSOR_PRINCIPAL || "client_config_verifier",
      },
      stderr: "pipe",
    });
    let serverStderr = "";
    transport.stderr?.on("data", (chunk) => {
      serverStderr += String(chunk);
    });
    const client = new Client({ name: "synapsor-client-config-verifier", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      if (!names.includes("billing.inspect_invoice") || !names.includes("billing.propose_late_fee_waiver")) {
        throw new Error(`expected billing semantic tools, got ${names.join(", ")}`);
      }
      const unsafe = names.filter((name) => unsafeToolName.test(name));
      if (unsafe.length > 0) {
        throw new Error(`unsafe model-callable tools exposed: ${unsafe.join(", ")}`);
      }
    } catch (error) {
      if (error instanceof Error && serverStderr.trim()) {
        error.message += `\nMCP server stderr:\n${serverStderr.trim()}`;
      }
      throw error;
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

for (const file of expectedFiles) {
  const config = readJson(file);
  inspectSecretValues(config, [file]);
  const entry = serverEntry(config);
  if (String(entry.command) !== "corepack") {
    throw new Error(`${file}: expected command corepack`);
  }
  await verifyServer(file, entry);
  console.log(`${file}: stdio tools/list verified`);
}

console.log("MCP client config examples are parseable, secret-free, and expose semantic tools only.");
