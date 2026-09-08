import type { PolicyManagementParent, RuntimeConfig } from "@synapsor-runner/mcp-server";
import { createBoundaryAuthoringChat, type BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import { promptBoundaryMappingModel } from "./boundary-commands.js";
import { openProjectControlPolicies } from "./control-policy-store.js";
import { createOperatorParentReview } from "./owner-policy-parent-review.js";
import { buildOperatorParentCatalog, draftOperatorParentPolicy, type TrustedParentIdentityBindings } from "./owner-policy-parent-model.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { parentReviewLines } from "./owner-policy-parent-summary.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";
import { renderTerminalJson } from "./terminal-syntax.js";
import type { BoundaryJobPlanningSession } from "./boundary-job-model.js";
import { DEFAULT_TERMINAL_OPENAI_ASK_MODEL } from "./terminal-ask-defaults.js";

type Input = { projectRoot: string; config: RuntimeConfig; configPath: string; storePath: string;
  name: string; env: NodeJS.ProcessEnv; actor: string; recheckConfig(): Promise<void> };

/** Optional deployment setup. Identity bindings are collected locally, never
 * invented by the drafting model; the exact parent review still authorizes them. */
export async function runOperatorParentChat(input: Input, dependencies: {
  io?: OwnerPolicyReviewIo;
  chat?: BoundaryAuthoringChat;
  modelSession?: BoundaryJobPlanningSession;
  draft?: typeof draftOperatorParentPolicy;
} = {}): Promise<number> {
  const binding = await openProjectControlPolicies(input);
  if (!binding) throw new Error("First run policy storage for this project and review its existing authority migration. Ordinary database onboarding does not require owner delegation.");
  const chat = dependencies.chat ?? createBoundaryAuthoringChat(dependencies.io ? { io: {
    ...dependencies.io, onInterrupt: () => () => {}, close() {},
  } } : {});
  const service = createOperatorParentReview({ ...input, binding });
  try {
    const context = await service.context(input.name);
    if (!context.rules.length) { chat.checkpoint("No reviewed actions yet", ["Prepare your database job first. Delegation can customize only existing verified business actions."], "warning"); return 0; }
    const choice = await chat.session.chooseOption?.("CUSTOMIZABLE AGENT RULES", [
      { value: "yes", label: context.current ? "Edit the delegable business rules with the model" : "Let authorized owners customize their agent rules",
        detail: "You review who may edit, which rules can change, and the hard restrictions. Source access stays separate." },
      { value: "no", label: "Keep the current setup" },
    ], { initialValue: context.current ? "yes" : "no", requireExplicitSelection: true,
      context: ["Should authorized customers or account administrators be able to customize what their agents may do?"] });
    if (choice !== "yes") return 0;
    const identities = context.current ? identityBindings(context.current)
      : await collectOwnerBindings(chat, input.config.action_rules?.owner_management?.policy_name ?? "my_agent_rules");
    if (!identities) return 0;
    // Validate the complete structural context before asking for model egress.
    const catalog = buildOperatorParentCatalog(context.rules, context.current);
    const selectedModel = dependencies.modelSession ?? await promptBoundaryMappingModel(chat.session,
      { provider: "openai", model: DEFAULT_TERMINAL_OPENAI_ASK_MODEL, apiKeyEnv: "OPENAI_API_KEY" }, { env: input.env });
    if (!selectedModel) return 0;
    const model = { ...selectedModel, conversation: selectedModel.conversation ?? createModelAuthoringConversation() };
    chat.setModel(`${model.provider}[${model.model}]`);
    chat.rememberDetails("Operator delegation model disclosure", renderTerminalJson({ catalog,
      current_rules: context.current?.delegation ?? null, allowed_agents: [...new Set(identities.agent_owners.map((entry) => entry.agent))],
      excluded: ["source rows", "credentials", "connection URLs", "owner identity bindings", "activation tokens"] }, false).split("\n"));
    let permission: string | undefined;
    do {
      permission = await chat.session.chooseOption?.("MODEL PERMISSION", [
      { value: "allow", label: "Allow this reviewed setup conversation" },
      { value: "details", label: "Inspect the exact context first" },
      { value: "cancel", label: "Not now" },
    ], { initialValue: "cancel", requireExplicitSelection: true, context: [
      `${model.provider}[${model.model}] receives reviewed action metadata, current delegable rules, allowed agent names, and answers you type.`,
      "No source rows, credentials, connection URLs, owner identity bindings or human activation tokens are sent. No authority changes during drafting.",
      ] });
      if (permission === "details") chat.showDetails();
    } while (permission === "details");
    if (permission !== "allow") return 0;
    chat.checkpoint("Delegation setup", ["Describe which rules owners may customize and what must remain mandatory. Identity bindings stay fixed; /details is available throughout."]);
    let current = context.current;
    while (true) {
      const message = await chat.readOperator?.();
      if (message === undefined) return 0;
      if (!message.trim()) continue;
      const result = await chat.progress("Reviewing delegable business rules", () => (dependencies.draft ?? draftOperatorParentPolicy)({
        session: model, operatorMessage: message, currentParent: current, identityBindings: identities,
        catalog, compiledRules: context.rules, egressAcknowledged: true, env: input.env,
      })).catch((error: unknown) => {
        const raw = (error as { code?: unknown })?.code;
        const code = typeof raw === "string" && /^[A-Z_]{1,100}$/u.test(raw) ? raw : "PARENT_DRAFT_UNAVAILABLE";
        chat.rememberDetails("Delegation draft not saved", [code, "Current active authority and source data are unchanged."]);
        chat.checkpoint("Draft not saved", [`${code}. Your existing rules are unchanged. Try describing the change again, use /details, or Esc to leave.`], "warning");
        return undefined;
      });
      if (!result) continue;
      if (result.state === "clarification") { await chat.streamModel([result.question]); continue; }
      const review = await service.prepare(input.name, result.parent, context.epoch).catch((error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        const stale = code === "POLICY_PARENT_REVIEW_STALE";
        chat.rememberDetails("Delegation review unavailable", [
          stale ? "POLICY_PARENT_REVIEW_STALE" : "POLICY_PARENT_REVIEW_INVALID",
          "This candidate was not saved or activated. Existing authority and source data are unchanged.",
        ]);
        chat.checkpoint(stale ? "Rules changed during drafting" : "This draft cannot be reviewed", [
          stale ? "Another reviewed change was saved during this conversation. Your draft has not replaced it."
            : "Runner could not validate this candidate against the current business actions. Your existing rules remain in place.",
          "Reopen policy delegation to review the current rules; /details contains the local failure category.",
        ], "warning");
        return undefined;
      });
      if (!review) return 1;
      current = result.parent;
      chat.rememberDetails("Exact parent delegation revision", renderTerminalJson(review, false).split("\n"));
      await chat.streamModel([result.summary]);
      let decision: string | undefined;
      do {
        decision = await chat.session.chooseOption?.("REVIEW OWNER DELEGATION", [
        { value: "confirm", label: "Enable this exact reviewed delegation" },
        { value: "revise", label: "Ask a question or change the rules" },
        { value: "details", label: "Inspect exact bindings, rules and changes" },
        { value: "cancel", label: "Leave authority unchanged" },
        ], { initialValue: "cancel", requireExplicitSelection: true, context: parentReviewLines(review) });
        if (decision === "details") {
          const lines = renderTerminalJson(review, false).split("\n");
          if (chat.session.showReviewDetails) await chat.session.showReviewDetails("Exact parent delegation revision", lines);
          else chat.showDetails();
        }
      } while (decision === "details");
      if (decision === "confirm") {
        await input.recheckConfig();
        await service.confirm(review);
        chat.checkpoint("Owner delegation saved", [
          "Owner edits still require authenticated human activation. Source access and execution are unchanged.",
          input.config.action_rules?.owner_management
            ? `Next: policy chat --config ${input.configPath} opens authorized owner settings.`
            : "Owner chat is not connected yet. Configure its backend-issued assistant and separate human-review sign-ins before use; see docs/owner-controlled-rules.md.",
        ], "success");
        return 0;
      }
      service.cancel(review);
      if (decision !== "revise") return 0;
    }
  } finally { chat.close(); await binding.close(); }
}

function identityBindings(parent: PolicyManagementParent): TrustedParentIdentityBindings {
  return structuredClone({ managers: parent.managers, agent_owners: parent.agent_owners,
    ...(parent.runtime_delegations ? { runtime_delegations: parent.runtime_delegations } : {}) });
}

export async function collectOwnerBindings(chat: BoundaryAuthoringChat, policyName: string): Promise<TrustedParentIdentityBindings | undefined> {
  const scopeMode = await chat.session.chooseOption?.("WHOSE AGENT RULES", [
    { value: "personal", label: "One person's agent rules" },
    { value: "tenant", label: "One shared account's agent rules" },
    { value: "cancel", label: "Back" },
  ], { initialValue: "personal", requireExplicitSelection: true,
    context: ["Use exact identifiers from your sign-in and workload backend. They are not database-row values or model-selected identities."] });
  if (scopeMode !== "personal" && scopeMode !== "tenant") return undefined;
  const read = async (question: string, name = false): Promise<string | undefined> => {
    while (true) {
      const value = await chat.readLiteral?.(question);
      if (value === undefined) return undefined;
      const text = value.trim();
      if (text && (name ? /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(text) : text.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(text))) return text;
      chat.checkpoint("Check this identifier", [name ? "Use a workload name: letters, numbers, underscores, dots or hyphens, starting with a letter or underscore." : "Use the exact nonempty backend identifier, up to 256 characters."], "warning");
    }
  };
  const account = await read("Account identifier from your sign-in backend"); if (!account) return undefined;
  const principal = await read(scopeMode === "personal" ? "Owner principal from your sign-in backend" : "Delegating administrator principal from your sign-in backend"); if (!principal) return undefined;
  const subject = await read("Human sign-in subject allowed to review these rules"); if (!subject) return undefined;
  const agent = await read("Agent workload name", true); if (!agent) return undefined;
  const scope = scopeMode === "personal" ? { level: "principal" as const, tenant_id: account, principal }
    : { level: "tenant" as const, tenant_id: account };
  return { managers: [{ subject, actor_kind: "human", tenant_id: account, scope: { mode: "exact", scope: structuredClone(scope) },
    permissions: ["inspect", "draft", "activate", "revoke", "audit"] }],
    agent_owners: [{ agent, scope: structuredClone(scope) }],
    runtime_delegations: [{ agent, delegator: principal, owner: structuredClone(scope), policies: [{ scope: structuredClone(scope), name: policyName }] }] };
}
