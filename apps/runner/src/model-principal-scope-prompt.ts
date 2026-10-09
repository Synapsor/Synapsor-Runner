import type { ModelPrincipalScopeOption } from "./model-principal-scope-review.js";

/** Descriptive ownership only; never added to provider bytes, durable records,
 * authority digests or existing in-flight operation pins. */
export const MODEL_PRINCIPAL_SCOPE_PROMPT = {
  id: "synapsor.principal-scope.answer",
  version: 1,
  contract: { submission_tool: "runner.review_principal_scope_answer", states: ["resolved", "none", "clarification"] },
  context_owner: "model-principal-scope-review",
  correction_owner: "model-principal-scope-review",
} as const;
const REVIEW_PRINCIPAL_SCOPE_TOOL = MODEL_PRINCIPAL_SCOPE_PROMPT.contract.submission_tool;

/** Exact already reviewed candidate snapshot and bounded answer supplied by the
 * producer; this renderer does not choose scope or trusted identity values. */
export type ModelPrincipalScopePromptInput = Readonly<{
  resourceId: string;
  catalog: readonly ModelPrincipalScopeOption[];
  answer: string;
  scopeKind?: "organization_and_person";
}>;

export const MODEL_PRINCIPAL_SCOPE_SYSTEM_PROMPT = [
      "You translate one business-language identity-scope answer into one exact Runner candidate.",
      "The candidate list is closed. Identifiers and labels are not proof; use the operator's stated semantics and ask for clarification instead of guessing.",
      "You cannot grant authority, choose trusted identity values, activate a Boundary, execute SQL, approve, apply, or write.",
    ].join(" ");

export function buildModelPrincipalScopePrompt(input: ModelPrincipalScopePromptInput): string {
  const { catalog, answer } = input;
  return [
    input.scopeKind
      ? "Interpret the operator's policy to distinguish organization scope from authenticated-person scope. Each candidate is one complete orientation of both existing columns and their inspected session settings."
      : "Translate one operator answer about authenticated-person row scope.",
    `Exact reviewed resource: ${input.resourceId}`,
    `Exact Runner candidates: ${JSON.stringify(catalog)}`,
    `Operator answer: ${JSON.stringify(answer)}`,
    `Call ${REVIEW_PRINCIPAL_SCOPE_TOOL} exactly once.`,
    "Resolve only when the answer uniquely identifies one exact candidate and confirms that trusted authenticated-principal context has that meaning.",
    ...(input.scopeKind ? ["Structural proof does not establish business orientation. If the policy does not distinguish the organization and person, ask which is which. Runner will separately ask the operator to confirm the exact proposed mapping before saving it."] : []),
    "If the operator says none, rejects all candidates, or says this resource is not per-person, submit status none.",
    "If the answer is ambiguous, asks a question, or does not establish the business meaning, submit one concise clarification question. Never guess from an identifier.",
    "Do not emit SQL, credentials, tenant or principal values, activation, approval, or write authority.",
  ].join("\n");
}

/** Eligibility and consumption of the bounded correction remain producer-owned. */
export function buildModelPrincipalScopeCorrectionPrompt(input: Readonly<{ question: string; issue: string }>): string {
  const { question, issue } = input;
  return [
      "Runner rejected the first interpretation. Do not repeat it.",
      `Validation issue: ${issue.slice(0, 700)}`,
      "Submit one corrected exact candidate, none, or one clarification question.",
      question,
    ].join("\n");
}
