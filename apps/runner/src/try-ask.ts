import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import {
  collectAnalyticsAnalyses,
  analysisJson,
  renderAnalyticsTurn,
} from "./analytics-shell-render.js";
import {
  readReviewedAskAccessSummary,
  resolveAskAccessGuidance,
  type AskAccessGuidance,
} from "./ask-access-summary.js";
import {
  createTerminalAnalyticsShellIo,
  runAnalyticsShell,
  type AnalyticsShellIo,
  type ShellAnalysisRecord,
} from "./analytics-shell.js";
import {
  computeAskAuthority,
  resolveActiveBoundarySummary,
  resolveAskDeploymentProfile,
  resolvePendingBoundaryReviewSummary,
} from "./ask-authority.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";
import { assertKnownOptions, optionalArg, positional } from "./cli-options.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { startLocalUiServer } from "./local-ui.js";
import {
  AskError,
  WorkbenchAskSession,
  type AskProviderDependencies,
  type AskProvider,
  type AskToolGateway,
} from "./model-ask.js";
import { resolveSynapsorProject } from "./project-resolution.js";
import {
  activateProtectedQuery,
  createProtectedQueryDraft,
  describeProtectableAnalysis,
  listProtectableQueries,
  suggestProtectedCapabilityName,
} from "./protect-query.js";
import {
  bindProtectedPlansToAnswer,
  NO_REVIEWED_ANALYTICS_ACCESS_MESSAGE,
} from "./scoped-explore.js";
import { readHiddenSecret } from "./secret-input.js";
import { terminalTheme } from "./boundary-cli-picker.js";
import { inspectCompiledExplorePlan } from "./explore-operator-evidence.js";
import { readGuidedOnboardingState } from "./guided-project.js";
import { readTerminalTextWithEscape } from "./terminal-prompt.js";
import {
  padTerminalBlock,
  terminalContentWidth,
} from "./terminal-layout.js";

export type TryAskDependencies = {
  env?: NodeJS.ProcessEnv;
  gatewayFactory?: typeof createWorkbenchAskMcpGateway;
  providerDependencies?: AskProviderDependencies;
  profileResolver?: typeof resolveAskDeploymentProfile;
  confirmEgress?: (review: {
    provider: string;
    model: string;
    endpointOrigin: string;
    tools: string[];
  }) => Promise<boolean>;
  shellIo?: AnalyticsShellIo;
  bindPlansToAnswer?: typeof bindProtectedPlansToAnswer;
  listProtectable?: typeof listProtectableQueries;
  createProtectedDraft?: typeof createProtectedQueryDraft;
  activateProtected?: typeof activateProtectedQuery;
  uiServerFactory?: typeof startLocalUiServer;
  runTerminalBoundaryReview?: (input: {
    projectRoot: string;
    activationReviewNotice: string;
    onActivated: () => Promise<number>;
  }) => Promise<number>;
  runPostAccessAsk?: (args: string[]) => Promise<number>;
  readSecret?: typeof readHiddenSecret;
};

export async function tryAsk(
  args: string[],
  dependencies: TryAskDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const gatewayFactory = dependencies.gatewayFactory ?? createWorkbenchAskMcpGateway;
  const profileResolver = dependencies.profileResolver ?? resolveAskDeploymentProfile;
  assertKnownOptions(
    args,
    new Set([
      "--project-root",
      "--config",
      "--store",
      "--provider",
      "--model",
      "--base-url",
      "--api-key-env",
      "--mode",
      "--consent",
      "--verbose",
      "--json",
    ]),
    "try ask",
  );
  const question = positional(args, 0)?.trim();
  const json = args.includes("--json");
  const verbose = args.includes("--verbose");
  if (!question && json) {
    throw new Error("try ask --json requires one positional question.");
  }
  const requestedMode = optionalArg(args, "--mode");
  if (requestedMode && requestedMode !== "auto" && requestedMode !== "authoring") {
    throw new AskError(
      "ASK_AUTHORING_ONLY",
      "try ask is the Scoped Explore analytics surface and supports authoring mode only.",
      409,
    );
  }
  const provider = providerValue(optionalArg(args, "--provider"));
  const model = resolveAskModel(provider, optionalArg(args, "--model"));
  const projectRoot = path.resolve(optionalArg(args, "--project-root") ?? process.cwd());
  const guidedState = await readGuidedOnboardingState(projectRoot);
  const boundaryArtifactsRoot = path.resolve(
    projectRoot,
    guidedState?.artifacts.boundary_root ?? "synapsor/generated",
  );
  const discovered = await resolveSynapsorProject(projectRoot, env);
  const configPath = path.resolve(
    optionalArg(args, "--config")
      ?? discovered?.config_path
      ?? path.join(projectRoot, "synapsor/synapsor.runner.json"),
  );
  const storePath = path.resolve(
    optionalArg(args, "--store")
      ?? discovered?.store_path
      ?? path.join(projectRoot, ".synapsor/local.db"),
  );
  const apiKeyEnv = optionalArg(args, "--api-key-env")
    ?? (provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : undefined);
  let pastedSecret: string | undefined;
  if (provider !== "openai_compatible" && (!apiKeyEnv || !env[apiKeyEnv]?.trim())) {
    if (!dependencies.readSecret && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      throw new Error(
        `${providerLabel(provider)} credential is unavailable. Export ${apiKeyEnv ?? "a provider key environment variable"} or use an interactive hidden prompt.`,
      );
    }
    pastedSecret = await (dependencies.readSecret ?? readHiddenSecret)(
      `${providerLabel(provider)} API key (hidden, memory only) [Esc Back]: `,
    );
  }

  let initialGateway: AskToolGateway | undefined;
  let workbench: Awaited<ReturnType<typeof startLocalUiServer>> | undefined;
  const session = new WorkbenchAskSession();
  try {
    initialGateway = await gatewayFactory({
      configPath,
      storePath,
      projectRoot,
      env,
      mode: "authoring",
    });
    const tools = await initialGateway.listTools();
    assertAnalyticsTools(tools.map((tool) => tool.name));
    const profile = await profileResolver(projectRoot);
    if (profile !== "development" && profile !== "staging") {
      throw new AskError(
        "ASK_AUTHORING_UNAVAILABLE",
        NO_REVIEWED_ANALYTICS_ACCESS_MESSAGE,
        409,
      );
    }
    let authority = await computeAskAuthority({
      tools,
      configPath,
      projectRoot,
      profile,
      mode: "authoring",
    });
    let configuration = session.configure({
      provider,
      model,
      ...(optionalArg(args, "--base-url") ? { base_url: optionalArg(args, "--base-url") } : {}),
      ...(pastedSecret
        ? { api_key: pastedSecret }
        : apiKeyEnv
          ? { api_key_env: apiKeyEnv }
          : {}),
      authority_digest: authority.authority_digest,
      egress_acknowledged: true,
    }, env);
    pastedSecret = undefined;
    await requireEgressConsent({
      args,
      configuration,
      provider,
      model,
      mode: "authoring",
      tools: tools.map((tool) => tool.name),
      json,
      ...(dependencies.confirmEgress ? { confirmEgress: dependencies.confirmEgress } : {}),
    });

    const rebindAfterReviewedActivation = async (): Promise<number> => {
      let gateway: AskToolGateway | undefined;
      try {
        gateway = await gatewayFactory({
          configPath,
          storePath,
          projectRoot,
          env,
          mode: "authoring",
        });
        const currentTools = await gateway.listTools();
        assertAnalyticsTools(currentTools.map((tool) => tool.name));
        const currentAuthority = await computeAskAuthority({
          tools: currentTools,
          configPath,
          projectRoot,
          profile,
          mode: "authoring",
        });
        if (currentAuthority.authority_digest === authority.authority_digest) return 0;

        configuration = session.rebindAuthority(currentAuthority.authority_digest);
        authority = currentAuthority;
        const theme = terminalTheme(
          process.stdout.isTTY === true && !("NO_COLOR" in env),
        );
        writeInteractiveStdout([
          theme.success("Ask access updated"),
          `${theme.key(providerDisplayLabel(provider, configuration.endpoint_scope))} / ${theme.key(model)} is bound to the newly activated reviewed access.`,
          "Conversation context was cleared. No provider request was made.",
          "",
        ].join("\n"));
        return 0;
      } finally {
        await gateway?.close().catch(() => undefined);
      }
    };

    const ask = async (
      plainQuestion: string,
      onProgress?: (phase: "provider" | "tool") => void,
    ) => {
      let gateway = initialGateway ?? await gatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env,
        mode: "authoring",
      });
      initialGateway = undefined;
      const currentTools = await gateway.listTools();
      assertAnalyticsTools(currentTools.map((tool) => tool.name));
      const currentAuthority = await computeAskAuthority({
        tools: currentTools,
        configPath,
        projectRoot,
        profile,
        mode: "authoring",
      });
      if (currentAuthority.authority_digest !== authority.authority_digest) {
        await gateway.close().catch(() => undefined);
        throw new AskError(
          "ASK_AUTHORITY_CHANGED",
          "Reviewed access changed outside this Ask handoff. Your question was not sent. Run /access to review it here, or restart `synapsor-runner try ask` to confirm the new provider access before asking.",
          409,
        );
      }
      const turn = await session.run(
        plainQuestion,
        gateway,
        {
          ...(dependencies.providerDependencies ?? {}),
          ...(onProgress
            ? {
                onProgress: (event) => {
                  dependencies.providerDependencies?.onProgress?.(event);
                  onProgress(event.phase);
                },
              }
            : {}),
        },
        currentAuthority.authority_digest,
        async () => revalidateCliAskAuthority({
          configPath,
          storePath,
          projectRoot,
          profile,
          env,
          gatewayFactory,
        }),
      );
      const analyses = collectAnalyticsAnalyses(turn.tool_calls);
      const completedDataPlan = turn.tool_calls.some((call) =>
        call.tool === "app.explore_data"
        && call.status === "ok"
        && call.result.ok !== false);
      const accessGuidance = completedDataPlan
        ? undefined
        : await resolveAskAccessGuidance({
            projectRoot,
            question: plainQuestion,
            toolCalls: turn.tool_calls,
          }).catch(() => undefined);
      const references = analyses.flatMap((analysis) =>
        analysis.reference ? [analysis.reference] : []);
      const answerId = `ans_${crypto.randomBytes(12).toString("hex")}`;
      if (references.length > 0) {
        await (dependencies.bindPlansToAnswer ?? bindProtectedPlansToAnswer)({
          projectRoot,
          tokens: references,
          answerId,
        });
      }
      return {
        turn,
        analyses,
        answer_id: answerId,
        ...(accessGuidance ? { access_guidance: accessGuidance } : {}),
      };
    };

    if (question) {
      const response = await ask(question);
      const payload = askJsonPayload({
        provider,
        model,
        turn: response.turn,
        analyses: response.analyses,
        accessGuidance: response.access_guidance,
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        writeInteractiveStdout(renderAnalyticsTurn(
          response.turn,
          response.analyses,
          process.stdout.isTTY
            ? terminalContentWidth(process.stdout.columns)
            : process.stdout.columns ?? 100,
          {
            ansi: Boolean(process.stdout.isTTY),
            includeAttempts: verbose,
            attemptsHint: "Rerun with --verbose to inspect them.",
            accessGuidance: response.access_guidance,
          },
        ));
      }
      return 0;
    }

    while (true) {
      const accessSummary = await loadReviewedAccessSummary({
      gatewayFactory,
      configPath,
      storePath,
      projectRoot,
      env,
      });
      const activeBoundary = await resolveActiveBoundarySummary(projectRoot);
      const pendingBoundaryReview = await resolvePendingBoundaryReviewSummary(projectRoot);
      const listProtectable = dependencies.listProtectable ?? listProtectableQueries;
      const createDraft = dependencies.createProtectedDraft ?? createProtectedQueryDraft;
      const activateProtected = dependencies.activateProtected ?? activateProtectedQuery;
      const uiFactory = dependencies.uiServerFactory ?? startLocalUiServer;
      const shellExit = await runAnalyticsShell({
      projectRoot,
      providerLabel: providerDisplayLabel(provider, configuration.endpoint_scope),
      modelLabel: model,
      boundaryLabel: activeBoundary?.name,
      profileLabel: profile,
      reviewedDataAreas: accessSummary.table_count,
      accessSummary,
      pendingBoundaryReview,
      operatorLabel: localAskOperator(env),
      verboseAttempts: verbose,
      io: dependencies.shellIo ?? createTerminalAnalyticsShellIo(),
      ask,
      listAnalyses: async () => {
        const available = await listProtectable({ projectRoot });
        return available.map((item): ShellAnalysisRecord => ({
          token: item.token,
          expires_at: item.expires_at,
          boundary_digest: item.boundary_digest,
          normalized_plan: item.normalized_plan,
          ...(item.created_at ? { created_at: item.created_at } : {}),
          ...(item.answer_id ? { answer_id: item.answer_id } : {}),
          ...(item.evidence_bundle_id ? { evidence_bundle_id: item.evidence_bundle_id } : {}),
          ...(item.query_audit_handle ? { query_audit_handle: item.query_audit_handle } : {}),
          ...(item.outcome ? { outcome: item.outcome } : {}),
          ...(item.returned_rows_or_groups === undefined ? {} : {
            returned_rows_or_groups: item.returned_rows_or_groups,
          }),
          ...(item.returned_cells === undefined ? {} : { returned_cells: item.returned_cells }),
          ...(item.suppressed_groups === undefined ? {} : { suppressed_groups: item.suppressed_groups }),
          ...(item.minimum_cohort_override
            ? { minimum_cohort_override: item.minimum_cohort_override }
            : {}),
          description: describeProtectableAnalysis(item.normalized_plan),
          suggested_capability: suggestProtectedCapabilityName(item.normalized_plan),
        }));
      },
      protect: async ({
        reference,
        capabilityName,
        minimumCohortConfirmation,
        minimumCohortConfirmed,
        minimumCohortActor,
      }) => {
        const created = await createDraft({
          projectRoot,
          token: reference,
          capabilityName,
          description: "Answer one reviewed bounded analysis.",
          returnsHint: "Returns only the reviewed bounded result shape.",
          env,
          ...(minimumCohortConfirmation ? { minimumCohortConfirmation } : {}),
          ...(minimumCohortConfirmed ? { minimumCohortConfirmed } : {}),
          ...(minimumCohortActor ? { minimumCohortActor } : {}),
        });
        return {
          draft: created.draft,
          dsl: created.dsl,
        };
      },
      activateProtected: async ({
        capabilityName,
        reviewedDigest,
        actor,
        minimumCohortConfirmed,
      }) => {
        const active = await activateProtected({
          projectRoot,
          capabilityName,
          expectedDigest: reviewedDigest,
          operatorConfirmed: true,
          actor,
          ...(minimumCohortConfirmed ? { minimumCohortConfirmed } : {}),
          configPath,
          disableExplore: false,
          env,
        });
        await rebindAfterReviewedActivation();
        return active;
      },
      inspectAnalysis: ({ record }) => inspectCompiledExplorePlan({
        projectRoot,
        boundaryDigest: record.boundary_digest,
        plan: record.normalized_plan,
      }),
      openAccessEditor: async () => {
        workbench ??= await uiFactory({
          configPath,
          storePath,
          projectRoot,
          boundaryRoot: boundaryArtifactsRoot,
          host: "127.0.0.1",
          port: 0,
          deploymentProfile: profile,
        });
        return { workbenchUrl: workbench.url };
      },
      clearConversation: () => session.clearConversation(),
      cancel: () => session.cancel(),
      });
      if (shellExit !== "access") return 0;

      await initialGateway?.close().catch(() => undefined);
      initialGateway = undefined;
      const runBoundaryReview = dependencies.runTerminalBoundaryReview
        ?? (async (reviewInput: {
          projectRoot: string;
          activationReviewNotice: string;
          onActivated: () => Promise<number>;
        }) => {
          const [{ boundaryReviewCommand }, { inspectDatabase }] = await Promise.all([
            import("./boundary-commands.js"),
            import("@synapsor-runner/schema-inspector"),
          ]);
          return boundaryReviewCommand(
            ["--project-root", reviewInput.projectRoot, "--access"],
            inspectDatabase,
            undefined,
            async () => reviewInput.onActivated(),
            {
              activationReviewNotice: () => reviewInput.activationReviewNotice,
              startAtBoundaryList: true,
            },
          );
        });
      const activationReviewNotice = formatProviderEgressActivationNotice({
        provider: providerDisplayLabel(provider, configuration.endpoint_scope),
        model,
        endpointOrigin: configuration.endpoint_origin,
        local: configuration.endpoint_scope === "custom_loopback",
      }, process.stdout.isTTY === true && !("NO_COLOR" in env));
      let reviewResult: number;
      try {
        reviewResult = await runBoundaryReview({
          projectRoot,
          activationReviewNotice,
          onActivated: rebindAfterReviewedActivation,
        });
      } catch (error) {
        try {
          await rebindAfterReviewedActivation();
        } catch {
          throw error;
        }
        const theme = terminalTheme(
          process.stdout.isTTY === true && !("NO_COLOR" in env),
        );
        writeInteractiveStdout([
          theme.warning("Boundary was not activated"),
          redactCliErrorMessage(error instanceof Error ? error.message : String(error)),
          "Your previous reviewed Ask access is still active. Returning to Ask.",
          "",
        ].join("\n"));
        continue;
      }
      if (reviewResult !== 0) return reviewResult;
    }
  } finally {
    pastedSecret = undefined;
    session.clear();
    await initialGateway?.close().catch(() => undefined);
    await workbench?.close().catch(() => undefined);
  }
  return 0;
}

async function revalidateCliAskAuthority(input: {
  configPath: string;
  storePath: string;
  projectRoot: string;
  profile: "development" | "staging";
  env: NodeJS.ProcessEnv;
  gatewayFactory: typeof createWorkbenchAskMcpGateway;
}): Promise<`sha256:${string}`> {
  let gateway: AskToolGateway | undefined;
  try {
    gateway = await input.gatewayFactory({
      configPath: input.configPath,
      storePath: input.storePath,
      projectRoot: input.projectRoot,
      env: input.env,
      mode: "authoring",
    });
    const tools = await gateway.listTools();
    assertAnalyticsTools(tools.map((tool) => tool.name));
    if (gateway.mode !== "authoring") {
      throw new AskError("ASK_AUTHORITY_CHANGED", "Ask mode changed during the provider session.", 409);
    }
    return (await computeAskAuthority({
      tools,
      configPath: input.configPath,
      projectRoot: input.projectRoot,
      profile: input.profile,
      mode: "authoring",
    })).authority_digest;
  } finally {
    await gateway?.close().catch(() => undefined);
  }
}

async function requireEgressConsent(input: {
  args: string[];
  configuration: ReturnType<WorkbenchAskSession["configure"]>;
  provider: AskProvider;
  model: string;
  mode: "authoring";
  tools: string[];
  json: boolean;
  confirmEgress?: TryAskDependencies["confirmEgress"];
}): Promise<void> {
  if (input.configuration.endpoint_scope === "custom_loopback") return;
  const expectedConsent = `ALLOW EGRESS ${input.configuration.consent_fingerprint}`;
  let consent = optionalArg(input.args, "--consent")?.trim();
  if (
    !consent
    && !input.json
    && (input.confirmEgress || (process.stdin.isTTY && process.stdout.isTTY))
  ) {
    const review = {
      provider: providerDisplayLabel(input.provider, input.configuration.endpoint_scope),
      model: input.model,
      endpointOrigin: input.configuration.endpoint_origin,
      tools: input.tools,
    };
    writeInteractiveStdout(formatProviderEgressReview(
      review,
      process.stdout.isTTY === true && !("NO_COLOR" in process.env),
    ));
    const accepted = input.confirmEgress
      ? await input.confirmEgress(review)
      : await confirmProviderEgress();
    if (!accepted) {
      throw new AskError(
        "ASK_EGRESS_CONSENT_DECLINED",
        "Provider egress was not approved. No provider request was made.",
        409,
      );
    }
    consent = expectedConsent;
  }
  if (consent !== expectedConsent) {
    throw new AskError(
      "ASK_EGRESS_CONSENT_REQUIRED",
      `Ask requires the exact non-secret consent ${expectedConsent}.`,
      409,
    );
  }
}

export function formatProviderEgressReview(input: {
  provider: string;
  model: string;
  endpointOrigin: string;
}, color = false): string {
  const theme = terminalTheme(color);
  return [
    theme.title("Provider egress review"),
    `  ${theme.key(input.provider)} will receive your question and only data allowed by the active reviewed boundaries.`,
    `  Model: ${theme.key(input.model)}`,
    `  Endpoint: ${theme.scope(input.endpointOrigin)}`,
    "  Model-withheld and kept-out raw values are never sent.",
    "  Trusted scope stays fixed outside model arguments; its raw column value is sent only when reviewed as Model + Runner.",
    "  The model cannot activate, approve, apply, or change this authority.",
    "",
  ].join("\n");
}

export function formatProviderEgressActivationNotice(input: {
  provider: string;
  model: string;
  endpointOrigin: string;
  local: boolean;
}, color = false): string {
  const theme = terminalTheme(color);
  return [
    theme.title("Model continuation"),
    input.local
      ? `  After activation, ${theme.key(input.provider)} / ${theme.key(input.model)} at ${theme.scope(input.endpointOrigin)} may use only the Model + Runner fields shown above.`
      : `  After activation, ${theme.key(input.provider)} / ${theme.key(input.model)} at ${theme.scope(input.endpointOrigin)} may receive only the Model + Runner fields shown above.`,
    input.local
      ? "  Confirming activation binds this exact reviewed access to the current local Ask session."
      : "  Confirming activation also renews provider egress consent for this exact reviewed access in the current Ask session.",
    "  Model-withheld and kept-out raw values remain unavailable to the model.",
    "  Activation itself makes no provider request.",
    "",
  ].join("\n");
}

function writeInteractiveStdout(value: string): void {
  process.stdout.write(process.stdout.isTTY ? padTerminalBlock(value) : value);
}

async function confirmProviderEgress(): Promise<boolean> {
  while (true) {
    const answer = await readTerminalTextWithEscape(
      "Continue? [Y/n] [Esc Back]: ",
      process.stdin as ReadStream,
      process.stderr as WriteStream,
    );
    if (answer === undefined) return false;
    const decision = parseEgressConfirmation(answer);
    if (decision !== undefined) return decision;
    process.stderr.write(process.stderr.isTTY
      ? padTerminalBlock("Press Enter or type y for Yes; type n for No; Esc returns.\n")
      : "Press Enter or type y for Yes; type n for No; Esc returns.\n");
  }
}

export function parseEgressConfirmation(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return undefined;
}

async function loadReviewedAccessSummary(input: {
  gatewayFactory: typeof createWorkbenchAskMcpGateway;
  configPath: string;
  storePath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<Awaited<ReturnType<typeof readReviewedAskAccessSummary>>> {
  let gateway: AskToolGateway | undefined;
  try {
    gateway = await input.gatewayFactory({
      configPath: input.configPath,
      storePath: input.storePath,
      projectRoot: input.projectRoot,
      env: input.env,
      mode: "authoring",
    });
    return await readReviewedAskAccessSummary(gateway);
  } finally {
    await gateway?.close().catch(() => undefined);
  }
}

function askJsonPayload(input: {
  provider: AskProvider;
  model: string;
  turn: Awaited<ReturnType<WorkbenchAskSession["run"]>>;
  analyses: ReturnType<typeof collectAnalyticsAnalyses>;
  accessGuidance?: AskAccessGuidance;
}): Record<string, unknown> {
  return {
    ok: true,
    mode: "authoring",
    provider: input.provider,
    model: input.model,
    answer: input.turn.answer,
    answer_is_untrusted_model_output: input.turn.answer_is_untrusted_model_output,
    answer_source: input.turn.answer_source,
    runner_verified_analysis: {
      authority_digest: input.turn.authority_digest,
      tools_called: input.turn.tool_calls.map((call) => call.tool),
      analyses: input.analyses.map(analysisJson),
      database_result_verified: input.turn.tool_calls.some((call) =>
        call.tool === "app.explore_data" && call.status === "ok"),
      source_database_changed: false,
    },
    ...(input.turn.usage ? { usage: input.turn.usage } : {}),
    ...(input.accessGuidance ? { access_guidance: input.accessGuidance } : {}),
    source_database_changed: false,
    model_can_activate: false,
    model_can_approve: false,
    model_can_apply: false,
  };
}

function assertAnalyticsTools(names: string[]): void {
  const actual = [...names].sort();
  const expected = ["app.describe_data", "app.explore_data"];
  if (actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])) {
    throw new AskError(
      "ASK_AUTHORING_TOOL_SURFACE_INVALID",
      "Synapsor Analytics exposes exactly app.describe_data and app.explore_data.",
      409,
    );
  }
}

function providerValue(value: string | undefined): AskProvider {
  if (value === "openai") return "openai";
  if (value === "anthropic") return "anthropic";
  if (value === "openai-compatible") return "openai_compatible";
  throw new Error("try ask requires --provider openai|anthropic|openai-compatible.");
}

export function resolveAskModel(provider: AskProvider, value: string | undefined): string {
  const requested = value?.trim();
  if (requested) return requested;
  if (provider === "openai") return "gpt-5-mini";
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  throw new Error("try ask requires --model <value> for an OpenAI-compatible endpoint.");
}

function providerLabel(provider: AskProvider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return "OpenAI-compatible";
}

export function providerDisplayLabel(
  provider: AskProvider,
  endpointScope: "official_remote" | "custom_remote" | "custom_loopback",
): string {
  if (provider !== "openai_compatible") return providerLabel(provider);
  return endpointScope === "custom_loopback"
    ? "OpenAI-compatible (local/loopback)"
    : "OpenAI-compatible (custom remote)";
}

function localAskOperator(env: NodeJS.ProcessEnv): string {
  return env.SYNAPSOR_OPERATOR_ID?.trim().slice(0, 128)
    || env.USER?.trim().slice(0, 128)
    || env.USERNAME?.trim().slice(0, 128)
    || "local-developer";
}
