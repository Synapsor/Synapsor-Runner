import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unpackExtension } from "@anthropic-ai/mcpb";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "apps/runner/package.json"), "utf8"),
);
const archivePath = path.resolve(
  process.argv[2]
    ?? path.join(
      root,
      "dist/mcpb",
      `synapsor-runner-${packageJson.version}-unsigned.mcpb`,
    ),
);
const tempDir = await mkdtemp(path.join(os.tmpdir(), "synapsor-mcpb-runtime-"));
const unpackDir = path.join(tempDir, "unpacked");
const storePath = path.join(tempDir, "local.db");
const appUri = "ui://synapsor/proposal-review.html";

await access(archivePath);

try {
  if (!await unpackExtension({
    mcpbPath: archivePath,
    outputDir: unpackDir,
    silent: true,
  })) {
    throw new Error("MCPB unpack failed");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(unpackDir, "dist/runner.mjs"),
      "mcp",
      "serve",
      "--config",
      path.join(root, "examples/support-plan-credit/synapsor.runner.json"),
      "--store",
      storePath,
    ],
    cwd: unpackDir,
    env: {
      ...process.env,
      PLAN_CREDIT_POSTGRES_READ_URL:
        "postgresql://localhost/not-used-for-tools-list",
      PLAN_CREDIT_POSTGRES_WRITE_URL:
        "postgresql://localhost/not-used-for-tools-list",
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "mcpb_verifier",
    },
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });

  const client = new Client({
    name: "synapsor-runner-mcpb-verifier",
    version: "1.0.0",
  });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "support.inspect_customer",
      "support.propose_plan_credit",
    ]) {
      if (!names.includes(expected)) {
        throw new Error(`unpacked MCPB is missing ${expected}: ${names.join(", ")}`);
      }
    }
    const unsafe = names.filter((name) =>
      /execute_sql|run_query|approve|apply|commit/i.test(name));
    if (unsafe.length) {
      throw new Error(`unpacked MCPB exposes unsafe tools: ${unsafe.join(", ")}`);
    }

    const proposalTool = tools.find(
      (tool) => tool.name === "support.propose_plan_credit",
    );
    const advertisedUri = proposalTool?._meta?.ui?.resourceUri
      ?? proposalTool?._meta?.["ui/resourceUri"];
    if (advertisedUri !== appUri) {
      throw new Error(
        `proposal tool advertised ${JSON.stringify(advertisedUri)} instead of ${appUri}`,
      );
    }

    const resources = (await client.listResources()).resources;
    if (!resources.some((resource) => resource.uri === appUri)) {
      throw new Error(`unpacked MCPB did not list ${appUri}`);
    }
    const app = await client.readResource({ uri: appUri });
    const content = app.contents.find((item) => item.uri === appUri);
    if (
      content?.mimeType !== "text/html;profile=mcp-app"
      || typeof content.text !== "string"
      || !content.text.includes("ui/notifications/tool-result")
    ) {
      throw new Error("unpacked MCPB returned an invalid proposal app resource");
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        archive: path.basename(archivePath),
        runner_version: packageJson.version,
        semantic_tools: names,
        proposal_app_uri: appUri,
        proposal_app_mime_type: content.mimeType,
        model_facing_approval_or_apply_tools: [],
      }, null, 2)}\n`,
    );
  } catch (error) {
    if (error instanceof Error && serverStderr.trim()) {
      error.message += `\nMCP server stderr:\n${serverStderr.trim()}`;
    }
    throw error;
  } finally {
    await client.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
