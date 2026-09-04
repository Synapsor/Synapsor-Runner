import readline from "node:readline";
import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { terminalTheme } from "./boundary-cli-picker.js";
import { cliCommandName } from "./cli-command-meta.js";
import {
  createInPlaceTerminalRenderer,
  readTerminalTextWithEscape,
} from "./terminal-prompt.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";
import {
  padTerminalBlock,
  padTerminalLine,
  terminalContentWidth,
  wrapStyledTerminalLine,
} from "./terminal-layout.js";
import {
  DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL,
  DEFAULT_TERMINAL_OPENAI_ASK_MODEL,
} from "./terminal-ask-defaults.js";
import { discoverOpenAiCompatibleModels } from "./openai-compatible-models.js";
import { guidedActionStatus } from "./guided-action.js";
import { loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { mcp } from "./mcp-project.js";
import type { ManagedMcpProjectClient } from "./managed-mcp-project.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";

export { discoverOpenAiCompatibleModels } from "./openai-compatible-models.js";

export type PostActivationAskRoute =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "mcp-client"
  | "mcp-http"
  | "later";

export type PostActivationAskSelection =
  | {
      route: "openai";
      model: string;
    }
  | {
      route: "anthropic";
      model: string;
    }
  | {
      route: "openai-compatible";
      model: string;
      baseUrl: string;
    }
  | {
      route: "mcp-client";
      client: ManagedMcpProjectClient;
    }
  | {
      route: "mcp-http";
    }
  | {
      route: "later";
    };

export type PostActivationAskDependencies = {
  chooseRoute?: (
    defaultRoute: PostActivationAskRoute,
  ) => Promise<PostActivationAskRoute | undefined>;
  promptWithDefault?: (
    prompt: string,
    defaultValue: string,
  ) => Promise<string | undefined>;
  listOpenAiCompatibleModels?: (baseUrl: string) => Promise<string[]>;
  chooseMcpClient?: () => Promise<ManagedMcpProjectClient | undefined>;
  hasActiveActions?: (projectRoot: string) => Promise<boolean>;
  runMcpInstall?: (args: string[]) => Promise<number>;
  runAsk?: (
    args: string[],
    options?: { consentOnFirstQuestion?: boolean },
  ) => Promise<number>;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  stderr?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
};

type RouteOption = {
  id: PostActivationAskRoute;
  label: string;
  detail: string;
};

type McpClientPickerKey = {
  name?: string;
  ctrl?: boolean;
};

type McpClientPickerTransition = {
  selected: number;
  client?: ManagedMcpProjectClient;
  cancelled?: true;
};

const managedMcpClientOptions: Array<{
  id: ManagedMcpProjectClient;
  label: string;
  detail: string;
}> = [
  { id: "claude-code", label: "Claude Code", detail: "Project-scoped .mcp.json" },
  { id: "cursor", label: "Cursor", detail: "Project-scoped .cursor/mcp.json" },
  { id: "vscode", label: "VS Code", detail: "Project-scoped .vscode/mcp.json" },
];

const routeOptions: RouteOption[] = [
  {
    id: "openai",
    label: "OpenAI",
    detail: `Start the terminal chat with ${DEFAULT_TERMINAL_OPENAI_ASK_MODEL}`,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    detail: "Start the terminal chat with Claude Sonnet",
  },
  {
    id: "openai-compatible",
    label: "Local model",
    detail: "Use a loopback OpenAI-compatible endpoint",
  },
  {
    id: "mcp-client",
    label: "Local stdio MCP",
    detail: "Choose Claude Code, Cursor, or VS Code next",
  },
  {
    id: "mcp-http",
    label: "Production HTTP MCP",
    detail: "OAuth/JWT, TLS, and shared accounting deployment steps",
  },
  {
    id: "later",
    label: "Later",
    detail: "Leave the reviewed boundary active and return to the shell",
  },
];

export async function runPostActivationAskHandoff(
  input: {
    projectRoot: string;
    includeActions?: boolean;
    autoStartConfiguredProvider?: boolean;
    consentOnFirstQuestion?: boolean;
    requestTimeoutSeconds?: number;
    sessionTokenBudget?: number;
    maxOutputTokens?: number;
    selection?: PostActivationAskSelection;
  },
  dependencies: PostActivationAskDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const write = (value: string) => stdout.write(
    stdout.isTTY === true ? padTerminalBlock(value) : value,
  );
  const theme = terminalTheme(stdout.isTTY === true && !("NO_COLOR" in env));
  const configuredSelection = input.autoStartConfiguredProvider
    ? soleConfiguredHostedSelection(env)
    : undefined;
  const selection = input.selection
    ?? configuredSelection
    ?? await choosePostActivationAskSelection(dependencies);
  if (!selection) {
    write([
      "Model selection cancelled. Your reviewed boundaries remain active.",
      `Resume: ${cliCommandName()} try ask --project-root ${shellToken(input.projectRoot)}`,
      "",
    ].join("\n"));
    return 0;
  }
  const route = selection.route;

  if (route === "later") {
    write([
      "Your reviewed boundaries remain active.",
      `Start the terminal chat later: ${cliCommandName()} try ask ` +
        `--project-root ${shellToken(input.projectRoot)} ` +
        `--provider openai --model ${DEFAULT_TERMINAL_OPENAI_ASK_MODEL}`,
      "",
    ].join("\n"));
    return 0;
  }

  if (route === "mcp-client") {
    const includeActions = input.includeActions
      ?? await (dependencies.hasActiveActions ?? hasActiveActionRuntime)(input.projectRoot);
    const installArgs = [
      "install", selection.client,
      "--project", "--authoring",
      "--project-root", input.projectRoot,
      ...(includeActions ? ["--include-actions"] : []),
    ];
    try {
      const code = await (dependencies.runMcpInstall ?? mcp)(installArgs);
      if (code !== 0) return code;
      const runtimeBindings = await reviewedRuntimeBindingNames(input.projectRoot).catch(() => []);
      write(formatMcpClientHandoff(
        input.projectRoot,
        selection.client,
        includeActions,
        runtimeBindings,
      ));
      return 0;
    } catch (error) {
      if (safeErrorMessage(error) === "confirmation declined") {
        write([
          "MCP install cancelled. Your reviewed boundaries remain active.",
          input.selection
            ? "No project client configuration was changed."
            : "Back at connection choices.",
          "",
        ].join("\n"));
        if (!input.selection) {
          return runPostActivationAskHandoff({
            ...input,
            autoStartConfiguredProvider: false,
            selection: undefined,
          }, dependencies);
        }
        return 0;
      }
      stderr.write([
        `Local MCP setup did not complete: ${safeErrorMessage(error)}`,
        "The reviewed Read and Action boundaries are unchanged.",
        `Retry after resolving the error: ${cliCommandName()} mcp ${formatRetryArgs(installArgs)}`,
        "The retry shows the exact install preview again before writing project configuration.",
        "",
      ].join("\n"));
      return 1;
    }
  }
  if (route === "mcp-http") {
    write(formatHttpMcpHandoff(input.projectRoot));
    return 0;
  }

  const askArgs = ["--project-root", input.projectRoot];
  if (route === "openai") {
    askArgs.push("--provider", "openai", "--model", selection.model);
  } else if (route === "anthropic") {
    askArgs.push("--provider", "anthropic", "--model", selection.model);
  } else {
    askArgs.push(
      "--provider", "openai-compatible",
      "--model", selection.model,
      "--base-url", selection.baseUrl,
    );
  }
  if (input.requestTimeoutSeconds !== undefined) {
    askArgs.push("--timeout", String(input.requestTimeoutSeconds));
  }
  if (input.sessionTokenBudget !== undefined) {
    askArgs.push("--session-token-budget", String(input.sessionTokenBudget));
  }
  if (input.maxOutputTokens !== undefined) {
    askArgs.push("--max-output-tokens", String(input.maxOutputTokens));
  }

  const routeLabel = route === "openai"
    ? "OpenAI"
    : route === "anthropic"
      ? "Anthropic"
      : "local OpenAI-compatible model";
  if (configuredSelection && !input.selection) {
    write(
      `${theme.key(routeLabel)} is already configured in this process.\n`,
    );
  }
  write([
    `Starting Synapsor Analytics with ${theme.key(routeLabel)}.`,
    `Selected model: ${theme.key(selection.model)}`,
    ...(input.requestTimeoutSeconds === undefined
      ? []
      : [`Model request timeout: ${theme.key(`${input.requestTimeoutSeconds} seconds`)} per provider call`]),
    ...(input.sessionTokenBudget === undefined
      ? []
      : [`Ask session token budget: ${theme.key(input.sessionTokenBudget.toLocaleString("en-US"))} provider-reported tokens`]),
    ...(input.maxOutputTokens === undefined
      ? []
      : [`Provider output limit: ${theme.key(input.maxOutputTokens.toLocaleString("en-US"))} tokens per call`]),
    "",
  ].join("\n"));
  const runAsk = dependencies.runAsk
    ?? (async (args: string[], options?: { consentOnFirstQuestion?: boolean }) => {
      const { tryAsk } = await import("./try-ask.js");
      return tryAsk(
        args,
        options?.consentOnFirstQuestion
          ? {
            confirmEgress: async () => {
              write(
                "Submitting your first data question confirms the provider egress review above. " +
                "No provider request is made until you submit that question.\n\n",
              );
              return true;
            },
          }
          : {},
      );
  });
  try {
    return (configuredSelection || input.selection) && input.consentOnFirstQuestion
      ? await runAsk(askArgs, { consentOnFirstQuestion: true })
      : await runAsk(askArgs);
  } catch (error) {
    if (error instanceof ProviderCredentialInputCancelledError) {
      write([
        "Provider credential entry cancelled. Back at model selection.",
        "Your reviewed boundaries remain active, and no provider request was made.",
        "",
      ].join("\n"));
      return runPostActivationAskHandoff({
        projectRoot: input.projectRoot,
        includeActions: input.includeActions,
        consentOnFirstQuestion: input.consentOnFirstQuestion,
        requestTimeoutSeconds: input.requestTimeoutSeconds,
        sessionTokenBudget: input.sessionTokenBudget,
        maxOutputTokens: input.maxOutputTokens,
      }, dependencies);
    }
    stderr.write([
      `Ask did not start: ${safeErrorMessage(error)}`,
      "The reviewed boundary is still active.",
      `Retry: ${cliCommandName()} try ask ${formatRetryArgs(askArgs)}`,
      "",
    ].join("\n"));
    return 1;
  }
}

export function preferredRoute(env: NodeJS.ProcessEnv): PostActivationAskRoute {
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return "openai";
}

export function soleConfiguredHostedRoute(
  env: NodeJS.ProcessEnv,
): "openai" | "anthropic" | undefined {
  const configured = [
    ...(env.OPENAI_API_KEY?.trim() ? ["openai" as const] : []),
    ...(env.ANTHROPIC_API_KEY?.trim() ? ["anthropic" as const] : []),
  ];
  return configured.length === 1 ? configured[0] : undefined;
}

export function defaultPostActivationAskSelection(
  env: NodeJS.ProcessEnv,
): Extract<PostActivationAskSelection, { route: "openai" | "anthropic" }> {
  const route = preferredRoute(env);
  return route === "anthropic"
    ? {
      route,
      model: DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL,
    }
    : {
      route: "openai",
      model: DEFAULT_TERMINAL_OPENAI_ASK_MODEL,
    };
}

export function soleConfiguredHostedSelection(
  env: NodeJS.ProcessEnv,
): Extract<PostActivationAskSelection, { route: "openai" | "anthropic" }> | undefined {
  const route = soleConfiguredHostedRoute(env);
  if (!route) return undefined;
  return route === "anthropic"
    ? { route, model: DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL }
    : { route, model: DEFAULT_TERMINAL_OPENAI_ASK_MODEL };
}

export function formatPostActivationAskSelection(
  selection: PostActivationAskSelection,
): string {
  if (selection.route === "mcp-client") return `Local stdio MCP / ${managedMcpClientLabel(selection.client)}`;
  if (selection.route === "mcp-http") return "Production HTTP MCP";
  if (selection.route === "later") return "Choose later";
  if (selection.route === "openai") return `OpenAI / ${selection.model}`;
  if (selection.route === "anthropic") return `Anthropic / ${selection.model}`;
  return `Local OpenAI-compatible / ${selection.model}`;
}

export async function choosePostActivationAskSelection(
  dependencies: Pick<
    PostActivationAskDependencies,
    "chooseRoute" | "chooseMcpClient" | "promptWithDefault" | "listOpenAiCompatibleModels" | "env"
  > = {},
): Promise<PostActivationAskSelection | undefined> {
  const env = dependencies.env ?? process.env;
  const prompt = dependencies.promptWithDefault
    ?? ((label, defaultValue) =>
      promptWithDefault(label, defaultValue, process.stdin, process.stderr));
  while (true) {
    const route = dependencies.chooseRoute
      ? await dependencies.chooseRoute(preferredRoute(env))
      : await chooseRouteInTerminal(
        preferredRoute(env),
        process.stdin as ReadStream,
        process.stderr as WriteStream,
      );
    if (!route) return undefined;
    if (route === "mcp-client") {
      const client = dependencies.chooseMcpClient
        ? await dependencies.chooseMcpClient()
        : await chooseMcpClientInTerminal(
          process.stdin as ReadStream,
          process.stderr as WriteStream,
        );
      if (!client) continue;
      return { route, client };
    }
    if (route === "mcp-http" || route === "later") return { route };
    if (route === "openai") {
      const model = await prompt("OpenAI model", DEFAULT_TERMINAL_OPENAI_ASK_MODEL);
      if (model === undefined) continue;
      return { route, model };
    }
    if (route === "anthropic") {
      const model = await prompt("Anthropic model", DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL);
      if (model === undefined) continue;
      return { route, model };
    }
    while (true) {
      const baseUrl = await prompt(
        "Local OpenAI-compatible base URL",
        "http://127.0.0.1:11434/v1",
      );
      if (baseUrl === undefined) break;
      const detectedModels = await (dependencies.listOpenAiCompatibleModels
        ?? discoverOpenAiCompatibleModels)(baseUrl).catch(() => []);
      const defaultModel = detectedModels[0] ?? "llama3.2";
      const detectedLabel = detectedModels.length
        ? ` (detected: ${detectedModels.slice(0, 5).join(", ")}${detectedModels.length > 5 ? ", ..." : ""})`
        : "";
      const model = await prompt(`Local model name${detectedLabel}`, defaultModel);
      if (model === undefined) continue;
      return { route, baseUrl, model };
    }
  }
}

export function formatMcpClientHandoff(
  projectRoot: string,
  client: ManagedMcpProjectClient,
  includeActions: boolean,
  runtimeBindings: ReviewedRuntimeBinding[] = [],
): string {
  const cmd = cliCommandName();
  const root = shellToken(projectRoot);
  const launch = client === "claude-code"
    ? "claude"
    : client === "cursor"
      ? `cursor ${root}`
      : `code ${root}`;
  return [
    "LOCAL STDIO MCP READY",
    `Client: ${managedMcpClientLabel(client)}`,
    "Synapsor entry: app.describe_data + app.explore_data + app.describe_actions + app.request_change",
    includeActions
      ? "Active outcomes are discovered behind the same Action tools; Read and Action activation remain separate."
      : "No Action is active yet. Action discovery is empty and change requests are refused until activation.",
    "Do not start a separate server: the stdio client launches Runner for each MCP session.",
    ...(runtimeBindings.length
      ? [
          "Set this session's trusted identity before opening the client:",
          ...runtimeBindings.map((binding) =>
            `  export ${binding.environment}='<${binding.role}>'`),
          "These values are required only for live scoped calls. They remain outside model arguments and saved project files.",
        ]
      : ["Start or restart the client from the trusted runtime environment required by this reviewed boundary."]),
    "",
    `  cd ${root}`,
    `  ${launch}`,
    "",
    "Verify the exact tool split after the client reloads:",
    `  ${cmd} mcp status ${client} --project${includeActions ? " --include-actions" : ""} --check-launch`,
    "The agent may read and create proposals. It cannot activate boundaries, approve proposals, or apply source changes.",
    "",
  ].join("\n");
}

type ReviewedRuntimeBinding = {
  role: "tenant" | "principal";
  environment: string;
};

async function reviewedRuntimeBindingNames(projectRoot: string): Promise<ReviewedRuntimeBinding[]> {
  const boundaries = await loadActivatedExplorationBoundaries(projectRoot);
  const values = new Map<string, ReviewedRuntimeBinding>();
  for (const boundary of boundaries) {
    const trusted = boundary.trusted_context;
    if (trusted.provider !== "environment") continue;
    if (trusted.tenant_env) {
      values.set(`tenant:${trusted.tenant_env}`, {
        role: "tenant",
        environment: trusted.tenant_env,
      });
    }
    if (trusted.principal_env) {
      values.set(`principal:${trusted.principal_env}`, {
        role: "principal",
        environment: trusted.principal_env,
      });
    }
  }
  return [...values.values()];
}

export async function hasActiveActionRuntime(
  projectRoot: string,
  dependencies: {
    guidedStatus?: typeof guidedActionStatus;
    loadSemanticAuthority?: typeof loadActiveActionRuleAuthority;
  } = {},
): Promise<boolean> {
  const status = await (dependencies.guidedStatus ?? guidedActionStatus)(projectRoot);
  if (status.action_boundary.active?.authority.capabilities.length) return true;
  try {
    const semantic = await (dependencies.loadSemanticAuthority
      ?? loadActiveActionRuleAuthority)(projectRoot);
    return semantic.registry.rules.length > 0;
  } catch {
    // Missing, stale, or invalid semantic authority must never be installed.
    return false;
  }
}

function managedMcpClientLabel(client: ManagedMcpProjectClient): string {
  if (client === "claude-code") return "Claude Code";
  if (client === "cursor") return "Cursor";
  return "VS Code";
}

export function formatHttpMcpHandoff(projectRoot: string): string {
  const cmd = cliCommandName();
  const root = shellToken(projectRoot);
  return [
    "PRODUCTION HTTP MCP",
    "Production HTTP needs operator-owned identity-provider, TLS, and shared PostgreSQL accounting inputs.",
    "Runner verifies OAuth/JWT access tokens; it never issues, refreshes, prints, or stores token values.",
    "",
    "1. Scaffold the production config (the command requires your engine, claims, issuer, audience, and accounting namespace):",
    `   ${cmd} config init --production-explore --help`,
    `   Project root: ${root}`,
    "",
    "2. Review and activate the production Read Boundary, then run the complete preflight:",
    `   ${cmd} doctor --config ./synapsor.runner.json --transport streamable-http --preflight --host 0.0.0.0 --trusted-tls-proxy`,
    "",
    "3. Serve the exact two-tool production surface behind the trusted TLS proxy:",
    `   ${cmd} mcp serve --transport streamable-http --production-explore --host 0.0.0.0 --trusted-tls-proxy --config ./synapsor.runner.json`,
    "",
    "4. Prefer the MCP client's OAuth discovery flow. For a bounded environment-token fallback, generate a secret-free client config:",
    `   ${cmd} mcp client-config --client claude-code --transport streamable-http --config ./synapsor.runner.json`,
    "   Replace claude-code with cursor or vscode for those clients.",
    "",
    "Full guide: docs/production-scoped-explore-http.md",
    "",
  ].join("\n");
}

async function promptWithDefault(
  label: string,
  defaultValue: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  const theme = terminalTheme((output as WriteStream).isTTY && !("NO_COLOR" in process.env));
  const value = await readTerminalTextWithEscape(
    `${label} ${theme.value(`[${defaultValue}]`)} ${theme.key("[Esc Back]")}: `,
    input as ReadStream,
    output as WriteStream,
  );
  return value === undefined ? undefined : value || defaultValue;
}

async function chooseRouteInTerminal(
  defaultRoute: PostActivationAskRoute,
  input: ReadStream,
  output: WriteStream,
): Promise<PostActivationAskRoute | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("The post-activation Ask choice requires a real terminal.");
  }
  let selected = Math.max(
    0,
    routeOptions.findIndex((option) => option.id === defaultRoute),
  );
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const renderer = createInPlaceTerminalRenderer(output, {
    maxRows: () => output.rows,
  });
  const queued: Array<{ name?: string; ctrl?: boolean }> = [];
  const waiters: Array<(key: { name?: string; ctrl?: boolean }) => void> = [];
  const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    const waiter = waiters.shift();
    if (waiter) waiter(key);
    else queued.push(key);
  };
  readline.emitKeypressEvents(input);
  input.on("keypress", onKey);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?25l");
  const theme = terminalTheme(!("NO_COLOR" in process.env));

  const render = () => {
    const width = terminalContentWidth(output.columns);
    const lines = [
      theme.title("USE YOUR REVIEWED BOUNDARIES"),
      "Choose how you want an agent to use this project.",
      theme.dim("Only reviewed tools are exposed. Activation, approval, and apply stay outside the agent."),
      "",
      ...routeOptions.map((option, index) => formatPostActivationRouteLine({
        option,
        selected: index === selected,
        color: !("NO_COLOR" in process.env),
      })),
      "",
      `${theme.key("Up/Down")} Select   ${theme.key("Enter")} Continue   ${theme.key("Esc")} Back`,
    ].flatMap((line) =>
      wrapStyledTerminalLine(line, width).map((wrapped) => padTerminalLine(wrapped)));
    renderer.render(lines);
  };
  const nextKey = () => {
    const key = queued.shift();
    if (key) return Promise.resolve(key);
    return new Promise<{ name?: string; ctrl?: boolean }>((resolve) => waiters.push(resolve));
  };

  try {
    while (true) {
      render();
      const key = await nextKey();
      if (key.name === "up") {
        selected = (selected - 1 + routeOptions.length) % routeOptions.length;
      } else if (key.name === "down") {
        selected = (selected + 1) % routeOptions.length;
      } else if (key.name === "return" || key.name === "enter") {
        return routeOptions[selected]!.id;
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        return undefined;
      }
    }
  } finally {
    input.off("keypress", onKey);
    renderer.clear();
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}

async function chooseMcpClientInTerminal(
  input: ReadStream,
  output: WriteStream,
): Promise<ManagedMcpProjectClient | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("The local MCP client choice requires a real terminal.");
  }
  const options = managedMcpClientOptions;
  let selected = 0;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const renderer = createInPlaceTerminalRenderer(output, { maxRows: () => output.rows });
  const queued: Array<{ name?: string; ctrl?: boolean }> = [];
  const waiters: Array<(key: { name?: string; ctrl?: boolean }) => void> = [];
  const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    const waiter = waiters.shift();
    if (waiter) waiter(key);
    else queued.push(key);
  };
  readline.emitKeypressEvents(input);
  input.on("keypress", onKey);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?25l");
  const theme = terminalTheme(!("NO_COLOR" in process.env));
  const render = () => {
    const width = terminalContentWidth(output.columns);
    const lines = [
      theme.title("CONNECT A LOCAL MCP CLIENT"),
      "Choose the client Runner may configure for this project.",
      theme.dim("Nothing is selected or installed until you press Enter and confirm the exact preview."),
      "",
      ...options.map((option, index) => formatPostActivationRouteLine({
        option,
        selected: index === selected,
        color: !("NO_COLOR" in process.env),
      })),
      "",
      `${theme.key("Up/Down")} Choose   ${theme.key("1/2/3")} Choose directly   ${theme.key("Enter")} Review install   ${theme.key("Esc")} Back`,
    ].flatMap((line) =>
      wrapStyledTerminalLine(line, width).map((wrapped) => padTerminalLine(wrapped)));
    renderer.render(lines);
  };
  const nextKey = () => {
    const key = queued.shift();
    if (key) return Promise.resolve(key);
    return new Promise<{ name?: string; ctrl?: boolean }>((resolve) => waiters.push(resolve));
  };

  try {
    while (true) {
      render();
      const key = await nextKey();
      const transition = mcpClientPickerTransition(selected, key);
      selected = transition.selected;
      if (transition.client) return transition.client;
      if (transition.cancelled) return undefined;
    }
  } finally {
    input.off("keypress", onKey);
    renderer.clear();
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}

export function mcpClientPickerTransition(
  selected: number,
  key: McpClientPickerKey,
): McpClientPickerTransition {
  if (key.name === "up") {
    return {
      selected: (selected - 1 + managedMcpClientOptions.length)
        % managedMcpClientOptions.length,
    };
  }
  if (key.name === "down") {
    return { selected: (selected + 1) % managedMcpClientOptions.length };
  }
  if (["1", "2", "3"].includes(key.name ?? "")) {
    return { selected: Number(key.name) - 1 };
  }
  if (key.name === "return" || key.name === "enter") {
    return { selected, client: managedMcpClientOptions[selected]!.id };
  }
  if (key.name === "escape" || (key.ctrl && key.name === "c")) {
    return { selected, cancelled: true };
  }
  return { selected };
}

export function formatPostActivationRouteLine(input: {
  option: Pick<RouteOption, "label" | "detail">;
  selected: boolean;
  color: boolean;
}): string {
  const marker = input.selected ? ">" : " ";
  const line = `${marker} ${input.option.label.padEnd(21)} ${input.option.detail}`;
  return input.selected ? terminalTheme(input.color).focus(line) : line;
}

function formatRetryArgs(args: string[]): string {
  return args.map(shellToken).join(" ");
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/g, "https://")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 500);
}
