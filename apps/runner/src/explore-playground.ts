import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import runnerPackage from "../package.json" with { type: "json" };
import { loadBoundaryReviewContext } from "./boundary-commands.js";
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
import { resolveSynapsorProject } from "./project-resolution.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import {
  readTerminalTextWithEscape,
  withAlternateTerminalScreen,
  withRawTerminalScreen,
  withTerminalProgress,
  type TerminalKeypress,
} from "./terminal-prompt.js";
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
import { ui } from "./ui-command.js";

type PlaygroundGateway = {
  target: "local" | "remote_http";
  targetLabel: string;
  scopeLabel: string[];
  describe(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  validate?: (request: ExplorePlaygroundRequest) => Promise<Record<string, unknown>>;
  run(request: ExplorePlaygroundRequest): Promise<Record<string, unknown>>;
  sqlForEvidence?: (evidenceId: string) => Promise<Record<string, unknown> | undefined>;
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
  openWorkbench?: typeof ui;
  readEvidenceSql?: typeof readLocalEvidenceSql;
  resolveWorkbenchProject?: typeof resolveExplorePlaygroundWorkbenchProject;
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

const PLAYGROUND_WORKBENCH_OPTIONS = new Set([
  "--project-root",
  "--config",
  "--store",
  "--host",
  "--port",
  "--no-open",
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
  if (!new Set(["playground", "workbench", "run", "validate", "describe"]).has(subcommand)) {
    throw new Error("explore accepts playground, workbench, run, validate, or describe.");
  }
  if (subcommand === "workbench") {
    assertKnownOptions(options, PLAYGROUND_WORKBENCH_OPTIONS, "explore workbench");
    return openExplorePlaygroundWorkbench(options, {
      env: dependencies.env ?? process.env,
      openWorkbench: dependencies.openWorkbench ?? ui,
      resolveProject: dependencies.resolveWorkbenchProject ?? resolveExplorePlaygroundWorkbenchProject,
    });
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
    readEvidenceSql: dependencies.readEvidenceSql,
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
    readEvidenceSql?: typeof readLocalEvidenceSql;
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
  const project = await resolveSynapsorProject(projectRoot, dependencies.env);
  const runtime = await (dependencies.createRuntime ?? createScopedExploreBoundarySetRuntime)({
    projectRoot,
    transport: "stdio",
    env: dependencies.env,
  });
  return localPlaygroundGateway(
    runtime,
    projectRoot,
    project?.store_path ?? path.join(projectRoot, ".synapsor/local.db"),
    dependencies.readEvidenceSql ?? readLocalEvidenceSql,
  );
}

function localPlaygroundGateway(
  runtime: ExplorePlaygroundRuntime,
  projectRoot: string,
  storePath: string,
  readEvidenceSql: typeof readLocalEvidenceSql,
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
    sqlForEvidence: (evidenceId) => readEvidenceSql(storePath, evidenceId),
    close: () => runtime.close(),
  };
}

async function openExplorePlaygroundWorkbench(
  args: string[],
  dependencies: {
    env: NodeJS.ProcessEnv;
    openWorkbench: typeof ui;
    resolveProject: typeof resolveExplorePlaygroundWorkbenchProject;
  },
): Promise<number> {
  const projectRoot = path.resolve(
    optionalArg(args, "--project-root")
      ?? activeProjectResolutionState.current?.project_root
      ?? process.cwd(),
  );
  const project = await dependencies.resolveProject(projectRoot, dependencies.env);
  const configPath = optionalArg(args, "--config")
    ?? project.configPath
    ?? path.join(projectRoot, "synapsor.runner.json");
  const storePath = optionalArg(args, "--store")
    ?? project.storePath
    ?? path.join(projectRoot, ".synapsor/local.db");
  return dependencies.openWorkbench([
    ...(args.includes("--no-open") ? [] : ["--open"]),
    "--playground",
    "--boundary-root",
    project.boundaryRoot,
    "--config",
    configPath,
    "--store",
    storePath,
    ...(optionalArg(args, "--host") ? ["--host", optionalArg(args, "--host")!] : []),
    ...(optionalArg(args, "--port") ? ["--port", optionalArg(args, "--port")!] : []),
  ]);
}

async function resolveExplorePlaygroundWorkbenchProject(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ boundaryRoot: string; configPath?: string; storePath?: string }> {
  const project = await resolveSynapsorProject(projectRoot, env);
  const review = await loadBoundaryReviewContext(projectRoot);
  return {
    boundaryRoot: review.boundaryRoot,
    configPath: project?.config_path,
    storePath: project?.store_path,
  };
}

async function readLocalEvidenceSql(
  storePath: string,
  evidenceId: string,
): Promise<Record<string, unknown> | undefined> {
  const store = new ProposalStore(storePath);
  try {
    const evidence = store.getEvidenceBundle(evidenceId);
    if (!evidence || !isRecord(evidence.payload) || !isRecord(evidence.payload.parameterized_sql)) {
      return undefined;
    }
    return {
      source: "captured_parameterized_sql",
      evidence_bundle_id: evidence.evidence_bundle_id,
      boundary_digest: evidence.payload.boundary_digest,
      normalized_plan: evidence.payload.normalized_plan,
      parameterized_sql: evidence.payload.parameterized_sql,
    };
  } finally {
    store.close();
  }
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
  const terminalInput = input.stdin as unknown as ReadStream;
  const terminalOutput = input.stdout as unknown as WriteStream;
  const state: InteractivePlaygroundState = {
    document: input.initialDocument,
    boundary: input.initialBoundary,
    pendingKeys: [],
    selectedAction: input.initialDocument === undefined
      ? "paste"
      : input.gateway.validate ? "validate" : "run",
    message: input.initialDocument === undefined
      ? "Paste a plan to begin. Esc returns to this menu."
      : "Plan loaded from the command line.",
  };

  return withAlternateTerminalScreen(terminalOutput, async () => {
    if (state.document === undefined) {
      await pasteInteractivePlan(state, terminalInput, terminalOutput, input.color);
    }
    while (true) {
      const action = await choosePlaygroundAction({
        gateway: input.gateway,
        state,
        input: terminalInput,
        output: terminalOutput,
        color: input.color,
      });
      state.selectedAction = action;
      if (action === "quit") return 0;

      if (action === "paste") {
        await pasteInteractivePlan(state, terminalInput, terminalOutput, input.color);
        continue;
      }
      if (action === "file") {
        const requested = await readTerminalTextWithEscape(
          "LOAD JSON PLAN\nPath [Esc Back]: ",
          terminalInput,
          terminalOutput,
        );
        if (requested === undefined) {
          state.message = "File selection cancelled. The loaded plan is unchanged.";
          continue;
        }
        try {
          state.document = JSON.parse(await fs.readFile(path.resolve(requested), "utf8"));
          state.lastSql = undefined;
          state.lastEvidenceId = undefined;
          state.message = `Plan loaded from ${requested}.`;
        } catch (error) {
          state.message = "Plan file was not loaded.";
          await showPlaygroundPage({
            title: "PLAN FILE NOT LOADED",
            content: safeTerminalText(error instanceof Error ? error.message : String(error)),
            input: terminalInput,
            output: terminalOutput,
          });
        }
        continue;
      }
      if (action === "boundary") {
        const selected = await readTerminalTextWithEscape(
          [
            "SELECT ACTIVE BOUNDARY",
            "Leave blank for automatic routing from the exact resource ID.",
            `Current: ${state.boundary ?? "automatic"}`,
            "Boundary [Esc Back]: ",
          ].join("\n"),
          terminalInput,
          terminalOutput,
        );
        if (selected === undefined) {
          state.message = "Boundary selection cancelled.";
          continue;
        }
        state.boundary = selected || undefined;
        state.lastSql = undefined;
        state.lastEvidenceId = undefined;
        state.message = `Boundary: ${state.boundary ?? "automatic from exact resource ID"}.`;
        continue;
      }
      if (action === "catalog") {
        try {
          const catalog = await withTerminalProgress(
            terminalOutput,
            "Loading the reviewed catalog",
            () => input.gateway.describe({
              ...(state.boundary ? { boundary: state.boundary } : {}),
              limit: 25,
            }),
          );
          await showPlaygroundPage({
            title: "REVIEWED CATALOG",
            content: formatPlaygroundCatalog(catalog, input.gateway, input.color),
            input: terminalInput,
            output: terminalOutput,
          });
          state.message = "Reviewed catalog inspected. No source rows were queried.";
        } catch (error) {
          await showPlaygroundError(error, false, terminalInput, terminalOutput, input.color);
          state.message = "Catalog lookup was refused.";
        }
        continue;
      }
      if (action === "json") {
        await showPlaygroundPage({
          title: "LOADED JSON PLAN",
          content: state.document === undefined
            ? "No plan is loaded. Press P to paste formatted JSON or F to load a file."
            : renderTerminalJson(state.document, input.color),
          input: terminalInput,
          output: terminalOutput,
        });
        continue;
      }
      if (action === "sql") {
        await showPlaygroundPage({
          title: "LAST COMPILED SQL",
          content: formatInteractivePlaygroundSql(state, input.gateway, input.color, input.stdout.columns),
          input: terminalInput,
          output: terminalOutput,
        });
        continue;
      }
      if (action === "help") {
        await showPlaygroundPage({
          title: "PLAYGROUND HELP",
          content: playgroundHelp(input.gateway.validate !== undefined),
          input: terminalInput,
          output: terminalOutput,
        });
        continue;
      }
      if (state.document === undefined) {
        state.message = "No plan is loaded. Press P to paste formatted JSON or F to load a file.";
        continue;
      }

      const request = normalizeExplorePlaygroundRequest(state.document, state.boundary);
      if (action === "validate") {
        if (!input.gateway.validate) {
          state.message = "Remote validate-only is unavailable; Run performs server validation before execution.";
          continue;
        }
        try {
          const result = await withTerminalProgress(
            terminalOutput,
            "Rechecking catalog, authority, trusted scope, and read-only SQL",
            () => input.gateway.validate!(request),
          );
          state.lastSql = result;
          state.lastEvidenceId = undefined;
          state.message = "SQL preview ready. No source rows queried and no Explore budget consumed.";
          await showPlaygroundPage({
            title: "PARAMETERIZED SQL PREVIEW",
            content: formatPlaygroundValidation(result, input.gateway, input.color, input.stdout.columns),
            input: terminalInput,
            output: terminalOutput,
          });
        } catch (error) {
          state.message = "Runner refused validation. No source rows were queried.";
          await showPlaygroundError(error, true, terminalInput, terminalOutput, input.color);
        }
        continue;
      }

      try {
        const execution = await withTerminalProgress(
          terminalOutput,
          "Validating and running through the reviewed Explore boundary",
          async () => {
            const result = await input.gateway.run(request);
            const evidenceId = evidenceIdFromResult(result);
            const sql = evidenceId && input.gateway.sqlForEvidence
              ? await input.gateway.sqlForEvidence(evidenceId)
              : undefined;
            return { result, evidenceId, sql };
          },
        );
        const { result } = execution;
        state.lastEvidenceId = execution.evidenceId;
        state.lastSql = execution.sql;
        state.message = result.ok === false
          ? "Runner refused the plan. No result was released."
          : "Reviewed result released. Press S for captured SQL or J for the plan.";
        await showPlaygroundPage({
          title: "RUN RESULT",
          content: formatPlaygroundExecution(result, request, input.gateway, input.color, false),
          input: terminalInput,
          output: terminalOutput,
        });
      } catch (error) {
        state.message = "Runner refused the plan. No result was released.";
        await showPlaygroundError(error, false, terminalInput, terminalOutput, input.color);
      }
    }
  });
}

type PlaygroundAction =
  | "paste"
  | "file"
  | "catalog"
  | "boundary"
  | "validate"
  | "run"
  | "sql"
  | "json"
  | "help"
  | "quit";

type InteractivePlaygroundState = {
  document?: unknown;
  boundary?: string;
  pendingKeys: TerminalKeypress[];
  selectedAction: PlaygroundAction;
  message: string;
  lastSql?: Record<string, unknown>;
  lastEvidenceId?: string;
};

type PlaygroundActionItem = {
  action: PlaygroundAction;
  key: string;
  label: string;
  detail: string;
};

async function choosePlaygroundAction(input: {
  gateway: PlaygroundGateway;
  state: InteractivePlaygroundState;
  input: ReadStream;
  output: WriteStream;
  color: boolean;
}): Promise<PlaygroundAction> {
  const actions: PlaygroundActionItem[] = [
    { action: "paste", key: "P", label: "Paste or replace JSON", detail: "formatted multiline JSON loads automatically" },
    { action: "file", key: "F", label: "Load JSON file", detail: "read one plan or MCP envelope" },
    { action: "catalog", key: "C", label: "Reviewed catalog", detail: "inspect exact available resource IDs" },
    { action: "boundary", key: "B", label: "Boundary routing", detail: input.state.boundary ?? "automatic from exact resource ID" },
    ...(input.gateway.validate
      ? [{ action: "validate" as const, key: "V", label: "Preview parameterized SQL", detail: "compile with values withheld; no rows queried or budget spent" }]
      : []),
    { action: "run", key: "R", label: "Run reviewed plan", detail: "normal scope, privacy, budget, and evidence path" },
    {
      action: "sql",
      key: "S",
      label: "Show last SQL",
      detail: input.state.lastSql
        ? "captured parameterized statement; values withheld"
        : input.state.lastEvidenceId
          ? "inspect the server-side evidence record"
          : "available after local validation or execution",
    },
    { action: "json", key: "J", label: "Show loaded JSON", detail: input.state.document === undefined ? "no plan loaded" : planDocumentSummary(input.state.document) },
    { action: "help", key: "?", label: "Help", detail: "input shape, navigation, and safety" },
    { action: "quit", key: "Q", label: "Exit playground", detail: "return to the terminal" },
  ];
  let selected = Math.max(0, actions.findIndex((item) => item.action === input.state.selectedAction));
  return withRawTerminalScreen(input.input, input.output, async (nextKey, render) => {
    while (true) {
      const planStatus = input.state.document === undefined
        ? renderTerminalStyledText("not loaded", input.color, "warning")
        : `${renderTerminalStyledText("loaded", input.color, "success")} - ${planDocumentSummary(input.state.document)}`;
      render([
        renderTerminalSectionHeading("Explore Plan Playground", input.color),
        `Target: ${safeTerminalText(input.gateway.targetLabel)}`,
        `Plan: ${planStatus}`,
        `Boundary: ${safeTerminalText(input.state.boundary ?? "automatic")}`,
        `Status: ${safeTerminalText(input.state.message)}`,
        "",
        ...actions.map((item, index) =>
          `${index === selected ? ">" : " "} [${item.key}] ${item.label} - ${item.detail}`),
        "",
        "Up/Down Move   Enter Open   Letter shortcuts   Esc/Q Exit",
      ]);
      const key = input.state.pendingKeys.shift() ?? await nextKey();
      if (isTerminalExitKey(key)) return "quit";
      if (key.name === "up") {
        selected = (selected - 1 + actions.length) % actions.length;
        continue;
      }
      if (key.name === "down") {
        selected = (selected + 1) % actions.length;
        continue;
      }
      if (isTerminalEnterKey(key)) return actions[selected]!.action;
      const shortcut = terminalShortcut(key);
      const matched = actions.find((item) => item.key.toLowerCase() === shortcut);
      if (matched) return matched.action;
    }
  });
}

async function pasteInteractivePlan(
  state: InteractivePlaygroundState,
  input: ReadStream,
  output: WriteStream,
  color: boolean,
): Promise<void> {
  try {
    const document = await readMultilinePlaygroundJson(input, output, state.pendingKeys);
    if (document === undefined) {
      state.message = state.document === undefined
        ? "Paste cancelled. No plan is loaded."
        : "Paste cancelled. The loaded plan is unchanged.";
      return;
    }
    state.document = document;
    state.lastSql = undefined;
    state.lastEvidenceId = undefined;
    state.selectedAction = "run";
    state.message = `${renderTerminalStyledText("Plan loaded.", color, "success")} Validate or run when ready.`;
  } catch (error) {
    state.message = "Plan JSON was not loaded.";
    await showPlaygroundPage({
      title: "JSON NOT LOADED",
      content: [
        safeTerminalText(error instanceof Error ? error.message : String(error)),
        "",
        "Press P to paste again. Formatted multiline JSON is supported.",
      ].join("\n"),
      input,
      output,
    });
  }
}

async function readMultilinePlaygroundJson(
  input: ReadStream,
  output: WriteStream,
  pendingKeys: TerminalKeypress[],
): Promise<unknown | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive JSON paste requires a real terminal.");
  }
  output.write([
    "PASTE EXPLORE JSON",
    "Paste one formatted plan or MCP envelope. It loads automatically when the JSON is complete.",
    "Esc cancels. A line containing only . can still finish input manually.",
    "",
  ].join("\n"));
  readline.emitKeypressEvents(input);
  const rl = readline.createInterface({ input, output, terminal: true, prompt: "json> " });
  return new Promise<unknown | undefined>((resolve, reject) => {
    const lines: string[] = [];
    let settled = false;
    let bracketedPasteActive = false;
    let handoffKeyHandled = false;
    const captureTrailingKeypress = (_text: string, key: TerminalKeypress) => {
      if (isBracketedPasteStartKey(key)) {
        bracketedPasteActive = true;
        return;
      }
      if (isBracketedPasteEndKey(key)) {
        bracketedPasteActive = false;
        return;
      }
      if (bracketedPasteActive || handoffKeyHandled) return;
      handoffKeyHandled = true;
      if (isPlaygroundHandoffKey(key)) pendingKeys.push(key);
    };
    const finish = (value: unknown | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      input.off("keypress", onKeypress);
      rl.off("line", onLine);
      rl.off("close", onClose);
      rl.close();
      const settle = () => {
        if (error) reject(error);
        else resolve(value);
      };
      if (value === undefined || error) {
        settle();
        return;
      }
      // A terminal can deliver the final JSON newline and the first menu key
      // in one input burst. Keep that key while readline releases stdin so the
      // raw menu receives it instead of requiring a second keypress.
      input.on("keypress", captureTrailingKeypress);
      setImmediate(() => {
        input.off("keypress", captureTrailingKeypress);
        settle();
      });
    };
    const parse = () => {
      const serialized = lines.join("\n").trim();
      if (!serialized) return finish(undefined);
      try {
        finish(JSON.parse(serialized));
      } catch (error) {
        finish(undefined, new Error(`Explore plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    const onLine = (line: string) => {
      if (line.trim() === ".") {
        parse();
        return;
      }
      lines.push(line);
      if (jsonDocumentComplete(lines.join("\n"))) {
        parse();
        return;
      }
      rl.prompt();
    };
    const onClose = () => {
      if (settled) return;
      if (lines.length) parse();
      else finish(undefined);
    };
    const onKeypress = (_text: string, key: TerminalKeypress) => {
      if (isBracketedPasteStartKey(key)) {
        bracketedPasteActive = true;
        return;
      }
      if (isBracketedPasteEndKey(key)) {
        bracketedPasteActive = false;
        return;
      }
      if (key.name !== "escape" && key.sequence !== "\u001b") return;
      output.write("\n");
      finish(undefined);
    };
    input.on("keypress", onKeypress);
    rl.on("line", onLine);
    rl.on("close", onClose);
    rl.prompt();
  });
}

function isBracketedPasteStartKey(key: TerminalKeypress): boolean {
  return key.sequence === "\u001b[200~" || key.name === "paste-start";
}

function isBracketedPasteEndKey(key: TerminalKeypress): boolean {
  return key.sequence === "\u001b[201~" || key.name === "paste-end";
}

function isPlaygroundHandoffKey(key: TerminalKeypress): boolean {
  return isTerminalExitKey(key)
    || isTerminalEnterKey(key)
    || key.name === "up"
    || key.name === "down"
    || ["p", "f", "c", "b", "v", "r", "s", "j", "?"].includes(terminalShortcut(key));
}

function jsonDocumentComplete(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let rootStarted = false;
  let rootClosed = false;
  for (const character of trimmed) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (rootClosed && !/\s/u.test(character)) return true;
    if (character === "{" || character === "[") {
      rootStarted = true;
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      if (!stack.length) return true;
      const opened = stack.pop();
      if ((opened === "{" && character !== "}") || (opened === "[" && character !== "]")) return true;
      if (rootStarted && !stack.length) rootClosed = true;
    }
  }
  return rootStarted && rootClosed && !inString && stack.length === 0;
}

async function showPlaygroundError(
  error: unknown,
  validationOnly: boolean,
  input: ReadStream,
  output: WriteStream,
  color: boolean,
): Promise<void> {
  await showPlaygroundPage({
    title: "RUNNER REFUSAL",
    content: error instanceof ScopedExploreError
      ? formatPlaygroundRefusal(error, color, validationOnly)
      : safeTerminalText(error instanceof Error ? error.message : String(error)),
    input,
    output,
  });
}

async function showPlaygroundPage(input: {
  title: string;
  content: string;
  input: ReadStream;
  output: WriteStream;
}): Promise<void> {
  const width = Math.min(terminalContentWidth(input.output.columns), 116);
  const wrapped = input.content
    .split("\n")
    .flatMap((line) => wrapStyledTerminalLine(line, width));
  const bodyRows = Math.max(3, Math.floor(input.output.rows ?? 24) - 5);
  let offset = 0;
  await withRawTerminalScreen(input.input, input.output, async (nextKey, render) => {
    while (true) {
      const maximumOffset = Math.max(0, wrapped.length - bodyRows);
      offset = Math.max(0, Math.min(offset, maximumOffset));
      const end = Math.min(wrapped.length, offset + bodyRows);
      render([
        input.title,
        wrapped.length > bodyRows ? `Lines ${offset + 1}-${end} of ${wrapped.length}` : "",
        ...wrapped.slice(offset, end),
        "",
        "Up/Down Scroll   PgUp/PgDn Page   Home/End Jump   Esc/Enter Back",
      ]);
      const key = await nextKey();
      if (key.name === "escape" || key.name === "left" || key.name === "backspace" || isTerminalEnterKey(key)) return;
      if (key.name === "up") offset -= 1;
      else if (key.name === "down") offset += 1;
      else if (key.name === "pageup") offset -= bodyRows;
      else if (key.name === "pagedown" || key.name === "space") offset += bodyRows;
      else if (key.name === "home") offset = 0;
      else if (key.name === "end") offset = maximumOffset;
      else if (terminalShortcut(key) === "q") return;
    }
  });
}

function isTerminalExitKey(key: TerminalKeypress): boolean {
  return key.name === "escape"
    || (key.ctrl === true && (key.name === "c" || key.name === "d"))
    || terminalShortcut(key) === "q";
}

function isTerminalEnterKey(key: TerminalKeypress): boolean {
  return key.name === "return"
    || key.name === "enter"
    || key.sequence === "\r"
    || key.sequence === "\n";
}

function terminalShortcut(key: TerminalKeypress): string {
  const value = key.name?.length === 1 ? key.name : key.sequence;
  return typeof value === "string" && value.length === 1 ? value.toLowerCase() : "";
}

function planDocumentSummary(document: unknown): string {
  if (!isRecord(document)) return "invalid non-object input";
  const plan = isRecord(document.plan) ? document.plan : document;
  const kind = typeof plan.kind === "string" ? plan.kind : "unknown plan";
  const resource = typeof plan.resource === "string" ? plan.resource : "resource not selected";
  return `${kind} on ${resource}`;
}

function evidenceIdFromResult(result: Record<string, unknown>): string | undefined {
  if (typeof result.evidence_bundle_id === "string") return result.evidence_bundle_id;
  const audit = isRecord(result.audit) ? result.audit : undefined;
  return typeof audit?.evidence_bundle_id === "string" ? audit.evidence_bundle_id : undefined;
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

function formatInteractivePlaygroundSql(
  state: InteractivePlaygroundState,
  gateway: PlaygroundGateway,
  color: boolean,
  columns?: number,
): string {
  const captured = state.lastSql;
  const parameterized = captured && isRecord(captured.parameterized_sql)
    ? captured.parameterized_sql
    : undefined;
  const statements = parameterized && Array.isArray(parameterized.statements)
    ? parameterized.statements.filter(isRecord)
    : [];
  if (statements.length) {
    const source = captured?.source === "captured_parameterized_sql"
      ? "Captured from the evidence bundle written for the last execution."
      : "Compiled by validate-only for the currently loaded plan; no source query ran.";
    return [
      renderTerminalStyledText(
        captured?.source === "captured_parameterized_sql"
          ? "SQL CAPTURED FOR THE LAST RUN"
          : "VALIDATED SQL PREVIEW",
        color,
        "success",
      ),
      source,
      "Parameter values are intentionally absent. SQL and parameters were never exposed to the model.",
      ...(state.lastEvidenceId
        ? [renderTerminalFact("Evidence", state.lastEvidenceId, { color, tone: "identifier" })]
        : []),
      "",
      ...statements.map((statement, index) => renderTerminalSqlFrame(String(statement.statement ?? ""), {
        title: statements.length === 1 ? "Parameterized read-only statement" : `Parameterized statement ${index + 1}`,
        metadata: [
          `Engine: ${String(parameterized!.engine ?? captured?.database_engine ?? "unknown")}`,
          `Parameters: ${String(statement.parameter_count ?? 0)} values withheld`,
        ],
        color,
        columns,
      })),
    ].join("\n");
  }
  if (gateway.target === "remote_http") {
    return [
      "Production MCP deliberately does not return operator SQL to the client.",
      state.lastEvidenceId
        ? `The last run wrote evidence ${state.lastEvidenceId}. On the Runner host, inspect it with:`
        : "Run a plan first, then inspect its evidence on the Runner host:",
      `${cliCommandName()} evidence show ${state.lastEvidenceId ?? "<evidence-id>"} --details --config ./synapsor.runner.json`,
      "This keeps the production MCP surface model-safe while preserving exact operator audit evidence.",
    ].join("\n");
  }
  return [
    "No compiled SQL is available yet.",
    "Use V to validate without querying source rows, or R to execute and capture the exact parameterized statement in evidence.",
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
    renderTerminalSectionHeading("Normalized Plan", color),
    renderTerminalJson(result.normalized_plan, color),
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
    "Navigation:",
    "  Up/Down move   Enter open   Esc back or exit",
    "  P paste JSON   F load file   C catalog   B boundary",
    `  ${validateAvailable ? "V preview SQL   " : ""}R run plan   S last SQL   J loaded JSON   ? help   Q quit`,
    "",
    "Formatted JSON:",
    "  With no plan loaded, paste immediately. The editor detects the closing object and loads it automatically.",
    "  P replaces the plan. Esc cancels without changing it. A line containing only . remains an optional manual finish.",
    "",
    "Result screens:",
    "  Up/Down or PgUp/PgDn scroll. Esc or Enter returns to the action menu.",
    "",
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
