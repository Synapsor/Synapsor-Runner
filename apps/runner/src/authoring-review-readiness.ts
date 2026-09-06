import type { PolicyCoverage, PolicyTextSnapshot } from "./authoring-policy-source.js";
import { unresolvedPolicyPassages } from "./authoring-policy-coverage.js";
import { readBoundaryRevisionCatalog, type ReadBoundaryFieldExposureChange } from "./read-boundary-revision-model.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";

export function policyReviewReadiness(source: PolicyTextSnapshot, report?: PolicyCoverage) {
  if (!report) return { ready: false, privacy: false, summary: [
    "Before activation: recheck the attached rules. Activation is unavailable; the saved draft and exact details remain available.",
  ] };
  const pending = unresolvedPolicyPassages(report);
  const topics = [...new Set(pending.map((passage) => passage.topic ?? `Rule at lines ${passage.start}-${passage.end}`))];
  const privacy = pending.some((passage) => passage.field_checks?.some((check) => check.expectation === "private"));
  return { ready: !pending.length, privacy, summary: pending.length ? [
    `Before activation: ${topics.join("; ")}. These are required decisions, not optional recommendations.`,
    "Continue with the model to resolve them in this saved draft. Activation is unavailable until the checks pass.",
  ] : [`Attached rules: ${source.name} v${source.version}; interpretation checked against this revision. Exact source and decisions remain available in Review attached rules.`] };
}

/** Repair only a model-interpreted source requirement on a proven structural
 * role. Ambiguous business meanings still need the operator. No new access. */
export function knownPolicyPrivacyReductions(input: {
  report: PolicyCoverage; read: ExplorationBoundaryDraft; actions: CompiledActionRuleModelDraftV1[];
  clarifiedFields?: ReadonlySet<string>;
}): ReadBoundaryFieldExposureChange[] {
  const catalog = readBoundaryRevisionCatalog(input.read);
  const result = new Map<string, ReadBoundaryFieldExposureChange>();
  const businessVisible = new Set(input.report.passages.flatMap((passage) => (passage.field_checks ?? [])
    .filter((check) => check.expectation === "business_visible").map((check) => `${check.resource}.${check.field}`)));
  for (const passage of unresolvedPolicyPassages(input.report)) {
    if (passage.issue_kind === "schema_meaning" || passage.disposition === "unsupported") continue;
    for (const check of passage.field_checks ?? []) {
      const key = `${check.resource}.${check.field}`;
      if (check.expectation !== "private" || businessVisible.has(key)) continue;
      const field = catalog.resources.find((resource) => resource.id === check.resource)?.fields.find((field) => field.id === check.field);
      if (!field || field.current_exposure === "kept_out" || !field.raw_return && !field.model_operations.length) continue;
      const proven = field.roles.some((role) => ["record_identity", "relationship_key", "trusted_scope"].includes(role))
        || input.actions.some((action) => action.verification_boundary.resources.some((resource) => resource.resource === check.resource
          && (resource.primary_key === check.field || resource.version_field === check.field)));
      if (!proven && !input.clarifiedFields?.has(key)) continue;
      result.set(key, { resource: check.resource, field: check.field, before: field.current_exposure,
        after: "runner_only", model_operations: "none",
        rationale: `Attached rule at lines ${passage.start}-${passage.end} requires privacy; ${proven ? "reviewed structural role" : "the operator's business clarification"} establishes the internal use. Existing Read selection is preserved.` });
    }
  }
  return [...result.values()];
}
