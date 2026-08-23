import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ReadStream, WriteStream } from "node:tty";
import { inspectDatabase, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import {
  createActionOperatorService,
  type ActionOperatorDecision,
  type ActionOperatorService,
  type ActionProposalDetail,
} from "./action-operator.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  discardGuidedActionDraft,
  guidedActionDraftDetails,
  guidedActionOptions,
  guidedActionStatus,
  readGuidedActionDesignInput,
  recordGuidedActionPreview,
  reviseGuidedActionAuthority,
  type GuidedActionAuthorityRevisionInput,
  type GuidedActionDraft,
  type GuidedActionInput,
  type GuidedActionOperation,
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

export type ActionPromptChoice = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

export type ActionControlPrompter = {
  choose(title: string, choices: ActionPromptChoice[], context?: string[]): Promise<string | undefined>;
  text(label: string, options?: { defaultValue?: string; secret?: boolean }): Promise<string | undefined>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean | undefined>;
  message(title: string, lines: string[]): Promise<void>;
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
  configPath?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  inspection?: SchemaInspection;
  prompter?: ActionControlPrompter;
  operatorService?: ActionOperatorService;
  initialSuggestionId?: string;
  modelSuggestionGenerator?: typeof generateModelActionSuggestion;
  modelSuggestionSession?: ActionModelSuggestionSession;
  returnToAsk?: boolean;
  terminalInput?: ReadStream;
  terminalOutput?: WriteStream;
}): Promise<ActionControlPlaneResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const env = input.env ?? process.env;
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
    while (true) {
      const options = await guidedActionOptions({ projectRoot, inspection });
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
        });
        if (activated) activatedActions.add(activated);
        continue;
      }
      const choice = await prompter.choose(
        "SAFE ACTION CONTROL PLANE",
        actionHomeChoices(status, suggestions, options),
        [
          "Agents may invoke active semantic tools to create proposals. They cannot author, activate, approve, or apply authority.",
          `Active ${status.activations.length} | Drafts ${status.drafts.length} | Proposal-only is the default.`,
          `Eligible targets ${options.resources.length} | Blocked targets ${options.blocked_resources.length}.`,
          ...notice,
        ],
      );
      notice = [];
      if (!choice || choice === "quit") break;
      try {
        if (choice === "model_suggest") {
          const imported = await collectModelActionSuggestion({
            projectRoot,
            options,
            prompter,
            env,
            generator: input.modelSuggestionGenerator ?? generateModelActionSuggestion,
            ...(input.modelSuggestionSession ? { session: input.modelSuggestionSession } : {}),
          });
          if (imported) {
            notice = [
              `Imported ${imported.suggestion_id} as ${imported.state.toUpperCase()}. No authority or active tool changed.`,
            ];
          }
          continue;
        }
        if (choice === "readiness") {
          await prompter.message("SAFE ACTION READINESS", actionReadinessLines(options));
          continue;
        }
        if (choice === "new") {
          const intent = await prompter.text("What should the agent be allowed to propose?");
          if (!intent) continue;
          const route = input.modelSuggestionSession
            ? await prompter.choose("MAP BUSINESS INTENT", [
                {
                  value: "runner",
                  label: "Review Runner-ranked candidates (recommended)",
                  detail: "Uses reviewed names, labels, descriptions, and schema proofs locally. No provider request.",
                },
                {
                  value: "model",
                  label: `Ask the current ${input.modelSuggestionSession.provider} model for one bounded suggestion`,
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
              session: input.modelSuggestionSession!,
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
            });
            if (activated) activatedActions.add(activated);
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
            const authority = await collectAuthority(prompter, options.deployment_profile);
            if (!authority) continue;
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
  const rollout = authoring.mode === "guided"
    ? await prompter.choose("CHOOSE INITIAL ROLLOUT", [
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
        {
          value: "advanced",
          label: "Customize approval or execution",
          detail: "Review quorum, deterministic policy, executor, receipts, and optional worker controls.",
        },
      ], [
        "Starting proposal-only keeps activation useful while making source mutation impossible.",
        "Execution can be added later only through a separately rehearsed and activated revision.",
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
    const numericArguments = (patches ?? []).filter((patch) =>
      patch.value_source === "argument" && patch.minimum !== undefined && patch.maximum !== undefined);
    if (operation !== "delete" && requiredApprovals === 1 && numericArguments.length > 0
      && await prompter.confirm("Add deterministic bounded auto-approval? The model cannot select or change this policy.", Boolean(authoring.initial?.auto_approval))) {
      const field = await chooseRequired(prompter, "AUTO-APPROVAL FIELD", numericArguments.map((patch) => patch.column));
      if (!field) return undefined;
      const patch = numericArguments.find((item) => item.column === field)!;
      const maximum = Number(await prompter.text(`Auto-approve ${field} at or below`, {
        defaultValue: String(authoring.initial?.auto_approval?.field === field
          ? authoring.initial.auto_approval.maximum
          : patch.maximum),
      }));
      const maxPerDay = boundedInteger(await requiredText(
        prompter,
        "Maximum auto-approved proposals per day",
        String(authoring.initial?.auto_approval?.max_per_day ?? 20),
      ), 1, 1_000_000, "per-day policy count");
      const maxTotal = boundedInteger(await requiredText(
        prompter,
        "Maximum aggregate approved value per day",
        String(authoring.initial?.auto_approval?.max_total_per_day ?? Math.max(maximum, 1) * maxPerDay),
      ), 1, 1_000_000_000, "aggregate policy value");
      autoApproval = { field, maximum, max_per_day: maxPerDay, max_total_per_day: maxTotal };
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
  const scopeConfirmed = await prompter.confirm(
    `Confirm trusted scope: tenant ${resource.tenant_key}${resource.principal_key ? ` and principal ${resource.principal_key}` : ""} come only from Runner context, never model arguments.`,
    false,
  );
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

export function createTerminalActionPrompter(input: ReadStream, output: WriteStream): ActionControlPrompter {
  const color = output.isTTY && !process.env.NO_COLOR;
  const theme = terminalTheme(Boolean(color));
  const clear = () => output.write("\u001b[2J\u001b[H");
  return {
    async choose(title, choices, context = []) {
      if (!choices.length) return undefined;
      let selected = Math.max(0, choices.findIndex((choice) => !choice.disabled));
      return withRawTerminalScreen(input, output, async (nextKey, render) => {
        while (true) {
          render([
            theme.title(`  ${title}`),
            ...context.map((line) => `  ${theme.dim(line)}`),
            "",
            ...choices.flatMap((choice, index) => [
              `${index === selected ? theme.focus("  >") : "   "} ${choice.disabled ? theme.dim(choice.label) : choice.label}`,
              ...(choice.detail ? [`      ${choice.disabled ? theme.dim(choice.detail) : theme.dim(choice.detail)}`] : []),
            ]),
            "",
            `  ${theme.key("Up/Down")} Select   ${theme.key("Enter")} Continue   ${theme.key("Esc")} Back`,
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
      const value = await readTerminalTextWithEscape(`  ${label}${suffix} [Esc Back]: `, input, output);
      if (value === undefined) return undefined;
      return value || options.defaultValue;
    },
    async confirm(label, defaultValue = false) {
      const value = await this.choose("CONFIRM REVIEWED DECISION", [
        { value: "yes", label: "Yes", detail: label },
        { value: "no", label: "No", detail: "Leave this decision unchanged or return." },
      ], [`Default: ${defaultValue ? "yes" : "no"}`]);
      return value === undefined ? undefined : value === "yes";
    },
    async message(title, lines) {
      await this.choose(title, [{ value: "continue", label: "Continue" }], lines);
    },
  };
}

async function collectAndCreateAction(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  options: Awaited<ReturnType<typeof guidedActionOptions>>;
  prompter: ActionControlPrompter;
  suggestion?: ActionSuggestionAssessment;
  authoring?: ActionAuthoringContext;
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
  });
  await input.prompter.message("DISABLED ACTION REVISION CREATED", [
    `Capability: ${created.draft.capability}`,
    `Authority: ${created.draft.authority_posture}`,
    `Writeback: ${created.draft.writeback_mode}`,
    `Exact digest: ${created.draft.contract_digest}`,
    "No active tools or source rows changed.",
  ]);
  return created.draft;
}

async function reviewActionDraft(input: {
  projectRoot: string;
  inspection: SchemaInspection;
  draft: GuidedActionDraft;
  prompter: ActionControlPrompter;
  env: NodeJS.ProcessEnv;
  baseConfigPath?: string;
  operatorSession?: ActionOperatorSession;
  returnToAsk?: boolean;
}): Promise<string | undefined> {
  let draft = input.draft;
  const operatorSession = input.operatorSession ?? {};
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
      const options = await guidedActionOptions({ projectRoot: input.projectRoot, inspection: input.inspection });
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
      const active = await activateGuidedAction({
        projectRoot: input.projectRoot,
        capabilityName: draft.capability,
        expectedDigest: draft.contract_digest,
        confirmation: `ACTIVATE ${draft.contract_digest}`,
        actor,
        inspection: input.inspection,
        ...(input.baseConfigPath ? { configPath: input.baseConfigPath } : {}),
      });
      await input.prompter.message("SAFE ACTION ACTIVATED", [
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
  }
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
): ActionPromptChoice[] {
  return [
    ...status.activations.map((active) => ({
      value: `active:${active.capability}`,
      label: `${active.capability} [ACTIVE ${active.authority_posture}]`,
      detail: `${active.operation?.toUpperCase() ?? "ACTION"} ${active.resource ?? "legacy target"} | ${active.contract_digest.slice(0, 20)}...`,
    })),
    ...status.drafts.map((draft) => ({
      value: `draft:${draft.capability}`,
      label: `${draft.capability} [DISABLED DRAFT]`,
      detail: `${draft.operation.toUpperCase()} ${draft.resource} | ${draft.authority_posture} | ${draft.effect_preview ? "previewed" : "preview required"}`,
    })),
    ...suggestions.map((suggestion) => ({
      value: `suggestion:${suggestion.suggestion_id}`,
      label: `${suggestion.suggestion_id} [${suggestion.state.toUpperCase()}]`,
      detail: suggestion.assessment.suggestion.intent,
    })),
    {
      value: "new",
      label: "Create from business intent (recommended)",
      detail: "Describe the effect, then review schema-proven INSERT, UPDATE, or DELETE candidates.",
      disabled: options.resources.length === 0,
    },
    { value: "model_suggest", label: "Ask a model for a bounded suggestion", detail: "Sends structural candidate metadata only; the result remains untrusted and non-authoritative.", disabled: options.resources.length === 0 },
    {
      value: "readiness",
      label: "Readiness and blocked targets",
      detail: `${options.resources.length} eligible; ${options.blocked_resources.length} need direct write-scope or schema remediation.`,
    },
    { value: "proposals", label: "Proposal inbox and lifecycle", detail: "Review proposals, approvals, apply posture, receipts, replay, and evidence." },
    { value: "quit", label: "Quit" },
  ];
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
    `Send the business intent plus exact structural candidates to ${provider}/${model}? No source rows, credentials, trusted tenant/principal values, approval policy, executor, or active authority are sent.`,
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
    "The suggestion only reorders candidates. Every authority decision remains explicit.",
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

type ActionIntentHints = {
  resource?: string;
  operation?: GuidedActionOperation;
  fields: string[];
  notes: string[];
};

export function rankActionIntent(
  resources: GuidedActionResourceOption[],
  intentInput?: string,
): ActionIntentHints {
  const intent = intentInput?.trim();
  if (!intent) return { fields: [], notes: [] };
  const tokens = intentTokens(intent);
  const rankedResources = resources
    .map((resource) => ({ resource, score: metadataIntentScore(tokens, [resource.id, resource.table, resource.label, resource.description]) }))
    .sort((left, right) => right.score - left.score || left.resource.id.localeCompare(right.resource.id));
  const first = rankedResources[0];
  const second = rankedResources[1];
  const resource = first && first.score > 0 && (!second || first.score > second.score)
    ? first.resource.id
    : undefined;
  const selected = resource ? first?.resource : undefined;
  const fields = selected
    ? selected.structurally_eligible_fields
      .map((field) => ({ field, score: metadataIntentScore(tokens, [field.name, field.label, field.description]) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.field.name.localeCompare(right.field.name))
      .map((candidate) => candidate.field.name)
    : [];
  const operationScores: Array<{ operation: GuidedActionOperation; score: number }> = [
    { operation: "insert", score: cueScore(tokens, ["add", "create", "insert", "new", "open", "register"]) },
    { operation: "update", score: cueScore(tokens, ["adjust", "assign", "cancel", "change", "close", "credit", "mark", "refund", "set", "update"]) },
    { operation: "delete", score: cueScore(tokens, ["delete", "purge", "remove"]) },
  ];
  operationScores.sort((left, right) => right.score - left.score);
  const operation = operationScores[0]!.score > 0 && operationScores[0]!.score > operationScores[1]!.score
    ? operationScores[0]!.operation
    : undefined;
  const notes = resource
    ? [`Runner ranked ${resource}${fields.length ? ` and field${fields.length === 1 ? "" : "s"} ${fields.join(", ")}` : ""} from reviewed metadata. Nothing was selected or authorized automatically.`]
    : ["Runner found no unique resource match. Choose the exact reviewed target; ambiguous intent never grants authority."];
  return { ...(resource ? { resource } : {}), ...(operation ? { operation } : {}), fields, notes };
}

function intentTokens(value: string): Set<string> {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = normalized ? normalized.split(/\s+/) : [];
  return new Set(tokens.flatMap((token) => [token, singularIntentToken(token)]));
}

function singularIntentToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function metadataIntentScore(tokens: Set<string>, values: Array<string | undefined>): number {
  let score = 0;
  for (const [index, value] of values.entries()) {
    if (!value) continue;
    const metadataTokens = intentTokens(value);
    let matches = 0;
    for (const token of metadataTokens) if (token.length > 1 && tokens.has(token)) matches += 1;
    score += matches * (index < 2 ? 4 : 2);
  }
  return score;
}

function cueScore(tokens: Set<string>, cues: string[]): number {
  return cues.reduce((score, cue) => score + (tokens.has(cue) ? 1 : 0), 0);
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
    ? `${action.required_approvals ?? 1} x ${action.approval_role}; deterministic approval only when ${action.auto_approval.field} <= ${action.auto_approval.maximum}, at most ${action.auto_approval.max_per_day}/day and ${action.auto_approval.max_total_per_day} aggregate/day.`
    : `${action.required_approvals ?? 1} x ${action.approval_role}; no model approval authority.`;
  return [
    `${action.capability_name}`,
    `${action.description}`,
    "",
    "AGENT MAY PROPOSE",
    ...fieldLines,
    "",
    "RUNNER SUPPLIES AND RECHECKS",
    `  Trusted tenant ${resource.tenant_key}${resource.principal_key ? ` and principal ${resource.principal_key}` : ""}; never model arguments.`,
    `  Exact row identity ${resource.primary_key}${action.conflict_column ? ` and conflict guard ${action.conflict_column}` : ""}${action.dedup_proposal_column ? `; retry identity ${action.dedup_proposal_column}` : ""}.`,
    "",
    "AGENT MAY NOT",
    "  Choose another table or field, send SQL, approve, activate, apply, select identity, or change policy.",
    "",
    "REVIEW AND EXECUTION",
    `  Approval: ${approval}`,
    `  Authority: ${action.authority_posture ?? "proposal_only"}; writeback ${action.writeback?.mode ?? "none"}.`,
    action.writeback?.mode === "none"
      ? "  Source mutation is impossible under this revision. Calls create immutable proposals only."
      : "  Source mutation still requires a separate trusted approval and executor call with every guard rechecked.",
  ];
}

function actionReadinessLines(options: Awaited<ReturnType<typeof guidedActionOptions>>): string[] {
  return [
    "Runner reports structural candidates only. Every action still requires human review, rehearsal, and activation.",
    "",
    "ELIGIBLE TARGETS",
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
    "BLOCKED TARGETS",
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

async function requiredText(prompter: ActionControlPrompter, label: string, defaultValue?: string): Promise<string> {
  const value = await prompter.text(label, { ...(defaultValue !== undefined ? { defaultValue } : {}) });
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
