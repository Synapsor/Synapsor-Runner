import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { inspectDatabase, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ActionBoundarySharedLimitV1 } from "@synapsor-runner/protocol";
import {
  createActionOperatorService,
  type ActionOperatorDecision,
  type ActionOperatorService,
  type ActionProposalDetail,
} from "./action-operator.js";
import {
  activateGuidedAction,
  activateGuidedActionBoundary,
  createGuidedActionDraft,
  discardGuidedActionDraft,
  guidedActionDraftDetails,
  guidedActionOptions,
  guidedActionStatus,
  readGuidedActionDraft,
  readGuidedActionDesignInput,
  recordGuidedActionPreview,
  reviseGuidedActionAuthority,
  reviseGuidedActionBoundary,
  type GuidedActionAuthorityRevisionInput,
  type GuidedActionAutoApprovalCondition,
  type GuidedActionAutoApprovalInput,
  type GuidedActionDraft,
  type GuidedActionInput,
  type GuidedActionOperation,
  type GuidedActionPatchInput,
  type GuidedActionResourceOption,
} from "./guided-action.js";
import type { ActionSuggestionAssessment } from "./action-design.js";
import {
  importActionSuggestion,
  listActionSuggestions,
  readActionSuggestion,
  recordActionSuggestionReview,
  type ActionSuggestionView,
} from "./action-suggestions.js";
import { generateModelActionSuggestion } from "./action-suggestion-model.js";
import {
  DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL,
  DEFAULT_TERMINAL_OPENAI_ASK_MODEL,
} from "./terminal-ask-defaults.js";
import { executeGuidedActionPreview } from "./guided-action-runtime.js";
import { renderBoundaryMapTable } from "./boundary-map-presentation.js";
import { terminalTheme } from "./boundary-cli-picker.js";
import {
  readTerminalTextWithEscape,
  withAlternateTerminalScreen,
  withRawTerminalScreen,
} from "./terminal-prompt.js";
import { terminalContentWidth } from "./terminal-layout.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import type { AskProvider, AskProviderDependencies } from "./model-ask.js";
import { cliCommandName } from "./cli-command-meta.js";
import {
  prepareQuickProposalAction,
  rankActionIntent,
  type QuickProposalDecisions,
} from "./guided-action-quick.js";

export { rankActionIntent } from "./guided-action-quick.js";

export type ActionPromptChoice = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

type ActionTextPromptOptions = {
  defaultValue?: string;
  secret?: boolean;
  title?: string;
  context?: string[];
};

class ActionPromptBack extends Error {
  constructor() {
    super("Action authoring returned to the previous screen.");
    this.name = "ActionPromptBack";
  }
}

function isActionPromptBack(error: unknown): error is ActionPromptBack {
  return error instanceof ActionPromptBack;
}

export type ActionControlPrompter = {
  choose(
    title: string,
    choices: ActionPromptChoice[],
    context?: string[],
    initialValue?: string,
  ): Promise<string | undefined>;
  text(label: string, options?: ActionTextPromptOptions): Promise<string | undefined>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean | undefined>;
  message(title: string, lines: string[], backLabel?: string): Promise<void>;
};

export type ActionControlPlaneResult = {
  state: "closed";
  source_database_changed: false;
  activated_actions: string[];
};

export type ActionModelSuggestionSession = {
  provider: AskProvider;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  dependencies?: AskProviderDependencies;
};

/**
 * Keeps the common local path setup-free without choosing between two
 * simultaneously configured providers. Credential values remain in process
 * environment and are never copied into managed artifacts.
 */
export function conventionalModelAuthoringSession(
  env: NodeJS.ProcessEnv,
): ActionModelSuggestionSession | undefined {
  const openAiReady = Boolean(env.OPENAI_API_KEY?.trim());
  const anthropicReady = Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (openAiReady === anthropicReady) return undefined;
  return openAiReady
    ? {
        provider: "openai",
        model: DEFAULT_TERMINAL_OPENAI_ASK_MODEL,
        apiKeyEnv: "OPENAI_API_KEY",
      }
    : {
        provider: "anthropic",
        model: DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL,
        apiKeyEnv: "ANTHROPIC_API_KEY",
      };
}

export function actionAuthorityRevisionNeedsVersionAdvance(
  current: Pick<GuidedActionInput, "operation" | "receipt_mode" | "version_advance">,
  authority: GuidedActionAuthorityRevisionInput,
): boolean {
  return current.operation === "update"
    && authority.authority_posture !== "proposal_only"
    && authority.writeback.mode === "direct_sql"
    && (authority.receipt_mode ?? current.receipt_mode ?? "runner_ledger") === "runner_ledger"
    && !current.version_advance;
}

export type ActionAuthoringContext = {
  intent?: string;
  mode?: "guided" | "expert";
  initial?: GuidedActionInput;
};

export type ActionOperatorSession = {
  provider?: "dev_env" | "signed_key" | "jwt_oidc";
  actor?: string;
  tokenEnv?: string;
  identity?: string;
  privateKeyPath?: string;
};

export async function inspectActionProject(
  projectRootInput: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchemaInspection> {
  const projectRoot = path.resolve(projectRootInput);
  const lock = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8"),
  ) as {
    engine: "postgres" | "mysql";
    source_env: string;
    inspected_schema?: string;
  };
  return inspectDatabase({
    engine: lock.engine,
    databaseUrlEnv: lock.source_env,
    ...(lock.inspected_schema ? { schema: lock.inspected_schema } : {}),
    env,
  });
}

export async function runActionControlPlane(input: {
  projectRoot: string;
  boundaryName?: string;
  configPath?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  inspection?: SchemaInspection;
  prompter?: ActionControlPrompter;
  operatorService?: ActionOperatorService;
  initialSuggestionId?: string;
  modelSuggestionGenerator?: typeof generateModelActionSuggestion;
  modelSuggestionSession?: ActionModelSuggestionSession;
  initialIntent?: string;
  prepareOnly?: boolean;
  actionBoundaryJobIntent?: string;
  returnToAsk?: boolean;
  terminalInput?: ReadStream;
  terminalOutput?: WriteStream;
}): Promise<ActionControlPlaneResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const env = input.env ?? process.env;
  const modelSuggestionSession = input.modelSuggestionSession
    ?? conventionalModelAuthoringSession(env);
  const inspection = input.inspection ?? await inspectActionProject(projectRoot, env);
  const operatorService = input.operatorService ?? createActionOperatorService({
    configPath: path.join(projectRoot, "synapsor.actions.runner.json"),
    storePath: input.storePath ?? path.join(projectRoot, ".synapsor/local.db"),
  });
  const activatedActions = new Set<string>();
  const operatorSession: ActionOperatorSession = {};
  const execute = async (prompter: ActionControlPrompter) => {
    let notice: string[] = [];
    let initialSuggestionId = input.initialSuggestionId;
    let initialIntent = input.initialIntent?.trim();
    while (true) {
      const options = await guidedActionOptions({
        projectRoot,
        inspection,
        ...(input.boundaryName ? { boundaryName: input.boundaryName } : {}),
        allowReviewedPending: true,
      });
      const status = await guidedActionStatus(projectRoot);
      const suggestions = await listActionSuggestions({ projectRoot, options });
      if (initialSuggestionId) {
        const suggestion = await readActionSuggestion({ projectRoot, suggestionId: initialSuggestionId, options });
        initialSuggestionId = undefined;
        const activated = await reviewImportedSuggestion({
          projectRoot,
          inspection,
          options,
          suggestion,
          prompter,
          env,
          baseConfigPath: input.configPath,
          operatorSession,
          returnToAsk: input.returnToAsk,
          prepareOnly: input.prepareOnly,
          actionBoundaryJobIntent: input.actionBoundaryJobIntent,
        });
        if (activated) activatedActions.add(activated);
        if (input.prepareOnly) break;
        continue;
      }
      if (initialIntent) {
        const intent = initialIntent;
        initialIntent = undefined;
        try {
          const activated = await createAndReviewQuickAction({
            projectRoot,
            inspection,
            options,
            prompter,
            intent,
            env,
            baseConfigPath: input.configPath,
            operatorSession,
            returnToAsk: input.returnToAsk,
            prepareOnly: input.prepareOnly,
            actionBoundaryJobIntent: input.actionBoundaryJobIntent,
          });
          if (activated) activatedActions.add(activated);
        } catch (error) {
          if (!isActionPromptBack(error)) {
            await prompter.message("PROPOSAL ACTION REFUSED", [
              error instanceof Error ? error.message : String(error),
              "No action authority was activated and no weaker action was substituted.",
            ]);
          }
        }
        if (input.prepareOnly) break;
        continue;
      }
      const homeChoices = actionHomeChoices(status, suggestions, options, modelSuggestionSession);
      const preferredDraft = status.drafts.find((draft) => draft.effect_preview) ?? status.drafts[0];
      const choice = await prompter.choose(
        "ACTION BOUNDARY",
        homeChoices,
        [
          "The Action Boundary is the reviewed set of changes an agent may propose. Approval and apply stay outside the agent.",
          ...actionBoundaryHomeLines(status),
          `Active ${status.activations.length} | Drafts ${status.drafts.length} | Proposal-only is the default.`,
          `Targets with at least one proposal operation ${actionReadyResourceCount(options)} | Fully blocked ${actionBlockedTargetCount(options)}.`,
          ...notice,
        ],
        preferredDraft ? `draft:${preferredDraft.capability}` : "boundary",
      );
      notice = [];
      if (!choice || choice === "quit") break;
      try {
        if (choice === "boundary") {
          await reviewActionBoundary({
            projectRoot,
            inspection,
            options,
            prompter,
            env,
            ...(input.configPath ? { configPath: input.configPath } : {}),
          });
          continue;
        }
        if (choice === "model_suggest") {
          const imported = await collectModelActionSuggestion({
            projectRoot,
            options,
            prompter,
            env,
            generator: input.modelSuggestionGenerator ?? generateModelActionSuggestion,
            ...(modelSuggestionSession ? { session: modelSuggestionSession } : {}),
          });
          if (imported) {
            notice = [
              `Imported ${imported.suggestion_id} as ${imported.state.toUpperCase()}. No authority or active tool changed.`,
            ];
          }
          continue;
        }
        if (choice === "readiness") {
          await prompter.message(
            "SAFE ACTION READINESS",
            actionReadinessLines(options),
            "Back to Safe Action menu",
          );
          continue;
        }
        if (choice === "new") {
          const intent = await prompter.text("What should the agent be allowed to propose?", {
            title: "DESCRIBE ONE PROPOSAL ACTION",
            context: [
              "Describe one business change, not SQL or a table-edit command.",
              "Runner maps it to one source-proven target, then asks only for unresolved bounds and guards.",
              "The result stays disabled until a source-unchanged rehearsal and separate exact activation.",
              "Example: Update dispatcher alert level and maximum open requests with version conflict protection.",
            ],
          });
          if (!intent) continue;
          const activated = await createAndReviewQuickAction({
            projectRoot,
            inspection,
            options,
            prompter,
            intent,
            env,
            baseConfigPath: input.configPath,
            operatorSession,
            returnToAsk: input.returnToAsk,
            prepareOnly: false,
          });
          if (activated) activatedActions.add(activated);
          if (options.boundary_state === "reviewed_pending") break;
          continue;
        }
        if (choice === "new_advanced") {
          const intent = await prompter.text("What should the agent be allowed to propose?", {
            title: "DESCRIBE ONE ADVANCED PROPOSAL ACTION",
            context: [
              "Describe one business change, not SQL or a table-edit command.",
              "Runner ranks only source-proven targets; you will review every field, guard, approval, and execution choice.",
              "Nothing activates or writes until separate rehearsal and exact activation.",
            ],
          });
          if (!intent) continue;
          const route = modelSuggestionSession
            ? await prompter.choose("MAP BUSINESS INTENT", [
                {
                  value: "runner",
                  label: "Review Runner-ranked candidates (recommended)",
                  detail: "Uses reviewed names, labels, descriptions, and schema proofs locally. No provider request.",
                },
                {
                  value: "model",
                  label: `Ask the current ${modelSuggestionSession.provider} model for one bounded suggestion`,
                  detail: "Sends the intent and structural candidate metadata only. The result grants no authority.",
                },
                { value: "back", label: "Back" },
              ], [
                "Both routes still require human review of every business and authority decision.",
              ])
            : "runner";
          if (!route || route === "back") continue;
          let suggestion: ActionSuggestionAssessment | undefined;
          if (route === "model") {
            const imported = await collectModelActionSuggestion({
              projectRoot,
              options,
              prompter,
              env,
              intent,
              generator: input.modelSuggestionGenerator ?? generateModelActionSuggestion,
              session: modelSuggestionSession!,
            });
            if (!imported || imported.state !== "suggested") continue;
            suggestion = imported.current_assessment;
          }
          const created = await collectAndCreateAction({
            projectRoot,
            inspection,
            options,
            prompter,
            ...(suggestion ? { suggestion } : {}),
            authoring: { intent, mode: "guided" },
          });
          if (created) {
            notice = [`Drafted ${created.capability} (${created.authority_posture}, ${created.contract_digest}). No authority was activated.`];
            const activated = await reviewActionDraft({
              projectRoot,
              inspection,
              draft: created,
              prompter,
              env,
              baseConfigPath: input.configPath,
              operatorSession,
              returnToAsk: input.returnToAsk,
            });
            if (activated) activatedActions.add(activated);
          }
          continue;
        }
        if (choice.startsWith("suggestion:")) {
          const suggestion = suggestions.find((item) => item.suggestion_id === choice.slice("suggestion:".length));
          if (suggestion) {
            const activated = await reviewImportedSuggestion({
              projectRoot,
              inspection,
              options,
              suggestion,
              prompter,
              env,
              baseConfigPath: input.configPath,
              operatorSession,
              returnToAsk: input.returnToAsk,
            });
            if (activated) activatedActions.add(activated);
          }
          continue;
        }
        if (choice === "proposals") {
          await reviewActionProposalInbox({ operatorService, prompter, env, operatorSession });
          continue;
        }
        if (choice.startsWith("draft:")) {
          const capability = choice.slice("draft:".length);
          const draft = status.drafts.find((item) => item.capability === capability);
          if (draft) {
            const activated = await reviewActionDraft({
              projectRoot,
              inspection,
              draft,
              prompter,
              env,
              baseConfigPath: input.configPath,
              operatorSession,
              returnToAsk: input.returnToAsk,
              quickStart: actionDraftUsesQuickResume(draft),
            });
            if (activated) activatedActions.add(activated);
            if (options.boundary_state === "reviewed_pending") {
              const refreshed = await readGuidedActionDraft(projectRoot, draft.capability);
              if (refreshed.effect_preview) break;
            }
          }
          continue;
        }
        if (choice.startsWith("active:")) {
          const capability = choice.slice("active:".length);
          const active = status.activations.find((item) => item.capability === capability);
          if (!active) continue;
          const activeChoice = await prompter.choose("ACTIVE SAFE ACTION", [
            { value: "runtime", label: "Show agent connection commands", detail: "Test the semantic tool or install the separate action runtime in an MCP client." },
            { value: "replace", label: "Create a replacement design revision", detail: "Re-review fields, bounds, transitions, approval, and execution. Current authority remains active." },
            { value: "revise", label: "Promote, demote, or replace execution posture", detail: "Creates a disabled new digest; current authority remains active." },
            { value: "back", label: "Back" },
          ], actionAuthorityLines(active));
          if (activeChoice === "runtime") {
            await prompter.message("CONNECT AN AGENT TO THIS SAFE ACTION", actionRuntimeLines(active));
          }
          if (activeChoice === "replace") {
            const current = await readGuidedActionDesignInput(projectRoot, active.capability, "active");
            const replacement = await collectAndCreateAction({
              projectRoot,
              inspection,
              options,
              prompter,
              authoring: { intent: current.description, mode: "guided", initial: current },
            });
            if (replacement) {
              const activated = await reviewActionDraft({
                projectRoot,
                inspection,
                draft: replacement,
                prompter,
                env,
                baseConfigPath: input.configPath,
                operatorSession,
                returnToAsk: input.returnToAsk,
              });
              if (activated) activatedActions.add(activated);
            }
          }
          if (activeChoice === "revise") {
            let authority = await collectAuthority(prompter, options.deployment_profile);
            if (!authority) continue;
            const current = await readGuidedActionDesignInput(projectRoot, active.capability, "active");
            const needsVersionAdvance = actionAuthorityRevisionNeedsVersionAdvance(current, authority);
            if (needsVersionAdvance) {
              const versionAdvance = await prompter.choose("VERSION ADVANCEMENT REQUIRED", [
                {
                  value: "integer_increment",
                  label: `Increment the reviewed numeric ${current.conflict_column ?? "version"}`,
                  detail: "Runner advances it in the guarded transaction; recommended for exact conflict detection.",
                },
                {
                  value: "database_generated",
                  label: `Database generates the next ${current.conflict_column ?? "version"}`,
                  detail: "Available only when inspected schema evidence proves the database generates a new value.",
                },
                { value: "back", label: "Back" },
              ]);
              if (!versionAdvance || versionAdvance === "back") continue;
              authority = {
                ...authority,
                version_advance: versionAdvance as GuidedActionInput["version_advance"],
              };
            }
            const revised = await reviseGuidedActionAuthority({
              projectRoot,
              capabilityName: active.capability,
              expectedCurrentDigest: active.contract_digest,
              authority,
              inspection,
            });
            await prompter.message("NEW ACTION REVISION DRAFTED", [
              `${revised.transition.kind.toUpperCase()}: ${active.authority_posture} -> ${revised.draft.authority_posture}`,
              `Old active digest: ${active.contract_digest}`,
              `New disabled digest: ${revised.draft.contract_digest}`,
              "Old proposals retain their original writeback posture and never gain execution authority.",
            ]);
            const activated = await reviewActionDraft({
              projectRoot,
              inspection,
              draft: revised.draft,
              prompter,
              env,
              baseConfigPath: input.configPath,
              operatorSession,
              returnToAsk: input.returnToAsk,
            });
            if (activated) activatedActions.add(activated);
          }
        }
      } catch (error) {
        if (isActionPromptBack(error)) {
          notice = [];
          continue;
        }
        notice = [
          error instanceof Error ? error.message : String(error),
          "No authority was activated and no weaker fallback was used.",
        ];
        await prompter.message("SAFE ACTION REFUSED", notice);
      }
    }
  };

  if (input.prompter) await execute(input.prompter);
  else {
    const terminalInput = input.terminalInput ?? process.stdin as ReadStream;
    const terminalOutput = input.terminalOutput ?? process.stdout as WriteStream;
    if (!terminalInput.isTTY || !terminalOutput.isTTY || typeof terminalInput.setRawMode !== "function") {
      throw new Error("action review requires a real terminal. Use action draft --answers <json> for scripts and CI.");
    }
    await withAlternateTerminalScreen(terminalOutput, async () => {
      await execute(createTerminalActionPrompter(terminalInput, terminalOutput));
    });
  }
  return { state: "closed", source_database_changed: false, activated_actions: [...activatedActions] };
}

export async function reviewActionProposalInbox(input: {
  operatorService: ActionOperatorService;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  operatorSession?: ActionOperatorSession;
}): Promise<void> {
  const operatorSession = input.operatorSession ?? {};
  let state: "pending_review" | "approved" | "pending_worker" | "applied" | "rejected" | undefined;
  let search = "";
  let from: string | undefined;
  let timeLabel = "all time";
  let page = 0;
  const pageSize = 12;
  while (true) {
    const filters = {
      ...(state ? { state } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(from ? { from } : {}),
    };
    let result = await input.operatorService.page({
      ...filters,
      limit: pageSize,
      offset: page * pageSize,
    });
    const total = result.total;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > maxPage) {
      page = maxPage;
      result = await input.operatorService.page({
        ...filters,
        limit: pageSize,
        offset: page * pageSize,
      });
    }
    const rows = result.items;
    const choice = await input.prompter.choose(
      "PROPOSAL INBOX",
      [
        ...rows.map((proposal) => ({
          value: `proposal:${proposal.proposal_id}`,
          label: `${proposal.capability}: ${proposal.business_object} ${proposal.object_id}`,
          detail: `${proposal.state.replace(/_/g, " ")} | ${proposal.writeback_mode} | ${formatActionTimestamp(proposal.created_at)}`,
        })),
        { value: "next", label: "Next page", detail: `${page + 1} of ${maxPage + 1}`, disabled: page >= maxPage },
        { value: "previous", label: "Previous page", detail: `${page + 1} of ${maxPage + 1}`, disabled: page === 0 },
        { value: "state", label: "Filter by lifecycle state", detail: state ?? "all states" },
        { value: "time", label: "Filter by proposal age", detail: timeLabel },
        { value: "search", label: "Search capability, object, proposal ID, or state", detail: search || "no search" },
        { value: "clear", label: "Clear filters", disabled: !state && !search && !from },
        { value: "back", label: "Back" },
      ],
      [
        `${total} matching proposal${total === 1 ? "" : "s"}; page ${page + 1} of ${maxPage + 1}.`,
        "Approval and apply are operator-only. Every mutation decision is bound to the exact proposal hash shown in detail.",
        ...(rows.length ? [] : ["No proposal matches this view. Change or clear the filters."]),
      ],
    );
    if (!choice || choice === "back") return;
    if (choice === "next") { page += 1; continue; }
    if (choice === "previous") { page = Math.max(0, page - 1); continue; }
    if (choice === "clear") { state = undefined; search = ""; from = undefined; timeLabel = "all time"; page = 0; continue; }
    if (choice === "search") {
      search = await input.prompter.text("Search text", { defaultValue: search }) ?? search;
      page = 0;
      continue;
    }
    if (choice === "state") {
      const selected = await input.prompter.choose("FILTER PROPOSALS", [
        { value: "all", label: "All states" },
        { value: "pending_review", label: "Pending human review" },
        { value: "approved", label: "Approved, awaiting apply" },
        { value: "pending_worker", label: "Queued for supervised execution" },
        { value: "applied", label: "Applied" },
        { value: "rejected", label: "Rejected" },
      ]);
      if (selected) state = selected === "all" ? undefined : selected as typeof state;
      page = 0;
      continue;
    }
    if (choice === "time") {
      const selected = await input.prompter.choose("FILTER BY PROPOSAL AGE", [
        { value: "all", label: "All time" },
        { value: "24h", label: "Last 24 hours" },
        { value: "7d", label: "Last 7 days" },
        { value: "30d", label: "Last 30 days" },
      ]);
      if (selected) {
        const duration = selected === "24h" ? 86_400_000 : selected === "7d" ? 604_800_000 : selected === "30d" ? 2_592_000_000 : 0;
        from = duration ? new Date(Date.now() - duration).toISOString() : undefined;
        timeLabel = selected === "all" ? "all time" : selected === "24h" ? "last 24 hours" : selected === "7d" ? "last 7 days" : "last 30 days";
      }
      page = 0;
      continue;
    }
    if (choice.startsWith("proposal:")) {
      await reviewActionProposal({
        operatorService: input.operatorService,
        proposalId: choice.slice("proposal:".length),
        prompter: input.prompter,
        env: input.env,
        operatorSession,
      });
    }
  }
}

async function reviewActionProposal(input: {
  operatorService: ActionOperatorService;
  proposalId: string;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  operatorSession: ActionOperatorSession;
}): Promise<void> {
  let detail = await input.operatorService.detail(input.proposalId);
  while (true) {
    const proposal = detail.proposal;
    const writebackMode = proposal.change_set.writeback.mode;
    const choice = await input.prompter.choose("PROPOSAL REVIEW", [
      { value: "approve", label: "Approve exact proposal", detail: "Records a hash-bound human decision after freshness and role checks.", disabled: proposal.state !== "pending_review" },
      { value: "reject", label: "Reject exact proposal", detail: "Records a reason and verified operator identity.", disabled: proposal.state !== "pending_review" },
      { value: "apply", label: "Apply approved proposal", detail: writebackMode === "read_only" ? "This proposal was created under WRITEBACK NONE and can never execute." : "Rechecks active digest, approval, scope, conflict, idempotency, and receipt authority.", disabled: proposal.state !== "approved" || writebackMode === "read_only" },
      { value: "lifecycle", label: "Events, receipts, and evidence summary" },
      { value: "replay", label: "Create exact replay record", detail: "Snapshots proposal, approvals, events, receipts, query audit, and evidence in the operator ledger." },
      { value: "refresh", label: "Reload current state" },
      { value: "back", label: "Back to inbox" },
    ], actionProposalDetailLines(detail));
    if (!choice || choice === "back") return;
    if (choice === "refresh") {
      detail = await input.operatorService.detail(input.proposalId);
      continue;
    }
    if (choice === "lifecycle") {
      await input.prompter.message("PROPOSAL LIFECYCLE", actionProposalLifecycleLines(detail));
      continue;
    }
    if (choice === "replay") {
      const replay = await input.operatorService.replay(proposal.proposal_id, proposal.proposal_hash);
      await input.prompter.message("REPLAY RECORDED", [
        `Replay: ${replay.replay_id}`,
        `Proposal: ${proposal.proposal_id}`,
        `Approvals: ${replay.approvals.length} | Events: ${replay.events.length} | Receipts: ${replay.receipts.length}`,
        `Evidence records: ${replay.evidence.length} | Query audit records: ${replay.query_audit.length}`,
        "Source database changed: no",
      ]);
      detail = await input.operatorService.detail(input.proposalId);
      continue;
    }
    try {
      const decision = await collectActionOperatorDecision({
        action: choice as "approve" | "reject" | "apply",
        detail,
        operatorService: input.operatorService,
        prompter: input.prompter,
        env: input.env,
        operatorSession: input.operatorSession,
      });
      if (!decision) continue;
      if (choice === "approve") detail = await input.operatorService.approve(proposal.proposal_id, decision);
      else if (choice === "reject") detail = await input.operatorService.reject(proposal.proposal_id, decision);
      else {
        const result = await input.operatorService.apply(proposal.proposal_id, decision);
        detail = result.detail;
        if (result.code !== 0) {
          await input.prompter.message("APPLY DID NOT COMPLETE", [
            `Result code: ${result.code}`,
            `Current state: ${detail.proposal.state}`,
            "The source mutation path failed closed. Review the lifecycle and receipt before retrying.",
          ]);
          continue;
        }
      }
      await input.prompter.message("OPERATOR DECISION RECORDED", [
        `Decision: ${choice.toUpperCase()}`,
        `Proposal: ${detail.proposal.proposal_id}`,
        `Current state: ${detail.proposal.state}`,
        `Source database changed: ${detail.proposal.source_database_mutated ? "yes" : "no"}`,
      ]);
    } catch (error) {
      await input.prompter.message("OPERATOR DECISION REFUSED", [
        error instanceof Error ? error.message : String(error),
        "No weaker fallback was used. Reload the proposal before trying again.",
      ]);
      detail = await input.operatorService.detail(input.proposalId);
    }
  }
}

async function collectActionOperatorDecision(input: {
  action: "approve" | "reject" | "apply";
  detail: ActionProposalDetail;
  operatorService: ActionOperatorService;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  operatorSession: ActionOperatorSession;
}): Promise<ActionOperatorDecision | undefined> {
  const proposal = input.detail.proposal;
  const confirmation = await input.prompter.confirm(
    `${input.action.toUpperCase()} selected proposal ${proposal.proposal_id} at ${shortDigest(proposal.proposal_hash)}? `
    + (input.action === "apply"
      ? "This may mutate one source row after every reviewed guard is rechecked."
      : "Runner binds this decision to the full current proposal hash."),
    false,
  );
  if (!confirmation) return undefined;
  const reason = await input.prompter.text(`${input.action} reason`);
  if (!reason?.trim()) throw new Error(`${input.action} requires a reviewable reason.`);
  const posture = await input.operatorService.identityPosture();
  if (input.operatorSession.provider !== posture.provider) {
    input.operatorSession.provider = posture.provider;
    input.operatorSession.actor = undefined;
    input.operatorSession.tokenEnv = undefined;
    input.operatorSession.identity = undefined;
    input.operatorSession.privateKeyPath = undefined;
  }
  if (posture.provider === "jwt_oidc") {
    const tokenEnv = input.operatorSession.tokenEnv ?? await input.prompter.text("OIDC operator token environment name", {
      defaultValue: "SYNAPSOR_OPERATOR_IDENTITY_TOKEN",
    });
    if (!tokenEnv) return undefined;
    input.operatorSession.tokenEnv = tokenEnv;
    const identityToken = input.env[tokenEnv]?.trim();
    if (!identityToken) throw new Error(`${tokenEnv} is unset. The token value is never displayed or persisted.`);
    return {
      reason: reason.trim(),
      expected_proposal_hash: proposal.proposal_hash,
      identityToken,
    };
  }
  if (posture.provider === "signed_key") {
    const identity = input.operatorSession.identity ?? await input.prompter.text("Configured operator identity");
    const privateKeyPath = input.operatorSession.privateKeyPath
      ?? await input.prompter.text("Operator private-key path", { secret: true });
    if (!identity || !privateKeyPath) return undefined;
    input.operatorSession.identity = identity;
    input.operatorSession.privateKeyPath = privateKeyPath;
    return {
      reason: reason.trim(),
      expected_proposal_hash: proposal.proposal_hash,
      identity,
      privateKeyPath,
    };
  }
  const actor = input.operatorSession.actor ?? await input.prompter.text("Development operator identity", {
    defaultValue: input.env.SYNAPSOR_OPERATOR_ACTOR ?? input.env.USER ?? "local_operator",
  });
  if (!actor) return undefined;
  input.operatorSession.actor = actor;
  return {
    actor,
    reason: reason.trim(),
    expected_proposal_hash: proposal.proposal_hash,
  };
}

function actionProposalDetailLines(detail: ActionProposalDetail): string[] {
  const proposal = detail.proposal;
  const changeSet = proposal.change_set as unknown as {
    patch?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    approval: { required_role: string };
    writeback: { mode: string };
  };
  const fields = Object.keys(changeSet.patch ?? changeSet.after ?? {});
  return [
    `${proposal.action}: ${proposal.business_object} ${proposal.object_id}`,
    `State: ${proposal.state} | Created: ${formatActionTimestamp(proposal.created_at)}`,
    "",
    "REQUESTED EFFECT",
    ...(fields.length
      ? fields.map((field) => {
          const before = changeSet.before?.[field];
          const after = changeSet.after?.[field] ?? changeSet.patch?.[field];
          return `  ${field}: ${formatActionValue(before)} -> ${formatActionValue(after)}`;
        })
      : ["  Hard-delete the exact reviewed subject. Stored row values are not expanded in this summary."]),
    "",
    `Approval: ${detail.approval_progress.approved}/${detail.approval_progress.required} | role ${changeSet.approval.required_role}`,
    `Freshness: ${detail.freshness_status} | Writeback: ${changeSet.writeback.mode}`,
    `Receipts: ${detail.receipts.length} | Evidence items: ${detail.evidence_item_count}`,
    `Exact proposal hash: ${proposal.proposal_hash}`,
    `Source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ];
}

function actionProposalLifecycleLines(detail: ActionProposalDetail): string[] {
  return [
    ...actionProposalDetailLines(detail),
    "",
    "Events",
    ...(detail.events.length
      ? detail.events.map((event) => `  ${formatActionTimestamp(event.created_at)}  ${event.kind}  actor=${event.actor}`)
      : ["  none"]),
    "",
    "Writeback receipts",
    ...(detail.receipts.length
      ? detail.receipts.map((receipt) => `  ${formatActionTimestamp(receipt.created_at)}  ${receipt.status}  mutated=${receipt.source_database_mutated ? "yes" : "no"}  idempotency=${receipt.idempotency_key}`)
      : ["  none"]),
    "",
    "Only reviewed patch values are rendered above. Use the exact replay record for complete audit linkage.",
  ];
}

export async function collectGuidedActionInput(
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
  prompter: ActionControlPrompter,
  suggestion?: ActionSuggestionAssessment,
  authoring: ActionAuthoringContext = {},
): Promise<GuidedActionInput | undefined> {
  const suggested = suggestion?.status === "suggested" ? suggestion.suggestion : undefined;
  const suggestedAutoApproval = suggested?.approval_policy_proposal
    ? {
        conditions: structuredClone(suggested.approval_policy_proposal.conditions),
        max_per_day: suggested.approval_policy_proposal.max_per_day,
        ...(suggested.approval_policy_proposal.max_total_per_day === undefined
          ? {}
          : {
              max_total_per_day: suggested.approval_policy_proposal.max_total_per_day,
              total_field: suggested.approval_policy_proposal.total_field,
            }),
      } satisfies GuidedActionAutoApprovalInput
    : undefined;
  const hints = rankActionIntent(options.resources, authoring.intent);
  const preferredResource = suggested?.resource ?? authoring.initial?.resource ?? hints.resource;
  const resources = prioritizeByValue(options.resources, preferredResource, (resource) => resource.id);
  const resourceId = await prompter.choose(
    "CHOOSE ACTION TARGET",
    resources.map((resource) => ({
      value: resource.id,
      label: resource.label ? `${resource.label} (${resource.id})` : resource.id,
      detail: `${resource.structurally_eligible_fields.length} structurally eligible fields; trusted scope ${resource.tenant_key}${resource.principal_key ? ` + ${resource.principal_key}` : ""}`,
    })),
    [
      "These are candidates, not write permissions. Generated, scope-owned, and kept-out fields remain unavailable.",
      ...(suggested ? [`Imported suggestion: ${suggested.intent} Every choice still requires explicit review.`] : []),
      ...(!suggested && authoring.intent
        ? [`Intent: ${authoring.intent}`, ...hints.notes]
        : []),
    ],
  );
  if (!resourceId) return undefined;
  const resource = options.resources.find((item) => item.id === resourceId)!;
  const operation = await prompter.choose(
    "CHOOSE OPERATION",
    prioritizeByValue(
      ["update", "insert", "delete"] as GuidedActionOperation[],
      suggested?.operation ?? authoring.initial?.operation ?? hints.operation,
      (candidate) => candidate,
    ).map((candidate) => ({
      value: candidate,
      label: candidate.toUpperCase(),
      detail: resource.operation_availability[candidate].reason,
      disabled: !resource.operation_availability[candidate].available,
    })),
    ["Every operation is single-row and proposal-first. Unproven shapes remain disabled."],
  ) as GuidedActionOperation | undefined;
  if (!operation) return undefined;

  const dedupColumn = operation === "insert"
    ? await chooseStructuralGuard(
        prompter,
        "CHOOSE INSERT IDEMPOTENCY COLUMN",
        resource.insert_dedup_candidates,
        authoring.initial?.dedup_proposal_column,
        authoring.mode === "guided",
      )
    : undefined;
  if (operation === "insert" && !dedupColumn) return undefined;
  const patches = operation === "delete"
    ? []
    : await collectPatches(resource, prompter, {
        operation,
        dedupColumn,
        suggestedFields: suggested?.resource === resource.id && suggested.operation === operation
          ? suggested.fields
          : hints.resource === resource.id
            ? hints.fields
            : undefined,
        ...(authoring.initial?.resource === resource.id && authoring.initial.operation === operation
          ? { initialPatches: authoring.initial.patches }
          : {}),
      });
  if (operation !== "delete" && (!patches || patches.length === 0)) return undefined;
  const requestedInitialAutoApproval = suggestedAutoApproval ?? authoring.initial?.auto_approval;
  const initialAutoApprovalIssues = requestedInitialAutoApproval
    ? autoApprovalPatchCompatibilityIssues(requestedInitialAutoApproval, patches ?? [])
    : [];
  const reviewableInitialAutoApproval = requestedInitialAutoApproval && initialAutoApprovalIssues.length === 0
    ? requestedInitialAutoApproval
    : undefined;
  const conflictColumn = operation === "insert"
    ? undefined
    : await chooseStructuralGuard(
        prompter,
        "CHOOSE CONFLICT / VERSION GUARD",
        resource.conflict_candidates,
        authoring.initial?.conflict_column,
        authoring.mode === "guided",
      );
  if (operation !== "insert" && !conflictColumn) return undefined;
  const defaultCapability = `${resource.table.replace(/s$/i, "")}.propose_${operation}_${resource.table.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const capabilityName = await prompter.text("Exact semantic capability name", {
    defaultValue: authoring.initial?.capability_name ?? defaultCapability,
  });
  if (!capabilityName) return undefined;
  const description = await prompter.text("Plain-language business effect", {
    defaultValue: authoring.initial?.description
      ?? suggested?.intent
      ?? authoring.intent
      ?? `Propose a reviewed ${operation} for one ${resource.table.replace(/s$/i, "")} within trusted scope.`,
  });
  if (!description) return undefined;
  const rolloutChoices = [
        ...(authoring.initial
          ? [{
              value: "keep",
              label: "Keep the currently reviewed approval and execution posture",
              detail: `${authoring.initial.required_approvals ?? 1} x ${authoring.initial.approval_role}; ${authoring.initial.authority_posture ?? "proposal_only"}.`,
            }]
          : []),
        {
          value: "safe",
          label: "Proposal-only with one human reviewer (recommended)",
          detail: "WRITEBACK NONE. The source database cannot change under this revision.",
        },
        ...(operation !== "delete" && (patches ?? []).some((patch) => patch.value_source === "argument")
          ? [{
              value: "delegate",
              label: reviewableInitialAutoApproval
                ? "Review the suggested deterministic approval policy"
                : "Delegate approval within deterministic limits",
              detail: "Runner checks exact before/after rules and circuit breakers. Any failure falls back to human review; apply stays off.",
            }]
          : []),
        {
          value: "advanced",
          label: "Customize approval or execution",
          detail: "Review quorum, deterministic policy, executor, receipts, and optional worker controls.",
        },
      ];
  const rollout = authoring.mode === "guided"
    ? await prompter.choose("CHOOSE INITIAL ROLLOUT", prioritizeByValue(
        rolloutChoices,
        reviewableInitialAutoApproval ? "delegate" : undefined,
        (item) => item.value,
      ), [
        "Starting proposal-only keeps activation useful while making source mutation impossible.",
        "Deterministic approval and execution are separate reviewed authorities.",
        "Execution can be added later only through a separately rehearsed and activated revision.",
        ...(initialAutoApprovalIssues.length
          ? [
              "The imported approval policy refers to fields outside this exact write selection, so Runner will rebuild the policy from the fields you reviewed.",
              `Incompatible policy references: ${initialAutoApprovalIssues.join(", ")}.`,
            ]
          : []),
      ])
    : "advanced";
  if (!rollout) return undefined;

  let approvalRole: string;
  let requiredApprovals: number;
  let authority: GuidedActionAuthorityRevisionInput;
  let versionAdvance: GuidedActionInput["version_advance"];
  let autoApproval: GuidedActionInput["auto_approval"];
  let reversible = false;
  if (rollout === "keep" && authoring.initial) {
    approvalRole = authoring.initial.approval_role;
    requiredApprovals = authoring.initial.required_approvals ?? 1;
    authority = authorityFromActionInput(authoring.initial);
    versionAdvance = authoring.initial.version_advance;
    autoApproval = authoring.initial.auto_approval;
    reversible = authoring.initial.reversible === true;
  } else if (rollout === "safe") {
    approvalRole = "action_reviewer";
    requiredApprovals = 1;
    authority = { authority_posture: "proposal_only", writeback: { mode: "none" } };
  } else if (rollout === "delegate") {
    approvalRole = "action_reviewer";
    requiredApprovals = 1;
    authority = { authority_posture: "proposal_only", writeback: { mode: "none" } };
    autoApproval = await collectDeterministicAutoApproval({
      prompter,
      resource,
      operation,
      patches: patches ?? [],
      initial: reviewableInitialAutoApproval,
    });
    if (!autoApproval) return undefined;
  } else {
    approvalRole = await requiredText(
      prompter,
      "Required reviewer role",
      authoring.initial?.approval_role ?? "action_reviewer",
    );
    requiredApprovals = boundedInteger(
      await requiredText(prompter, "Required approval count (1-10)", String(authoring.initial?.required_approvals ?? 1)),
      1,
      10,
      "approval count",
    );
    const selectedAuthority = await collectAuthority(prompter, options.deployment_profile, authoring.initial);
    if (!selectedAuthority) return undefined;
    authority = selectedAuthority;
    if (operation === "update") {
      const selection = await prompter.choose("VERSION ADVANCEMENT", prioritizeByValue([
        { value: "integer_increment", label: "Increment the reviewed numeric version", detail: "Best for Runner-owned direct SQL and conflict-safe retries." },
        { value: "database_generated", label: "Database generates the next version", detail: "Use only when the schema proves this behavior." },
        { value: "none", label: "No version advancement in this revision", detail: "Proposal-only works, but direct-SQL promotion will require a new design." },
      ], authoring.initial?.version_advance ?? "none", (item) => item.value));
      if (!selection) return undefined;
      if (selection !== "none") versionAdvance = selection as GuidedActionInput["version_advance"];
    }
    const modelArguments = (patches ?? []).filter((patch) => patch.value_source === "argument");
    if (operation !== "delete" && requiredApprovals === 1 && modelArguments.length > 0
      && await prompter.confirm(
        "Add deterministic bounded auto-approval? A model suggestion is only a starting point; this exact operator-reviewed policy is authoritative.",
        Boolean(reviewableInitialAutoApproval),
      )) {
      autoApproval = await collectDeterministicAutoApproval({
        prompter,
        resource,
        operation,
        patches: patches ?? [],
        initial: reviewableInitialAutoApproval,
      });
      if (!autoApproval) return undefined;
    }
    const directSql = authority.writeback.mode === "direct_sql";
    reversible = operation === "update"
      && directSql
      && authority.authority_posture !== "supervised_execution"
      && !autoApproval
      ? await prompter.confirm("Enable reviewed compensation? A revert is always a separate proposal.", Boolean(authoring.initial?.reversible)) === true
      : false;
  }
  let deleteConfirmation: string | undefined;
  if (operation === "delete") {
    deleteConfirmation = await prompter.text(`Hard delete confirmation (enter DELETE ${resource.id})`, {
      defaultValue: authoring.initial?.delete_confirmation,
    });
    if (!deleteConfirmation) return undefined;
  }
  const trustedScope = resource.organization_scope
    ? `whole organization ${resource.organization_scope.organization_id} is frozen by the reviewed boundary; no tenant column or model argument is used`
    : `tenant ${resource.tenant_key}${resource.principal_key ? ` and principal ${resource.principal_key}` : ""} come only from Runner context, never model arguments`;
  const scopeConfirmed = await prompter.confirm(`Confirm trusted scope: ${trustedScope}.`, false);
  if (!scopeConfirmed) return undefined;

  const action: GuidedActionInput = {
    capability_name: capabilityName,
    description,
    resource: resource.id,
    operation,
    ...(patches ? { patches } : {}),
    ...(conflictColumn ? { conflict_column: conflictColumn } : {}),
    ...(versionAdvance ? { version_advance: versionAdvance } : {}),
    ...(dedupColumn ? { dedup_proposal_column: dedupColumn } : {}),
    approval_role: approvalRole,
    required_approvals: requiredApprovals,
    ...(autoApproval ? { auto_approval: autoApproval } : {}),
    authority_posture: authority.authority_posture,
    writeback: authority.writeback,
    supervised_worker_execution: authority.supervised_worker_execution === true,
    ...(authority.worker_policy ? { worker_policy: authority.worker_policy } : {}),
    ...(authority.receipt_mode ? { receipt_mode: authority.receipt_mode } : {}),
    ...(authority.write_url_env ? { write_url_env: authority.write_url_env } : {}),
    reversible,
    confirmed_trusted_scope: true,
    ...(deleteConfirmation ? { delete_confirmation: deleteConfirmation } : {}),
  };
  const accepted = authoring.mode === "guided"
    ? await prompter.choose("REVIEW DISABLED SAFE ACTION", [
        {
          value: "create",
          label: authoring.initial ? "Create replacement revision" : "Create disabled revision",
          detail: "Writes review artifacts only. No tool activates and no source row changes.",
        },
        { value: "back", label: "Back and change the design" },
      ], actionReviewLines(action, resource)) === "create"
    : await prompter.confirm(actionReviewPrompt(action, resource), false);
  return accepted ? action : undefined;
}

export async function collectQuickProposalActionInput(
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
  prompter: ActionControlPrompter,
  intent: string,
  initialContext: string[] = [],
): Promise<GuidedActionInput | "advanced" | undefined> {
  const decisions: QuickProposalDecisions = {};
  let firstChoice = true;
  const choiceContext = (context: string[]): string[] => {
    if (!firstChoice) return context;
    firstChoice = false;
    return initialContext.length
      ? [...initialContext, "", ...context]
      : context;
  };
  while (true) {
    const preparation = prepareQuickProposalAction({ options, intent, decisions });
    if (preparation.state === "ready") {
      const resource = options.resources.find((candidate) => candidate.id === preparation.action.resource)!;
      const canDelegateApproval = preparation.action.operation !== "delete"
        && (preparation.action.patches ?? []).some((patch) => patch.value_source === "argument");
      const decision = await prompter.choose("REVIEW PROPOSAL ACTION", [
        {
          value: "create",
          label: "Prepare and rehearse this disabled proposal action",
          detail: "Writes disabled artifacts only; source rows stay unchanged.",
        },
        ...(canDelegateApproval
          ? [{
              value: "delegate",
              label: "Add deterministic approval rules",
              detail: "Exact conditions and rolling limits; uncertainty returns to human review.",
            }]
          : []),
        {
          value: "advanced",
          label: "Open Advanced design",
          detail: "Change values, transitions, approval, execution, or receipts.",
        },
        { value: "back", label: "Back" },
      ], choiceContext(quickActionCardLines(preparation.summary)));
      if (decision === "advanced") return "advanced";
      if (decision === "delegate") {
        const autoApproval = await collectDeterministicAutoApproval({
          prompter,
          resource,
          operation: preparation.action.operation,
          patches: preparation.action.patches ?? [],
        });
        return autoApproval ? { ...preparation.action, auto_approval: autoApproval } : undefined;
      }
      return decision === "create" ? preparation.action : undefined;
    }
    const unresolved = preparation.decision;
    if (unresolved.kind === "resource" || unresolved.kind === "operation" || unresolved.kind === "guard_column") {
      const value = await prompter.choose(
        unresolved.title.toUpperCase(),
        unresolved.choices,
        choiceContext([unresolved.help]),
      );
      if (!value) return undefined;
      if (unresolved.kind === "resource") decisions.resource = value;
      if (unresolved.kind === "operation") decisions.operation = value as GuidedActionOperation;
      if (unresolved.kind === "guard_column") decisions.guard_column = value;
      continue;
    }
    if (unresolved.kind === "fields") {
      const value = await prompter.choose(
        unresolved.title.toUpperCase(),
        unresolved.choices,
        choiceContext([unresolved.help]),
      );
      if (!value) return undefined;
      decisions.fields = [value];
      continue;
    }
    if (unresolved.kind === "numeric_bounds") {
      const defaultRange = unresolved.suggested_minimum !== undefined && unresolved.suggested_maximum !== undefined
        ? `${unresolved.suggested_minimum},${unresolved.suggested_maximum}`
        : undefined;
      const selectedResource = options.resources.find((candidate) =>
        candidate.id === preparation.selected.resource);
      const target = preparation.selected.resource
        ? `${preparation.selected.operation?.toUpperCase() ?? "PROPOSAL"} ${preparation.selected.resource}`
        : "reviewed proposal target";
      const raw = await prompter.text(`Allowed ${unresolved.field} range (minimum,maximum)`, {
        ...(defaultRange ? { defaultValue: defaultRange } : {}),
        title: unresolved.title.toUpperCase(),
        context: [
          `Target: ${target}`,
          ...(selectedResource?.label && selectedResource.label !== selectedResource.id
            ? [`Table label: ${selectedResource.label}`]
            : []),
          `Agent-supplied field: ${unresolved.field}`,
          unresolved.help,
          "Enter two numbers separated by a comma, for example 0.5,16.",
          "These bounds constrain every proposal; they do not auto-approve or write anything.",
        ],
      });
      if (raw === undefined) return undefined;
      const values = raw.split(",").map((value) => Number(value.trim()));
      if (values.length !== 2 || !values.every(Number.isFinite) || values[0]! > values[1]!) {
        throw new Error(`${unresolved.field} needs a finite minimum,maximum range with minimum <= maximum.`);
      }
      decisions.numeric_bounds = {
        ...(decisions.numeric_bounds ?? {}),
        [unresolved.field]: { minimum: values[0]!, maximum: values[1]! },
      };
      continue;
    }
    if (unresolved.kind !== "delete_confirmation") {
      throw new Error(`Unsupported quick proposal decision ${unresolved.kind}.`);
    }
    const value = await prompter.text(`Type ${unresolved.expected} to include hard-delete proposals`);
    if (value === undefined) return undefined;
    decisions.delete_confirmation = value;
  }
}

function quickActionCardLines(
  summary: Extract<ReturnType<typeof prepareQuickProposalAction>, { state: "ready" }>["summary"],
): string[] {
  const argumentsSummary = summary.arguments.length
    ? summary.arguments.map((argument) =>
        `${argument.label ?? argument.field} (${argument.constraint})`).join("; ")
    : "none";
  return [
    `Target: ${summary.operation.toUpperCase()} ${summary.resource_label ?? summary.resource}`,
    `Agent supplies: ${argumentsSummary}`,
    `Runner supplies: ${summary.trusted_context.join("; ") || "no trusted scope fields"}`,
    `Retry guard: ${summary.retry_or_conflict_guard} | Approval: ${summary.approval}`,
    `PROPOSAL ONLY | writes ${summary.writeback.toUpperCase()} | no SQL, scope, activation, approval, or apply authority`,
  ];
}

export function createTerminalActionPrompter(input: ReadStream, output: WriteStream): ActionControlPrompter {
  const color = output.isTTY && !process.env.NO_COLOR;
  const theme = terminalTheme(Boolean(color), { brand: true });
  const clear = () => output.write("\u001b[2J\u001b[H");
  return {
    async choose(title, choices, context = [], initialValue) {
      if (!choices.length) return undefined;
      const requested = initialValue === undefined
        ? -1
        : choices.findIndex((choice) => choice.value === initialValue && !choice.disabled);
      let selected = requested >= 0
        ? requested
        : Math.max(0, choices.findIndex((choice) => !choice.disabled));
      return withRawTerminalScreen(input, output, async (nextKey, render) => {
        while (true) {
          render([
            theme.title(`  ${title}`),
            ...context.map((line) => `  ${formatActionPromptContextLine(theme, line)}`),
            "",
            ...choices.flatMap((choice, index) => [
              `${index === selected ? theme.focus("  >") : "   "} ${choice.disabled ? theme.dim(choice.label) : choice.label}`,
              ...(choice.detail ? [`      ${choice.disabled ? theme.dim(choice.detail) : theme.dim(choice.detail)}`] : []),
            ]),
            "",
            `  ${theme.key("Up/Down")} Navigate   ${theme.key("Enter")} Select   ${theme.key("Esc")} Back`,
          ]);
          const key = await nextKey();
          if (key.name === "escape" || key.sequence === "\u001b" || (key.ctrl && ["c", "d"].includes(key.name ?? ""))) return undefined;
          if (key.name === "up" || key.name === "down") {
            const direction = key.name === "up" ? -1 : 1;
            for (let offset = 1; offset <= choices.length; offset += 1) {
              const candidate = (selected + direction * offset + choices.length) % choices.length;
              if (!choices[candidate]!.disabled) {
                selected = candidate;
                break;
              }
            }
          }
          if ((key.name === "return" || key.name === "enter") && !choices[selected]!.disabled) return choices[selected]!.value;
        }
      });
    },
    async text(label, options = {}) {
      clear();
      const suffix = options.defaultValue !== undefined ? ` [${options.defaultValue}]` : "";
      const hasFrame = Boolean(options.title || options.context?.length);
      const prompt = hasFrame
        ? [
            ...(options.title ? [theme.title(`  ${options.title}`)] : []),
            ...(options.context ?? []).map((line) => `  ${formatActionPromptContextLine(theme, line)}`),
            "",
            `  ${label}${suffix} ${theme.key("[Esc Back]")}: `,
          ].join("\n")
        : `  ${label}${suffix} ${theme.key("[Esc Back]")}: `;
      const value = await readTerminalTextWithEscape(prompt, input, output);
      if (value === undefined) return undefined;
      return value || options.defaultValue;
    },
    async confirm(label, defaultValue = false) {
      const value = await this.choose("CONFIRM REVIEWED DECISION", [
        { value: "yes", label: "Yes", detail: label },
        { value: "no", label: "No", detail: "Leave this decision unchanged or return." },
      ], [`Default: ${defaultValue ? "yes" : "no"}`], defaultValue ? "yes" : "no");
      return value === undefined ? undefined : value === "yes";
    },
    async message(title, lines, backLabel = "Back to previous screen") {
      await this.choose(title, [{ value: "back", label: backLabel }], lines);
    },
  };
}

function formatActionPromptContextLine(
  theme: ReturnType<typeof terminalTheme>,
  line: string,
): string {
  if (!line) return "";
  const trimmed = line.trim();
  if (trimmed === "READ REVIEW COMPLETE - NOT ACTIVE") return theme.success(line);
  if (/[A-Z]/u.test(trimmed)
    && trimmed === trimmed.toUpperCase()
    && /^[A-Z0-9][A-Z0-9 +&/():.'-]*$/u.test(trimmed)) {
    return theme.title(line);
  }
  return theme.dim(line);
}

async function collectAndCreateAction(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  prompter: ActionControlPrompter;
  suggestion?: ActionSuggestionAssessment;
  authoring?: ActionAuthoringContext;
  actionBoundaryJobIntent?: string;
}): Promise<GuidedActionDraft | undefined> {
  const action = await collectGuidedActionInput(
    input.options,
    input.prompter,
    input.suggestion,
    input.authoring,
  );
  if (!action) return undefined;
  const created = await createGuidedActionDraft({
    projectRoot: input.projectRoot,
    action,
    inspection: input.inspection,
    boundaryName: input.options.boundary_name,
    allowReviewedPending: input.options.boundary_state === "reviewed_pending",
    ...(input.actionBoundaryJobIntent
      ? { actionBoundaryJobIntent: input.actionBoundaryJobIntent }
      : {}),
  });
  const stagedSharedLimitCount = action.auto_approval
    ? await reviewAndStageActionBoundaryLimits({
        projectRoot: input.projectRoot,
        inspection: input.inspection,
        prompter: input.prompter,
        capability: created.draft.capability,
        action,
        resource: input.options.resources.find((resource) => resource.id === action.resource)!,
        suggestion: input.suggestion,
      })
    : 0;
  await input.prompter.message("DISABLED ACTION REVISION CREATED", [
    `Capability: ${created.draft.capability}`,
    `Authority: ${created.draft.authority_posture}`,
    `Writeback: ${created.draft.writeback_mode}`,
    `Exact digest: ${created.draft.contract_digest}`,
    ...(stagedSharedLimitCount
      ? [`Shared approval limits: ${stagedSharedLimitCount} saved in the disabled Action Boundary revision.`]
      : []),
    "No active tools or source rows changed.",
  ]);
  return created.draft;
}

async function reviewAndStageActionBoundaryLimits(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  prompter: ActionControlPrompter;
  capability: string;
  action: GuidedActionInput;
  resource: GuidedActionResourceOption;
  suggestion?: ActionSuggestionAssessment;
}): Promise<number> {
  const argumentFields = new Set((input.action.patches ?? [])
    .filter((patch) => patch.value_source === "argument")
    .map((patch) => patch.column));
  let limits = suggestedActionBoundaryLimits(input.capability, input.suggestion)
    .filter((limit) => limit.kind === "count" || (limit.field !== undefined && argumentFields.has(limit.field)));
  if (!limits.length) {
    const add = await input.prompter.confirm(
      "Add a rolling trusted-scope circuit breaker for deterministic approvals? This bounds approvals separately for each verified tenant, principal, or object.",
      false,
    );
    if (!add) return 0;
    const scope = await input.prompter.choose("TRUSTED APPROVAL LIMIT SCOPE", [
      ...(input.resource.principal_key
        ? [{
            value: "tenant_principal",
            label: "Each trusted tenant + principal (recommended)",
            detail: "Each authenticated person or agent gets a separate rolling ceiling inside its tenant.",
          }]
        : []),
      { value: "tenant", label: "Each trusted tenant", detail: "Every principal in one tenant shares the rolling ceiling." },
      { value: "tenant_object", label: "Each trusted tenant + target row", detail: "Bounds repeated approvals against one exact reviewed object." },
    ], ["The agent supplies none of these identity values; Runner derives them from verified runtime context."]);
    if (!scope) return 0;
    const scopeDescription = scope === "tenant_principal"
      ? "each trusted tenant + principal"
      : scope === "tenant_object"
        ? "each trusted tenant + target row"
        : "each trusted tenant";
    const maximum = boundedInteger(
      await requiredText(
        input.prompter,
        "Maximum approvals in the rolling window",
        String(input.action.auto_approval!.max_per_day),
        {
          title: "SET TRUSTED-SCOPE APPROVAL LIMIT",
          context: [
            `Action: ${input.action.operation.toUpperCase()} ${input.resource.id}`,
            `Selected scope: ${scopeDescription}. Identity comes from verified Runner context, never model arguments.`,
            "Enter the count ceiling now; choose the rolling time window on the next screen.",
            "When this shared ceiling is reached, automatic approval stops and proposals require human review.",
          ],
        },
      ),
      1,
      Number.MAX_SAFE_INTEGER,
      "Shared approval maximum",
    );
    const window = await input.prompter.choose("ROLLING APPROVAL WINDOW", [
      { value: "3600", label: "1 hour" },
      { value: "86400", label: "24 hours (recommended)" },
      { value: "604800", label: "7 days" },
      { value: "2592000", label: "30 days" },
    ], [
      `Action: ${input.action.operation.toUpperCase()} ${input.resource.id}`,
      `Selected scope: ${scopeDescription} | maximum ${maximum} approval(s).`,
      "Choose how far back Runner counts approvals for this trusted-scope circuit breaker.",
    ], "86400");
    if (!window) return 0;
    limits = [{
      id: `reviewed_${scope}_count`,
      kind: "count",
      scope: scope as ActionBoundarySharedLimitV1["scope"],
      maximum,
      window_seconds: Number(window),
      capability: input.capability,
    }];
    const approval = input.action.auto_approval!;
    if (approval.max_total_per_day !== undefined && approval.total_field
      && await input.prompter.confirm(
        `Also apply the ${approval.total_field} aggregate ceiling at this trusted scope?`,
        true,
      )) {
      limits.push({
        id: `reviewed_${scope}_total`,
        kind: "total",
        scope: scope as ActionBoundarySharedLimitV1["scope"],
        maximum: approval.max_total_per_day,
        window_seconds: Number(window),
        capability: input.capability,
        field: approval.total_field,
      });
    }
  }
  const accepted = await input.prompter.confirm(
    [
      "Save the suggested trusted-scope circuit breakers in the disabled Action Boundary?",
      ...limits.map((limit) => actionBoundaryLimitSummary(limit)),
      "These use verified tenant/principal/object context. A tripped or indeterminate limit falls back to human review.",
    ].join(" "),
    false,
  );
  if (!accepted) return 0;
  await stageActionBoundaryLimits({ ...input, limits });
  return limits.length;
}

async function stageActionBoundaryLimits(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  limits: ActionBoundarySharedLimitV1[];
}): Promise<void> {
  const status = await guidedActionStatus(input.projectRoot);
  const current = status.action_boundary.draft ?? status.action_boundary.active;
  if (!current) {
    throw new Error("ACTION_BOUNDARY_DRAFT_REQUIRED: the proposed shared limits need one disabled Action Boundary revision.");
  }
  const proposedIds = new Set(input.limits.map((limit) => limit.id));
  await reviseGuidedActionBoundary({
    projectRoot: input.projectRoot,
    inspection: input.inspection,
    sharedLimits: [
      ...current.authority.shared_limits.filter((limit) => !proposedIds.has(limit.id)),
      ...input.limits,
    ],
  });
}

export function suggestedActionBoundaryLimits(
  capability: string,
  suggestion?: ActionSuggestionAssessment,
): ActionBoundarySharedLimitV1[] {
  const proposed = suggestion?.status === "suggested"
    ? suggestion.suggestion.approval_policy_proposal?.shared_limits ?? []
    : [];
  const capabilityStem = capability.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32);
  return proposed.map((limit, index) => ({
    id: `suggested_${capabilityStem}_${limit.scope}_${limit.kind}_${index + 1}`,
    kind: limit.kind,
    scope: limit.scope,
    maximum: limit.maximum,
    window_seconds: limit.window_seconds,
    capability,
    ...(limit.field ? { field: limit.field } : {}),
  }));
}

async function collectDeterministicAutoApproval(input: {
  prompter: ActionControlPrompter;
  resource: GuidedActionResourceOption;
  operation: GuidedActionOperation;
  patches: GuidedActionPatchInput[];
  initial?: GuidedActionAutoApprovalInput;
}): Promise<GuidedActionAutoApprovalInput | undefined> {
  const modelPatches = input.patches.filter((patch) => patch.value_source === "argument");
  const proposedConditions = input.initial ? reviewedAutoApprovalConditions(input.initial) : [];
  const policyContext = [
    `Target: ${input.operation.toUpperCase()} ${input.resource.id}`,
    "Every condition is ANDed. A failed, missing, or uncertain check returns the proposal to human review.",
    "This policy may approve a proposal; it never grants apply authority or writes to the source database.",
  ];
  const style = await input.prompter.choose("AUTO-APPROVAL CONDITIONS", [
    ...(proposedConditions.length
      ? [{
          value: "proposed",
          label: "Use these proposed conditions as the disabled starting point",
          detail: "Every condition and limit is shown below and remains editable before activation.",
        }]
      : []),
    {
      value: "recommended",
      label: "Review one safe condition per supplied field (recommended)",
      detail: "Amount ceilings stay explicit; enums, booleans, and bounded text are covered so no model-controlled write is ignored.",
    },
    {
      value: "custom",
      label: "Customize ranges and allowed values",
      detail: "Choose numeric ranges, enum subsets, boolean values, and exact or length-bounded text per field.",
    },
  ], [
    ...policyContext,
    ...(proposedConditions.length
      ? [
          "",
          "PROPOSED CONDITIONS (NOT AUTHORITY)",
          ...proposedConditions.map((condition) => `  ${approvalConditionSummary(condition)}`),
          `  Per-action circuit breaker: ${input.initial!.max_per_day}/day`,
          ...(input.initial!.max_total_per_day === undefined
            ? []
            : [`  Aggregate circuit breaker: ${input.initial!.max_total_per_day} ${input.initial!.total_field}/day`]),
        ]
      : []),
  ]);
  if (!style) return undefined;
  if (style === "proposed") {
    const accepted = await input.prompter.confirm(
      "Use this exact deterministic policy in the disabled Action Boundary draft? You can edit it before activation.",
      false,
    );
    if (!accepted) return undefined;
    return structuredClone(input.initial);
  }
  const custom = style === "custom";
  const fieldByName = new Map(input.resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const conditions: GuidedActionAutoApprovalCondition[] = [];
  for (const patch of modelPatches) {
    const field = fieldByName.get(patch.column);
    if (!field) throw new Error(`Auto-approval field ${patch.column} is no longer structurally available.`);
    const numeric = patch.minimum !== undefined && patch.maximum !== undefined;
    if (numeric) {
      const mode = custom
        ? await input.prompter.choose(`WHEN MAY ${field.label ?? patch.column} AUTO-APPROVE?`, [
            { value: "at_most", label: "At or below a reviewed maximum" },
            { value: "range", label: "Inside a reviewed range" },
            { value: "exact", label: "Only one exact value" },
          ], [
            ...policyContext,
            `Field: ${patch.column} | proposal envelope: ${patch.minimum} through ${patch.maximum}.`,
            "Choose the narrower condition that must pass for automatic approval.",
          ])
        : "at_most";
      if (!mode) return undefined;
      if (mode === "range") {
        const minimum = finiteNumber(await requiredText(
          input.prompter,
          `${patch.column} minimum for auto-approval`,
          String(patch.minimum),
          {
            title: "SET NUMERIC AUTO-APPROVAL RANGE",
            context: [
              ...policyContext,
              `Field: ${patch.column} | proposal envelope: ${patch.minimum} through ${patch.maximum}.`,
              "Enter the lowest value eligible for automatic approval.",
            ],
          },
        ), `${patch.column} policy minimum`);
        const maximum = finiteNumber(await requiredText(
          input.prompter,
          `${patch.column} maximum for auto-approval`,
          String(patch.maximum),
          {
            title: "SET NUMERIC AUTO-APPROVAL RANGE",
            context: [
              ...policyContext,
              `Field: ${patch.column} | proposal envelope: ${patch.minimum} through ${patch.maximum}.`,
              `Minimum already reviewed: ${minimum}. Enter the highest value eligible for automatic approval.`,
            ],
          },
        ), `${patch.column} policy maximum`);
        conditions.push(
          { field: patch.column, operator: "gte", value: minimum },
          { field: patch.column, operator: "lte", value: maximum },
        );
      } else if (mode === "exact") {
        const value = finiteNumber(await requiredText(
          input.prompter,
          `Exact ${patch.column} value for auto-approval`,
          String(patch.minimum),
          {
            title: "SET EXACT AUTO-APPROVAL VALUE",
            context: [
              ...policyContext,
              `Field: ${patch.column} | proposal envelope: ${patch.minimum} through ${patch.maximum}.`,
              "Only this exact value will be eligible for automatic approval.",
            ],
          },
        ), `${patch.column} exact policy value`);
        conditions.push({ field: patch.column, operator: "eq", value });
      } else {
        const legacyDefault = input.initial?.field === patch.column ? input.initial.maximum : undefined;
        const existingTyped = input.initial?.conditions?.find((condition) =>
          (condition.source ?? "patch") === "patch" && condition.field === patch.column && condition.operator === "lte");
        const maximum = finiteNumber(await requiredText(
          input.prompter,
          `Auto-approve ${patch.column} at or below`,
          String(legacyDefault ?? existingTyped?.value ?? patch.maximum),
          {
            title: "SET NUMERIC AUTO-APPROVAL CEILING",
            context: [
              ...policyContext,
              `Field: ${patch.column} | proposal envelope: ${patch.minimum} through ${patch.maximum}.`,
              "Enter the highest value eligible for automatic approval; larger valid proposals require human review.",
            ],
          },
        ), `${patch.column} policy maximum`);
        conditions.push({ field: patch.column, operator: "lte", value: maximum });
      }
      continue;
    }
    if (field.enum_values.length) {
      const allowed = custom
        ? parseReviewedEnumSubset(
            await requiredText(
              input.prompter,
              `${patch.column} values eligible for auto-approval (comma separated)`,
              field.enum_values.join(", "),
              {
                title: "SET AUTO-APPROVAL VALUES",
                context: [
                  ...policyContext,
                  `Field: ${patch.column} | reviewed values: ${field.enum_values.join(", ")}.`,
                  "Enter a comma-separated subset. Other reviewed values require human approval.",
                ],
              },
            ),
            field.enum_values,
            patch.column,
          )
        : field.enum_values;
      conditions.push({ field: patch.column, operator: "in", values: allowed });
      continue;
    }
    if (/bool/i.test(field.data_type)) {
      const choice = custom
        ? await input.prompter.choose(`AUTO-APPROVE ${field.label ?? patch.column}`, [
            { value: "false", label: "Only false" },
            { value: "true", label: "Only true" },
            { value: "either", label: "Either reviewed boolean value" },
          ], [
            ...policyContext,
            `Field: ${patch.column} | choose the boolean values eligible for automatic approval.`,
          ])
        : "either";
      if (!choice) return undefined;
      conditions.push(choice === "either"
        ? { field: patch.column, operator: "in", values: [false, true] }
        : { field: patch.column, operator: "eq", value: choice === "true" });
      continue;
    }
    const mode = custom
      ? await input.prompter.choose(`AUTO-APPROVE ${field.label ?? patch.column}`, [
          { value: "exact", label: "Only one exact reviewed value" },
          { value: "length", label: "Any text within a reviewed maximum length" },
        ], [
          ...policyContext,
          `Field: ${patch.column} | choose how narrowly text values are eligible for automatic approval.`,
        ])
      : "length";
    if (!mode) return undefined;
    if (mode === "exact") {
      const value = await requiredText(
        input.prompter,
        `Exact ${patch.column} value for auto-approval`,
        undefined,
        {
          title: "SET EXACT AUTO-APPROVAL VALUE",
          context: [...policyContext, `Field: ${patch.column} | only this exact text will auto-approve.`],
        },
      );
      conditions.push({ field: patch.column, operator: "eq", value });
    } else {
      const maximum = boundedInteger(await requiredText(
        input.prompter,
        `${patch.column} maximum length for auto-approval`,
        String(patch.max_length ?? 128),
        {
          title: "SET TEXT AUTO-APPROVAL LIMIT",
          context: [
            ...policyContext,
            `Field: ${patch.column} | proposal maximum length: ${patch.max_length ?? 4096}.`,
            "Enter the longest text value eligible for automatic approval.",
          ],
        },
      ), 1, patch.max_length ?? 4096, `${patch.column} policy length`);
      conditions.push({ field: patch.column, operator: "max_length", value: maximum });
    }
  }
  for (const patch of input.patches.filter((candidate) =>
    candidate.value_source === "fixed" && (candidate.allowed_from?.length ?? 0) > 0)) {
    conditions.push({ source: "before", field: patch.column, operator: "in", values: patch.allowed_from });
  }
  const maxPerDay = boundedInteger(await requiredText(
    input.prompter,
    "Maximum auto-approved proposals per day",
    String(input.initial?.max_per_day ?? 20),
    {
      title: "SET PER-ACTION CIRCUIT BREAKER",
      context: [
        ...policyContext,
        "Enter how many proposals this action policy may auto-approve per rolling 24 hours.",
        "After the ceiling is reached, further proposals require human review.",
      ],
    },
  ), 1, 1_000_000, "per-day policy count");
  const numericPatches = modelPatches.filter((patch) => patch.minimum !== undefined && patch.maximum !== undefined);
  if (!numericPatches.length) return { conditions, max_per_day: maxPerDay };
  const totalField = numericPatches.length === 1
    ? numericPatches[0]!.column
    : await chooseRequired(input.prompter, "DAILY AGGREGATE LIMIT FIELD", numericPatches.map((patch) => patch.column));
  if (!totalField) return undefined;
  const totalPatch = numericPatches.find((patch) => patch.column === totalField)!;
  const maxTotal = boundedInteger(await requiredText(
    input.prompter,
    `Maximum aggregate ${totalField} auto-approved per day`,
    String(input.initial?.max_total_per_day ?? Math.max(totalPatch.maximum ?? 1, 1) * maxPerDay),
    {
      title: "SET AGGREGATE CIRCUIT BREAKER",
      context: [
        ...policyContext,
        `Count ceiling already reviewed: ${maxPerDay} auto-approved proposal(s) per rolling 24 hours.`,
        `Enter the maximum combined ${totalField} across those auto-approved proposals.`,
      ],
    },
  ), 1, 1_000_000_000, "aggregate policy value");
  return {
    conditions,
    max_per_day: maxPerDay,
    max_total_per_day: maxTotal,
    total_field: totalField,
  };
}

function finiteNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return parsed;
}

function parseReviewedEnumSubset(value: string, allowed: string[], field: string): string[] {
  const selected = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!selected.length || selected.some((item) => !allowed.includes(item))) {
    throw new Error(`${field} policy values must be selected from: ${allowed.join(", ")}.`);
  }
  return selected;
}

export async function reviewActionDraft(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  draft: GuidedActionDraft;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  baseConfigPath?: string;
  operatorSession?: ActionOperatorSession;
  returnToAsk?: boolean;
  quickStart?: boolean;
  prepareOnly?: boolean;
  actionBoundaryJobIntent?: string;
}): Promise<string | undefined> {
  let draft = input.draft;
  const operatorSession = input.operatorSession ?? {};
  if (input.quickStart && !draft.effect_preview) {
    try {
      const details = await guidedActionDraftDetails(input.projectRoot, draft.capability);
      const args = await collectQuickGuidedRehearsalArgs(details, input.prompter);
      if (!args) {
        await input.prompter.message("PROPOSAL ACTION KEPT DISABLED", [
          `Action: ${draft.capability}`,
          "The exact existing row ID needed for UPDATE or DELETE rehearsal was not provided.",
          "No rehearsal ran, no authority activated, and no source row changed.",
          "Open this disabled draft later to rehearse it with one authorized row ID.",
        ]);
        return undefined;
      }
      const preview = await executeGuidedActionPreview({
        projectRoot: input.projectRoot,
        ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
        capabilityName: draft.capability,
        args,
        env: input.env,
      });
      draft = await recordGuidedActionPreview({
        projectRoot: input.projectRoot,
        capabilityName: draft.capability,
        contractDigest: preview.draft_digest,
        proposalId: preview.proposal_id,
        proposalHash: preview.proposal_hash,
        sourceDatabaseChanged: preview.source_database_changed,
      });
    } catch (error) {
      await input.prompter.message("AUTOMATIC REHEARSAL NEEDS ATTENTION", [
        error instanceof Error ? error.message : String(error),
        "The action remains a disabled draft. No source row or active tool changed.",
        "Use the guided rehearsal below to supply a value or required production token.",
      ]);
    }
  }
  if (input.prepareOnly) {
    let deterministicApproval = false;
    try {
      deterministicApproval = Boolean(
        (await readGuidedActionDesignInput(input.projectRoot, draft.capability, "draft")).auto_approval,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("GUIDED_ACTION_DRAFT_REQUIRED")) throw error;
    }
    await input.prompter.message("PROPOSAL ACTION DRAFT SAVED", [
      `Action: ${draft.capability}`,
      `Rehearsal: ${draft.effect_preview ? "passed in a disposable ledger" : "still required"}`,
      "Proposal action: DISABLED",
      `Approval: ${deterministicApproval ? "DETERMINISTIC POLICY (DISABLED)" : "HUMAN"}`,
      "Writeback: OFF",
      "Source database changed: no",
      "Review and activate this exact action separately when the read boundary is ready.",
    ]);
    return undefined;
  }
  if (input.quickStart && draft.effect_preview) {
    const design = await readGuidedActionDesignInput(input.projectRoot, draft.capability, "draft");
    const options = await guidedActionOptions({
      projectRoot: input.projectRoot,
      inspection: input.inspection,
      ...(draft.boundary_name ? { boundaryName: draft.boundary_name } : {}),
      allowReviewedPending: true,
    });
    const resource = options.resources.find((candidate) => candidate.id === design.resource);
    if (!resource) throw new Error(`GUIDED_ACTION_RESOURCE_UNKNOWN: ${design.resource} is no longer eligible.`);
    if (options.boundary_state === "reviewed_pending") {
      await input.prompter.message("PROPOSAL ACTION READY", [
        `Action: ${draft.capability}`,
        `Read dependency: ${options.boundary_name} (${shortDigest(options.boundary_digest)})`,
        "Rehearsal: passed in a disposable ledger",
        "Proposal action: DISABLED",
        "Source database changed: no",
        "",
        "Return to access review and activate this exact read boundary first. Then press Y again to activate the rehearsed proposal action.",
      ]);
      return undefined;
    }
    const choice = await input.prompter.choose("ACTIVATE PROPOSAL ACTION", [
      {
        value: "activate",
        label: "Activate this exact proposal-only action",
        detail: "Creates proposals only; approval and apply remain outside the agent.",
      },
      {
        value: "advanced",
        label: "Open draft details",
        detail: "Inspect DSL, policy, rehearsal, or edit the design.",
      },
      { value: "back", label: "Leave disabled" },
    ], [
      ...actionActivationReviewLines(design, resource),
      "Rehearsal: passed for this exact disabled revision; source database changed: no.",
    ]);
    if (choice === "activate") {
      const actor = input.env.SYNAPSOR_OPERATOR_ACTOR ?? input.env.USER ?? "local_operator";
      operatorSession.actor = actor;
      return activateActionDraft({ ...input, draft, actor });
    }
    if (choice !== "advanced") return undefined;
  }
  while (true) {
    const choice = await input.prompter.choose("DISABLED ACTION REVISION", [
      { value: "preview", label: "Run guided proposal rehearsal", detail: "Collects typed values, uses a disposable ledger, and never applies the proposal." },
      { value: "activate", label: "Activate this exact rehearsed revision", detail: draft.effect_preview ? "Runner binds confirmation to the selected digest and rechecks it at activation." : "Unavailable until the exact digest has a successful rehearsal.", disabled: !draft.effect_preview },
      { value: "edit", label: "Edit or replace this reviewed design", detail: "Creates a disabled replacement digest. Active authority remains unchanged." },
      { value: "dsl", label: "View generated DSL and authority summary" },
      { value: "discard", label: "Discard this disabled draft", detail: "Removes only this exact disabled draft. Active revisions and source rows are untouched." },
      { value: "back", label: "Back" },
    ], actionDraftLines(draft));
    if (!choice || choice === "back") return undefined;
    if (choice === "dsl") {
      const details = await guidedActionDraftDetails(input.projectRoot, draft.capability);
      await input.prompter.message("GENERATED REVIEW ARTIFACT", [
        ...actionDraftLines(draft),
        "",
        ...details.dsl.trimEnd().split("\n"),
      ]);
      continue;
    }
    if (choice === "edit") {
      const current = await readGuidedActionDesignInput(input.projectRoot, draft.capability, "draft");
      const options = await guidedActionOptions({
        projectRoot: input.projectRoot,
        inspection: input.inspection,
        ...(draft.boundary_name ? { boundaryName: draft.boundary_name } : {}),
        allowReviewedPending: true,
      });
      const replacement = await collectAndCreateAction({
        projectRoot: input.projectRoot,
        inspection: input.inspection,
        options,
        prompter: input.prompter,
        authoring: { intent: current.description, mode: "guided", initial: current },
      });
      if (replacement) draft = replacement;
      continue;
    }
    if (choice === "discard") {
      const confirmed = await input.prompter.confirm(
        `Discard disabled revision ${draft.capability} (${shortDigest(draft.contract_digest)})? Active authority and source data remain unchanged.`,
        false,
      );
      if (!confirmed) continue;
      await discardGuidedActionDraft({
        projectRoot: input.projectRoot,
        capabilityName: draft.capability,
        expectedDigest: draft.contract_digest,
      });
      await input.prompter.message("DISABLED ACTION DRAFT DISCARDED", [
        `Capability: ${draft.capability}`,
        `Discarded digest: ${draft.contract_digest}`,
        "Active revisions changed: no",
        "Source database changed: no",
      ]);
      return undefined;
    }
    if (choice === "preview") {
      const details = await guidedActionDraftDetails(input.projectRoot, draft.capability);
      const args = await collectGuidedRehearsalArgs(details, input.prompter);
      if (!args) continue;
      const preview = await executeGuidedActionPreview({
        projectRoot: input.projectRoot,
        ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
        capabilityName: draft.capability,
        args,
        env: input.env,
      });
      draft = await recordGuidedActionPreview({
        projectRoot: input.projectRoot,
        capabilityName: draft.capability,
        contractDigest: preview.draft_digest,
        proposalId: preview.proposal_id,
        proposalHash: preview.proposal_hash,
        sourceDatabaseChanged: preview.source_database_changed,
      });
      await input.prompter.message("REHEARSAL VERIFIED", [
        `Proposal identity: ${preview.proposal_id}`,
        `Proposal hash: ${preview.proposal_hash}`,
        "Source database changed: no",
        "The disposable rehearsal ledger was removed; this proposal can never be applied.",
      ]);
      continue;
    }
    if (choice === "activate") {
      const actor = operatorSession.actor ?? await input.prompter.text("Operator audit identity", {
        defaultValue: input.env.SYNAPSOR_OPERATOR_ACTOR ?? input.env.USER ?? "local_operator",
      });
      if (!actor) continue;
      operatorSession.actor = actor;
      const confirmed = await input.prompter.confirm(
        `Activate ${draft.capability} at exact digest ${shortDigest(draft.contract_digest)}? Runner will recompute the full digest. This does not approve or apply any proposal.`,
        false,
      );
      if (!confirmed) continue;
      return activateActionDraft({ ...input, draft, actor });
    }
  }
}

async function activateActionDraft(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  draft: GuidedActionDraft;
  prompter: ActionControlPrompter;
  actor: string;
  baseConfigPath?: string;
  returnToAsk?: boolean;
  quickStart?: boolean;
}): Promise<string> {
  const active = await activateGuidedAction({
    projectRoot: input.projectRoot,
    capabilityName: input.draft.capability,
    expectedDigest: input.draft.contract_digest,
    confirmation: `ACTIVATE ${input.draft.contract_digest}`,
    actor: input.actor,
    inspection: input.inspection,
    ...(input.baseConfigPath ? { configPath: input.baseConfigPath } : {}),
  });
  const actionBoundary = (await guidedActionStatus(input.projectRoot)).action_boundary.active;
  await input.prompter.message(input.quickStart ? "SETUP COMPLETE" : "SAFE ACTION ACTIVATED", input.quickStart
    ? [
        "Read boundary: ACTIVE",
        `Proposal action: ACTIVE (${active.capability})`,
        actionBoundaryActivationStatusLine(actionBoundary),
        actionBoundaryApprovalStatusLine(actionBoundary, active.capability),
        "Writeback: DISABLED",
        "Source database changed: no",
        "",
        "Agents may create bounded immutable proposals. They still cannot activate, approve, apply, change trusted scope, or change source rows.",
        input.returnToAsk
          ? "Returning to the read-only Ask shell. Its reviewed two-tool Explore surface is unchanged."
          : "Select the active action from this control plane for connection commands, exact digests, DSL, and audit details.",
      ]
    : [
        `Capability: ${active.capability}`,
        `Authority: ${active.authority_posture}`,
        `Writeback: ${active.writeback_mode}`,
        `Exact digest: ${active.contract_digest}`,
        `Action runtime: ${active.config_path}`,
        active.writeback_mode === "none"
          ? "Source mutation remains impossible. Calls create immutable proposals only."
          : "A separate trusted approval and execution path is still required before source mutation.",
        input.returnToAsk
          ? "Returning to the read-only Ask shell with the same provider, model, credential, and conversation. Its two-tool Explore surface is intentionally unchanged."
          : "The action is ready in its separate semantic-tool runtime.",
        ...actionRuntimeLines(active),
        "Open this control plane again to review proposals, approvals, receipts, and replay.",
      ]);
  return active.capability;
}

export async function collectGuidedRehearsalArgs(
  details: Awaited<ReturnType<typeof guidedActionDraftDetails>>,
  prompter: ActionControlPrompter,
): Promise<Record<string, unknown> | undefined> {
  const mode = await prompter.choose("REHEARSAL VALUES", [
    {
      value: "guided",
      label: "Enter typed values (recommended)",
      detail: "Runner uses the generated argument types, enums, and reviewed bounds.",
    },
    {
      value: "json",
      label: "Paste exact JSON (advanced)",
      detail: "Useful for repeatable fixtures. The same generated contract validates it.",
    },
    { value: "back", label: "Back" },
  ], [
    "Rehearsal creates a disposable proposal and never changes the source database.",
  ]);
  if (!mode || mode === "back") return undefined;
  if (mode === "json") {
    const raw = await prompter.text("Exact rehearsal arguments as JSON", {
      defaultValue: JSON.stringify(details.preview_args),
    });
    return raw ? parseJsonObject(raw, "rehearsal arguments") : undefined;
  }
  const capability = details.contract.capabilities.find((candidate) => candidate.name === details.draft.capability);
  if (!capability) throw new Error("GUIDED_ACTION_CAPABILITY_MISSING: the managed contract no longer contains its action.");
  const args: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(capability.args ?? {})) {
    if (definition.type === "object_array") {
      throw new Error("GUIDED_ACTION_ARGUMENT_SHAPE_UNSUPPORTED: guided actions do not emit object-array arguments.");
    }
    const defaultValue = details.preview_args[name];
    if (definition.enum?.length) {
      const enumValues = definition.enum;
      const value = await prompter.choose(
        `VALUE FOR ${name}`,
        enumValues.map((candidate, index) => ({
          value: String(index),
          label: formatActionValue(candidate),
        })),
        [definition.description ?? "Choose one exact reviewed value."],
      );
      if (value === undefined) return undefined;
      const selected = enumValues[Number(value)];
      if (selected === undefined) {
        throw new Error(`GUIDED_ACTION_REHEARSAL_VALUE_INVALID: ${name} is not an allowed reviewed value.`);
      }
      args[name] = selected;
      continue;
    }
    if (definition.type === "boolean") {
      const value = await prompter.choose(`VALUE FOR ${name}`, [
        { value: "true", label: "True" },
        { value: "false", label: "False" },
      ], [definition.description ?? "Choose one boolean value."]);
      if (value === undefined) return undefined;
      args[name] = value === "true";
      continue;
    }
    const raw = await prompter.text(`Value for ${name}`, {
      defaultValue: defaultValue === undefined ? undefined : String(defaultValue),
    });
    if (raw === undefined) return undefined;
    if (definition.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)
        || (definition.minimum !== undefined && value < definition.minimum)
        || (definition.maximum !== undefined && value > definition.maximum)) {
        throw new Error(
          `GUIDED_ACTION_REHEARSAL_VALUE_INVALID: ${name} must be a finite number`
          + `${definition.minimum === undefined ? "" : ` >= ${definition.minimum}`}`
          + `${definition.maximum === undefined ? "" : ` <= ${definition.maximum}`}.`,
        );
      }
      args[name] = value;
      continue;
    }
    if (definition.max_length !== undefined && raw.length > definition.max_length) {
      throw new Error(`GUIDED_ACTION_REHEARSAL_VALUE_INVALID: ${name} exceeds ${definition.max_length} characters.`);
    }
    args[name] = raw;
  }
  const accepted = await prompter.choose("REVIEW REHEARSAL", [
    { value: "run", label: "Run source-unchanged rehearsal" },
    { value: "back", label: "Back and change values" },
  ], [
    ...Object.entries(args).map(([name, value]) => `${name}: ${formatActionValue(value)}`),
    "Trusted tenant/principal context is injected by Runner and is not shown as a model argument.",
  ]);
  return accepted === "run" ? args : undefined;
}

export function generatedGuidedRehearsalArgs(
  details: Awaited<ReturnType<typeof guidedActionDraftDetails>>,
): Record<string, unknown> {
  const capability = details.contract.capabilities.find((candidate) => candidate.name === details.draft.capability);
  if (!capability) throw new Error("GUIDED_ACTION_CAPABILITY_MISSING: the managed contract no longer contains its action.");
  const args: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(capability.args ?? {})) {
    if (definition.type === "object_array") {
      throw new Error("GUIDED_ACTION_ARGUMENT_SHAPE_UNSUPPORTED: guided actions do not emit object-array arguments.");
    }
    if (definition.enum?.length) {
      args[name] = definition.enum[0];
      continue;
    }
    if (definition.type === "number") {
      args[name] = definition.minimum ?? (definition.maximum !== undefined && definition.maximum < 0 ? definition.maximum : 0);
      continue;
    }
    if (definition.type === "boolean") {
      args[name] = false;
      continue;
    }
    const source = typeof details.preview_args[name] === "string"
      ? String(details.preview_args[name])
      : `rehearsal-${name.replaceAll("_", "-")}`;
    args[name] = definition.max_length === undefined
      ? source
      : source.slice(0, Math.max(1, definition.max_length));
  }
  return args;
}

export async function collectQuickGuidedRehearsalArgs(
  details: Awaited<ReturnType<typeof guidedActionDraftDetails>>,
  prompter: ActionControlPrompter,
): Promise<Record<string, unknown> | undefined> {
  const args = generatedGuidedRehearsalArgs(details);
  const capability = details.contract.capabilities.find((candidate) => candidate.name === details.draft.capability);
  if (!capability) throw new Error("GUIDED_ACTION_CAPABILITY_MISSING: the managed contract no longer contains its action.");
  const lookupArgument = capability.lookup?.id_from_arg;
  if (!lookupArgument) return args;
  const resource = `${capability.subject.schema}.${capability.subject.table}`;
  const value = await prompter.text(
    `Existing ${lookupArgument} value`,
    {
      title: "CHOOSE ONE EXISTING ROW FOR REHEARSAL",
      context: [
        `Target: ${details.draft.operation.toUpperCase()} ${resource}`,
        `Row identity argument: ${lookupArgument}`,
        "Runner reads this one authorized row under trusted tenant/principal scope to verify before-state and conflict guards.",
        "The proposal is written only to a disposable ledger; the source row is never changed.",
        "Enter an exact existing ID for the current trusted scope.",
      ],
    },
  );
  if (value === undefined) return undefined;
  if (!value.trim()) {
    throw new Error(`A non-empty existing ${resource} ID is required for rehearsal.`);
  }
  args[lookupArgument] = value.trim();
  return args;
}

async function collectPatches(
  resource: GuidedActionResourceOption,
  prompter: ActionControlPrompter,
  input: {
    operation: GuidedActionOperation;
    dedupColumn?: string;
    suggestedFields?: string[];
    initialPatches?: GuidedActionInput["patches"];
  },
): Promise<NonNullable<GuidedActionInput["patches"]> | undefined> {
  if (input.initialPatches?.length) {
    const choice = await prompter.choose("REVIEW WRITE FIELDS", [
      {
        value: "keep",
        label: "Keep the currently reviewed fields and value bounds",
        detail: input.initialPatches.map((patch) => patch.column).join(", "),
      },
      {
        value: "replace",
        label: "Choose fields and value bounds again",
        detail: "The active revision remains unchanged until a replacement is rehearsed and activated.",
      },
      { value: "back", label: "Back" },
    ]);
    if (!choice || choice === "back") return undefined;
    if (choice === "keep") return structuredClone(input.initialPatches);
  }
  const patches: NonNullable<GuidedActionInput["patches"]> = [];
  const suggestedOrder = new Map((input.suggestedFields ?? []).map((field, index) => [field, index]));
  const eligibleFields = [...resource.structurally_eligible_fields].sort((left, right) => {
    const leftOrder = suggestedOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = suggestedOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
  const remaining = new Map(eligibleFields.map((field) => [field.name, field]));
  while (remaining.size > 0) {
    const selected = new Set(patches.map((patch) => patch.column));
    const missingRequired = input.operation === "insert"
      ? resource.structurally_eligible_fields
        .filter((field) => field.required_for_insert && field.name !== input.dedupColumn && !selected.has(field.name))
        .map((field) => field.name)
      : [];
    const choice = await prompter.choose("CHOOSE EXACT WRITE FIELDS", [
      ...[...remaining.values()].map((field) => ({
        value: field.name,
        label: field.label ? `${field.label} (${field.name})` : field.name,
        detail: `${field.data_type}${field.enum_values.length ? ` | enum ${field.enum_values.join(", ")}` : ""}${field.nullable ? " | nullable" : ""}${input.operation === "insert" && field.required_for_insert && field.name !== input.dedupColumn ? " | required for INSERT" : ""}`,
      })),
      {
        value: "done",
        label: patches.length ? "Done selecting fields" : "Cancel",
        detail: missingRequired.length ? `Still required: ${missingRequired.join(", ")}` : undefined,
        disabled: patches.length === 0 || missingRequired.length > 0,
      },
    ], [
      "Structural eligibility is not business permission. You must review the value shape next.",
      ...(missingRequired.length ? [`INSERT still requires: ${missingRequired.join(", ")}.`] : []),
    ]);
    if (!choice) return undefined;
    if (choice === "done") break;
    const field = remaining.get(choice)!;
    const source = await prompter.choose(`VALUE AUTHORITY FOR ${field.name}`, [
      { value: "argument", label: "Bounded model argument", detail: "The model supplies only a value inside the exact reviewed type and bounds." },
      { value: "fixed", label: "Fixed reviewed value", detail: "The model cannot choose or alter this value." },
    ]);
    if (!source) return undefined;
    if (source === "fixed") {
      let fixed: string | undefined;
      if (field.enum_values.length) fixed = await chooseRequired(prompter, `FIXED ${field.name}`, field.enum_values);
      else fixed = await prompter.text(`Fixed ${field.name} value`);
      if (fixed === undefined) return undefined;
      const fixedValue = parseFieldScalar(fixed, field);
      const allowedFrom = input.operation === "update" && field.enum_values.length
        ? parseAllowedValues(
            await requiredText(
              prompter,
              `Allowed current ${field.name} values (comma-separated)`,
              field.enum_values.filter((value) => value !== String(fixedValue)).join(","),
            ),
            field.enum_values,
          )
        : [];
      patches.push({ column: field.name, value_source: "fixed", fixed_value: fixedValue, allowed_from: allowedFrom });
    } else if (isNumericType(field.data_type)) {
      const minimum = Number(await requiredText(prompter, `Business minimum for ${field.name}`));
      const maximum = Number(await requiredText(prompter, `Business maximum for ${field.name}`));
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
        throw new Error(`Action field ${field.name} needs finite reviewed bounds with minimum <= maximum.`);
      }
      patches.push({ column: field.name, value_source: "argument", argument_name: field.name, minimum, maximum });
    } else if (field.enum_values.length) {
      patches.push({ column: field.name, value_source: "argument", argument_name: field.name });
    } else if (isBooleanType(field.data_type)) {
      patches.push({ column: field.name, value_source: "argument", argument_name: field.name });
    } else {
      const maxLength = boundedInteger(
        await requiredText(prompter, `Maximum business-safe length for ${field.name}`),
        1,
        100_000,
        `${field.name} maximum length`,
      );
      patches.push({ column: field.name, value_source: "argument", argument_name: field.name, max_length: maxLength });
    }
    remaining.delete(choice);
    const selectedAfterReview = new Set(patches.map((patch) => patch.column));
    const requiredRemaining = input.operation === "insert"
      ? resource.structurally_eligible_fields
        .filter((candidate) => candidate.required_for_insert
          && candidate.name !== input.dedupColumn
          && !selectedAfterReview.has(candidate.name))
        .map((candidate) => candidate.name)
      : [];
    const suggestedRemaining = (input.suggestedFields ?? [])
      .filter((candidate) => remaining.has(candidate));
    if (requiredRemaining.length) {
      const continueRequired = await prompter.confirm(
        `Review the next required INSERT field? Still required: ${requiredRemaining.join(", ")}. No cancels this incomplete action draft.`,
        true,
      );
      if (continueRequired !== true) return undefined;
      continue;
    }
    if (suggestedRemaining.length) {
      const continueSuggested = await prompter.confirm(
        `Review the next model-suggested write field? Still suggested: ${suggestedRemaining.join(", ")}.`,
        true,
      );
      if (continueSuggested !== true) break;
      continue;
    }
    if (!(await prompter.confirm("Add another exact write field?", false))) break;
  }
  return patches;
}

async function collectAuthority(
  prompter: ActionControlPrompter,
  deploymentProfile: "development" | "staging" | "production",
  initial?: GuidedActionInput,
): Promise<GuidedActionAuthorityRevisionInput | undefined> {
  const posture = await prompter.choose("EXECUTION AUTHORITY", prioritizeByValue([
    { value: "proposal_only", label: "Proposal-only (recommended)", detail: "WRITEBACK NONE. Source mutation is impossible." },
    { value: "executable", label: "Executable after separate approval", detail: "Adds a reviewed executor, but agents still cannot approve or apply." },
    { value: "supervised_execution", label: "Supervised worker execution", detail: "Exact-digest direct SQL worker with queue, lease, retry, rate, and writer-posture controls." },
  ], initial?.authority_posture ?? "proposal_only", (item) => item.value));
  if (!posture) return undefined;
  if (posture === "proposal_only") {
    return { authority_posture: "proposal_only", writeback: { mode: "none" } };
  }
  if (posture === "supervised_execution") {
    const fingerprint = deploymentProfile === "production"
      ? await prompter.text("Reviewed least-privilege writer posture fingerprint (sha256:...)")
      : undefined;
    if (deploymentProfile === "production" && !fingerprint) return undefined;
    return {
      authority_posture: "supervised_execution",
      writeback: { mode: "direct_sql" },
      supervised_worker_execution: true,
      receipt_mode: "runner_ledger",
      write_url_env: await requiredText(prompter, "Writer credential environment name", initial?.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL"),
      worker_policy: {
        profile: deploymentProfile,
        concurrency: boundedInteger(await requiredText(prompter, "Worker concurrency", String(initial?.worker_policy?.concurrency ?? 1)), 1, 32, "worker concurrency"),
        queue_limit: boundedInteger(await requiredText(prompter, "Queue limit", String(initial?.worker_policy?.queue_limit ?? 100)), 1, 10_000, "queue limit"),
        lease_seconds: boundedInteger(await requiredText(prompter, "Lease seconds", String(initial?.worker_policy?.lease_seconds ?? 300)), 15, 3_600, "lease seconds"),
        max_attempts: boundedInteger(await requiredText(prompter, "Maximum attempts", String(initial?.worker_policy?.max_attempts ?? 5)), 1, 100, "maximum attempts"),
        proposal_ttl_seconds: boundedInteger(await requiredText(prompter, "Proposal TTL seconds", String(initial?.worker_policy?.proposal_ttl_seconds ?? 86_400)), 60, 2_592_000, "proposal TTL"),
        require_least_privilege_writer: deploymentProfile === "production",
        ...(fingerprint ? { writer_posture_fingerprint: fingerprint as `sha256:${string}` } : {}),
      },
    };
  }
  const mode = await prompter.choose("REVIEWED EXECUTOR", prioritizeByValue([
    { value: "direct_sql", label: "Runner direct SQL", detail: "Runner rechecks scope, conflict, idempotency, receipt, and one-row bounds in one guarded transaction." },
    { value: "app_handler", label: "Application handler", detail: "An exact reviewed application executor owns the final effect." },
    { value: "cloud_worker", label: "Cloud worker", detail: "A separately deployed cloud executor owns the final effect." },
  ], initial?.writeback?.mode === "none" ? "direct_sql" : initial?.writeback?.mode, (item) => item.value));
  if (!mode) return undefined;
  const executor = mode === "app_handler"
    ? await prompter.text("Exact application executor name", { defaultValue: initial?.writeback?.executor })
    : undefined;
  if (mode === "app_handler" && !executor) return undefined;
  return {
    authority_posture: "executable",
    writeback: { mode: mode as "direct_sql" | "app_handler" | "cloud_worker", ...(executor ? { executor } : {}) },
    ...(mode === "direct_sql" ? {
      receipt_mode: "runner_ledger" as const,
      write_url_env: await requiredText(prompter, "Writer credential environment name", initial?.write_url_env ?? "SYNAPSOR_DATABASE_WRITE_URL"),
    } : {}),
  };
}

function actionHomeChoices(
  status: Awaited<ReturnType<typeof guidedActionStatus>>,
  suggestions: ActionSuggestionView[],
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
  modelSuggestionSession?: ActionModelSuggestionSession,
): ActionPromptChoice[] {
  const readyTargets = actionReadyResourceCount(options);
  const blockedTargets = actionBlockedTargetCount(options);
  return [
    {
      value: "boundary",
      label: `Review Action Boundary [${actionBoundaryStateLabel(status)}]`,
      detail: actionBoundaryChoiceDetail(status),
    },
    ...status.activations.map((active) => ({
      value: `active:${active.capability}`,
      label: `${active.capability} [ACTIVE ${active.authority_posture}]`,
      detail: `${active.operation?.toUpperCase() ?? "ACTION"} ${active.resource ?? "legacy target"} | ${active.contract_digest.slice(0, 20)}...`,
    })),
    ...status.drafts.map((draft) => ({
      value: `draft:${draft.capability}`,
      label: draft.effect_preview
        ? "Continue rehearsed proposal action [READY FOR REVIEW]"
        : "Continue proposal action setup [DISABLED]",
      detail: `${draft.operation.toUpperCase()} ${draft.resource} | ${draft.capability} | ${draft.effect_preview ? "rehearsal passed" : "rehearsal needed"}`,
    })),
    ...suggestions.map((suggestion) => ({
      value: `suggestion:${suggestion.suggestion_id}`,
      label: `${suggestion.suggestion_id} [${suggestion.state.toUpperCase()}]`,
      detail: suggestion.assessment.suggestion.intent,
    })),
    {
      value: "new",
      label: "Create a proposal action (recommended)",
      detail: "Describe the effect. Runner prepares one proposal-only action card and rehearses it without source writes.",
      disabled: readyTargets === 0,
    },
    {
      value: "new_advanced",
      label: "Advanced action design",
      detail: "Choose fixed values, transitions, approval policy, execution posture, receipts, and every low-level field decision.",
      disabled: readyTargets === 0,
    },
    {
      value: "model_suggest",
      label: modelSuggestionSession
        ? `Ask the current ${modelSuggestionSession.provider}/${modelSuggestionSession.model} model for a bounded suggestion`
        : "Ask a model for a bounded suggestion",
      detail: modelSuggestionSession
        ? "Reuses the current in-memory Ask connection after one structural-metadata egress confirmation. The result remains untrusted and non-authoritative."
        : "Sends structural candidate metadata only; the result remains untrusted and non-authoritative.",
      disabled: readyTargets === 0,
    },
    {
      value: "readiness",
      label: "Readiness and blocked targets",
      detail: `${readyTargets} have at least one proposal operation; ${blockedTargets} need direct write-scope or schema remediation.`,
    },
    { value: "proposals", label: "Proposal inbox and lifecycle", detail: "Review proposals, approvals, apply posture, receipts, replay, and evidence." },
    { value: "quit", label: "Quit" },
  ];
}

function actionBoundaryStateLabel(status: Awaited<ReturnType<typeof guidedActionStatus>>): string {
  if (status.action_boundary.draft && status.action_boundary.active) return "ACTIVE + DISABLED CHANGES";
  if (status.action_boundary.draft) return "DISABLED DRAFT";
  if (status.action_boundary.active) {
    return status.action_boundary.synthesized_from_legacy_actions ? "ACTIVE / MIGRATION VIEW" : "ACTIVE";
  }
  return "OFF";
}

export function actionBoundaryActivationStatusLine(
  boundary: Awaited<ReturnType<typeof guidedActionStatus>>["action_boundary"]["active"],
): string {
  if (!boundary) return "Action Boundary: status unavailable";
  const count = boundary.authority.capabilities.length;
  return `Action Boundary: ACTIVE (${boundary.name}; ${count} action${count === 1 ? "" : "s"})`;
}

export function actionBoundaryApprovalStatusLine(
  boundary: Awaited<ReturnType<typeof guidedActionStatus>>["action_boundary"]["active"],
  capability: string,
): string {
  const approval = boundary?.authority.approval_policies.find((candidate) =>
    candidate.capability === capability);
  return approval?.mode === "policy"
    ? "Approval: DETERMINISTIC POLICY WITH HUMAN FALLBACK"
    : "Approval: HUMAN REVIEW";
}

function actionBoundaryChoiceDetail(status: Awaited<ReturnType<typeof guidedActionStatus>>): string {
  const boundary = status.action_boundary.draft ?? status.action_boundary.active;
  if (!boundary) return "No agent change authority is active or drafted.";
  const proposed = status.action_boundary.draft
    ? `${status.action_boundary.draft.authority.capabilities.length} exact action revision(s) in the disabled candidate`
    : `${status.action_boundary.active!.authority.capabilities.length} exact active action revision(s)`;
  return `${boundary.label} | ${proposed}`;
}

function actionBoundaryHomeLines(status: Awaited<ReturnType<typeof guidedActionStatus>>): string[] {
  const active = status.action_boundary.active;
  const draft = status.action_boundary.draft;
  if (!active && !draft) return ["Action Boundary OFF | no agent change authority."];
  if (active && draft) {
    return [
      `Action Boundary ACTIVE (${active.authority.capabilities.length} actions) | disabled candidate has ${draft.authority.capabilities.length}.`,
    ];
  }
  const boundary = draft ?? active!;
  return [
    `Action Boundary ${draft ? "DISABLED" : "ACTIVE"} | ${boundary.authority.capabilities.length} exact action revision(s).`,
  ];
}

function actionBoundaryAuthorityLines(status: Awaited<ReturnType<typeof guidedActionStatus>>): string[] {
  const active = status.action_boundary.active;
  const draft = status.action_boundary.draft;
  if (!active && !draft) {
    return [
      "State: OFF",
      "The agent has no reviewed proposal or change authority.",
      "Create a proposal action to prepare a disabled Action Boundary candidate.",
    ];
  }
  const selected = draft ?? active!;
  const lines = [
    `Name: ${selected.name}`,
    `State: ${draft ? "DISABLED CANDIDATE" : "ACTIVE"}`,
    `Purpose: ${selected.job_intent}`,
    `Exact actions: ${selected.authority.capabilities.length}`,
    `Read Boundary dependencies: ${selected.authority.read_dependencies.length}`,
    `Approval policies: ${selected.authority.approval_policies.length}`,
    `Execution profiles: ${selected.authority.execution_profiles.length}`,
    `Shared limits: ${selected.authority.shared_limits.length || "none"}`,
    `Digest: ${selected.digest}`,
    "",
    ...selected.authority.capabilities.map((capability) => {
      const policy = selected.authority.approval_policies.find((item) => item.capability === capability.capability);
      const execution = selected.authority.execution_profiles.find((item) => item.capability === capability.capability);
      return `${capability.operation.toUpperCase()} ${capability.resource} | ${capability.capability} | ${policy?.mode ?? "human"} approval | ${execution?.authority_posture ?? "proposal_only"}`;
    }),
  ];
  if (active && draft) {
    lines.push(
      "",
      `Currently active: ${active.authority.capabilities.length} exact action revision(s), digest ${active.digest}`,
      "The disabled candidate grants nothing until its reviewed actions are rehearsed and activated.",
    );
  }
  if (status.action_boundary.synthesized_from_legacy_actions) {
    lines.push(
      "",
      "Migration view: this boundary was reconstructed from existing active Safe Action revisions without changing authority.",
    );
  }
  return lines;
}

async function reviewActionBoundary(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  configPath?: string;
}): Promise<void> {
  let notice: string[] = [];
  while (true) {
    const status = await guidedActionStatus(input.projectRoot);
    const selected = status.action_boundary.draft ?? status.action_boundary.active;
    if (!selected) {
      await input.prompter.message("ACTION BOUNDARY AUTHORITY", actionBoundaryAuthorityLines(status));
      return;
    }
    const exactActiveSet = actionBoundaryMatchesActiveActions(status);
    const choice = await input.prompter.choose("REVIEW ACTION BOUNDARY", [
      {
        value: "limits",
        label: `Shared approval limits [${selected.authority.shared_limits.length}]`,
        detail: "Bound rolling proposal approvals across actions by trusted tenant, principal, object, capability, or the whole boundary.",
      },
      {
        value: "activate",
        label: "Activate this exact boundary revision",
        detail: status.action_boundary.draft
          ? exactActiveSet
            ? "Publishes reviewed limit changes only. It cannot approve a proposal or change a source row."
            : "Activate the rehearsed proposal action first; its exact capability and boundary revision publish together."
          : "No disabled boundary revision is waiting.",
        disabled: !status.action_boundary.draft || !exactActiveSet,
      },
      { value: "back", label: "Back to Action Boundary" },
    ], [
      ...actionBoundaryAuthorityLines(status),
      "",
      ...actionBoundaryTrustedScopeLines(status, input.options),
      ...notice,
    ]);
    notice = [];
    if (!choice || choice === "back") return;
    if (choice === "limits") {
      const updated = await reviewActionBoundaryLimits({ ...input, status });
      if (updated) notice = [updated];
      continue;
    }
    if (choice === "activate" && status.action_boundary.draft) {
      const draft = status.action_boundary.draft;
      const confirmed = await input.prompter.confirm(
        `Activate Action Boundary ${draft.name} at ${shortDigest(draft.digest)}? This changes reviewed policy authority only; it cannot approve or apply a proposal.`,
        false,
      );
      if (!confirmed) continue;
      const actor = await input.prompter.text("Operator audit identity", {
        defaultValue: input.env.SYNAPSOR_OPERATOR_ACTOR ?? input.env.USER ?? "local_operator",
      });
      if (!actor) continue;
      const activated = await activateGuidedActionBoundary({
        projectRoot: input.projectRoot,
        expectedDigest: draft.digest,
        confirmation: `ACTIVATE ${draft.digest}`,
        actor,
        ...(input.configPath ? { configPath: input.configPath } : {}),
      });
      notice = [
        `Action Boundary ${activated.name} is ACTIVE at ${shortDigest(activated.digest)}. No proposal was approved or applied.`,
      ];
    }
  }
}

async function reviewActionBoundaryLimits(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  prompter: ActionControlPrompter;
  status: Awaited<ReturnType<typeof guidedActionStatus>>;
}): Promise<string | undefined> {
  const selected = input.status.action_boundary.draft ?? input.status.action_boundary.active;
  if (!selected) return undefined;
  const limits = [...selected.authority.shared_limits];
  const choice = await input.prompter.choose("SHARED APPROVAL LIMITS", [
    { value: "add_count", label: "Add rolling approval count", detail: "Example: at most 20 approved proposals per trusted tenant every 24 hours." },
    { value: "add_total", label: "Add rolling numeric total", detail: "Example: at most 1,000 credit units per trusted tenant and principal every 24 hours." },
    ...limits.map((limit) => ({
      value: `remove:${limit.id}`,
      label: `Remove ${limit.id}`,
      detail: actionBoundaryLimitSummary(limit),
    })),
    { value: "back", label: "Back" },
  ], [
    "These circuit breakers apply only to deterministic policy approval. A tripped or indeterminate limit falls back to human review.",
    "Trusted tenant, principal, and object values come from verified runtime context, never the agent.",
    ...(limits.length ? ["", ...limits.map(actionBoundaryLimitSummary)] : ["No shared approval limits are reviewed yet."]),
  ]);
  if (!choice || choice === "back") return undefined;
  let next = limits;
  if (choice.startsWith("remove:")) {
    const id = choice.slice("remove:".length);
    next = limits.filter((limit) => limit.id !== id);
  } else {
    const kind = choice === "add_total" ? "total" : "count";
    const id = await requiredText(input.prompter, "Short limit name", `${kind}_${limits.length + 1}`);
    const scope = await input.prompter.choose("LIMIT SCOPE", [
      { value: "tenant_principal", label: "Each trusted tenant + principal", detail: "Recommended when actions are assigned to authenticated people or agents." },
      { value: "tenant_object", label: "Each trusted tenant + object", detail: "Bounds repeated approvals against one exact reviewed target row." },
      { value: "tenant", label: "Each trusted tenant", detail: "All principals in one tenant share the ceiling." },
      { value: "capability", label: "Each proposal capability", detail: "Separates usage by exact reviewed action name." },
      { value: "boundary", label: "Whole Action Boundary", detail: "One ceiling across every tenant and action in this boundary." },
      { value: "back", label: "Back" },
    ]);
    if (!scope || scope === "back") return undefined;
    const capabilityChoices = selected.authority.capabilities.map((item) => ({
      value: item.capability,
      label: item.capability,
      detail: `${item.operation.toUpperCase()} ${item.resource}`,
    }));
    const capability = kind === "total"
      ? await input.prompter.choose("NUMERIC ACTION", [...capabilityChoices, { value: "back", label: "Back" }], [
          "A numeric total is tied to one exact action so its reviewed patch field is unambiguous.",
        ])
      : await input.prompter.choose("LIMIT APPLIES TO", [
          { value: "all", label: "All actions in this boundary" },
          ...capabilityChoices,
          { value: "back", label: "Back" },
        ]);
    if (!capability || capability === "back") return undefined;
    let field: string | undefined;
    if (kind === "total") {
      const draftExists = input.status.drafts.some((item) =>
        item.capability === capability
        && selected.authority.capabilities.some((reference) =>
          reference.capability === item.capability && reference.contract_digest === item.contract_digest));
      const design = await readGuidedActionDesignInput(
        input.projectRoot,
        capability,
        draftExists ? "draft" : "active",
      );
      const numericFields = (design.patches ?? [])
        .filter((patch) => patch.value_source === "argument"
          ? Number.isFinite(patch.minimum) && Number.isFinite(patch.maximum)
          : typeof patch.fixed_value === "number")
        .map((patch) => patch.column);
      field = await chooseRequired(input.prompter, "NUMERIC VALUE TO TOTAL", numericFields);
      if (!field) return undefined;
    }
    const maximum = boundedInteger(
      await requiredText(input.prompter, kind === "count" ? "Maximum approved proposals" : "Maximum approved numeric total"),
      1,
      Number.MAX_SAFE_INTEGER,
      "Shared approval maximum",
    );
    const windowChoice = await input.prompter.choose("ROLLING WINDOW", [
      { value: "3600", label: "1 hour" },
      { value: "86400", label: "24 hours" },
      { value: "604800", label: "7 days" },
      { value: "2592000", label: "30 days" },
      { value: "custom", label: "Custom seconds", detail: "60 through 31,536,000 seconds." },
      { value: "back", label: "Back" },
    ]);
    if (!windowChoice || windowChoice === "back") return undefined;
    const windowSeconds = windowChoice === "custom"
      ? boundedInteger(
          await requiredText(input.prompter, "Rolling window seconds"),
          60,
          31_536_000,
          "Rolling window",
        )
      : Number(windowChoice);
    const limit: ActionBoundarySharedLimitV1 = {
      id,
      kind,
      scope: scope as ActionBoundarySharedLimitV1["scope"],
      maximum,
      window_seconds: windowSeconds,
      ...(capability !== "all" ? { capability } : {}),
      ...(field ? { field } : {}),
    };
    next = [...limits.filter((item) => item.id !== id), limit];
  }
  const revised = await reviseGuidedActionBoundary({
    projectRoot: input.projectRoot,
    inspection: input.inspection,
    sharedLimits: next,
  });
  return `Saved disabled Action Boundary revision ${shortDigest(revised.digest)} with ${next.length} shared limit(s). Active authority is unchanged until explicit activation.`;
}

function actionBoundaryMatchesActiveActions(
  status: Awaited<ReturnType<typeof guidedActionStatus>>,
): boolean {
  const draft = status.action_boundary.draft;
  if (!draft) return false;
  const active = new Map(status.activations.map((item) => [item.capability, item.contract_digest]));
  return active.size === draft.authority.capabilities.length
    && draft.authority.capabilities.every((item) => active.get(item.capability) === item.contract_digest);
}

function actionBoundaryTrustedScopeLines(
  status: Awaited<ReturnType<typeof guidedActionStatus>>,
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
): string[] {
  const selected = status.action_boundary.draft ?? status.action_boundary.active;
  if (!selected) return [];
  const dependencyByDigest = new Map(selected.authority.read_dependencies.map((dependency) => [
    dependency.digest,
    dependency,
  ]));
  const scopes = selected.authority.capabilities.map((capability) => {
    const resource = options.resources.find((candidate) => candidate.id === capability.resource);
    const dependency = dependencyByDigest.get(capability.read_dependency_digest)
      ?? selected.authority.read_dependencies[0];
    if (resource?.organization_scope) {
      return `${capability.resource}: whole organization ${resource.organization_scope.organization_id}; no model-supplied tenant.`;
    }
    return `${capability.resource}: tenant from trusted ${resource?.tenant_key ?? "reviewed runtime context"}`
      + (resource?.principal_key ? `; principal from trusted ${resource.principal_key}` : "; no per-principal row restriction")
      + (dependency ? ` (${dependency.name} ${shortDigest(dependency.digest)})` : "");
  });
  return ["Trusted MCP scope:", ...scopes.map((scope) => `  ${scope}`)];
}

export function actionBoundaryLimitSummary(limit: ActionBoundarySharedLimitV1): string {
  const measure = limit.kind === "count"
    ? `${limit.maximum} deterministic approvals`
    : `${limit.maximum} total ${limit.field}`;
  const action = limit.capability ? ` for ${limit.capability}` : " across matching actions";
  const scope = {
    tenant: "trusted tenant",
    tenant_principal: "trusted tenant + principal",
    tenant_object: "trusted tenant + object",
    capability: "exact capability",
    boundary: "whole Action Boundary",
  }[limit.scope];
  return `At most ${measure}${action} per ${scope} in ${formatLimitWindow(limit.window_seconds)}.`;
}

function formatLimitWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${seconds} seconds`;
}

export function actionDraftUsesQuickResume(
  draft: Pick<GuidedActionDraft, "authority_posture">,
): boolean {
  return draft.authority_posture === "proposal_only";
}

function actionReadyResourceCount(
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
): number {
  return options.resources.filter((resource) =>
    Object.values(resource.operation_availability).some((availability) => availability.available)).length;
}

function actionBlockedTargetCount(
  options: Awaited<ReturnType<typeof guidedActionOptions>>,
): number {
  return options.blocked_resources.length + options.resources.length - actionReadyResourceCount(options);
}

async function collectModelActionSuggestion(input: {
  projectRoot: string;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  generator: typeof generateModelActionSuggestion;
  intent?: string;
  session?: ActionModelSuggestionSession;
}): Promise<ActionSuggestionView | undefined> {
  const intent = input.intent ?? await input.prompter.text("Business intent for the suggestion");
  if (!intent) return undefined;
  const selectedProvider = input.session?.provider ?? await input.prompter.choose("MODEL PROVIDER", [
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "openai_compatible", label: "OpenAI-compatible endpoint" },
  ]);
  if (!selectedProvider) return undefined;
  const provider = selectedProvider as AskProvider;
  const model = input.session?.model ?? await input.prompter.text("Model", {
    defaultValue: provider === "openai"
      ? DEFAULT_TERMINAL_OPENAI_ASK_MODEL
      : provider === "anthropic"
        ? DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL
        : undefined,
  });
  if (!model) return undefined;
  const apiKeyEnv = input.session?.apiKeyEnv ?? (provider === "openai_compatible"
    ? await input.prompter.text("API key environment name (leave blank when the endpoint needs none)")
    : await input.prompter.text("API key environment name", {
        defaultValue: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
      }));
  const baseUrl = input.session?.baseUrl ?? (provider === "openai_compatible"
    ? await input.prompter.text("OpenAI-compatible base URL")
    : undefined);
  if (provider === "openai_compatible" && !baseUrl) return undefined;
  const acknowledged = await input.prompter.confirm(
    `Send the business intent plus exact structural candidates to ${provider}/${model}? No source rows, credentials, trusted tenant/principal values, active policy, executor, or active authority are sent. The model may return a non-authoritative deterministic policy proposal for your review.`,
    false,
  );
  if (!acknowledged) return undefined;
  const generated = await input.generator({
    intent,
    provider,
    model,
    options: input.options,
    env: input.env,
    ...(input.session?.apiKey ? { apiKey: input.session.apiKey } : apiKeyEnv ? { apiKeyEnv } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(input.session?.dependencies ? { dependencies: input.session.dependencies } : {}),
    egressAcknowledged: true,
  });
  const imported = await importActionSuggestion({
    projectRoot: input.projectRoot,
    value: generated.assessment.suggestion,
    options: input.options,
  });
  await input.prompter.message(`ACTION SUGGESTION ${imported.state.toUpperCase()}`, [
    `ID: ${imported.suggestion_id}`,
    `Intent: ${imported.assessment.suggestion.intent}`,
    ...imported.current_assessment.structural_evidence.map((item) =>
      `${item.state.toUpperCase()} ${item.decision} ${item.value}: ${item.reason}`),
    ...imported.current_assessment.blockers.map((blocker) => `BLOCKED: ${blocker}`),
    ...(imported.assessment.suggestion.approval_policy_proposal
      ? ["Deterministic approval policy: proposed for operator review; not active."]
      : ["Approval: human by default."]),
    "Authority granted: no. Active tools changed: no. Source database changed: no.",
  ]);
  return imported;
}

async function reviewImportedSuggestion(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  suggestion: ActionSuggestionView;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  baseConfigPath?: string;
  operatorSession?: ActionOperatorSession;
  returnToAsk?: boolean;
  prepareOnly?: boolean;
  actionBoundaryJobIntent?: string;
}): Promise<string | undefined> {
  const suggestion = input.suggestion;
  const evidence = suggestion.current_assessment.structural_evidence.map((item) =>
    `${item.state.toUpperCase()} ${item.decision} ${item.value}: ${item.reason}`);
  if (suggestion.state !== "suggested") {
    await input.prompter.message(`ACTION SUGGESTION ${suggestion.state.toUpperCase()}`, [
      `ID: ${suggestion.suggestion_id}`,
      `Intent: ${suggestion.assessment.suggestion.intent}`,
      ...(suggestion.stale_reason ? [suggestion.stale_reason] : []),
      ...evidence,
      ...suggestion.current_assessment.blockers.map((blocker) => `BLOCKED: ${blocker}`),
      suggestion.state === "reviewed" && suggestion.review
        ? `Reviewed into disabled revision ${suggestion.review.capability} (${suggestion.review.contract_digest}).`
        : "No authority was granted and no source row changed.",
    ]);
    return undefined;
  }
  const proceed = await input.prompter.confirm([
    `Review imported suggestion ${suggestion.suggestion_id}?`,
    suggestion.assessment.suggestion.intent,
    suggestion.assessment.suggestion.approval_policy_proposal
      ? "The suggestion prioritizes candidates and offers deterministic policy inputs. Every condition, limit, activation, and execution decision remains explicit."
      : "The suggestion only reorders candidates. Every authority decision remains explicit.",
  ].join(" "), false);
  if (!proceed) return undefined;
  const draft = await collectAndCreateAction({
    projectRoot: input.projectRoot,
    inspection: input.inspection,
    options: input.options,
    prompter: input.prompter,
    suggestion: suggestion.current_assessment,
    authoring: {
      intent: suggestion.current_assessment.suggestion.intent,
      mode: "guided",
    },
    actionBoundaryJobIntent: input.actionBoundaryJobIntent,
  });
  if (!draft) return undefined;
  await recordActionSuggestionReview({
    projectRoot: input.projectRoot,
    suggestion,
    capability: draft.capability,
    contractDigest: draft.contract_digest,
  });
  return reviewActionDraft({
    projectRoot: input.projectRoot,
    inspection: input.inspection,
    draft,
    prompter: input.prompter,
    env: input.env,
    ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
    ...(input.operatorSession ? { operatorSession: input.operatorSession } : {}),
    returnToAsk: input.returnToAsk,
    quickStart: actionDraftUsesQuickResume(draft),
    prepareOnly: input.prepareOnly,
  });
}

async function createAndReviewQuickAction(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  prompter: ActionControlPrompter;
  intent: string;
  env: NodeJS.ProcessEnv;
  baseConfigPath?: string;
  operatorSession?: ActionOperatorSession;
  returnToAsk?: boolean;
  prepareOnly?: boolean;
  actionBoundaryJobIntent?: string;
}): Promise<string | undefined> {
  const quick = await collectQuickProposalActionInput(
    input.options,
    input.prompter,
    input.intent,
    input.prepareOnly && input.actionBoundaryJobIntent
      ? [
          "READ REVIEW COMPLETE - NOT ACTIVE",
          `Read Boundary: ${input.options.boundary_name} is fully reviewed and remains disabled.`,
          "Agent read authority: unchanged | source database changed: no",
          "Preparing a separate disabled Action Boundary; proposal, approval, apply, and writes remain off.",
        ]
      : [],
  );
  let draft: GuidedActionDraft | undefined;
  let quickStart = true;
  if (quick === "advanced") {
    draft = await collectAndCreateAction({
      projectRoot: input.projectRoot,
      inspection: input.inspection,
      options: input.options,
      prompter: input.prompter,
      authoring: { intent: input.intent, mode: "guided" },
      actionBoundaryJobIntent: input.actionBoundaryJobIntent,
    });
    quickStart = false;
  } else if (quick) {
    draft = (await createGuidedActionDraft({
      projectRoot: input.projectRoot,
      action: quick,
      inspection: input.inspection,
      boundaryName: input.options.boundary_name,
      allowReviewedPending: input.options.boundary_state === "reviewed_pending",
      ...(input.actionBoundaryJobIntent
        ? { actionBoundaryJobIntent: input.actionBoundaryJobIntent }
        : {}),
    })).draft;
    if (quick.auto_approval) {
      await reviewAndStageActionBoundaryLimits({
        projectRoot: input.projectRoot,
        inspection: input.inspection,
        prompter: input.prompter,
        capability: draft.capability,
        action: quick,
        resource: input.options.resources.find((resource) => resource.id === quick.resource)!,
      });
    }
  }
  if (!draft) return undefined;
  return reviewActionDraft({
    projectRoot: input.projectRoot,
    inspection: input.inspection,
    draft,
    prompter: input.prompter,
    env: input.env,
    ...(input.baseConfigPath ? { baseConfigPath: input.baseConfigPath } : {}),
    ...(input.operatorSession ? { operatorSession: input.operatorSession } : {}),
    returnToAsk: input.returnToAsk,
    quickStart,
    prepareOnly: input.prepareOnly,
  });
}

function prioritizeByValue<T>(items: T[], preferred: string | undefined, key: (item: T) => string): T[] {
  if (!preferred) return [...items];
  return [...items].sort((left, right) => {
    const leftPreferred = key(left) === preferred ? 0 : 1;
    const rightPreferred = key(right) === preferred ? 0 : 1;
    return leftPreferred - rightPreferred;
  });
}

async function chooseStructuralGuard(
  prompter: ActionControlPrompter,
  title: string,
  values: string[],
  preferred: string | undefined,
  selectUnique: boolean,
): Promise<string | undefined> {
  if (!values.length) throw new Error(`${title} has no source-proven candidates.`);
  if (preferred && values.includes(preferred)) return preferred;
  if (selectUnique && values.length === 1) return values[0];
  return chooseRequired(prompter, title, values);
}

function authorityFromActionInput(action: GuidedActionInput): GuidedActionAuthorityRevisionInput {
  const posture = action.authority_posture
    ?? (action.supervised_worker_execution
      ? "supervised_execution"
      : action.writeback?.mode && action.writeback.mode !== "none"
        ? "executable"
        : "proposal_only");
  return {
    authority_posture: posture,
    writeback: action.writeback ?? { mode: posture === "proposal_only" ? "none" : "direct_sql" },
    supervised_worker_execution: action.supervised_worker_execution === true,
    ...(action.worker_policy ? { worker_policy: action.worker_policy } : {}),
    ...(action.receipt_mode ? { receipt_mode: action.receipt_mode } : {}),
    ...(action.write_url_env ? { write_url_env: action.write_url_env } : {}),
    ...(action.version_advance ? { version_advance: action.version_advance } : {}),
  };
}

export function actionReviewLines(
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
): string[] {
  const fieldByName = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const fieldLines = action.operation === "delete"
    ? ["  Hard-delete one exact row after separate human approval."]
    : (action.patches ?? []).map((patch) => {
        const field = fieldByName.get(patch.column);
        const name = field?.label ? `${field.label} (${patch.column})` : patch.column;
        if (patch.value_source === "fixed") {
          return `  Set ${name} to the reviewed fixed value ${formatActionValue(patch.fixed_value)}.`;
        }
        const bounds = patch.minimum !== undefined || patch.maximum !== undefined
          ? ` from ${patch.minimum ?? "-infinity"} through ${patch.maximum ?? "infinity"}`
          : patch.max_length
            ? ` with at most ${patch.max_length} characters`
            : field?.enum_values.length
              ? ` from ${field.enum_values.join(", ")}`
              : "";
        return `  Supply ${name}${bounds}.`;
      });
  const approval = action.auto_approval
    ? `${action.required_approvals ?? 1} x ${action.approval_role}; deterministic approval requires ${action.auto_approval.conditions?.length ?? 1} reviewed condition(s), at most ${action.auto_approval.max_per_day}/day${action.auto_approval.max_total_per_day !== undefined ? ` and ${action.auto_approval.max_total_per_day} aggregate/day` : ""}.`
    : `${action.required_approvals ?? 1} x ${action.approval_role}; no model approval authority.`;
  return [
    `${action.capability_name}`,
    `${action.description}`,
    "",
    "AGENT MAY PROPOSE",
    ...fieldLines,
    "",
    "RUNNER SUPPLIES AND RECHECKS",
    resource.organization_scope
      ? `  Reviewed whole-organization scope ${resource.organization_scope.organization_id}${resource.principal_key ? ` and trusted principal ${resource.principal_key}` : ""}; never model arguments.`
      : `  Trusted tenant ${resource.tenant_key}${resource.principal_key ? ` and principal ${resource.principal_key}` : ""}; never model arguments.`,
    `  Exact row identity ${resource.primary_key}${action.conflict_column ? ` and conflict guard ${action.conflict_column}` : ""}${action.dedup_proposal_column ? `; retry identity ${action.dedup_proposal_column}` : ""}.`,
    "",
    "AGENT MAY NOT",
    "  Choose another table or field, send SQL, approve, activate, apply, select identity, or change policy.",
    ...(action.auto_approval ? [
      "",
      "DETERMINISTIC AUTO-APPROVAL SUBSET",
      ...reviewedAutoApprovalConditions(action.auto_approval).map((condition) =>
        `  ${approvalConditionSummary(condition)}.`),
      `  Circuit breaker: at most ${action.auto_approval.max_per_day} auto-approved proposal(s) per day.`,
      ...(action.auto_approval.max_total_per_day !== undefined
        ? [`  Aggregate circuit breaker: at most ${action.auto_approval.max_total_per_day} of ${action.auto_approval.total_field} per day.`]
        : []),
      "  Missing state, failed conditions, stale evidence, or uncertain rolling usage returns to human review.",
    ] : []),
    "",
    "REVIEW AND EXECUTION",
    `  Approval: ${approval}`,
    `  Authority: ${action.authority_posture ?? "proposal_only"}; writeback ${action.writeback?.mode ?? "none"}.`,
    action.writeback?.mode === "none"
      ? "  Source mutation is impossible under this revision. Calls create immutable proposals only."
      : "  Source mutation still requires a separate trusted approval and executor call with every guard rechecked.",
  ];
}

export function actionActivationReviewLines(
  action: GuidedActionInput,
  resource: GuidedActionResourceOption,
): string[] {
  const fieldByName = new Map(resource.structurally_eligible_fields.map((field) => [field.name, field]));
  const supplied = action.operation === "delete"
    ? "none (one exact reviewed row only)"
    : (action.patches ?? []).map((patch) => {
        const field = fieldByName.get(patch.column);
        const name = field?.label ? `${field.label} (${patch.column})` : patch.column;
        if (patch.value_source === "fixed") return `${name}=${formatActionValue(patch.fixed_value)}`;
        if (patch.minimum !== undefined || patch.maximum !== undefined) {
          return `${name} ${patch.minimum ?? "-infinity"}..${patch.maximum ?? "infinity"}`;
        }
        if (patch.max_length) return `${name} <=${patch.max_length} chars`;
        if (field?.enum_values.length) return `${name} in ${field.enum_values.join("|")}`;
        return name;
      }).join("; ");
  const trustedScope = resource.organization_scope
    ? `whole organization ${resource.organization_scope.organization_id}`
    : `tenant ${resource.tenant_key}`;
  const guard = [
    `identity ${resource.primary_key}`,
    action.conflict_column ? `conflict ${action.conflict_column}` : undefined,
    action.dedup_proposal_column ? `retry ${action.dedup_proposal_column}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("; ");
  const approvalLines = action.auto_approval
    ? [
        "Approval: deterministic reviewed subset with human fallback.",
        `Conditions: ${reviewedAutoApprovalConditions(action.auto_approval)
          .map(approvalConditionSummary).join("; ")}.`,
        `Circuit breakers: ${action.auto_approval.max_per_day}/day${action.auto_approval.max_total_per_day !== undefined
          ? `; ${action.auto_approval.max_total_per_day} total ${action.auto_approval.total_field}/day`
          : ""}.`,
      ]
    : [`Approval: ${action.required_approvals ?? 1} x ${action.approval_role}; human review.`];
  return [
    `Target: ${action.operation.toUpperCase()} ${resource.id}`,
    `Agent supplies: ${supplied || "none"}`,
    `Runner supplies: ${trustedScope}${resource.principal_key ? ` + principal ${resource.principal_key}` : ""}; never model arguments.`,
    `Guards: ${guard}.`,
    ...approvalLines,
    `Authority: ${action.authority_posture ?? "proposal_only"}; writeback ${action.writeback?.mode ?? "none"}.`,
  ];
}

function reviewedAutoApprovalConditions(
  approval: GuidedActionAutoApprovalInput,
): GuidedActionAutoApprovalCondition[] {
  if (approval.conditions?.length) return approval.conditions;
  return approval.field && approval.maximum !== undefined
    ? [{ field: approval.field, operator: "lte", value: approval.maximum }]
    : [];
}

function autoApprovalPatchCompatibilityIssues(
  approval: GuidedActionAutoApprovalInput,
  patches: GuidedActionPatchInput[],
): string[] {
  const patchByColumn = new Map(patches.map((patch) => [patch.column, patch]));
  const conditions = reviewedAutoApprovalConditions(approval);
  const issues: string[] = [];
  for (const condition of conditions) {
    if ((condition.source ?? "patch") === "patch" && !patchByColumn.has(condition.field)) {
      issues.push(`policy patch.${condition.field}`);
    }
  }
  for (const patch of patches) {
    if (patch.value_source === "argument"
      && !conditions.some((condition) => (condition.source ?? "patch") === "patch" && condition.field === patch.column)) {
      issues.push(`uncovered patch.${patch.column}`);
    }
  }
  if (approval.total_field) {
    const totalPatch = patchByColumn.get(approval.total_field);
    if (!totalPatch || totalPatch.value_source !== "argument") {
      issues.push(`aggregate field ${approval.total_field}`);
    }
  }
  return [...new Set(issues)];
}

function approvalConditionSummary(condition: GuidedActionAutoApprovalCondition): string {
  const source = condition.source === "before" ? "current row" : "proposal";
  const field = `${source} ${condition.field}`;
  if (condition.operator === "in") {
    return `${field} must be one of ${(condition.values ?? []).map(formatActionValue).join(", ")}`;
  }
  if (condition.operator === "max_length") {
    return `${field} must contain at most ${formatActionValue(condition.value)} characters`;
  }
  const operator = condition.operator === "lte"
    ? "must be at most"
    : condition.operator === "gte"
      ? "must be at least"
      : "must equal";
  return `${field} ${operator} ${formatActionValue(condition.value)}`;
}

function actionReadinessLines(options: Awaited<ReturnType<typeof guidedActionOptions>>): string[] {
  return [
    "Runner reports structural candidates only. Every action still requires human review, rehearsal, and activation.",
    "",
    "REVIEWED TARGETS AND OPERATION PROOFS",
    ...(options.resources.length
      ? options.resources.flatMap((resource) => [
          `  ${resource.label ? `${resource.label} (${resource.id})` : resource.id}`,
          ...(["insert", "update", "delete"] as GuidedActionOperation[]).map((operation) => {
            const availability = resource.operation_availability[operation];
            return `    ${availability.available ? "AVAILABLE" : "BLOCKED"} ${operation.toUpperCase()}: ${availability.reason}`;
          }),
        ])
      : ["  none"]),
    "",
    "SCOPE-BLOCKED TARGETS",
    ...(options.blocked_resources.length
      ? options.blocked_resources.flatMap((resource) => [
          `  ${resource.label ? `${resource.label} (${resource.id})` : resource.id}`,
          ...resource.reasons.map((reason) => `    why: ${reason}`),
          ...resource.next_steps.map((step) => `    next: ${step}`),
        ])
      : ["  none"]),
    "",
    "A model cannot override these blockers or turn a read relationship into write scope.",
  ];
}

function actionAuthorityLines(active: {
  capability: string;
  resource?: string;
  operation?: GuidedActionOperation;
  authority_posture: string;
  writeback_mode: string;
  contract_digest: string;
  config_path: string;
}): string[] {
  return [
    `Capability: ${active.capability}`,
    `Target: ${active.operation?.toUpperCase() ?? "legacy action"} ${active.resource ?? "legacy target"}`,
    `Authority: ${active.authority_posture}`,
    `Writeback: ${active.writeback_mode}`,
    `Digest: ${active.contract_digest}`,
    `Runtime: ${active.config_path}`,
    active.writeback_mode === "none"
      ? "MAY create immutable proposals. MAY NOT change source data."
      : "MAY be executed only after separate approval through the reviewed executor. Agents cannot approve or apply.",
  ];
}

function actionRuntimeLines(active: { capability: string; config_path: string }): string[] {
  const cli = cliCommandName();
  return [
    `Test the exact tool: ${cli} try call ${active.capability} --sample --config ${active.config_path} --json`,
    `Inspect the model-facing surface: ${cli} try call --list --config ${active.config_path} --format json`,
    `Install for a client: ${cli} mcp install <claude-code|cursor|vscode> --project --config ${active.config_path} --yes`,
    "That runtime exposes reviewed semantic tools only. Approval, apply, activation, credentials, and SQL remain outside MCP.",
  ];
}

function actionDraftLines(draft: GuidedActionDraft): string[] {
  return [
    `Capability: ${draft.capability}`,
    `Target: ${draft.operation.toUpperCase()} ${draft.resource}`,
    `Authority: ${draft.authority_posture}`,
    `Writeback: ${draft.writeback_mode}`,
    `Digest: ${draft.contract_digest}`,
    `Preview: ${draft.effect_preview ? "verified; source unchanged" : "required"}`,
    "Current state: disabled. Active tools and source data are unchanged.",
  ];
}

function actionReviewPrompt(action: GuidedActionInput, resource: GuidedActionResourceOption): string {
  const fields = action.operation === "delete" ? "hard-delete one exact row" : action.patches?.map((patch) => patch.column).join(", ") ?? "none";
  return [
    `Create this disabled ActionDesign? ${action.operation.toUpperCase()} ${resource.id}; fields ${fields}; `,
    `scope ${resource.tenant_key}${resource.principal_key ? `/${resource.principal_key}` : ""}; `,
    `approval ${action.required_approvals ?? 1} x ${action.approval_role}; `,
    `authority ${action.authority_posture}; writeback ${action.writeback?.mode}. `,
    "No authority activates and no source row changes from this decision.",
  ].join("");
}

function shortDigest(value: string): string {
  return value.length > 28 ? `${value.slice(0, 20)}...${value.slice(-6)}` : value;
}

function formatActionValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(safeTerminalText(value));
  if (value === undefined) return "not set";
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "not set" : safeTerminalText(serialized);
  } catch {
    return "[unrenderable value]";
  }
}

function formatActionTimestamp(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return safeTerminalText(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

export function renderActionControlPlaneTable(
  status: Awaited<ReturnType<typeof guidedActionStatus>>,
  width = 100,
): string[] {
  const rows = [
    ...status.activations.map((item) => [
      item.capability,
      "ACTIVE",
      item.authority_posture,
      `${item.operation?.toUpperCase() ?? "ACTION"} ${item.resource ?? "legacy target"}`,
    ]),
    ...status.drafts.map((item) => [
      item.capability,
      "DRAFT",
      item.authority_posture,
      `${item.operation.toUpperCase()} ${item.resource}`,
    ]),
  ];
  if (!rows.length) return ["No Safe Actions are active or drafted."];
  const available = Math.max(72, Math.min(width, 116)) - 13;
  const capability = Math.max(20, Math.floor(available * 0.32));
  const state = 8;
  const authority = 20;
  const target = available - capability - state - authority;
  return renderBoundaryMapTable(
    ["Capability", "State", "Authority", "Target"],
    rows,
    { widths: [capability, state, authority, target] },
  );
}

async function chooseRequired(prompter: ActionControlPrompter, title: string, values: string[]): Promise<string | undefined> {
  if (!values.length) throw new Error(`${title} has no source-proven candidates.`);
  return prompter.choose(title, values.map((value) => ({ value, label: value })));
}

async function requiredText(
  prompter: ActionControlPrompter,
  label: string,
  defaultValue?: string,
  display: Pick<ActionTextPromptOptions, "title" | "context"> = {},
): Promise<string> {
  const value = await prompter.text(label, {
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...display,
  });
  if (value === undefined) throw new ActionPromptBack();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function boundedInteger(raw: string, minimum: number, maximum: number, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function parseAllowedValues(raw: string, allowed: string[]): string[] {
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (values.some((value) => !allowed.includes(value))) {
    throw new Error(`Transition sources must be selected from ${allowed.join(", ")}.`);
  }
  return values;
}

function parseFieldScalar(raw: string, field: GuidedActionResourceOption["writable_fields"][number]): JsonScalarValue {
  if (raw === "null" && field.nullable) return null;
  if (isNumericType(field.data_type)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${field.name} requires a finite number.`);
    return value;
  }
  if (isBooleanType(field.data_type)) {
    if (raw !== "true" && raw !== "false") throw new Error(`${field.name} requires true or false.`);
    return raw === "true";
  }
  return raw;
}

type JsonScalarValue = string | number | boolean | null;

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function isNumericType(dataType: string): boolean {
  return /(?:^|\b)(?:smallint|integer|bigint|int|decimal|numeric|real|double|float|money)(?:\b|$)/i.test(dataType);
}

function isBooleanType(dataType: string): boolean {
  return /(?:^|\b)(?:bool|boolean|tinyint\s*\(\s*1\s*\))(?:\b|$)/i.test(dataType);
}

export function actionTerminalWidth(output: Pick<WriteStream, "columns">): number {
  return Math.min(terminalContentWidth(output.columns), 116);
}
