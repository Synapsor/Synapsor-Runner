import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { createBoundaryReviewInteractiveSession, terminalTheme, type BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { reviewSemanticSupervisedExecution } from "./verified-action-review.js";
import { cliCommandName } from "./cli-command-meta.js";
import {
  createInPlaceTerminalRenderer,
  readTerminalTextWithEscape,
} from "./terminal-prompt.js";
import { ProviderCredentialInputCancelledError } from "./secret-input.js";
import {
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
import { mcp, managedMcpProjectStatusReport } from "./mcp-project.js";
import { formatMcpLaunchFailure } from "./mcp-audit.js";
import { managedMcpProjectStatus, resolveManagedMcpLauncher } from "./managed-mcp-project.js";
import { readPausedExecutionSetup, type SavedExecutionSetup } from "./semantic-execution-setup.js";
import type { ManagedMcpProjectClient } from "./managed-mcp-project.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { readSemanticSupervisedExecutionState, restoreReviewedSemanticReadScope } from "./semantic-action-deployment.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { clientHandoffMatchesActiveAuthority, pendingClientResponsibilities } from "./authoring-client-readiness.js";

export { discoverOpenAiCompatibleModels } from "./openai-compatible-models.js";

export type PostActivationAskRoute =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "mcp-client"
  | "mcp-http"
  | "edit-rules"
  | "manual-editor"
  | "owner-rules"
  | "execution-setup"
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
    }
  | {
      route: "edit-rules";
    }
  | {
      route: "manual-editor";
    }
  | {
      route: "owner-rules";
    }
  | {
      route: "execution-setup";
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
  confirmLaunchCheck?: () => Promise<boolean | undefined>;
  checkClientLaunch?: (projectRoot: string, client: ManagedMcpProjectClient) => Promise<{ ok: boolean; messages: string[] }>;
  readExecutionState?: typeof readSemanticSupervisedExecutionState;
  readRuntimeBindings?: typeof reviewedRuntimeBindingNames;
  readRuntimeIdentity?: typeof reviewedRuntimeIdentity;
  confirmWorkerStart?: (context: string[]) => Promise<boolean | undefined>;
  runWorker?: (args: string[]) => Promise<number>;
  runBoundaryReview?: (args: string[]) => Promise<number>;
  runOwnerRuleSetup?: (projectRoot: string) => Promise<void>;
  runExecutionReview?: (projectRoot: string) => Promise<void>;
  runAsk?: (
    args: string[],
    options?: { consentOnFirstQuestion?: boolean },
  ) => Promise<number>;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean; columns?: number };
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
  {
    id: "edit-rules",
    label: "Edit rules with model",
    detail: "Add or revise behavior; keep the same client and four tools",
  },
  {
    id: "execution-setup",
    label: "Execution setup",
    detail: "Review the writer for active actions; no redrafting or automatic writes",
  },
  {
    id: "manual-editor",
    label: "Manual Boundary editor",
    detail: "Review tables, fields and exact access controls",
  },
  {
    id: "owner-rules",
    label: "Owner-customizable agent rules (optional)",
    detail: "Review who can customize agent behavior; keep source access and execution separate",
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
    /** Ephemeral presentation state for returns within this client handoff. */
    displayedExecutionReview?: string;
  },
  dependencies: PostActivationAskDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const write = (value: string) => stdout.write(
    stdout.isTTY === true ? value.split(/\r?\n/u).flatMap((line) =>
      wrapStyledTerminalLine(line, terminalContentWidth(stdout.columns)).map((wrapped) => padTerminalLine(wrapped))).join("\n") : value,
  );
  const theme = terminalTheme(stdout.isTTY === true && !("NO_COLOR" in env));
  let executionReviewPending = false;
  let executionReviewKey: string | undefined;
  let guidedClientSetup = false;
  let paused: SavedExecutionSetup | undefined;
  let responsibilities: string[] = [];
  try {
    const { loadBoundaryReviewContext, boundaryAuthoringResumeBinding } = await import("./boundary-commands.js");
    const context = await loadBoundaryReviewContext(input.projectRoot);
    const saved = await readBoundaryAuthoringResumeState(input.projectRoot, boundaryAuthoringResumeBinding(context.bundle));
    if (saved.status === "ready" && saved.value.stage === "client_setup") {
      const current = await clientHandoffMatchesActiveAuthority(input.projectRoot, saved.value);
      guidedClientSetup = current;
      if (!current) write("The saved client setup predates the current authority. Review the changed boundaries before relying on the prior setup check.\n");
      if (current && saved.value.client_handoff?.action_digest) {
        const active = await loadActiveActionRuleAuthority(input.projectRoot);
        const execution = await (dependencies.readExecutionState ?? readSemanticSupervisedExecutionState)({ projectRoot: input.projectRoot });
        const pending = active.authority.rules.filter((entry) => entry.effect_envelope.writeback.mode === "direct_sql"
          && entry.effect_envelope.writeback.supervised_worker === "allowed"
          && !(execution.enabled && execution.policies.some((policy) => policy.outcome === entry.rule.outcome
            && policy.action_boundary_digest === active.authority.action_boundary.digest)));
        executionReviewPending = pending.length > 0;
        executionReviewKey = JSON.stringify([active.authority.action_boundary.digest, pending.map((entry) => entry.rule.outcome).sort()]);
        if (executionReviewPending) paused = await readPausedExecutionSetup(input.projectRoot, active.authority.action_boundary.digest);
      }
      responsibilities = await pendingClientResponsibilities(input.projectRoot, saved.value);
    }
  } catch (error) {
    // Ordinary non-guided projects have no authoring checkpoint. Real read
    // errors must not be turned into a claim that integration was verified.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") write(`Saved setup review unavailable: ${safeErrorMessage(error)}\nClient integration remains unverified.\n`);
  }
  const configuredSelection = input.autoStartConfiguredProvider && !executionReviewPending
    ? soleConfiguredHostedSelection(env)
    : undefined;
  if (executionReviewPending && !input.selection && input.displayedExecutionReview !== executionReviewKey) {
    write("Read and change requests are active. Some outcomes still need execution review; existing execution settings are unchanged. You can connect a client now or resume execution setup.\n");
    input = { ...input, displayedExecutionReview: executionReviewKey };
  }
  const selection = input.selection
    ?? configuredSelection
    ?? await choosePostActivationAskSelection(dependencies, guidedClientSetup || executionReviewPending ? "mcp-client" : undefined);
  if (!selection) {
    write(`${await savedSetupReceipt(input.projectRoot, executionReviewPending, paused)}\n`);
    return 0;
  }
  const route = selection.route;

  if (route === "owner-rules") {
    try {
      if (dependencies.runOwnerRuleSetup) await dependencies.runOwnerRuleSetup(input.projectRoot);
      else {
        const { ownerPolicyCommand } = await import("./owner-policy-commands.js");
        const { readRuntimeConfig } = await import("./cli-project.js");
        const { openProjectControlPolicies } = await import("./control-policy-store.js");
        const configPath = path.join(input.projectRoot, "synapsor.runner.json");
        const args = ["--config", configPath, "--project-root", input.projectRoot];
        // Preview and confirm migration separately; selecting this optional
        // entry is not consent to change the authoritative policy store.
        await ownerPolicyCommand(["storage", ...args], { env });
        const config = await readRuntimeConfig(configPath, { env });
        const storePath = path.resolve(input.projectRoot, config.storage?.sqlite_path ?? ".synapsor/local.db");
        const binding = await openProjectControlPolicies({ projectRoot: input.projectRoot, config, storePath, env });
        if (binding) {
          await binding.close();
          await ownerPolicyCommand(["delegation", ...args], { env });
        }
      }
    } catch (error) {
      write(`Optional owner-rule setup could not finish: ${safeErrorMessage(error)}\nClient setup remains available. Inspect current delegation before retrying; no source change was requested.\n\n`);
    }
    return runPostActivationAskHandoff({ ...input, selection: undefined, autoStartConfiguredProvider: false }, dependencies);
  }

  if (route === "execution-setup") {
    try {
      if (paused && !dependencies.runExecutionReview) {
        const session = createBoundaryReviewInteractiveSession();
        if (!await reviewPausedExecutionSetup(session, paused)) return runPostActivationAskHandoff({ ...input, selection: undefined, autoStartConfiguredProvider: false }, dependencies);
      }
      if (dependencies.runExecutionReview) await dependencies.runExecutionReview(input.projectRoot);
      else {
        const active = await loadActiveActionRuleAuthority(input.projectRoot);
        const reads = await loadActivatedExplorationBoundaries(input.projectRoot);
        const execution = await readSemanticSupervisedExecutionState({ projectRoot: input.projectRoot });
        const pending = active.authority.rules.filter((entry) => entry.effect_envelope.writeback.mode === "direct_sql"
          && entry.effect_envelope.writeback.supervised_worker === "allowed"
          && !(execution.enabled && execution.policies.some((policy) => policy.outcome === entry.rule.outcome
            && policy.action_boundary_digest === active.authority.action_boundary.digest)));
        if (!pending.length) write("No active action is waiting for execution enablement. A running worker is still required for enabled actions.\n");
        const session = createBoundaryReviewInteractiveSession();
        for (const entry of pending) {
          const notice = await reviewSemanticSupervisedExecution({ projectRoot: input.projectRoot,
            active: active.activation, activeReads: reads, outcome: entry.rule.outcome, session, env });
          if (notice) write([notice.title, ...notice.lines.filter((line) => !line.startsWith("Run: ")), ""].join("\n"));
        }
      }
    } catch (error) {
      write(`Execution review could not finish: ${safeErrorMessage(error)}\nSource data is unchanged; inspect or retry execution setup without redrafting.\n`);
    }
    return runPostActivationAskHandoff({ ...input, selection: undefined, autoStartConfiguredProvider: false }, dependencies);
  }

  if (route === "edit-rules" || route === "manual-editor") {
    const reviewArgs = ["--project-root", input.projectRoot, "--access",
      ...(route === "edit-rules" ? ["--job-first"] : [])];
    if (dependencies.runBoundaryReview) return dependencies.runBoundaryReview(reviewArgs);
    const { boundaryReviewCommand } = await import("./boundary-commands.js");
    return boundaryReviewCommand(reviewArgs, undefined, undefined, ({ projectRoot }) =>
      runPostActivationAskHandoff({ projectRoot,
        requestTimeoutSeconds: input.requestTimeoutSeconds,
        sessionTokenBudget: input.sessionTokenBudget,
        maxOutputTokens: input.maxOutputTokens,
      }, dependencies));
  }

  if (route === "later") {
    write(`${await savedSetupReceipt(input.projectRoot, executionReviewPending, paused)}\n`);
    return 0;
  }

  try {
    await restoreReviewedSemanticReadScope(input.projectRoot);
  } catch (error) {
    stderr.write(`Action connection needs review: ${safeErrorMessage(error)}\nThe saved authority is unchanged; no source query or write ran.\n`);
    return 1;
  }

  if (route === "mcp-client") {
    if (responsibilities.length) write(["Client integration checks still pending:", ...responsibilities.filter((_line, index) => index % 2 === 0),
      "These are assigned, not verified. The connection check tests transport and tools only.", ""].join("\n"));
    const includeActions = input.includeActions
      ?? await (dependencies.hasActiveActions ?? hasActiveActionRuntime)(input.projectRoot);
    const runtimeIdentity = await (dependencies.readRuntimeIdentity ?? reviewedRuntimeIdentity)(input.projectRoot)
      .catch(() => "unavailable" as const);
    if (runtimeIdentity === "production_authentication") {
      write("Local stdio MCP was not installed because this active boundary requires production authentication. Configure the reviewed Production HTTP MCP path instead; no client configuration changed.\n");
      write(formatHttpMcpHandoff(input.projectRoot));
      return 0;
    }
    const installArgs = [
      "install", selection.client,
      "--project", "--authoring",
      "--project-root", input.projectRoot,
      ...(includeActions ? ["--include-actions"] : []),
    ];
    let clientConfigured = false;
    try {
      const code = await (dependencies.runMcpInstall ?? mcp)(installArgs);
      if (code !== 0) return code;
      clientConfigured = true;
      let runtimeBindingFailure = false;
      const runtimeBindings = await (dependencies.readRuntimeBindings ?? reviewedRuntimeBindingNames)(input.projectRoot).catch(() => {
        runtimeBindingFailure = true;
        return [];
      });
      const approvedCheck = await (dependencies.confirmLaunchCheck ?? (async () => {
        if (!process.stdin.isTTY || !stdout.isTTY) return false;
        return createBoundaryReviewInteractiveSession().confirm("Verify this configured client connection now?", {
          defaultValue: false, context: ["Launch the installed stdio command, check the MCP handshake and tool catalog, then close that test connection.",
            "No model request, source row query, proposal or write will run. This does not start the client application or execution worker."],
        });
      }))();
      let connection = "configured; launch not checked";
      let connectionFailed = false;
      if (approvedCheck) {
        try {
          const checked = await (dependencies.checkClientLaunch ?? checkConfiguredClientLaunch)(input.projectRoot, selection.client);
          connectionFailed = !checked.ok;
          if (checked.ok) connection = "verified MCP handshake and tool catalog; test connection closed";
          else write(`Connection check: ${formatMcpLaunchFailure(checked.messages.join("\n"))}\n`);
        } catch (error) {
          connectionFailed = true;
          write(`Connection check: ${formatMcpLaunchFailure(error)}\n`);
        }
      }
      if (connectionFailed) connection = "saved; NOT CONNECTED; connection check failed";
      write(`Client connection: ${connection}.\n`);
      if (connectionFailed) {
        write([
          "CLIENT CONFIGURATION SAVED; NOT CONNECTED",
          `${managedMcpClientLabel(selection.client)} did not pass the configured Runner connection check. Do not treat client claims as saved requests or completed work.`,
          "Client configuration is preserved. Read, Action and execution permissions are unchanged; this probe made no model request, source query, proposal or write.",
          "Inspect the configured launcher and resolve the reported failure, then retry the explicit launch check:",
          `  ${cliCommandName()} mcp status ${selection.client} --project --project-root ${shellToken(input.projectRoot)} --check-launch${includeActions ? " --include-actions" : ""}`,
          "No client reinstall or new activation was performed by this check.",
          "",
        ].join("\n"));
      } else {
        write(formatMcpClientHandoff(
          input.projectRoot,
          selection.client,
          includeActions,
          runtimeBindings,
          runtimeIdentity,
          runtimeBindings.filter((binding) => env[binding.environment]?.trim()).map((binding) => binding.environment),
        ));
      }
      if (includeActions) {
        const execution = await (dependencies.readExecutionState ?? readSemanticSupervisedExecutionState)({ projectRoot: input.projectRoot });
        write(`Client mode: ${execution.enabled ? "execution configured; worker health not checked" : "proposal-only; automatic database updates are off"}. Completion requires a successful execution receipt.\n`);
        if (execution.enabled && execution.policies.length) {
          const missing = [...new Set(execution.policies.map((policy) => policy.write_url_env))].filter((name) => !env[name]?.trim());
          const missingIdentity = runtimeBindings.filter((binding) => !env[binding.environment]?.trim());
          if (missing.length) {
            write(`Next: provide the reviewed writer environment ${missing.join(", ")} before starting the worker. Client configuration and boundaries are preserved.\n`);
          } else if (runtimeBindingFailure) {
            write("Worker not started: the reviewed identity requirements could not be loaded. Inspect the saved Read and Action authority and retry execution setup; client configuration is preserved.\n");
          } else if (missingIdentity.length) {
            write(`Worker not started: this local execution mode also requires trusted identity in ${missingIdentity.map((binding) => binding.environment).join(", ")}.\n`
              + "Use trusted test identities locally; production identity must come from the authenticated session, never the model.\n");
          } else {
            const context = [
              `Client connection: ${connection}.`,
              ...(connectionFailed ? ["A worker can process already-approved requests independently; starting it does not repair or verify the client connection."] : []),
              `Process approved requests for: ${execution.policies.map((policy) => policy.outcome).join(", ")}.`,
              "This can write source rows for approved requests. The worker checks current authority, eligibility, writer posture and conflict guards before execution.",
              connectionFailed
                ? "Run in this terminal until Ctrl-C; setup will not create a background daemon. The client connection still needs repair."
                : "Run in this terminal until Ctrl-C. Open the MCP client in another terminal; setup will not create a background daemon.",
            ];
            const start = await (dependencies.confirmWorkerStart ?? (async (lines: string[]) => {
              if (!process.stdin.isTTY || !stdout.isTTY) return false;
              return createBoundaryReviewInteractiveSession().confirm("Start the reviewed execution worker here?", { defaultValue: false, context: lines });
            }))(context);
            if (start) {
              write("Starting the reviewed worker in this terminal. Completion requires a successful execution receipt, not approval alone.\n");
              const runWorker = dependencies.runWorker ?? (async (args: string[]) => (await import("./worker-runtime.js")).workerCommand(args));
              const code = await runWorker(["run", "--supervised", "--yes", "--config", path.resolve(input.projectRoot, execution.config_path)]);
              write("This worker has stopped. Client configuration and execution permissions remain saved; automatic processing needs a running worker.\n");
              if (connectionFailed) write("Client configuration is still saved but NOT CONNECTED; the failed connection check has not been retried.\n");
              return code !== 0 ? code : connectionFailed ? 1 : 0;
            }
            write(`Worker not started by setup. Next: ${cliCommandName()} worker run --supervised --yes --config ${shellToken(path.resolve(input.projectRoot, execution.config_path))}\n`);
          }
        }
      }
      return connectionFailed ? 1 : 0;
    } catch (error) {
      if (clientConfigured) {
        stderr.write(`Client configuration is saved. Execution setup could not finish: ${safeErrorMessage(error)}\n`
          + `No authority was changed by this check. Inspect execution configuration and retry ${cliCommandName()} worker run --supervised --yes; no client reinstall is needed.\n`);
        return 1;
      }
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
  if (selection.route === "edit-rules") return "Edit rules with model";
  if (selection.route === "manual-editor") return "Manual Boundary editor";
  if (selection.route === "owner-rules") return "Owner-customizable agent rules";
  if (selection.route === "execution-setup") return "Execution setup";
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
  initialRoute?: PostActivationAskRoute,
): Promise<PostActivationAskSelection | undefined> {
  const env = dependencies.env ?? process.env;
  const prompt = dependencies.promptWithDefault
    ?? ((label, defaultValue) =>
      promptWithDefault(label, defaultValue, process.stdin, process.stderr));
  while (true) {
    const route = dependencies.chooseRoute
      ? await dependencies.chooseRoute(initialRoute ?? preferredRoute(env))
      : await chooseRouteInTerminal(
        initialRoute ?? preferredRoute(env),
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
    if (route === "mcp-http" || route === "later" || route === "edit-rules" || route === "manual-editor" || route === "execution-setup" || route === "owner-rules") return { route };
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
  runtimeIdentity: ReviewedRuntimeIdentity = runtimeBindings.length ? "local_environment" : "unavailable",
  configuredBindings: readonly string[] = [],
): string {
  const root = shellToken(projectRoot);
  const launch = client === "claude-code"
    ? "claude"
    : client === "cursor"
      ? `cursor ${root}`
      : `code ${root}`;
  const missingBindings = runtimeBindings.filter((binding) => !configuredBindings.includes(binding.environment));
  return [
    "LOCAL STDIO MCP CONFIGURED",
    `${managedMcpClientLabel(client)} launches Runner with the four fixed tools. Do not start a separate MCP server.`,
    ...(!includeActions ? ["Read only: no Action is active; change requests remain refused."] : []),
    ...(runtimeIdentity === "production_authentication"
      ? ["Production identity comes from the reviewed authenticated session. Do not copy fixture values or accept identity from a client prompt or model."]
      : runtimeBindings.length
      ? missingBindings.length ? [
          "Local test identity still needed: use the account/person from your application fixture or trusted authentication setup. Runner cannot choose these from a database URL.",
          "Provide only the missing reviewed bindings in this terminal before opening the client:",
          ...missingBindings.map((binding) =>
            `  export ${binding.environment}='<${binding.role}>'`),
        ]
        : ["Local test identity is configured in this terminal; values stay private. Launch the client here. Other terminals or already-running clients need their own trusted environment.",
            "Identity values are configured, not authenticated or proven by the MCP handshake; every tool use still enforces the reviewed scope."]
      : ["Start or restart the client from the trusted runtime environment required by this reviewed boundary. Identity is not supplied by the model or client config."]),
    `  cd ${root}`,
    `  ${launch}`,
    "",
  ].join("\n");
}

async function checkConfiguredClientLaunch(projectRoot: string, client: ManagedMcpProjectClient) {
  const reports = [await managedMcpProjectStatusReport({ projectRoot, client, entryKind: "explore", checkLaunch: true, timeoutMs: 10_000 })];
  if ((await managedMcpProjectStatus(client, projectRoot, "actions")).state === "installed") {
    reports.push(await managedMcpProjectStatusReport({ projectRoot, client, entryKind: "actions", checkLaunch: true, timeoutMs: 10_000 }));
  }
  return { ok: reports.every((report) => report.ok && report.launch.checked), messages: reports.map((report) => report.launch.message) };
}

type ReviewedRuntimeBinding = {
  role: "tenant" | "principal";
  environment: string;
};

type ReviewedRuntimeIdentity = "local_environment" | "production_authentication" | "unavailable";

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

async function reviewedRuntimeIdentity(projectRoot: string): Promise<ReviewedRuntimeIdentity> {
  const boundaries = await loadActivatedExplorationBoundaries(projectRoot);
  if (boundaries.length === 0) return "unavailable";
  if (boundaries.every((boundary) => boundary.deployment_profile === "production"
    && boundary.trusted_context.provider === "http_claims")) {
    return "production_authentication";
  }
  if (boundaries.every((boundary) => boundary.deployment_profile !== "production"
    && boundary.trusted_context.provider === "environment")) {
    return "local_environment";
  }
  return "unavailable";
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
    "Read-only endpoint: this transport does not yet serve Action requests or owner settings. It is not an automatic-update integration.",
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

export async function savedSetupReceipt(projectRoot: string, executionPending: boolean, paused?: SavedExecutionSetup): Promise<string> {
  const launcher = await resolveManagedMcpLauncher();
  const resume = launcher.command === "npx"
    ? `Run the same build's start command again in ${shellToken(projectRoot)}${executionPending ? "; select Execution setup" : " to continue client setup"}.`
    : [...[launcher.command, ...launcher.args].map(shellToken), "boundary review --access --job-first --project-root", shellToken(projectRoot)].join(" ");
  return [
    executionPending ? "Setup saved - not ready for automatic changes." : "Setup saved. Your reviewed boundaries remain active.",
    ...(executionPending ? ["Read and reviewed change-request rules are active.",
      paused ? `Last check: ${paused.problem.summary}` : "Automatic completion is not fully configured: execution setup still needs review.",
      paused?.problem.publication_state ? "Next: reopen Execution setup to recover the exact save. Pausing does not disable existing execution."
        : "Next: review the saved writer requirements, repair the connection, then resume Execution setup."] : []),
    "This exit does not verify a client connection, runtime identity, or worker. Existing configuration is preserved.",
    `Resume saved setup: ${resume}`, "",
  ].join("\n");
}

export async function reviewPausedExecutionSetup(session: BoundaryReviewInteractiveSession, paused: SavedExecutionSetup): Promise<boolean> {
  const publication = paused.problem.publication_state !== undefined;
  for (;;) {
    const selected = await session.chooseOption?.("Resume execution setup", [
      { value: "recheck", label: publication ? "Recover the saved execution attempt" : "I repaired the connection; recheck it" },
      { value: "details", label: publication ? "View saved recovery details" : "View saved blocker and administrator handoff" },
      { value: "back", label: "Back to client setup" },
    ], { initialValue: "details", context: [paused.problem.summary, `Last check: ${paused.paused_at}. Not rechecked since pausing.`] });
    if (selected !== "details") return selected === "recheck";
    await session.showReviewDetails?.(publication ? "Saved execution recovery" : "Saved writer requirements", paused.problem.details);
  }
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
  let more = !["mcp-client", "execution-setup", "later"].includes(defaultRoute);
  const options = () => [...routeOptions.filter((option) => more
    ? !["mcp-client", "execution-setup", "later"].includes(option.id)
    : ["mcp-client", "execution-setup", "later"].includes(option.id)),
    { id: "more" as const, label: more ? "Back to client setup" : "More options", detail: more ? "" : "Terminal chat, production HTTP, rule editing and manual controls" }];
  let selected = Math.max(0, options().findIndex((option) => option.id === defaultRoute));
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
      theme.title(more ? "MORE OPTIONS" : "CONNECT YOUR CLIENT"),
      "Choose the next step for this saved project.",
      "",
      ...options().map((option, index) => formatPostActivationRouteLine({
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
        selected = (selected - 1 + options().length) % options().length;
      } else if (key.name === "down") {
        selected = (selected + 1) % options().length;
      } else if (key.name === "return" || key.name === "enter") {
        const value = options()[selected]!.id;
        if (value === "more") { more = !more; selected = 0; }
        else return value;
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
