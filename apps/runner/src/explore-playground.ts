import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import runnerPackage from "../package.json" with { type: "json" };
import { cliCommandName } from "./cli-command-meta.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { activeProjectResolutionState, readRuntimeConfig } from "./cli-project.js";
import {
  describeExplorePlaygroundScope,
  normalizeExplorePlaygroundRequest,
  runExplorePlaygroundRequest,
  validateExplorePlaygroundRequest,
  type ExplorePlaygroundRequest,
  type ExplorePlaygroundRuntime,
} from "./explore-playground-service.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { ScopedExploreError } from "./scoped-explore.js";
import {
  renderTerminalFact,
  renderTerminalJson,
  renderTerminalSectionHeading,
  renderTerminalSqlFrame,
  renderTerminalStyledText,
  safeTerminalCellText,
  safeTerminalText,
  terminalSyntaxColorEnabled,
} from "./terminal-syntax.js";

type PlaygroundGateway = {
  target: "local" | "remote_http";
  targetLabel: string;
  scopeLabel: string[];
  describe(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  validate?: (request: ExplorePlaygroundRequest) => Promise<Record<string, unknown>>;
  run(request: ExplorePlaygroundRequest): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

type ExplorePlaygroundDependencies = {
  createRuntime?: typeof createScopedExploreBoundarySetRuntime;
  connectRemote?: typeof connectRemotePlayground;
  readFile?: typeof fs.readFile;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
};

const PLAYGROUND_OPTIONS = new Set([
  "--project-root",
  "--plan",
  "--input",
  "--plan-json",
  "--boundary",
  "--resource",
  "--cursor",
  "--limit",
  "--url",
  "--config",
  "--token-env",
  "--json",
  "--details",
  "--no-color",
]);

export async function exploreCommand(
  args: string[],
  dependencies: ExplorePlaygroundDependencies = {},
): Promise<number> {
  const [rawSubcommand, ...rest] = args;
  const subcommand = !rawSubcommand || rawSubcommand.startsWith("-")
    ? "playground"
    : rawSubcommand === "sandbox"
      ? "playground"
      : rawSubcommand;
  const options = !rawSubcommand || rawSubcommand.startsWith("-") ? args : rest;
  if (!new Set(["playground", "run", "validate", "describe"]).has(subcommand)) {
    throw new Error("explore accepts playground, run, validate, or describe.");
  }
  assertKnownOptions(options, PLAYGROUND_OPTIONS, `explore ${subcommand}`);

  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const env = dependencies.env ?? process.env;
  const json = options.includes("--json");
  const color = !options.includes("--no-color") && terminalSyntaxColorEnabled(stdout);
  const gateway = await createPlaygroundGateway(options, {
    createRuntime: dependencies.createRuntime,
    connectRemote: dependencies.connectRemote,
    env,
  });
  try {
    if (subcommand === "describe") {
      const described = await gateway.describe({
        ...(optionalArg(options, "--boundary") ? { boundary: optionalArg(options, "--boundary") } : {}),
        ...(optionalArg(options, "--resource") ? { resource: optionalArg(options, "--resource") } : {}),
        ...(optionalArg(options, "--cursor") ? { cursor: integerOption(options, "--cursor", 0) } : {}),
        ...(optionalArg(options, "--limit") ? { limit: integerOption(options, "--limit", 1) } : {}),
      });
      stdout.write(json
        ? `${JSON.stringify(described, null, 2)}\n`
        : formatPlaygroundCatalog(described, gateway, color));
      return described.ok === false ? 1 : 0;
    }

    if (subcommand === "playground") {
      if (options.includes("--json")) {
        throw new Error("explore playground is interactive and does not accept --json. Use explore validate or explore run for automation.");
      }
      if ((optionalArg(options, "--plan") ?? optionalArg(options, "--input")) === "-") {
        throw new Error("Interactive playground cannot reuse stdin for both a plan and commands. Use P to paste JSON, or load a file with --plan <file>.");
      }
      if (stdin.isTTY !== true || stdout.isTTY !== true) {
        throw new Error(`explore playground requires an interactive terminal. Use ${cliCommandName()} explore validate --plan <file|-> or ${cliCommandName()} explore run --plan <file|->.`);
      }
      return await runInteractivePlayground({
        gateway,
        initialDocument: await optionalPlanDocument(options, dependencies.readFile ?? fs.readFile, stdin),
        initialBoundary: optionalArg(options, "--boundary"),
        stdin,
        stdout,
        stderr,
        color,
      });
    }

    const request = normalizeExplorePlaygroundRequest(
      await requiredPlanDocument(options, dependencies.readFile ?? fs.readFile, stdin),
      optionalArg(options, "--boundary"),
    );
    if (subcommand === "validate") {
      if (!gateway.validate) {
        throw new Error([
          "Remote HTTP validate-only is intentionally unavailable because production MCP exposes exactly app.describe_data and app.explore_data.",
          `Use ${cliCommandName()} explore run --url <mcp-url> --token-env <env> --plan <file>; the server validates the plan before any source query, or validate against the reviewed local project before deployment.`,
        ].join("\n"));
      }
      const result = await gateway.validate(request);
      stdout.write(json
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatPlaygroundValidation(result, gateway, color, stdout.columns));
      return 0;
    }

    const result = await gateway.run(request);
    stdout.write(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatPlaygroundExecution(result, request, gateway, color, options.includes("--details")));
    return result.ok === false ? 1 : 0;
  } catch (error) {
    if (!(error instanceof ScopedExploreError) || json) throw error;
    stderr.write(formatPlaygroundRefusal(error, color, subcommand === "validate"));
    return 1;
  } finally {
    await gateway.close();
  }
}

async function createPlaygroundGateway(
  args: string[],
  dependencies: {
    createRuntime?: typeof createScopedExploreBoundarySetRuntime;
    connectRemote?: typeof connectRemotePlayground;
    env: NodeJS.ProcessEnv;
  },
): Promise<PlaygroundGateway> {
  const remote = await remotePlaygroundSettings(args, dependencies.env);
  if (remote) {
    return await (dependencies.connectRemote ?? connectRemotePlayground)({
      ...remote,
      env: dependencies.env,
    });
  }
  if (optionalArg(args, "--token-env")) {
    throw new Error("--token-env is available only with --url or a production Explore --config.");
  }
  const projectRoot = path.resolve(
    optionalArg(args, "--project-root")
      ?? activeProjectResolutionState.current?.project_root
      ?? process.cwd(),
  );
  const runtime = await (dependencies.createRuntime ?? createScopedExploreBoundarySetRuntime)({
    projectRoot,
    transport: "stdio",
    env: dependencies.env,
  });
  return localPlaygroundGateway(runtime, projectRoot);
}

function localPlaygroundGateway(
  runtime: ExplorePlaygroundRuntime,
  projectRoot: string,
): PlaygroundGateway {
  const scope = describeExplorePlaygroundScope(runtime);
  return {
    target: "local",
    targetLabel: `local reviewed project ${projectRoot}`,
    scopeLabel: scope
      ? [
        `Tenant: ${scope.tenant.source} binding ${scope.tenant.binding}`,
        scope.principal.source === "not_required"
          ? "Principal: not required by the active boundary"
          : `Principal: ${scope.principal.source} binding ${scope.principal.binding ?? "configured"}`,
        "Raw trusted-scope values shown: no",
      ]
      : ["Trusted scope is resolved by Runner and never accepted from plan JSON."],
    describe: (input = {}) => runtime.describe(input),
    validate: (request) => validateExplorePlaygroundRequest(runtime, request),
    run: (request) => runExplorePlaygroundRequest(runtime, request),
    close: () => runtime.close(),
  };
}

export async function connectRemotePlayground(input: {
  url: string;
  tokenEnv: string;
  env: NodeJS.ProcessEnv;
}): Promise<PlaygroundGateway> {
  const token = input.env[input.tokenEnv];
  if (!token) {
    throw new Error(`${input.tokenEnv} is not set. Obtain a short-lived token from the configured identity provider; Runner never issues or refreshes it.`);
  }
  const endpoint = safeRemoteExploreUrl(input.url);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({
    name: "synapsor-runner-explore-plan-playground",
    version: runnerPackage.version,
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  const call = async (name: "app.describe_data" | "app.explore_data", args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const payload = structuredToolPayload(result);
    return payload;
  };
  return {
    target: "remote_http",
    targetLabel: endpoint.toString(),
    scopeLabel: [
      `Bearer token: environment ${input.tokenEnv}`,
      "Tenant and principal: verified JWT claims resolved by the server",
      "Raw trusted-scope values shown: no",
    ],
    describe: (request = {}) => call("app.describe_data", request),
    run: (request) => call("app.explore_data", {
      ...(request.boundary ? { boundary: request.boundary } : {}),
      plan: request.plan,
    }),
    close: () => client.close(),
  };
}

async function remotePlaygroundSettings(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; tokenEnv: string } | undefined> {
  const explicitUrl = optionalArg(args, "--url");
  const configPath = optionalArg(args, "--config");
  let configuredUrl: string | undefined;
  if (configPath) {
    const config = await readRuntimeConfig(configPath);
    if (config.production_explore?.enabled === true) {
      configuredUrl = config.http_security?.oauth_resource?.resource;
      if (!configuredUrl) {
        throw new Error("The production Explore config does not declare http_security.oauth_resource.resource.");
      }
    } else if (!explicitUrl) {
      throw new Error("--config selects remote playback only for a production Explore config. For local playback use --project-root.");
    }
  }
  if (explicitUrl && configuredUrl
    && safeRemoteExploreUrl(explicitUrl).toString() !== safeRemoteExploreUrl(configuredUrl).toString()) {
    throw new Error("--url does not match the production Explore protected resource in --config. Use one exact endpoint.");
  }
  const url = explicitUrl ?? configuredUrl;
  if (!url) return undefined;
  const tokenEnv = optionalArg(args, "--token-env") ?? "SYNAPSOR_MCP_ACCESS_TOKEN";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new Error("--token-env must name an uppercase environment variable using A-Z, 0-9, and underscore.");
  }
  if (!env[tokenEnv]) {
    throw new Error(`${tokenEnv} is not set. No token value may be supplied on the command line.`);
  }
  return { url, tokenEnv };
}

function safeRemoteExploreUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("Explore Plan Playground URLs cannot contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Explore Plan Playground URLs cannot contain query parameters or fragments. Put bearer credentials only in --token-env.");
  }
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Remote Explore Plan Playground requires HTTPS; cleartext HTTP is allowed only on loopback.");
  }
  return url;
}

function structuredToolPayload(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error("The remote MCP server returned an invalid tool result.");
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (isRecord(text)) {
    try {
      const parsed: unknown = JSON.parse(String(text.text));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the bounded refusal below.
    }
  }
  throw new Error("The remote MCP server returned no structured Explore result.");
}

async function requiredPlanDocument(
  args: string[],
  readFile: typeof fs.readFile,
  stdin: NodeJS.ReadStream,
): Promise<unknown> {
  const document = await optionalPlanDocument(args, readFile, stdin);
  if (document === undefined) {
    throw new Error("A plan is required. Use --plan <file|-> or --plan-json '<json>'.");
  }
  return document;
}

async function optionalPlanDocument(
  args: string[],
  readFile: typeof fs.readFile,
  stdin: NodeJS.ReadStream,
): Promise<unknown | undefined> {
  const planPath = optionalArg(args, "--plan") ?? optionalArg(args, "--input");
  const inline = optionalArg(args, "--plan-json");
  if (planPath && inline) throw new Error("Use either --plan/--input or --plan-json, not both.");
  if (!planPath && !inline) return undefined;
  const serialized = inline ?? (planPath === "-"
    ? await readAllStdin(stdin)
    : await readFile(path.resolve(planPath!), "utf8"));
  try {
    return JSON.parse(String(serialized));
  } catch (error) {
    throw new Error(`Explore plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readAllStdin(input: NodeJS.ReadStream): Promise<string> {
  let value = "";
  for await (const chunk of input) value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return value;
}

async function runInteractivePlayground(input: {
  gateway: PlaygroundGateway;
  initialDocument?: unknown;
  initialBoundary?: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  color: boolean;
}): Promise<number> {
  const rl = readline.createInterface({ input: input.stdin, output: input.stdout });
  let document = input.initialDocument;
  let boundary = input.initialBoundary;
  input.stdout.write(formatPlaygroundHeader(input.gateway, input.color));
  try {
    const catalog = await input.gateway.describe({ limit: 10 });
    input.stdout.write(formatPlaygroundCatalog(catalog, input.gateway, input.color));
    input.stdout.write(playgroundHelp(input.gateway.validate !== undefined));
    while (true) {
      const command = (await rl.question("playground> ")).trim();
      const normalized = command.toLowerCase();
      if (normalized === "q" || normalized === "quit" || normalized === "exit") return 0;
      if (normalized === "?" || normalized === "h" || normalized === "help") {
        input.stdout.write(playgroundHelp(input.gateway.validate !== undefined));
        continue;
      }
      if (normalized === "p" || normalized === "paste") {
        input.stdout.write("Paste one JSON plan or MCP envelope. Finish with a line containing only a period.\n");
        const lines: string[] = [];
        while (true) {
          const line = await rl.question("json> ");
          if (line.trim() === ".") break;
          lines.push(line);
        }
        try {
          document = JSON.parse(lines.join("\n"));
          input.stdout.write(`${renderTerminalStyledText("Plan loaded.", input.color, "success")} Use V to validate or R to run.\n`);
        } catch (error) {
          input.stderr.write(`Plan JSON was not loaded: ${safeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
        }
        continue;
      }
      if (normalized === "f" || normalized === "file") {
        const requested = (await rl.question("Plan file: ")).trim();
        try {
          document = JSON.parse(await fs.readFile(path.resolve(requested), "utf8"));
          input.stdout.write(`${renderTerminalStyledText("Plan loaded.", input.color, "success")} Use V to validate or R to run.\n`);
        } catch (error) {
          input.stderr.write(`Plan file was not loaded: ${safeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
        }
        continue;
      }
      if (normalized === "s" || normalized === "show") {
        input.stdout.write(document === undefined
          ? "No plan loaded. Use P to paste or F to load a file.\n"
          : `${renderTerminalJson(document, input.color)}\n`);
        continue;
      }
      if (normalized === "b" || normalized === "boundary") {
        const selected = (await rl.question("Exact active boundary (blank for automatic routing): ")).trim();
        boundary = selected || undefined;
        input.stdout.write(`Boundary selector: ${boundary ?? "automatic from exact resource id"}\n`);
        continue;
      }
      if (normalized === "c" || normalized === "catalog") {
        const catalog = await input.gateway.describe({ ...(boundary ? { boundary } : {}), limit: 10 });
        input.stdout.write(formatPlaygroundCatalog(catalog, input.gateway, input.color));
        continue;
      }
      if (normalized === "v" || normalized === "validate") {
        if (!input.gateway.validate) {
          input.stdout.write("Remote validate-only is unavailable on the fixed two-tool MCP surface. R runs server validation before execution.\n");
          continue;
        }
        if (document === undefined) {
          input.stdout.write("No plan loaded. Use P to paste or F to load a file.\n");
          continue;
        }
        try {
          const request = normalizeExplorePlaygroundRequest(document, boundary);
          const result = await input.gateway.validate(request);
          input.stdout.write(formatPlaygroundValidation(result, input.gateway, input.color, input.stdout.columns));
        } catch (error) {
          input.stderr.write(error instanceof ScopedExploreError
            ? formatPlaygroundRefusal(error, input.color, true)
            : `${safeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
        }
        continue;
      }
      if (normalized === "r" || normalized === "run") {
        if (document === undefined) {
          input.stdout.write("No plan loaded. Use P to paste or F to load a file.\n");
          continue;
        }
        try {
          const request = normalizeExplorePlaygroundRequest(document, boundary);
          const result = await input.gateway.run(request);
          input.stdout.write(formatPlaygroundExecution(result, request, input.gateway, input.color, false));
        } catch (error) {
          input.stderr.write(error instanceof ScopedExploreError
            ? formatPlaygroundRefusal(error, input.color, false)
            : `${safeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
        }
        continue;
      }
      input.stdout.write("Unknown command. Use P paste, F file, V validate, R run, C catalog, B boundary, S show, ? help, or Q quit.\n");
    }
  } finally {
    rl.close();
  }
}

function formatPlaygroundHeader(gateway: PlaygroundGateway, color: boolean): string {
  return [
    renderTerminalSectionHeading("Explore Plan Playground", color),
    "Paste the same fixed JSON plan shape used by app.explore_data. Runner accepts no SQL and no tenant/principal value from this editor.",
    renderTerminalFact("Target", gateway.targetLabel, { color, tone: "identifier" }),
    ...gateway.scopeLabel,
    "",
  ].join("\n");
}

function formatPlaygroundCatalog(
  payload: Record<string, unknown>,
  gateway: PlaygroundGateway,
  color: boolean,
): string {
  const resources = Array.isArray(payload.resources)
    ? payload.resources.filter(isRecord)
    : [];
  const boundaries = Array.isArray(payload.boundaries)
    ? payload.boundaries.filter(isRecord)
    : [];
  return [
    renderTerminalSectionHeading("Reviewed Catalog", color),
    renderTerminalFact("Target", gateway.targetLabel, { color, tone: "identifier", labelTone: "muted" }),
    ...(boundaries.length
      ? [`Active boundaries: ${boundaries.map((item) => String(item.name ?? "unknown")).join(", ")}`]
      : []),
    ...(resources.length
      ? resources.map((resource) => `- ${safeTerminalText(String(resource.id ?? "unknown"))}${resource.boundary_name ? `  [${safeTerminalText(String(resource.boundary_name))}]` : ""}`)
      : [payload.ok === false ? safeTerminalText(String(payload.message ?? "Catalog refused.")) : "No reviewed resources on this page."]),
    payload.next_cursor === null || payload.next_cursor === undefined
      ? ""
      : `More resources: use explore describe --cursor ${safeTerminalText(String(payload.next_cursor))}`,
    "",
  ].join("\n");
}

function formatPlaygroundValidation(
  result: Record<string, unknown>,
  gateway: PlaygroundGateway,
  color: boolean,
  columns?: number,
): string {
  const validation = isRecord(result.validation) ? result.validation : {};
  const parameterized = isRecord(result.parameterized_sql) ? result.parameterized_sql : {};
  const statements = Array.isArray(parameterized.statements)
    ? parameterized.statements.filter(isRecord)
    : [];
  return [
    renderTerminalStyledText("VALIDATED - READY TO RUN", color, "success"),
    renderTerminalFact("Boundary", String(result.boundary_name ?? "unknown"), { color, tone: "identifier" }),
    renderTerminalFact("Boundary digest", String(result.boundary_digest ?? "unknown"), { color, tone: "identifier", labelTone: "muted" }),
    renderTerminalFact("Catalog and authority rechecked", validation.source_catalog_rechecked === true ? "yes" : "unknown", { color, tone: "success" }),
    renderTerminalFact("Source data query executed", validation.source_query_executed === false ? "no" : "unknown", { color, tone: "success" }),
    renderTerminalFact("Explore budget consumed", validation.explore_budget_consumed === false ? "no" : "unknown", { color, tone: "success" }),
    renderTerminalFact("Estimated maximum response cells", String(validation.estimated_response_cells ?? "unknown"), { color }),
    "",
    renderTerminalSectionHeading("Normalized Plan", color),
    renderTerminalJson(result.normalized_plan, color),
    "",
    renderTerminalSectionHeading("Parameterized SQL Preview", color),
    "Parameter values are intentionally absent. This is the exact compiled statement shape, not model-visible SQL.",
    ...statements.map((statement, index) => renderTerminalSqlFrame(String(statement.statement ?? ""), {
      title: statements.length === 1 ? "Compiled read-only statement" : `Compiled statement ${index + 1}`,
      metadata: [
        `Engine: ${String(result.database_engine ?? parameterized.engine ?? "unknown")}`,
        `Parameters: ${String(statement.parameter_count ?? 0)} values withheld`,
      ],
      color,
      columns,
    })),
    "",
    ...gateway.scopeLabel,
    "",
  ].join("\n");
}

function formatPlaygroundExecution(
  result: Record<string, unknown>,
  request: ExplorePlaygroundRequest,
  gateway: PlaygroundGateway,
  color: boolean,
  details: boolean,
): string {
  if (result.ok === false) {
    return [
      renderTerminalStyledText("REFUSED BEFORE RELEASE", color, "danger"),
      safeTerminalText(String(result.error_code ?? "EXPLORE_REFUSED")),
      safeTerminalText(String(result.message ?? "The reviewed server refused this plan.")),
      "Source database changed: no",
      "",
    ].join("\n");
  }
  const audit = isRecord(result.audit) ? result.audit : {};
  const privacy = isRecord(result.privacy) ? result.privacy : {};
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  const lines = [
    renderTerminalStyledText("EXECUTED - REVIEWED RESULT RELEASED", color, "success"),
    renderTerminalFact("Target", gateway.targetLabel, { color, tone: "identifier", labelTone: "muted" }),
    renderTerminalFact("Boundary", String(result.boundary_name ?? request.boundary ?? "automatic reviewed route"), { color, tone: "identifier" }),
    renderTerminalFact("Resource", String(request.plan.resource ?? "unknown"), { color, tone: "identifier" }),
    renderTerminalFact("Source query executed", "yes", { color, tone: "success" }),
    renderTerminalFact("Source database changed", result.source_database_changed === false ? "no" : "unknown", { color, tone: "success" }),
    "",
    renderTerminalSectionHeading("Result", color),
    renderResultTable(rows),
    "",
    renderTerminalSectionHeading("Privacy And Audit", color),
    renderTerminalFact("Returned rows/groups", String(audit.returned_rows_or_groups ?? rows.length), { color }),
    renderTerminalFact("Returned cells", String(audit.returned_cells ?? "unknown"), { color }),
    renderTerminalFact("Suppressed groups", String(privacy.suppressed_groups ?? 0), {
      color,
      tone: Number(privacy.suppressed_groups ?? 0) > 0 ? "warning" : "success",
    }),
    renderTerminalFact("Evidence", String(result.evidence_bundle_id ?? audit.evidence_bundle_id ?? "recorded by remote server"), { color, tone: "identifier" }),
    "Trusted scope came from Runner configuration or verified JWT claims, never this plan.",
    "Returned database text is untrusted data, not instructions or authority.",
  ];
  if (details) {
    lines.push(
      "",
      renderTerminalSectionHeading("Operator Details", color),
      renderTerminalJson({
        normalized_input: request,
        outcome: result.outcome,
        privacy: result.privacy,
        audit: result.audit,
        operator_budget: result.operator_budget,
        operator_time_windows: result.operator_time_windows,
      }, color),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderResultTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no released rows or groups)";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const display = rows.map((row) => columns.map((column) => terminalCell(row[column])));
  const widths = columns.map((column, index) => Math.min(40, Math.max(
    column.length,
    ...display.map((row) => row[index]?.length ?? 0),
  )));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const line = (cells: string[]) => `|${cells.map((cell, index) => ` ${fitCell(cell, widths[index] ?? 1)} `).join("|")}|`;
  const truncated = display.some((row) => row.some((cell, index) => cell.length > (widths[index] ?? 1)));
  return [
    border,
    line(columns.map(safeTerminalCellText)),
    border,
    ...display.map(line),
    border,
    ...(truncated ? ["Some cells are shortened for terminal display; use --json for exact released values."] : []),
  ].join("\n");
}

function terminalCell(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return safeTerminalCellText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeTerminalCellText(JSON.stringify(value) ?? "null");
}

function fitCell(value: string, width: number): string {
  const shown = value.length > width
    ? `${value.slice(0, Math.max(1, width - 3))}...`
    : value;
  return shown.padEnd(width, " ");
}

function formatPlaygroundRefusal(
  error: ScopedExploreError,
  color: boolean,
  validationOnly: boolean,
): string {
  const sourceQueryExecuted = validationOnly
    ? "no"
    : error.details?.source_query_executed === true
      ? "yes; no result was released"
      : error.details?.source_query_executed === false
        ? "no"
        : "not stated by this refusal; no result was released";
  return [
    renderTerminalStyledText("RUNNER REFUSED THIS PLAN", color, "danger"),
    `${safeTerminalText(error.code)} - ${safeTerminalText(error.message)}`,
    `Source query executed: ${sourceQueryExecuted}`,
    ...(validationOnly ? ["Explore budget consumed: no"] : []),
    "Source database changed: no",
    "",
  ].join("\n");
}

function playgroundHelp(validateAvailable: boolean): string {
  return [
    "Commands:",
    "  P paste JSON   F load file   S show plan   C catalog   B boundary",
    `  ${validateAvailable ? "V validate only   " : ""}R run plan   ? help   Q quit`,
    "Validation never queries source rows or consumes Explore budget. Run uses the normal app.explore_data enforcement path.",
    "",
  ].join("\n");
}

function integerOption(args: string[], name: string, minimum: number): number {
  const value = Number(optionalArg(args, name));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
