import { isDeferredPolicyDeployment, isDeferredSourceReadback, type PolicyCoverage, type PolicyTextSnapshot, type PolicyPassage, type PolicySourceSession } from "./authoring-policy-source.js";
import { needsDeploymentCoverageClassification, unresolvedPolicyPassages } from "./authoring-policy-coverage.js";
import { readBoundaryRevisionCatalog, type ReadBoundaryFieldExposureChange } from "./read-boundary-revision-model.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";

export type AuthoringReadinessItem = {
  kind: "business_decision" | "mechanical_correction" | "unsupported_runtime" | "deployment_prerequisite" | "provider_failure";
  title: string; nextStep: string; passages: PolicyPassage[]; blocksReview: boolean;
};

export function applicationObligationAssigned(report: PolicyCoverage, passage: PolicyPassage, session?: PolicySourceSession): boolean {
  return passage.responsibility === "application" && !passage.field_checks?.length && Boolean(passage.application_obligations?.length
    && session?.application_assignments?.some((entry) => entry.source_digest === report.source_digest && entry.draft_digest === report.draft_digest
      && entry.start === passage.start && entry.end === passage.end && entry.verified === false && entry.owner === "client_application"
      && entry.obligations.length === passage.application_obligations!.length
      && entry.obligations.every((id) => passage.application_obligations!.includes(id))));
}

export function policyReadinessItems(report?: PolicyCoverage, session?: PolicySourceSession): AuthoringReadinessItem[] {
  if (!report) return [{ kind: "provider_failure", title: "Attached rules need checking",
    nextStep: "Retry the coverage check for this saved draft.", passages: [], blocksReview: true }];
  const grouped = new Map<string, AuthoringReadinessItem>();
  for (const passage of unresolvedPolicyPassages(report)) {
    const needsClassification = needsDeploymentCoverageClassification(passage);
    const deferred = isDeferredPolicyDeployment(passage) || isDeferredSourceReadback(passage);
    const kind = needsClassification ? "mechanical_correction"
      : passage.application_obligations?.length || deferred ? "deployment_prerequisite"
      : passage.issue_kind === "schema_meaning" || passage.issue_kind === "business_choice" ? "business_decision"
      : passage.disposition === "unsupported" ? "unsupported_runtime"
      : passage.responsibility === "runner" || passage.issue_kind === "coverage_link" ? "mechanical_correction"
      : passage.responsibility === "deployment" ? "deployment_prerequisite" : "business_decision";
    const title = passage.topic ?? `Rule at lines ${passage.start}-${passage.end}`;
    const key = `${kind}:${passage.deployment_prerequisite ?? (isDeferredSourceReadback(passage) ? "independent_source_readback" : "")}:${title}`;
    const nextStep = needsClassification
      ? "Recheck this deployment classification against exact Runner setup evidence. Do not revise business rules or require a client connection before authority review."
      : isDeferredSourceReadback(passage)
        ? "After each applicable execution, independently observe the source and compare it with the exact intended change. This readback remains unverified; a receipt alone is not that observation. No Action-code repair is required for this external step."
      : deferred && passage.deployment_prerequisite === "runner_client_connection"
        ? "After authority review, choose a supported Runner client in client setup and review installation and the connection check. Configuration has not been checked and connection remains unverified; identity, application behavior and execution need separate checks."
      : deferred && passage.deployment_prerequisite === "authenticated_identity"
      ? "After review, choose a client and configure runtime identity. Use a fixed test identity only for local testing; production identity must come from an authenticated application session. Runtime access remains unavailable without it."
      : deferred && passage.deployment_prerequisite === "runner_execution_setup"
      ? "After authority review, prepare or verify the dedicated writer, review execution permission, then configure and start the worker. Keep reader credentials separate. Setup and execution remain unverified; no request is completed without a successful receipt."
      : passage.next_step ?? passage.interpretation;
    const item = grouped.get(key) ?? { kind, title, nextStep, passages: [], blocksReview: false };
    item.passages.push(passage);
    item.blocksReview ||= !deferred && !applicationObligationAssigned(report, passage, session);
    grouped.set(key, item);
  }
  return [...grouped.values()];
}

export function policyReviewReadiness(source: PolicyTextSnapshot, report?: PolicyCoverage, session?: PolicySourceSession) {
  if (!report) return { ready: false, privacy: false, summary: [
    "Before activation: recheck the attached rules. Activation is unavailable; the saved draft and exact details remain available.",
  ] };
  const items = policyReadinessItems(report, session);
  const pending = items.filter((item) => item.blocksReview).flatMap((item) => item.passages);
  const topics = items.filter((item) => item.blocksReview).map((item) => item.title);
  const assigned = items.filter((item) => !item.blocksReview);
  const clientChecks = [...new Set(assigned.flatMap((item) => item.passages.flatMap((passage) => [
    ...(passage.deployment_prerequisite === "authenticated_identity" ? ["signed-in customer identity"] : []),
    ...(passage.deployment_prerequisite === "runner_client_connection" ? ["Runner client connection"] : []),
    ...(passage.application_obligations ?? []).filter(obligation => obligation !== "independent_source_readback").map((obligation) => obligation === "customer_selection"
      ? "customer selection" : "accurate status messages"),
  ])))];
  const privacy = pending.some((passage) => passage.field_checks?.some((check) => check.expectation === "private"));
  return { ready: !pending.length, privacy, items, summary: [...(pending.length ? [
    `Before activation: ${topics.join("; ")}. These are required decisions, not optional recommendations.`,
    "Continue with the model to resolve them in this saved draft. Activation is unavailable until the checks pass.",
  ] : [`Attached rules: ${source.name} v${source.version}; interpretation checked for this revision.`]),
    ...(clientChecks.length ? [`Client integration still unverified: ${clientChecks.join(", ")}. Check these during client setup before customer use.`] : []),
    ...(assigned.some(item => item.passages.some(isDeferredSourceReadback))
      ? ["Independent source readback remains unverified for each applicable execution. Perform and retain that separate observation after the change; a receipt or completed business review does not prove it."] : []),
    ...(assigned.some((item) => item.passages.some((passage) => passage.deployment_prerequisite === "runner_execution_setup"))
      ? ["Execution setup pending: dedicated writer review, separate execution permission and worker startup. Continue to these checks after authority review; automatic completion is not yet enabled."] : []),
  ] };
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
    if (passage.disposition === "unsupported") continue;
    for (const check of passage.field_checks ?? []) {
      const key = `${check.resource}.${check.field}`;
      if (passage.issue_kind === "schema_meaning" && !input.clarifiedFields?.has(key)) continue;
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
