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
import { ProviderCredentialInputCancelledError, readHiddenLocalIdentity } from "./secret-input.js";
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
import { listActionRuleAuthorityDrafts, loadActiveActionRuleAuthority, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { mcp, managedMcpProjectStatusReport } from "./mcp-project.js";
import { formatMcpLaunchFailure } from "./mcp-audit.js";
import { managedMcpProjectStatus, resolveManagedMcpLauncher } from "./managed-mcp-project.js";
import { readPausedExecutionSetup, type SavedExecutionSetup } from "./semantic-execution-setup.js";
import type { ManagedMcpProjectClient } from "./managed-mcp-project.js";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { readSemanticSupervisedExecutionState, restoreReviewedSemanticReadScope } from "./semantic-action-deployment.js";
import { readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { loadLocalTestRuntimeIdentity, saveLocalTestRuntimeIdentity, type LocalTestRuntimeBinding } from "./local-test-runtime-identity.js";
import { clientHandoffMatchesActiveAuthority, pendingClientResponsibilities, readPostActivationReadiness,
  type PostActivationReadiness } from "./authoring-client-readiness.js";
export { readPostActivationReadiness, type PostActivationReadiness } from "./authoring-client-readiness.js";

export { discoverOpenAiCompatibleModels } from "./openai-compatible-models.js";

export type PostActivationAskRoute =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-compatible"
  | "mcp-client"
  | "mcp-http"
  | "edit-rules"
  | "create-outcome"
  | "review-outcomes"
  | "manual-editor"
  | "owner-rules"
  | "execution-setup"
  | "later";

export type PostActivationAskSelection =
  | { route: "openrouter"; model: string }
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
      route: "create-outcome";
    }
  | {
      route: "review-outcomes";
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
    options?: readonly RouteOption[],
  ) => Promise<PostActivationAskRoute | undefined>;
  promptWithDefault?: (
    prompt: string,
    defaultValue: string,
  ) => Promise<string | undefined>;
  listOpenAiCompatibleModels?: (baseUrl: string) => Promise<string[]>;
  listHostedModels?: typeof discoverHostedProviderModels;
  chooseHostedModel?: (models: string[], current: string) => Promise<string | undefined>;
  chooseMcpClient?: () => Promise<ManagedMcpProjectClient | undefined>;
  hasActiveActions?: (projectRoot: string) => Promise<boolean>;
  runMcpInstall?: (args: string[]) => Promise<number>;
  confirmLaunchCheck?: () => Promise<boolean | undefined>;
  checkClientLaunch?: (projectRoot: string, client: ManagedMcpProjectClient) => Promise<{ ok: boolean; messages: string[] }>;
  readClientInstallation?: typeof managedMcpProjectStatus;
  readExecutionState?: typeof readSemanticSupervisedExecutionState;
  readReadiness?: typeof readPostActivationReadiness;
  readActionDrafts?: typeof listActionRuleAuthorityDrafts;
  readRuntimeBindings?: typeof reviewedRuntimeBindingNames;
  readRuntimeIdentity?: typeof reviewedRuntimeIdentity;
  /** Collects reviewed fixture identities locally. Values are never sent to a provider. */
  collectLocalTestIdentity?: (input: {
    projectRoot: string;
    client: ManagedMcpProjectClient;
    bindings: ReviewedRuntimeBinding[];
  }) => Promise<Record<string, string> | undefined>;
  loadLocalTestIdentity?: typeof loadLocalTestRuntimeIdentity;
  saveLocalTestIdentity?: (input: {
    projectRoot: string;
    bindings: LocalTestRuntimeBinding[];
    values: Record<string, string>;
  }) => Promise<{ path: string; bindings: LocalTestRuntimeBinding[] }>;
  confirmWorkerStart?: (context: string[]) => Promise<boolean | undefined>;
  runWorker?: (args: string[]) => Promise<number>;
  runBoundaryReview?: (args: string[]) => Promise<number>;
  runActionReview?: (args: string[]) => Promise<number>;
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
  { id: "openrouter", label: "OpenRouter", detail: "Choose a text/tool model; requests pass through OpenRouter to a serving provider" },
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
    id: "create-outcome",
    label: "Create the first verified outcome",
    detail: "Continue the saved job; keep active Read and review Action separately",
  },
  {
    id: "review-outcomes",
    label: "Review saved verified outcomes",
    detail: "Open the exact disabled Action draft; no new job or model is required",
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

export function continueClientSetup(projectRoot: string, dependencies: PostActivationAskDependencies = {}): Promise<number> {
  return runPostActivationAskHandoff({ projectRoot, includeActions: true,
    autoStartConfiguredProvider: false, initialRoute: "mcp-client" }, dependencies);
}

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
    /** Navigation preference only; saved authority and readiness are still checked. */
    initialRoute?: PostActivationAskRoute;
    /** Ephemeral presentation state for returns within this client handoff. */
    displayedExecutionReview?: string;
    usedIntendedClient?: boolean;
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
  let readiness: PostActivationReadiness;
  let savedActionDrafts: Awaited<ReturnType<typeof listActionRuleAuthorityDrafts>>;
  try {
    readiness = await (dependencies.readReadiness ?? readPostActivationReadiness)(input.projectRoot);
    savedActionDrafts = await (dependencies.readActionDrafts ?? listActionRuleAuthorityDrafts)(input.projectRoot);
  } catch (error) {
    stderr.write(`Saved authority needs review: ${safeErrorMessage(error)}\nThe saved authority is unchanged; no source query or write ran.\n`);
    return 1;
  }
  const firstOutcome = readiness.read === "active" && readiness.semantic_actions === "inactive";
  const hasSavedActionDrafts = savedActionDrafts.length > 0;
  let needsFirstOutcome = firstOutcome && readiness.legacy_actions === "active";
  if (readiness.read === "active") {
    write(`Read: active. Verified outcomes: ${readiness.semantic_actions === "active" ? "active" : "OFF"}.${readiness.legacy_actions === "active" ? " Legacy named actions: active." : ""}\n`);
    if (readiness.semantic_outcomes.length) {
      const automatic = readiness.semantic_outcomes.filter((outcome) => outcome.approval_mode === "policy").length;
      const humanOnly = readiness.semantic_outcomes.length - automatic;
      const executable = readiness.semantic_outcomes.filter((outcome) => outcome.execution_enabled).length;
      const approvals = [
        ...(automatic ? [`${automatic} automatic ${automatic === 1 ? "policy" : "policies"} with human fallback`] : []),
        ...(humanOnly ? [`${humanOnly} human-only ${humanOnly === 1 ? "outcome" : "outcomes"}`] : []),
      ];
      write(`Approval: ${approvals.join(", ")}. Execution enabled: ${executable}/${readiness.semantic_outcomes.length} outcomes.\n`);
      write(`Worker: not checked. Approval is not completion. ${cliCommandName()} action status shows each outcome.\n`);
    }
  }
  let executionReviewPending = false;
  let executionReviewKey: string | undefined;
  let pendingExecutionOutcomes: string[] = [];
  let staleExecutionOutcomes: string[] = [];
  let guidedClientSetup = false;
  let intendedClient: ManagedMcpProjectClient | undefined;
  let paused: SavedExecutionSetup | undefined;
  let responsibilities: string[] = [];
  try {
    const { loadBoundaryReviewContext, boundaryAuthoringResumeBinding } = await import("./boundary-commands.js");
    const context = await loadBoundaryReviewContext(input.projectRoot);
    const saved = await readBoundaryAuthoringResumeState(input.projectRoot, boundaryAuthoringResumeBinding(context.bundle));
    if (firstOutcome && saved.status === "ready" && saved.value.action) needsFirstOutcome = true;
    if (saved.status === "ready" && saved.value.stage === "client_setup") {
      const current = await clientHandoffMatchesActiveAuthority(input.projectRoot, saved.value);
      guidedClientSetup = current;
      if (current && saved.value.intended_client && saved.value.intended_client !== "later") intendedClient = saved.value.intended_client;
      if (!current) write("The saved client setup predates the current authority. Review the changed boundaries before relying on the prior setup check.\n");
      if (current && saved.value.client_handoff?.action_digest) {
        const active = await loadActiveActionRuleAuthority(input.projectRoot);
        const execution = await (dependencies.readExecutionState ?? readSemanticSupervisedExecutionState)({ projectRoot: input.projectRoot });
        const pending = active.authority.rules.filter((entry) => entry.effect_envelope.writeback.mode === "direct_sql"
          && entry.effect_envelope.writeback.supervised_worker === "allowed"
          && !(execution.enabled && execution.policies.some((policy) => policy.outcome === entry.rule.outcome
            && policy.action_boundary_digest === active.authority.action_boundary.digest)));
        executionReviewPending = pending.length > 0;
        pendingExecutionOutcomes = pending.map((entry) => entry.rule.outcome).sort();
        staleExecutionOutcomes = execution.enabled ? pendingExecutionOutcomes.filter((outcome) => execution.policies.some((policy) =>
          policy.outcome === outcome && policy.action_boundary_digest !== active.authority.action_boundary.digest)) : [];
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
  const currentJobClientSetup = guidedClientSetup && readiness.semantic_actions === "active" && readiness.semantic_outcomes.length > 0;
  const savedActionReviewPending = hasSavedActionDrafts && !currentJobClientSetup;
  if (hasSavedActionDrafts) {
    write(currentJobClientSetup
      ? `Other saved verified Action draft${savedActionDrafts.length === 1 ? "" : "s"}: ${savedActionDrafts.length}, available for optional review. Current client setup matches the active authority; the saved drafts are unchanged.\n`
      : `Saved verified Action draft${savedActionDrafts.length === 1 ? "" : "s"}: ${savedActionDrafts.length}, disabled and awaiting separate review. Review the saved verified outcomes; no new authoring or model is required. Current authority is unchanged.\n`);
  } else if (firstOutcome) {
    write(needsFirstOutcome
      ? "Read-only use remains available. Legacy actions are separate and do not enable app.request_change. Create the first verified outcome to continue the saved business job; current authority is preserved.\n"
      : "Read-only access is ready. Adding verified change outcomes is optional.\n");
  }
  const configuredSelection = input.autoStartConfiguredProvider && !currentJobClientSetup && !executionReviewPending && !needsFirstOutcome && !savedActionReviewPending
    ? soleConfiguredHostedSelection(env)
    : undefined;
  if (executionReviewPending && input.displayedExecutionReview !== executionReviewKey) {
    const unconfigured = pendingExecutionOutcomes.filter((outcome) => !staleExecutionOutcomes.includes(outcome));
    write(`Read and change requests are active. ${pendingExecutionOutcomes.join(", ")} ${pendingExecutionOutcomes.length === 1 ? "needs" : "need"} execution review for the current complete Action Boundary digest.\n`);
    if (staleExecutionOutcomes.length) write(`Prior supervised execution was not carried forward for: ${staleExecutionOutcomes.join(", ")}. Those saved policies bind an earlier Action revision.\n`);
    if (unconfigured.length) write(`Execution is not configured for this revision: ${unconfigured.join(", ")}. Deferred outcomes remain off.\n`);
    write("You can connect a client now or resume execution setup.\n");
    input = { ...input, displayedExecutionReview: executionReviewKey };
  }
  let intendedClientInstalled = false;
  if (intendedClient && !input.selection && !input.usedIntendedClient) {
    try {
      intendedClientInstalled = (await (dependencies.readClientInstallation ?? managedMcpProjectStatus)(intendedClient, input.projectRoot, "explore")).state === "installed";
    } catch {
      write("The saved client installation could not be inspected. Choose client setup to review it, or edit the saved rules; connection remains unverified.\n");
    }
  }
  const selection = input.selection
    ?? (intendedClient && !intendedClientInstalled && !input.usedIntendedClient && !savedActionReviewPending && !needsFirstOutcome ? { route: "mcp-client" as const, client: intendedClient } : undefined)
    ?? configuredSelection
    ?? await choosePostActivationAskSelection(dependencies,
      input.initialRoute ?? (savedActionReviewPending ? "review-outcomes" : needsFirstOutcome ? "create-outcome" : guidedClientSetup || executionReviewPending ? "mcp-client" : undefined),
      firstOutcome && !savedActionReviewPending, hasSavedActionDrafts);
  if (!selection) {
    write(`${await savedSetupReceipt(input.projectRoot, executionReviewPending, paused)}\n`);
    return 0;
  }
  const route = selection.route;
  if (route === "mcp-client" && intendedClient) input = { ...input, usedIntendedClient: true };

  if (route === "review-outcomes") {
    const args = ["review", "--project-root", input.projectRoot];
    if (dependencies.runActionReview) return dependencies.runActionReview(args);
    const { actionCommand } = await import("./boundary-commands.js");
    return actionCommand(args, undefined, projectRoot => continueClientSetup(projectRoot, dependencies));
  }

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

  if (route === "edit-rules" || route === "create-outcome" || route === "manual-editor") {
    const reviewArgs = ["--project-root", input.projectRoot, "--access",
      ...(route !== "manual-editor" ? ["--job-first"] : [])];
    if (dependencies.runBoundaryReview) return dependencies.runBoundaryReview(reviewArgs);
    const { boundaryReviewCommand } = await import("./boundary-commands.js");
    return boundaryReviewCommand(reviewArgs, undefined, undefined, ({ projectRoot }) =>
      runPostActivationAskHandoff({ projectRoot,
        requestTimeoutSeconds: input.requestTimeoutSeconds,
        sessionTokenBudget: input.sessionTokenBudget,
        maxOutputTokens: input.maxOutputTokens,
      }, dependencies), { clientSetup: projectRoot => continueClientSetup(projectRoot, dependencies) });
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
    if (responsibilities.length) write(["Client integration checks still pending:", ...responsibilities,
      "These are assigned, not verified. The connection check tests transport and tools only.", ""].join("\n"));
    const includeActions = firstOutcome ? false : input.includeActions
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
    let reviewedWorkerCommands: string[] = [];
    try {
      const code = await (dependencies.runMcpInstall ?? mcp)(installArgs);
      if (code !== 0) return code;
      clientConfigured = true;
      let runtimeBindingFailure = false;
      const runtimeBindings = await (dependencies.readRuntimeBindings ?? reviewedRuntimeBindingNames)(input.projectRoot).catch(() => {
        runtimeBindingFailure = true;
        return [];
      });
      let localTestRuntimeBindings: LocalTestRuntimeBinding[] = [];
      if (!runtimeBindingFailure && runtimeIdentity === "local_environment" && runtimeBindings.length) {
        let existingIdentity: Record<string, string> | undefined;
        try {
          existingIdentity = await (dependencies.loadLocalTestIdentity ?? loadLocalTestRuntimeIdentity)({ projectRoot: input.projectRoot });
        } catch (error) {
          write(`Saved local test identity cannot be reused: ${safeErrorMessage(error)}\nReview the current identity requirements before replacing it; client configuration is preserved.\n`);
        }
        if (existingIdentity) {
          localTestRuntimeBindings = runtimeBindings;
          write("Reviewed local test runtime already matches the current boundary. Reusing it without collecting identity values again.\n");
        } else {
          const collected = await (dependencies.collectLocalTestIdentity ?? collectLocalTestIdentity)({
            projectRoot: input.projectRoot,
            client: selection.client,
            bindings: runtimeBindings,
          });
          if (collected) {
            const values = validateLocalTestIdentity(runtimeBindings, collected);
            const saved = await (dependencies.saveLocalTestIdentity ?? saveLocalTestRuntimeIdentity)({
              projectRoot: input.projectRoot,
              bindings: runtimeBindings,
              values,
            });
            localTestRuntimeBindings = saved.bindings;
            write("Reviewed local test runtime configured. Values were not printed, copied to client configuration, sent to a provider, or added to authority. Local applications and programs running as your user can read this local test file; it is not production authentication.\n");
          } else {
            write("Local test identity setup was skipped. Client configuration is preserved; no scoped client test or worker start will be inferred.\n");
          }
        }
      }
      const configuredRuntimeBindings = new Set([
        ...runtimeBindings.filter((binding) => env[binding.environment]?.trim()).map((binding) => binding.environment),
        ...localTestRuntimeBindings.map((binding) => binding.environment),
      ]);
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
          const check = dependencies.checkClientLaunch ?? checkConfiguredClientLaunch;
          const checked = await check(input.projectRoot, selection.client);
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
      }
      const execution = includeActions
        ? await (dependencies.readExecutionState ?? readSemanticSupervisedExecutionState)({ projectRoot: input.projectRoot })
        : undefined;
      if (execution) {
        write(`Client mode: ${execution.enabled ? "execution configured; worker not started by setup; worker health not checked" : "proposal-only; automatic database updates are off"}. Completion requires a successful execution receipt.\n`);
      }
      if (!connectionFailed) {
        write(formatMcpClientHandoff(
          input.projectRoot,
          selection.client,
          includeActions,
          runtimeBindings,
          runtimeIdentity,
          [...configuredRuntimeBindings],
          localTestRuntimeBindings.map((binding) => binding.environment),
        ));
      }
      if (execution) {
        if (execution.enabled && execution.policies.length) {
          const workerConfigPath = path.resolve(input.projectRoot, execution.config_path);
          const scopedWorkers = new Set(execution.policies.map((policy) => policy.worker_identity || undefined)).size > 1;
          const workerArgs = (scopedWorkers ? execution.policies : [execution.policies[0]!]).map((policy) => [
            "run", "--supervised", "--yes", "--config", workerConfigPath,
            ...(scopedWorkers ? ["--capability", policy.outcome] : []),
            ...(policy.worker_identity ? ["--worker-id", policy.worker_identity] : []),
          ]);
          reviewedWorkerCommands = workerArgs.map((args) => `${cliCommandName()} worker ${formatRetryArgs(args)}`);
          const missing = [...new Set(execution.policies.map((policy) => policy.write_url_env))].filter((name) => !env[name]?.trim());
          const missingIdentity = runtimeBindings.filter((binding) => !configuredRuntimeBindings.has(binding.environment));
          if (missing.length) {
            write(`Next: provide the reviewed writer environment ${missing.join(", ")} before starting the worker. Client configuration and boundaries are preserved.\n`);
          } else if (runtimeBindingFailure) {
            write("Worker not started: the reviewed identity requirements could not be loaded. Inspect the saved Read and Action authority and retry execution setup; client configuration is preserved.\n");
          } else if (missingIdentity.length) {
            write(`Worker not started: this local execution mode also requires trusted identity in ${missingIdentity.map((binding) => binding.environment).join(", ")}.\n`);
          } else if (scopedWorkers) {
            write("Execution policies have different worker identity selections. Each command below selects one exact outcome; setup will not launch a generic worker.\n");
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
              write(`Launching worker command: ${reviewedWorkerCommands[0]}\n`);
              const runWorker = dependencies.runWorker ?? (async (args: string[]) => (await import("./worker-runtime.js")).workerCommand(args));
              const code = await runWorker(workerArgs[0]!);
              write("This worker has stopped. Client configuration and execution permissions remain saved; automatic processing needs a running worker.\n");
              if (connectionFailed) write("Client configuration is still saved but NOT CONNECTED; the failed connection check has not been retried.\n");
              return code !== 0 ? code : connectionFailed ? 1 : 0;
            }
          }
          write(scopedWorkers
            ? "No workers were started by setup. Run each outcome-scoped command separately after resolving any missing prerequisites; execution checks still apply.\n"
            : "Worker not started by setup. Resolve any missing prerequisites above before running the reviewed command; execution checks still apply.\n");
          for (const command of reviewedWorkerCommands) write(`Worker command (not run): ${command}\n`);
        }
      }
      return connectionFailed ? 1 : 0;
    } catch (error) {
      if (clientConfigured) {
        stderr.write(`Client configuration is saved. Execution setup could not finish: ${safeErrorMessage(error)}\n`
          + "No authority was changed by this check; no client reinstall is needed.\n"
          + (reviewedWorkerCommands.length
            ? `Resolve the reported failure before running the reviewed command${reviewedWorkerCommands.length === 1 ? "" : "s"} again.\n`
              + reviewedWorkerCommands.map((command) => `Worker command (not run): ${command}\n`).join("")
            : "Reopen execution setup to inspect its saved configuration; no worker command is inferred from unavailable execution authority.\n"));
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
  } else if (route === "openrouter") {
    askArgs.push("--provider", "openrouter", "--model", selection.model);
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
      : route === "openrouter" ? OPENROUTER_EGRESS
      : "local OpenAI-compatible model";
  if (configuredSelection && !input.selection) {
    write(
      `${theme.key(routeLabel)} is already configured in this process.\n`,
    );
  }
  write([
    `Starting Synapsor Analytics with ${theme.key(routeLabel)}.`,
    `Terminal Ask model: ${theme.key(selection.model)}`,
    "This selection is separate from the saved Boundary drafting provider and any external MCP client.",
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
  if (env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  return "openai";
}

export function soleConfiguredHostedRoute(
  env: NodeJS.ProcessEnv,
): HostedProvider | undefined {
  const configured = [
    ...(env.OPENAI_API_KEY?.trim() ? ["openai" as const] : []),
    ...(env.ANTHROPIC_API_KEY?.trim() ? ["anthropic" as const] : []),
    ...(env.OPENROUTER_API_KEY?.trim() ? ["openrouter" as const] : []),
  ];
  return configured.length === 1 ? configured[0] : undefined;
}

export function defaultPostActivationAskSelection(
  env: NodeJS.ProcessEnv,
): Extract<PostActivationAskSelection, { route: HostedProvider }> {
  const route = preferredRoute(env);
  if (route === "openrouter") return { route, model: DEFAULT_OPENROUTER_MODEL };
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
): Extract<PostActivationAskSelection, { route: HostedProvider }> | undefined {
  const route = soleConfiguredHostedRoute(env);
  if (!route) return undefined;
  return { route, model: defaultHostedModel(route) };
}

export function formatPostActivationAskSelection(
  selection: PostActivationAskSelection,
): string {
  if (selection.route === "mcp-client") return `Local stdio MCP / ${managedMcpClientLabel(selection.client)}`;
  if (selection.route === "mcp-http") return "Production HTTP MCP";
  if (selection.route === "edit-rules") return "Edit rules with model";
  if (selection.route === "create-outcome") return "Create the first verified outcome";
  if (selection.route === "review-outcomes") return "Review saved verified outcomes";
  if (selection.route === "manual-editor") return "Manual Boundary editor";
  if (selection.route === "owner-rules") return "Owner-customizable agent rules";
  if (selection.route === "execution-setup") return "Execution setup";
  if (selection.route === "later") return "Choose later";
  if (selection.route === "openai") return `OpenAI / ${selection.model}`;
  if (selection.route === "anthropic") return `Anthropic / ${selection.model}`;
  if (selection.route === "openrouter") return `OpenRouter + serving provider / ${selection.model}`;
  return `Local OpenAI-compatible / ${selection.model}`;
}

export async function choosePostActivationAskSelection(
  dependencies: Pick<
    PostActivationAskDependencies,
    "chooseRoute" | "chooseMcpClient" | "promptWithDefault" | "listOpenAiCompatibleModels" | "listHostedModels" | "chooseHostedModel" | "env"
  > = {},
  initialRoute?: PostActivationAskRoute,
  createFirstOutcome = false,
  reviewSavedOutcomes = false,
): Promise<PostActivationAskSelection | undefined> {
  const env = dependencies.env ?? process.env;
  const prompt = dependencies.promptWithDefault
    ?? ((label, defaultValue) =>
      promptWithDefault(label, defaultValue, process.stdin, process.stderr));
  while (true) {
    const route = dependencies.chooseRoute
      ? await dependencies.chooseRoute(initialRoute ?? preferredRoute(env),
        routeOptions.filter((option) => (option.id !== "create-outcome" || createFirstOutcome)
          && (option.id !== "review-outcomes" || reviewSavedOutcomes)))
      : await chooseRouteInTerminal(
        initialRoute ?? preferredRoute(env),
        process.stdin as ReadStream,
        process.stderr as WriteStream,
        createFirstOutcome,
        reviewSavedOutcomes,
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
    if (route === "mcp-http" || route === "later" || route === "edit-rules" || route === "create-outcome" || route === "review-outcomes" || route === "manual-editor" || route === "execution-setup" || route === "owner-rules") return { route };
    if (route === "openai") {
      const model = await prompt("Terminal Ask model (OpenAI)", DEFAULT_TERMINAL_OPENAI_ASK_MODEL);
      if (model === undefined) continue;
      return { route, model };
    }
    if (route === "anthropic") {
      const model = await prompt("Terminal Ask model (Anthropic)", DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL);
      if (model === undefined) continue;
      return { route, model };
    }
    if (route === "openrouter") {
      const models = await (dependencies.listHostedModels ?? discoverHostedProviderModels)({
        provider: route, apiKey: env[defaultProviderKeyEnv(route)] ?? "",
      }).catch(() => []);
      const model = models.length
        ? await (dependencies.chooseHostedModel ?? (async (available, current) => {
          const session = createBoundaryReviewInteractiveSession();
          if (!session.chooseOption) return prompt("OpenRouter model (publisher/model)", current);
          const selected = await session.chooseOption("OpenRouter model", [
            ...[...new Set([current, ...available])].map((id) => ({ value: id, label: id })),
            { value: "manual", label: "Enter another exact model ID" },
          ], { initialValue: current, requireExplicitSelection: true, context: [OPENROUTER_EGRESS, "Listed models advertise text and tool support. Availability is checked on the first request."] });
          return selected === "manual" ? prompt("OpenRouter model (publisher/model)", current) : selected;
        }))(models, DEFAULT_OPENROUTER_MODEL)
        : await prompt("OpenRouter model (catalog unavailable; checked on first request)", DEFAULT_OPENROUTER_MODEL);
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
      const model = await prompt(`Terminal Ask model (local)${detectedLabel}`, defaultModel);
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
  localTestRuntimeBindings: readonly string[] = [],
): string {
  const root = shellToken(projectRoot);
  const launch = client === "claude-code"
    ? "claude"
    : client === "cursor"
      ? `cursor ${root}`
      : `code ${root}`;
  const localTestRuntime = new Set(localTestRuntimeBindings);
  const missingBindings = runtimeBindings.filter((binding) => !configuredBindings.includes(binding.environment));
  const localTestRuntimeConfigured = runtimeBindings.some((binding) => localTestRuntime.has(binding.environment));
  return [
    localTestRuntimeConfigured
      ? "LOCAL STDIO MCP CONFIGURED; LOCAL TEST RUNTIME CONFIGURED"
      : runtimeIdentity !== "production_authentication" && missingBindings.length
      ? "LOCAL STDIO MCP CONFIGURED; NOT READY FOR CUSTOMER USE"
      : "LOCAL STDIO MCP CONFIGURED; CUSTOMER USE NOT VERIFIED",
    `${managedMcpClientLabel(client)} launches Runner with the four fixed tools. Do not start a separate MCP server.`,
    ...(!includeActions ? ["Read only: no Action is active; change requests remain refused."] : []),
    ...(runtimeIdentity === "production_authentication"
      ? ["Production identity comes from the reviewed authenticated session. Do not copy fixture values or accept identity from a client prompt or model."]
      : localTestRuntimeConfigured
        ? [
            "The reviewed fixture identity is in an owner-only local project runtime file. It is not copied to .mcp.json, authority, source, provider request, or normal output.",
            "The managed client and reviewed worker load this fixed local reference; start or restart the client normally. Local applications and programs running as your user can read these values. This is not production authentication.",
          ]
      : runtimeBindings.length
      ? missingBindings.length ? [
          `Local test identity still needed: ${missingBindings.map((binding) => binding.environment).join(", ")}.`,
          "Return to the local-test identity review; Runner never accepts identity values from MCP tool arguments or a model. Production requires authenticated session identity.",
        ]
        : ["Local test identity is supplied by the reviewed local runtime environment. Identity values are not authenticated or proven by the MCP handshake; every tool use still enforces the reviewed scope."]
      : ["Start or restart the client from the trusted runtime environment required by this reviewed boundary. Identity is not supplied by the model or client config."]),
    `  cd ${root}`,
    `  ${launch}`,
    "",
  ].join("\n");
}

async function collectLocalTestIdentity(input: {
  projectRoot: string;
  client: ManagedMcpProjectClient;
  bindings: ReviewedRuntimeBinding[];
}): Promise<Record<string, string> | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  const session = createBoundaryReviewInteractiveSession();
  const accepted = await session.confirm("Use a trusted local test identity for this setup session?", {
    defaultValue: false,
    context: [
      `${managedMcpClientLabel(input.client)} is configured. Save a reviewed fixture identity for this project's managed local client and supervised worker.`,
      `Required reviewed bindings: ${input.bindings.map((binding) => `${binding.role} (${binding.environment})`).join(", ")}.`,
      "Values are stored only in an owner-only local project runtime file, not in .mcp.json, authority, model/provider requests, or client configuration.",
      "Local applications and programs running as your user can read this file. This is local test setup, not production authentication. Esc keeps setup pending without changing generated client configuration.",
    ],
  });
  if (!accepted) return undefined;
  const values: Record<string, string> = {};
  for (const binding of input.bindings) {
    try {
      values[binding.environment] = await readHiddenLocalIdentity(
        `Trusted local test ${binding.role} value for ${binding.environment} (hidden) [Esc Back]: `,
      );
    } catch (error) {
      if (error instanceof ProviderCredentialInputCancelledError) return undefined;
      throw error;
    }
  }
  return values;
}

function validateLocalTestIdentity(
  bindings: ReviewedRuntimeBinding[],
  values: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(bindings.map((binding) => binding.environment));
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw new Error("LOCAL_TEST_IDENTITY_INVALID: local test setup supplied an unreviewed environment binding.");
  }
  const result: Record<string, string> = {};
  for (const binding of bindings) {
    const value = values[binding.environment];
    if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/u.test(value)) {
      throw new Error(`LOCAL_TEST_IDENTITY_INVALID: provide one nonblank printable ${binding.role} identity for this local test session.`);
    }
    result[binding.environment] = value.trim();
  }
  return result;
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
    readSemanticActivation?: typeof readActionRuleAuthorityActivation;
    loadSemanticAuthority?: typeof loadActiveActionRuleAuthority;
  } = {},
): Promise<boolean> {
  if (await (dependencies.readSemanticActivation ?? readActionRuleAuthorityActivation)(projectRoot) === undefined) return false;
  const semantic = await (dependencies.loadSemanticAuthority ?? loadActiveActionRuleAuthority)(projectRoot);
  return semantic.registry.rules.length > 0;
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
    executionPending ? "Setup saved. Execution review is still pending." : "Setup saved. Your reviewed boundaries remain active.",
    ...(executionPending ? ["Read and reviewed change-request rules are active.",
      paused ? `Last check: ${paused.problem.summary}` : "Automatic completion is not fully configured: execution setup still needs review.",
      paused?.problem.publication_state ? "Next: reopen Execution setup to recover the exact save. Pausing does not disable existing execution."
        : paused ? "Next: review the saved writer requirements, repair the connection, then resume Execution setup."
          : "Next: reopen Execution setup when you want to review the remaining outcomes. Existing execution settings are preserved."] : []),
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
  createFirstOutcome = false,
  reviewSavedOutcomes = false,
): Promise<PostActivationAskRoute | undefined> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("The post-activation Ask choice requires a real terminal.");
  }
  const primary = ["mcp-client", "edit-rules", "execution-setup", "later", ...(createFirstOutcome ? ["create-outcome"] : []),
    ...(reviewSavedOutcomes ? ["review-outcomes"] : [])];
  let more = !primary.includes(defaultRoute);
  const options = () => [...routeOptions.filter((option) => (option.id !== "create-outcome" || createFirstOutcome)
    && (option.id !== "review-outcomes" || reviewSavedOutcomes)
    && (more ? !primary.includes(option.id) : primary.includes(option.id))),
    { id: "more" as const, label: more ? "Back to client setup" : "More options", detail: more ? "" : "Terminal chat, production HTTP and manual controls" }];
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
import { defaultHostedModel, defaultProviderKeyEnv, DEFAULT_OPENROUTER_MODEL, OPENROUTER_EGRESS, type HostedProvider } from "./hosted-provider-settings.js";
import { discoverHostedProviderModels } from "./hosted-provider-models.js";
