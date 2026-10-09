import type { PolicyManagementParent } from "@synapsor-runner/mcp-server";
import type { ParentDelegationCatalog } from "./owner-policy-parent-model.js";

/** Descriptive ownership only; never added to provider bytes, durable records,
 * authority digests or existing in-flight operation pins. */
export const OWNER_POLICY_PARENT_PROMPT = {
  id: "synapsor.owner-policy-parent.delegation",
  version: 1,
  contract: { submission_tool: "runner.draft_operator_parent", states: ["candidate", "clarification"] },
  context_owner: "owner-policy-parent-model",
  correction_owner: "owner-policy-parent-model",
} as const;
const DRAFT_PARENT_TOOL = OWNER_POLICY_PARENT_PROMPT.contract.submission_tool;

/** Already bounded, resolved producer snapshots. Rendering grants no authority
 * and cannot resolve, adopt, save, retry or replace any current context. */
export type OwnerPolicyParentPromptInput = Readonly<{
  operatorMessage: string;
  catalog: ParentDelegationCatalog;
  prior: PolicyManagementParent["delegation"] | null;
  active: Pick<PolicyManagementParent, "delegation"> | null;
  allowedAgents: readonly string[];
}>;

export const OWNER_POLICY_PARENT_SYSTEM_PROMPT = "Produce one bounded operator parent delegation candidate through the required tool. Never invent verified facts, identity bindings, activation, or source-write authority.";

export function buildOwnerPolicyParentPrompt(input: OwnerPolicyParentPromptInput): string {
  const { operatorMessage, catalog, prior, active, allowedAgents } = input;
  return [
    "Draft one optional operator parent delegation for separate trusted human review.",
    `Operator request: ${JSON.stringify(operatorMessage)}`,
    `Verified Action catalog: ${JSON.stringify(catalog)}`,
    `Editable candidate delegation: ${JSON.stringify(prior)}`,
    `Currently activated delegation: ${JSON.stringify(active?.delegation ?? null)}`,
    "The current conversation is with the deployment operator, not a delegated owner. An unactivated candidate is editable, not an immutable parent ceiling. Correct its approval choice or unwanted candidate-only restriction when requested; do not make the operator restart. Catalog allow_automatic_approval is the starting setting, not a prohibition on an operator-reviewed change. Allowing inheritance never bypasses the compiled Action approval conditions or limits.",
    `Allowed delegable agent IDs: ${JSON.stringify(allowedAgents)}`,
    "Return exactly one structured tool result. You may change only delegation: delegable agents, outcomes, verified facts, predicates, approval posture, and bounded budgets.",
    "Use only the listed allowed agent IDs. Never create manager grants, owner-scope bindings, runtime bindings, credentials, identities, activation, a review approval, execution, writeback, SQL, or source changes. Those bindings are trusted local input and are not shown to you.",
    "Every compiled Action Rule eligibility check remains mandatory at runtime. An owner parent only adds restrictions; it never replaces or repeats compiled checks. Keeping an existing compiled availability, scope, or eligibility check requires no parent fact, predicate, or clarification. Ask only about an additional parent restriction the operator actually requests.",
    "Use only exact outcome names, compiled digests, fact names, sources, types, effect-envelope fields, and operators from the verified catalog. Facts marked ambiguous_label are verified but intentionally have only a raw qualified identifier; ask one concise human clarification before assigning a business title. If an operator request needs an unavailable business condition, ask one concise clarification instead of inventing a fact or bound.",
    "On a revision retain every activated delegated agent and every activated budget meter. Preserve candidate settings unless the operator asks to correct them. Preserve reviewed fact titles and operator sets by default; an operator may explicitly label an ambiguous raw identifier for root review. Do not silently remove caps or agents. This remains an untrusted candidate and grants no authority.",
    "Supported parent budget operations are effect_count and effect_field only. A budget is a positive bounded local window in reviewed integral units: effect_count uses unit effects; effect_field uses an exact allowed effect field with its reviewed integer or money-minor unit. Drafting starts with no runtime effect, reservation, or budget consumption; runtime evaluates only these reviewed effects after separate human review. No source query or execution occurs here.",
    `Call ${DRAFT_PARENT_TOOL} exactly once.`,
  ].join("\n");
}

/** The producer alone decides whether its one bounded correction may run. */
export function buildOwnerPolicyParentCorrectionPrompt(input: Readonly<{ baseQuestion: string; issue: string }>): string {
  const { baseQuestion, issue } = input;
  return [
          "Runner refused the first draft. This is the one bounded correction.",
          `Validation issue: ${issue}`,
          "Return one complete corrected candidate or one clarification. Do not add identity bindings or unverified facts.",
          baseQuestion,
        ].join("\n");
}
