import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(root, "examples", "mcp-client-configs");
const expectedFiles = ["generic-stdio.json", "claude-desktop.json", "cursor.json", "vscode.json"];
const flagshipConfigDir = path.join(root, "examples", "support-plan-credit", "mcp-client-examples");
const flagshipFiles = [
  "claude-desktop.json",
  "cursor-project.mcp.json",
  "cursor-global.mcp.json",
  "openai-agents-stdio.ts",
  "openai-agents-streamable-http.ts",
  "generic-stdio.json",
  "generic-streamable-http.json",
];
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

async function verifyFlagshipTools() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-mcp-client-support-plan-credit-"));
  try {
    const transport = new StdioClientTransport({
      command: "corepack",
      args: [
        "pnpm", "runner", "mcp", "serve",
        "--config", path.join(root, "examples", "support-plan-credit", "synapsor.runner.json"),
        "--store", path.join(tempDir, "local.db"),
      ],
      cwd: root,
      env: {
        ...process.env,
        PLAN_CREDIT_POSTGRES_READ_URL: "postgresql://localhost/not-used-for-tools-list",
        PLAN_CREDIT_POSTGRES_WRITE_URL: "postgresql://localhost/not-used-for-tools-list",
        SYNAPSOR_TENANT_ID: "acme",
        SYNAPSOR_PRINCIPAL: "client_config_verifier",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "synapsor-flagship-client-config-verifier", version: "0.1.0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const expected of ["support.inspect_customer", "support.propose_plan_credit"]) {
        if (!names.includes(expected)) throw new Error(`flagship MCP tools missing ${expected}: ${names.join(", ")}`);
      }
      const unsafe = names.filter((name) => unsafeToolName.test(name));
      if (unsafe.length) throw new Error(`unsafe flagship tools exposed: ${unsafe.join(", ")}`);
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

for (const file of flagshipFiles) {
  const filePath = path.join(flagshipConfigDir, file);
  const text = fs.readFileSync(filePath, "utf8");
  if (/\/(?:home|Users)\//.test(text)) throw new Error(`${file}: contains a machine-specific absolute path`);
  if (secretValue.test(text)) throw new Error(`${file}: contains a possible secret`);
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(text);
    inspectSecretValues(parsed, ["support-plan-credit", file]);
    if (file === "generic-streamable-http.json") {
      if (parsed.transport !== "streamable-http" || parsed.url !== "http://127.0.0.1:8766/mcp") {
        throw new Error(`${file}: expected the local Streamable HTTP endpoint`);
      }
    } else if (file === "generic-stdio.json") {
      if (parsed.transport !== "stdio" || parsed.command !== "npx" || !parsed.args?.includes("@synapsor/runner")) {
        throw new Error(`${file}: expected the stable npm stdio command`);
      }
    } else {
      const entry = serverEntry(parsed);
      if (entry.command !== "npx" || !entry.args?.includes("@synapsor/runner")) {
        throw new Error(`${file}: expected the stable npm command`);
      }
    }
  } else if (file === "openai-agents-stdio.ts") {
    if (!text.includes("MCPServerStdio") || !text.includes("--alias-mode openai")) {
      throw new Error(`${file}: expected OpenAI stdio SDK wiring and safe tool aliases`);
    }
  } else if (!text.includes("MCPServerStreamableHttp") || !text.includes("--alias-mode openai")) {
    throw new Error(`${file}: expected OpenAI Streamable HTTP wiring and matching server alias guidance`);
  }
  console.log(`support-plan-credit/${file}: parsed and safety-scanned`);
}

await verifyFlagshipTools();
console.log("support-plan-credit: stdio tools/list verified");

console.log("MCP client config examples are parseable, secret-free, and expose semantic tools only.");
