import readline from "node:readline";
import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { terminalTheme } from "./boundary-cli-picker.js";
import { cliCommandName } from "./cli-command-meta.js";
import { readTerminalTextWithEscape } from "./terminal-prompt.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";
import {
  padTerminalBlock,
  padTerminalLines,
} from "./terminal-layout.js";

export type PostActivationAskRoute =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "mcp-client"
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

const routeOptions: RouteOption[] = [
  {
    id: "openai",
    label: "OpenAI",
    detail: "Start the terminal chat with gpt-5-mini",
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
    label: "Existing MCP client",
    detail: "Cursor, Claude Code, VS Code, or another stdio client",
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
    autoStartConfiguredProvider?: boolean;
    consentOnFirstQuestion?: boolean;
    requestTimeoutSeconds?: number;
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
        "--provider openai --model gpt-5-mini",
      "",
    ].join("\n"));
    return 0;
  }

  if (route === "mcp-client") {
    write(formatMcpClientHandoff(input.projectRoot));
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
        consentOnFirstQuestion: input.consentOnFirstQuestion,
        requestTimeoutSeconds: input.requestTimeoutSeconds,
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
      model: "claude-sonnet-4-20250514",
    }
    : {
      route: "openai",
      model: "gpt-5-mini",
    };
}

export function soleConfiguredHostedSelection(
  env: NodeJS.ProcessEnv,
): Extract<PostActivationAskSelection, { route: "openai" | "anthropic" }> | undefined {
  const route = soleConfiguredHostedRoute(env);
  if (!route) return undefined;
  return route === "anthropic"
    ? { route, model: "claude-sonnet-4-20250514" }
    : { route, model: "gpt-5-mini" };
}

export function formatPostActivationAskSelection(
  selection: PostActivationAskSelection,
): string {
  if (selection.route === "mcp-client") return "Existing MCP client";
  if (selection.route === "later") return "Choose later";
  if (selection.route === "openai") return `OpenAI / ${selection.model}`;
  if (selection.route === "anthropic") return `Anthropic / ${selection.model}`;
  return `Local OpenAI-compatible / ${selection.model}`;
}

export async function choosePostActivationAskSelection(
  dependencies: Pick<
    PostActivationAskDependencies,
    "chooseRoute" | "promptWithDefault" | "env"
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
    if (route === "mcp-client" || route === "later") return { route };
    if (route === "openai") {
      const model = await prompt("OpenAI model", "gpt-5-mini");
      if (model === undefined) continue;
      return { route, model };
    }
    if (route === "anthropic") {
      const model = await prompt("Anthropic model", "claude-sonnet-4-20250514");
      if (model === undefined) continue;
      return { route, model };
    }
    while (true) {
      const baseUrl = await prompt(
        "Local OpenAI-compatible base URL",
        "http://127.0.0.1:11434/v1",
      );
      if (baseUrl === undefined) break;
      const model = await prompt("Local model name", "llama3.2");
      if (model === undefined) continue;
      return { route, baseUrl, model };
    }
  }
}

export function formatMcpClientHandoff(projectRoot: string): string {
  const cmd = cliCommandName();
  const root = shellToken(projectRoot);
  return [
    "Your reviewed boundaries are ready for an MCP client.",
    "If the client is already connected, refresh its tools and ask your question now.",
    "",
    "Managed project setup (run only for the client you use):",
    `  ${cmd} mcp install cursor --project --authoring --project-root ${root} --yes`,
    `  ${cmd} mcp install claude-code --project --authoring --project-root ${root} --yes`,
    `  ${cmd} mcp install vscode --project --authoring --project-root ${root} --yes`,
    "",
    "Other stdio clients:",
    `  ${cmd} mcp config generic --absolute-paths`,
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
  const wasPaused = input.isPaused();
  let renderedLines = 0;
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
    const lines = padTerminalLines([
      theme.title("ASK YOUR REVIEWED DATA"),
      "Choose how you want to ask with this reviewed boundary.",
      theme.dim("The model receives only the reviewed analytics tools and fields."),
      "",
      ...routeOptions.map((option, index) => formatPostActivationRouteLine({
        option,
        selected: index === selected,
        color: !("NO_COLOR" in process.env),
      })),
      "",
      `${theme.key("Up/Down")} Select   ${theme.key("Enter")} Continue   ${theme.key("Esc")} Back`,
    ]);
    if (renderedLines) output.write(`\u001b[${renderedLines}F`);
    const target = Math.max(renderedLines, lines.length);
    for (let index = 0; index < target; index += 1) {
      output.write(`\u001b[2K${lines[index] ?? ""}\n`);
    }
    renderedLines = target;
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
    if (renderedLines) output.write(`\u001b[${renderedLines}F\u001b[0J`);
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
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
