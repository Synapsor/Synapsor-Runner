#!/usr/bin/env node

import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  fileURLToPath,
} from "node:url";

type JsonObject = Record<string, unknown>;

type ModelVisibleTool = {
  name: string;
  description?: string;
  input_schema: JsonObject;
  output_schema?: JsonObject;
  contract_digest?: string;
};

type ModelToolCall = {
  name: string;
  arguments: JsonObject;
};

type Options = {
  transport: "stdio" | "streamable-http";
  config?: string;
  store?: string;
  url?: string;
  bearerTokenEnv?: string;
  call?: ModelToolCall;
};

const ANALYTICS_CATALOG_URI = "synapsor://analytics/catalog/v1";
const bundledRunnerCli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const options = parseOptions(process.argv.slice(2));
const client = new Client({
  name: "synapsor-host-neutral-typescript-example",
  version: "1.0.0",
});
const transport = createTransport(options);

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const modelTools = listed.tools.map<ModelVisibleTool>((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema as JsonObject,
    ...(tool.outputSchema ? { output_schema: tool.outputSchema as JsonObject } : {}),
    ...(typeof tool._meta?.["synapsor.contract_digest"] === "string"
      ? { contract_digest: tool._meta["synapsor.contract_digest"] }
      : {}),
  }));

  assertNoOperatorOrSqlAuthority(modelTools);
  const analyticsCatalog = await readAnalyticsCatalog(client);
  assertCatalogPins(modelTools, analyticsCatalog);

  const requestedCall = await applicationOwnedModelLayer(modelTools, options.call);
  if (!requestedCall) {
    printJson({
      connected: true,
      transport: options.transport,
      reviewed_tools: modelTools,
      analytics_catalog: analyticsCatalog,
      source_database_changed: false,
      next: "Pass --call <tool-name> --arguments '<json>' to forward one typed model decision.",
    });
  } else {
    const selected = modelTools.find((tool) => tool.name === requestedCall.name);
    if (!selected) {
      throw new Error(`The application model selected an unadvertised tool: ${requestedCall.name}`);
    }
    const result = await client.callTool({
      name: requestedCall.name,
      arguments: requestedCall.arguments,
    });
    printJson({
      connected: true,
      transport: options.transport,
      tool: requestedCall.name,
      contract_digest: selected.contract_digest ?? null,
      accepted: result.isError !== true,
      structured_result: result.structuredContent ?? null,
      serialized_result: result.content,
    });
  }
} finally {
  await client.close().catch(() => undefined);
}

async function applicationOwnedModelLayer(
  tools: ModelVisibleTool[],
  deterministicCall?: ModelToolCall,
): Promise<ModelToolCall | undefined> {
  // Replace only this function with the application's LLM adapter. Give that
  // adapter these reviewed schemas and forward its typed decision unchanged.
  if (!deterministicCall) return undefined;
  if (!tools.some((tool) => tool.name === deterministicCall.name)) {
    throw new Error(`Requested tool is not in the reviewed MCP catalog: ${deterministicCall.name}`);
  }
  return deterministicCall;
}

function createTransport(options: Options): StdioClientTransport | StreamableHTTPClientTransport {
  if (options.transport === "stdio") {
    if (!options.config) {
      throw new Error("--config is required for stdio.");
    }
    return new StdioClientTransport({
      command: process.execPath,
      args: [
        bundledRunnerCli,
        "mcp",
        "serve",
        "--config",
        options.config,
        ...(options.store ? ["--store", options.store] : []),
      ],
      env: process.env as Record<string, string>,
      stderr: "inherit",
    });
  }

  if (!options.url || !options.bearerTokenEnv) {
    throw new Error("--url and --bearer-token-env are required for Streamable HTTP.");
  }
  const url = new URL(options.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Streamable HTTP requires HTTPS, except for an explicit loopback URL.");
  }
  const token = process.env[options.bearerTokenEnv];
  if (!token) {
    throw new Error(`Bearer token environment variable is missing: ${options.bearerTokenEnv}`);
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
    },
  });
}

async function readAnalyticsCatalog(clientInstance: Client): Promise<JsonObject | null> {
  try {
    const response = await clientInstance.readResource({ uri: ANALYTICS_CATALOG_URI });
    const content = response.contents[0];
    if (!content || !("text" in content)) return null;
    return JSON.parse(content.text) as JsonObject;
  } catch {
    return null;
  }
}

function assertCatalogPins(tools: ModelVisibleTool[], catalog: JsonObject | null): void {
  if (!catalog) return;
  const capabilities = Array.isArray(catalog.capabilities)
    ? catalog.capabilities as JsonObject[]
    : [];
  for (const capability of capabilities) {
    const name = capability.capability;
    const contract = isObject(capability.contract) ? capability.contract : {};
    const digest = contract.digest;
    if (typeof name !== "string" || typeof digest !== "string") {
      throw new Error("Runner returned malformed analytics catalog authority.");
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || tool.contract_digest !== digest) {
      throw new Error(`Analytics catalog digest does not match tools/list for ${name}.`);
    }
  }
}

function assertNoOperatorOrSqlAuthority(tools: ModelVisibleTool[]): void {
  const forbidden = /(?:^|[._-])(execute[_-]?sql|sql|approve|apply|commit|activate)(?:$|[._-])/i;
  const unsafe = tools.find((tool) => forbidden.test(tool.name));
  if (unsafe) {
    throw new Error(`Refusing an unsafe model-facing tool catalog: ${unsafe.name}`);
  }
}

function parseOptions(args: string[]): Options {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write([
      "Host-neutral Synapsor MCP client example",
      "",
      "Stdio:",
      "  node client.ts --config ./synapsor.runner.json [--store ./.synapsor/local.db]",
      "",
      "Streamable HTTP:",
      "  node client.ts --url https://runner.example/mcp --bearer-token-env SYNAPSOR_MCP_TOKEN",
      "",
      "Forward one typed application-model decision:",
      "  --call analytics.weekly_churn --arguments '{\"region\":\"north\"}'",
      "",
    ].join("\n"));
    process.exit(0);
  }

  const url = optionValue(args, "--url");
  const config = optionValue(args, "--config");
  const callName = optionValue(args, "--call");
  const argumentsText = optionValue(args, "--arguments");
  if (callName && argumentsText === undefined) {
    throw new Error("--arguments is required with --call.");
  }
  if (!callName && argumentsText !== undefined) {
    throw new Error("--call is required with --arguments.");
  }

  const store = optionValue(args, "--store");
  const bearerTokenEnv = optionValue(args, "--bearer-token-env");
  return {
    transport: url ? "streamable-http" : "stdio",
    ...(config ? { config } : {}),
    ...(store ? { store } : {}),
    ...(url ? { url } : {}),
    ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
    ...(callName
      ? {
        call: {
          name: callName,
          arguments: parseJsonObject(argumentsText!),
        },
      }
      : {}),
  };
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseJsonObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error("--arguments must be one JSON object.");
  }
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
