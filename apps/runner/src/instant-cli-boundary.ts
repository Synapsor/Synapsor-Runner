import type { InspectEngine, SchemaInspection } from "@synapsor-runner/schema-inspector";
import process from "node:process";
import {
  activateExplorationBoundary,
  compareGenerationLock,
  explorationBoundaryCandidateDigest,
  generationLockRemediation,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import type {
  BoundaryReviewInteractiveSession,
} from "./boundary-cli-picker.js";
import { terminalTheme } from "./boundary-cli-picker.js";
import { instantLocalBoundaryCandidate } from "./boundary-candidate.js";
import { updateGuidedOnboardingState } from "./guided-project.js";
import { buildInstantFirstValue } from "./instant-first-value.js";
import {
  choosePostActivationAskSelection,
  formatPostActivationAskSelection,
  type PostActivationAskSelection,
} from "./post-activation-ask.js";
import {
  saveInstantBoundaryEditBaseline,
  saveInstantBoundaryReviewBaseline,
} from "./boundary-review-domain.js";
import {
  ExploreTrustedScopeError,
  resolveExploreTrustedScope,
  type ExploreTrustedScope,
} from "./explore-trusted-scope.js";
import { cliCommandName } from "./cli-command-meta.js";
import { padTerminalBlock } from "./terminal-layout.js";

export type InstantCliBoundaryActivationResult =
  | {
      accepted: false;
      reason: "operator_requested_detailed_review" | "operator_cancelled" | "not_eligible";
    }
  | {
      accepted: true;
      active: ActivatedExplorationBoundary;
      askSelection: PostActivationAskSelection;
    };

export type InstantCliBoundaryActivationInput = {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  lock: GenerationLock;
  schemaInspector(input: {
    engine: InspectEngine;
    databaseUrlEnv: string;
    schema?: string;
    env: NodeJS.ProcessEnv;
  }): Promise<SchemaInspection>;
  initialInspection?: SchemaInspection;
  regenerateBoundary?: (input: {
    inspection: SchemaInspection;
    draft: ExplorationBoundaryDraft;
    lock: GenerationLock;
  }) => Promise<{
    inspection: SchemaInspection;
    draft: ExplorationBoundaryDraft;
    lock: GenerationLock;
  }>;
  session: Pick<BoundaryReviewInteractiveSession, "promptText">;
  chooseAskSelection?: (
    currentSelection: PostActivationAskSelection | undefined,
  ) => Promise<PostActivationAskSelection | undefined>;
  resolveTrustedScopeFn?: typeof resolveExploreTrustedScope;
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
};

export async function activateInstantCliBoundary(
  input: InstantCliBoundaryActivationInput,
): Promise<InstantCliBoundaryActivationResult> {
  return activateInstantCliBoundaryAttempt(input, undefined);
}

async function activateInstantCliBoundaryAttempt(
  input: InstantCliBoundaryActivationInput,
  initialAskSelection: PostActivationAskSelection | undefined,
): Promise<InstantCliBoundaryActivationResult> {
  const env = input.env ?? process.env;
  const stdout = input.stdout ?? process.stdout;
  const write = (value: string) => stdout.write(
    stdout.isTTY === true ? padTerminalBlock(value) : value,
  );
  const candidate = instantLocalBoundaryCandidate(input.draft);
  const theme = terminalTheme(stdout.isTTY === true && !("NO_COLOR" in env));
  const resource = candidate.pack.resources[0];
  if (!resource) {
    write([
      "Quick Start could not prove a conservative connected starter boundary.",
      "Opening the detailed boundary editor instead. Nothing is active.",
      "",
    ].join("\n"));
    return { accepted: false, reason: "not_eligible" };
  }
  if (resource.minimum_cohort_overridden === true) {
    write([
      "Quick Start cannot accept a lowered privacy threshold.",
      "Opening the detailed boundary editor for an explicit recorded review.",
      "",
    ].join("\n"));
    return { accepted: false, reason: "not_eligible" };
  }

  const trustedScopeResolver = input.resolveTrustedScopeFn ?? resolveExploreTrustedScope;
  let inspection: SchemaInspection;
  let trustedScope: ExploreTrustedScope;
  try {
    inspection = input.initialInspection ?? await input.schemaInspector({
      engine: input.lock.engine,
      databaseUrlEnv: input.lock.source_env,
      schema: input.lock.inspected_schema,
      env,
    });
    const comparison = compareGenerationLock(input.lock, inspection);
    if (!comparison.current) {
      return handleStaleGenerationLock({
        input,
        inspection,
        changes: comparison.changes,
        askSelection: initialAskSelection,
        write,
        theme,
      });
    }
    trustedScope = await trustedScopeResolver({
      boundary: candidate,
      lock: input.lock,
      inspection,
      env,
    });
  } catch (error) {
    const missingBindings = error instanceof ExploreTrustedScopeError
      ? error.missingBindings
      : [];
    if (missingBindings.length > 0) {
      write([
        "Quick Start needs trusted row scope before it can read source data.",
        `Missing operator binding: ${missingBindings.join(", ")}`,
        error instanceof Error ? error.message : "Runner could not verify the database credential's row scope.",
        "Trusted values stay outside model arguments; Runner will not guess them from source rows.",
        "Quick Start paused. Nothing was activated.",
        "Set the missing value in the operator environment, then resume:",
        ...missingBindings.map((binding) => `  export ${binding}='<trusted value>'`),
        `  ${cliCommandName()} start --from-env ${input.lock.source_env} --cli`,
        "Workbench enforces the same requirement and keeps activation disabled until its process receives the value.",
        "",
      ].join("\n"));
      return { accepted: false, reason: "operator_cancelled" };
    }
    write([
      "Quick Start needs trusted row scope before it can read source data.",
      error instanceof Error ? error.message : "Runner could not verify the database credential's row scope.",
      "Trusted values stay outside model arguments; Runner will not guess them from source rows.",
      "Opening the detailed boundary editor. Nothing is active.",
      "",
    ].join("\n"));
    return { accepted: false, reason: "not_eligible" };
  }

  const firstValue = buildInstantFirstValue(candidate);
  const actor = operatorActor(env);
  const digest = explorationBoundaryCandidateDigest(candidate);
  let askSelection = initialAskSelection;
  write(formatInstantCliBoundaryReview({
    draft: input.draft,
    candidate,
    question: firstValue.question,
    actor,
    askSelection,
    trustedScope,
    color: stdout.isTTY === true && !("NO_COLOR" in env),
  }));
  while (true) {
    const actionInput = await input.session.promptText(
      `${theme.key("ENTER")} Start asking   ${theme.key("E")} Change access   ${theme.key("M")} Change model\n${theme.dim("Choice [Enter]:")} `,
    );
    if (actionInput === undefined) {
      write([
        "Quick Start paused. Nothing was activated.",
        "Run the same start command to resume this review.",
        "",
      ].join("\n"));
      return { accepted: false, reason: "operator_cancelled" };
    }
    const action = actionInput.trim().toLowerCase();
    if (!action || action === "y" || action === "yes") {
      if (!askSelection) {
        const selected = input.chooseAskSelection
          ? await input.chooseAskSelection(undefined)
          : await choosePostActivationAskSelection({ env });
        if (!selected) {
          write([
            "Model selection cancelled. Nothing was activated.",
            theme.dim("Back at Quick Start. Press Enter or M to choose a provider."),
            "",
          ].join("\n"));
          continue;
        }
        askSelection = selected;
        write([
          "",
          `${theme.success("Model")} ${formatPostActivationAskSelection(askSelection)}`,
          theme.dim("Provider selected. Continuing with the boundary activation you requested."),
          "",
        ].join("\n"));
      }
      break;
    }
    if (action === "m" || action === "model") {
      const selected: PostActivationAskSelection | undefined = input.chooseAskSelection
        ? await input.chooseAskSelection(askSelection)
        : await choosePostActivationAskSelection({ env });
      if (!selected) {
        write([
          askSelection
            ? "Model selection cancelled. Your previous model is unchanged."
            : "Model selection cancelled. No model is selected yet.",
          theme.dim("Back at Quick Start. Press Enter to choose, or M to choose again."),
          "",
        ].join("\n"));
        continue;
      }
      askSelection = selected;
      write([
        "",
        `${theme.success("Model")} ${formatPostActivationAskSelection(askSelection)}`,
        theme.dim("Press Enter to start, or M to change it again."),
        "",
      ].join("\n"));
      continue;
    }
    if (action === "e" || action === "edit" || action === "n" || action === "no") {
      await saveInstantBoundaryEditBaseline({
        projectRoot: input.projectRoot,
        draft: input.draft,
        candidate,
        actor,
      });
      write([
        "Quick Start was not accepted. Nothing is active.",
        "Opening the focused access editor with this connected boundary as the baseline.",
        "Use Enter to edit columns or A to add another table.",
        "",
      ].join("\n"));
      return { accepted: false, reason: "operator_requested_detailed_review" };
    }
    write("Use Enter, M, or E.\n");
  }
  if (!askSelection) {
    throw new Error("Quick Start cannot activate for Ask without an explicit model or MCP route.");
  }
  if (askSelection.route === "later") {
    write("The boundary will activate now; model setup will remain available for later.\n");
  } else if (askSelection.route === "mcp-client") {
    write("The boundary will activate now and then show MCP client setup.\n");
  }
  inspection = await input.schemaInspector({
    engine: input.lock.engine,
    databaseUrlEnv: input.lock.source_env,
    schema: input.lock.inspected_schema,
    env,
  });
  const comparison = compareGenerationLock(input.lock, inspection);
  if (!comparison.current) {
    return handleStaleGenerationLock({
      input,
      inspection,
      changes: comparison.changes,
      askSelection,
      write,
      theme,
    });
  }
  trustedScope = await trustedScopeResolver({
    boundary: candidate,
    lock: input.lock,
    inspection,
    env,
  });
  await saveInstantBoundaryReviewBaseline({
    projectRoot: input.projectRoot,
    draft: input.draft,
    candidate,
    actor,
  });
  const active = await activateExplorationBoundary({
    projectRoot: input.projectRoot,
    candidate,
    expectedDigest: digest,
    actor,
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
    activationAudit: {
      mode: "instant_development",
      launch_context: "start_from_env_local_authoring",
      confirmation_gesture: "activate_for_model",
    },
  });
  await updateGuidedOnboardingState({
    projectRoot: input.projectRoot,
    status: "boundary_active",
    completedStep: "boundary_active",
    authorityActive: true,
    recommendedNextAction: "Choose a model or MCP client and ask your first reviewed question.",
    now: active.activation.activated_at,
  }).catch(() => undefined);
  write([
    "",
    theme.success("✓ Ready"),
    `${theme.bold(active.pack.name)} is active for local read-only Explore.`,
    theme.dim("The broader generated draft remains off until you edit access."),
    "",
  ].join("\n"));
  return { accepted: true, active, askSelection };
}

async function handleStaleGenerationLock(input: {
  input: InstantCliBoundaryActivationInput;
  inspection: SchemaInspection;
  changes: string[];
  askSelection: PostActivationAskSelection | undefined;
  write(value: string): boolean;
  theme: ReturnType<typeof terminalTheme>;
}): Promise<InstantCliBoundaryActivationResult> {
  input.write([
    "",
    input.theme.title("DATABASE POSTURE CHANGED"),
    "Runner stopped before activation because the reviewed database posture changed:",
    ...input.changes.map((change) => `  - ${change}`),
    "",
    input.theme.dim("Nothing was activated. The stale boundary remains unavailable."),
    input.input.regenerateBoundary
      ? input.theme.dim("Regeneration creates a new disabled draft; you must review and activate it separately.")
      : generationLockRemediation(input.input.lock),
    "",
  ].join("\n"));
  if (!input.input.regenerateBoundary) {
    return { accepted: false, reason: "operator_cancelled" };
  }
  while (true) {
    const actionInput = await input.input.session.promptText(
      `${input.theme.key("R")} Regenerate against current posture   ${input.theme.key("Q")} Pause\n${input.theme.dim("Choice [R]:")} `,
    );
    if (actionInput === undefined) {
      input.write([
        "Regeneration paused. Nothing was activated.",
        generationLockRemediation(input.input.lock),
        "",
      ].join("\n"));
      return { accepted: false, reason: "operator_cancelled" };
    }
    const action = actionInput.trim().toLowerCase();
    if (!action || action === "r" || action === "regenerate") {
      const regenerated = await input.input.regenerateBoundary({
        inspection: input.inspection,
        draft: input.input.draft,
        lock: input.input.lock,
      });
      input.write([
        "",
        input.theme.success("✓ Regenerated disabled boundary against the current posture."),
        input.theme.dim("No authority is active. Review the new boundary, then press Enter separately to activate it."),
        "",
      ].join("\n"));
      return activateInstantCliBoundaryAttempt({
        ...input.input,
        draft: regenerated.draft,
        lock: regenerated.lock,
        initialInspection: regenerated.inspection,
      }, input.askSelection);
    }
    if (action === "q" || action === "quit" || action === "pause") {
      input.write([
        "Regeneration paused. Nothing was activated.",
        generationLockRemediation(input.input.lock),
        "",
      ].join("\n"));
      return { accepted: false, reason: "operator_cancelled" };
    }
    input.write("Use R to regenerate, or Q to pause.\n");
  }
}

function formatInstantCliBoundaryReview(input: {
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  question: string;
  actor: string;
  askSelection: PostActivationAskSelection | undefined;
  trustedScope: ExploreTrustedScope;
  color?: boolean;
}): string {
  const theme = terminalTheme(input.color === true);
  const resource = input.candidate.pack.resources[0]!;
  const totalResources = input.draft.pack.resources.length;
  const visibleFields = resource.selectable_fields.length;
  const withheldFields = input.candidate.pack.resources.reduce(
    (total, item) => total + (item.model_withheld_fields?.length ?? 0),
    0,
  );
  const keptOutFields = input.candidate.pack.resources.reduce(
    (total, item) => total + item.kept_out_fields.length,
    0,
  );
  const includedTables = input.candidate.pack.resources.length;
  const otherTables = Math.max(0, totalResources - includedTables);
  const resourceLabel = friendlyResourceLabel(resource.table);
  const includedSummary = input.candidate.pack.resources
    .map((item) => friendlyResourceLabel(item.table))
    .join(" · ");
  const visibleSummary = `${input.candidate.pack.resources.reduce(
    (total, item) => total + item.selectable_fields.length,
    0,
  )} fields across ${includedTables} ${includedTables === 1 ? "table" : "tables"}`;
  const withheldSummary = fieldSummary(input.candidate.pack.resources.flatMap(
    (item) => item.model_withheld_fields ?? [],
  ));
  const keptOutSummary = `${keptOutFields} field${keptOutFields === 1 ? "" : "s"}`;
  const label = (value: string) => theme.dim(value.padEnd(12));
  const tenantScope = input.trustedScope.tenant_source === "reviewed_organization"
    ? `whole reviewed organization (${input.candidate.organization_scope!.organization_id}); no tenant filter`
    : input.trustedScope.tenant_source === "postgres_role_setting"
      ? "tenant fixed by read-only login"
      : "tenant from operator environment";
  return [
    "",
    theme.title("YOUR FIRST SAFE QUESTION"),
    `Runner prepared one conservative, connected boundary from ${totalResources} inspected ${totalResources === 1 ? "table" : "tables"}.`,
    "A boundary is the reviewed data access your AI cannot exceed.",
    "",
    `  ${label("TABLES")} ${theme.bold(includedSummary || resourceLabel)}`,
    `  ${label("AI CAN USE")} ${theme.visible(visibleSummary || `${visibleFields} reviewed fields`)}`,
    ...(withheldFields > 0
      ? [`  ${label("RUNNER ONLY")} ${theme.runnerOnly(withheldSummary || `${withheldFields} fields`)}`]
      : []),
    `  ${label("KEPT OUT")} ${theme.keptOut([
      keptOutSummary || (keptOutFields ? `${keptOutFields} fields` : "no fields in this table"),
      otherTables ? `${otherTables} other ${otherTables === 1 ? "table" : "tables"}` : "",
    ].filter(Boolean).join(" · "))}`,
    `  ${label("ACCESS")} read-only · ${tenantScope}`,
    `  ${label("MODEL")} ${input.askSelection
      ? formatPostActivationAskSelection(input.askSelection)
      : "Choose OpenAI, Anthropic, a local model, or an MCP client"}`,
    "",
    theme.bold("Suggested from this boundary:"),
    `  "${input.question}"`,
    "",
    theme.dim("Enter opens model choice first, then records one review and activates only this read-only boundary."),
    theme.dim("Use /access later to add tables or boundaries without restarting this model session."),
    theme.dim("The model cannot review, activate, or widen access."),
    "",
  ].join("\n");
}

function friendlyResourceLabel(value: string): string {
  return value
    .replace(/^.*\./, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function fieldSummary(fields: string[]): string {
  const labels = fields.map((field) => field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase());
  const visible = labels.slice(0, 8);
  return [
    visible.join(" · "),
    labels.length > visible.length ? `+${labels.length - visible.length} more (E to inspect)` : "",
  ].filter(Boolean).join(" · ");
}

function operatorActor(env: NodeJS.ProcessEnv): string {
  const value = env.SYNAPSOR_OPERATOR_ID?.trim()
    || env.USER?.trim()
    || "local-developer";
  if (value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return "local-developer";
}
