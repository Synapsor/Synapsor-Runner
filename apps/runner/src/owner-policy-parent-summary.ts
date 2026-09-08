import type { OperatorParentReview } from "./owner-policy-parent-review.js";
import { renderOwnerRulePredicate } from "./owner-policy-review-ui.js";
import { formatPolicyDuration } from "./action-policy-scope.js";
import { renderReviewFacts } from "./review-facts.js";
import { wrapStyledTerminalLine } from "./terminal-layout.js";

export function parentReviewLines(review: OperatorParentReview, width = 96): string[] {
  const scope = (value: { level: string; tenant_id?: string; principal?: string }) => value.level === "operator" ? "deployment"
    : [value.tenant_id, value.principal].filter(Boolean).join(" / ");
  return ["Review owner delegation", `Parent: ${review.name}`,
    ...(review.before ? ["Replacing this parent requires its existing owner policies to be revalidated before further effects."] : []),
    ...renderReviewFacts([
      ["Who may edit", review.after.managers.map((grant) => `${grant.subject} (${grant.actor_kind}, ${grant.tenant_id}): ${grant.permissions.join(", ")} for ${grant.scope.mode === "exact" ? scope(grant.scope.scope) : grant.scope.mode === "personal" ? "their own authenticated personal scope" : "ALL owners in this deployment"}`).join("\n")],
      ["Agent owners", review.after.agent_owners.map((entry) => `${scope(entry.scope)}: ${entry.agent}`).join("\n")],
    ], width),
    ...review.after.delegation.outcomes.flatMap((entry) => {
      const before = review.before?.delegation.outcomes.find((prior) => prior.outcome === entry.outcome);
      return ["", ...renderReviewFacts([
        ["Business action", entry.outcome],
        ["Editable facts", entry.facts.map((fact) => fact.title).join(", ") || "None"],
        ["Always required", entry.require ? renderOwnerRulePredicate(entry.require) : "The existing application safeguards"],
        ["Approval", entry.allow_automatic_approval ? "Owners may inherit the Action's approval conditions and limits, or require human review" : "Human review required"],
        ...(before && before.allow_automatic_approval !== entry.allow_automatic_approval
          ? [["Approval change", before.allow_automatic_approval ? "Inherited Action approval -> human review only" : "Human review only -> optional inherited Action approval"] as const] : []),
      ], width)];
    }),
    ...(review.after.delegation.budgets ?? []).map((budget) =>
      `Hard allowance ${budget.title}: ${budget.maximum} ${budget.unit} per rolling ${formatPolicyDuration(budget.window_ms / 1000)} (${budget.scope === "tenant" ? "shared account" : "owner across agents"}).`),
    `Runtime bindings: ${review.after.runtime_delegations?.length ?? 0}. Missing bindings grant no agent authority.`,
    ...((review.after.delegation.budgets?.length ?? 0) ? ["Hard shared allowances and their measured effects are included in exact configuration; existing spent/reserved allowance is not reset."] : []),
    "Inspect exact configuration for field operators, bounds, runtime associations, changes from the prior parent and hard allowances.",
    "Source Read, Action, owner approval and execution remain independent safeguards."]
    .flatMap((line) => wrapStyledTerminalLine(line, width));
}
