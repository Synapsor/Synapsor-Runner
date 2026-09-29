import { disclosureReportMatchesSession } from "./authoring-scoped-disclosure.js";
import { validClientDutyInventory, clientDutyAssigned, isClientDutyPassage, type ClientDuty } from "./authoring-client-duties.js";
import { deferredReviewObligation } from "./authoring-obligation-review.js";
import { isDeferredPolicyDeployment, isDeferredSourceReadback, isDeferredSourceCounterMaintenance, type PolicyCoverage, type PolicyTextSnapshot, type PolicyPassage, type PolicySourceSession } from "./authoring-policy-source.js";
import { needsDeploymentCoverageClassification, unresolvedPolicyPassages } from "./authoring-policy-coverage.js";
import { readBoundaryRevisionCatalog, type ReadBoundaryFieldExposureChange } from "./read-boundary-revision-model.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";

export type AuthoringReadinessItem = {
  kind: "business_decision" | "mechanical_correction" | "unsupported_runtime" | "deployment_prerequisite" | "provider_failure";
  clientDuty?: ClientDuty; title: string; nextStep: string; passages: PolicyPassage[]; blocksReview: boolean;
};

export function applicationObligationAssigned(report: PolicyCoverage, passage: PolicyPassage, session?: PolicySourceSession): boolean {
  if (report.client_duties?.mode === "interactive_subject_action") return isClientDutyPassage(passage) && passage.application_obligations!.every(d => clientDutyAssigned(report, d as ClientDuty, session));
  return isClientDutyPassage(passage)
    && !passage.application_obligations?.includes("independent_source_readback") && Boolean(passage.application_obligations?.length
    && session?.application_assignments?.some((entry) => entry.source_digest === report.source_digest && entry.draft_digest === report.draft_digest
      && entry.start === passage.start && entry.end === passage.end && entry.verified === false && entry.owner === "client_application"
      && entry.obligations.length === passage.application_obligations!.length
      && entry.obligations.every((id) => passage.application_obligations!.includes(id))));
}

export function policyReadinessItems(report?: PolicyCoverage, session?: PolicySourceSession): AuthoringReadinessItem[] {
  if (!report) return [{ kind: "provider_failure", title: "Attached rules need checking",
    nextStep: "Retry the coverage check for this saved draft.", passages: [], blocksReview: true }];
  const grouped = new Map<string, AuthoringReadinessItem>();
  if(session?.input_policy_reviews?.length){
    const fidelity=report.input_fidelity;
    const relevant=session.input_policy_reviews.filter(r=>fidelity?.review_digests.includes(r.digest));
    if(!fidelity||!relevant.length||fidelity.findings.length||relevant.some(r=>r.source_digest!==report.source_digest||r.decision!=='confirmed'))
      grouped.set('source-input',{kind:'business_decision',title:'Source-required input bounds remain pending',nextStep:'Review the exact current source input interpretation and correct the disabled input component; no new business meaning or global nonempty default is inferred.',passages:[],blocksReview:true});
  }
  if (report.source_transaction_requirement_pending || session?.source_transaction_reviews?.length
    || report.passages.some(p=>p.receipt_component==='source_transaction_coupling')) {
    const associated=report.source_transaction_association;
    // A later decision for the same source/Action supersedes an earlier
    // confirmation. Status must not display old coverage as ready while the
    // next saved Review is waiting to revalidate it.
    const latest=new Map(session?.source_transaction_reviews?.map(record=>[record.id,record])??[]);
    const current=[...latest.values()].some(record=>record.digest===associated?.requirement_digest
      && record.source_digest===report.source_digest&&record.decision==='confirmed');
    if (!current || report.source_transaction_requirement_pending) grouped.set('source-transaction', {kind:'business_decision',
      title:'Source transaction requirement needs current review',
      nextStep:'Use the local saved Review to confirm the exact current policy/effect/receipt interpretation. Historical receipts or compiled capability do not establish source meaning.',
      passages:[],blocksReview:true});
  }
  const required = session?.scoped_disclosure_reviews?.length;
  const disclosure = report.scoped_disclosure;
  if (required && !disclosureReportMatchesSession(disclosure, session!)) {
    grouped.set("disclosure-current", {kind:"business_decision", title:"Source-required description classification needs current review",
      nextStep:"Open the local source-required disclosure review. Saved requirements remain pending; no model opinion or access change is required to inspect them.", passages:[],blocksReview:true});
  }
  for (const field of disclosure?.items ?? []) if (field.state !== "confirmed_non_sensitive") grouped.set(`disclosure:${field.id}:${field.resource}:${field.field}`, {
    kind:"business_decision", title:`${field.resource}.${field.field}: classification ${field.state === "deferred" ? "deliberately pending" : field.state}`,
    nextStep:field.state === "stale" ? "Revalidate the exact source, selected Read and store before renewing this owner decision. Prior evidence remains history."
      : "Use the local source-required disclosure review to inspect or revisit this exact owner decision. A grant is not classification; Keep pending does not accept risk or establish sensitivity.",
    passages:[],blocksReview:true,
  });
  const inventory = report.client_duties && validClientDutyInventory(report.client_duties) ? report.client_duties : undefined;
  if (!inventory || inventory.mode === "unresolved") grouped.set("client-contract", { kind: "business_decision",
    title: "Current client contract needs review", nextStep: "Recheck the saved job to establish the applicable client contract. Historical authority is unchanged.", passages: [], blocksReview: true });
  for (const duty of inventory?.duties ?? []) grouped.set(`client:${duty}`, { kind: "deployment_prerequisite", clientDuty: duty,
    title: duty === "customer_selection" ? "Client target selection" : "Client status presentation",
    nextStep: "Use the client integration responsibilities review to accept current ownership. Implementation and per-operation assurance remain unverified.",
    passages: [], blocksReview: !clientDutyAssigned(report, duty, session) });
  for (const passage of unresolvedPolicyPassages(report)) {
    if (inventory?.mode === "interactive_subject_action" && isClientDutyPassage(passage)) {
      for (const duty of passage.application_obligations!) grouped.get(`client:${duty}`)?.passages.push(passage);
      continue;
    }
    const needsClassification = needsDeploymentCoverageClassification(passage);
    const obligation = deferredReviewObligation(passage);
    const deferred = isDeferredPolicyDeployment(passage) || Boolean(obligation);
    const kind = needsClassification ? "mechanical_correction"
      : passage.application_obligations?.length || deferred ? "deployment_prerequisite"
      : passage.issue_kind === "schema_meaning" || passage.issue_kind === "business_choice" ? "business_decision"
      : passage.disposition === "unsupported" ? "unsupported_runtime"
      : passage.responsibility === "runner" || passage.issue_kind === "coverage_link" ? "mechanical_correction"
      : passage.responsibility === "deployment" ? "deployment_prerequisite" : "business_decision";
    const title = passage.topic ?? `Rule at lines ${passage.start}-${passage.end}`;
    const key = `${kind}:${passage.deployment_prerequisite ?? (isDeferredSourceReadback(passage) ? "independent_source_readback" : "")}:${title}`;
    const nextStep = obligation?.family === "receipt_setup"
      ? `Receipt/execution setup pending: after authority review, use execution setup to review ${obligation.requirement} receipt mode and the dedicated writer, then separate execution permission and worker startup. Selection, provisioning, an actual receipt and independent source readback are not verified by this business review.`
      : obligation?.family === "source_counter_maintenance"
      ? "The exact source-owner maintenance operating contract is current. The owner must keep every writer within that contract; independent external-writer and production assurance remain unverified. BUSINESS review does not enable execution or verify those writers. Revalidate the existing counter review if source, metadata, role, target or owner decision changes."
      : needsClassification
      ? "Recheck this deployment classification against exact Runner setup evidence. Do not revise business rules or require a client connection before authority review."
      : obligation?.family === "independent_source_readback"
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

export function policyReviewReadiness(source: PolicyTextSnapshot, report?: PolicyCoverage, session?: PolicySourceSession, location: "active" | "draft" = "draft") {
  if (!report || report.source_digest !== source.digest) return { ready: false, privacy: false, summary: [
    location === "active" ? "Current BUSINESS conformance needs rechecking. Active published rules are unchanged; no new authority or execution permission is granted." : "Before activation: recheck the attached rules. Activation is unavailable; the saved draft and exact details remain available.",
  ] };
  if (report.passages.some(p => p.counter_requirements?.length || p.counting_components?.length || p.counting_requirement_bindings?.length)
    && report.counting_inventory?.version !== 1) return { ready: false, privacy: false, summary: [
      "Counting review predates the positive requirement check. Recheck the saved draft; historical authority is unchanged."] };
  const items = policyReadinessItems(report, session);
  const pending = items.filter((item) => item.blocksReview).flatMap((item) => item.passages);
  const topics = items.filter((item) => item.blocksReview).map((item) => item.title);
  const assigned = items.filter((item) => !item.blocksReview);
  const clientChecks = [...new Set([...assigned.filter(i => i.clientDuty).map(i => i.title), ...assigned.flatMap((item) => item.passages.flatMap((passage) => [
    ...(passage.deployment_prerequisite === "authenticated_identity" ? ["signed-in customer identity"] : []),
    ...(passage.deployment_prerequisite === "runner_client_connection" ? ["Runner client connection"] : []),
    ...(passage.application_obligations ?? []).filter(obligation => obligation !== "independent_source_readback").map((obligation) => obligation === "customer_selection"
      ? "customer selection" : "accurate status messages"),
  ]))])];
  const privacy = pending.some((passage) => passage.field_checks?.some((check) => check.expectation === "private"));
  return { ready: !items.some(item => item.blocksReview), privacy, items, summary: [...(items.some(item => item.blocksReview) ? [
    location === "active" ? `Current BUSINESS conformance: pending. ${topics.join("; ")}.` : `Before activation: ${topics.join("; ")}. These are required decisions, not optional recommendations.`,
    location === "active" ? "Active published rules are unchanged. Missing classification is not established by prior access approval. No new authority or execution permission is granted by this review." : "Use the applicable review controls to resolve these decisions in this saved draft. Activation is unavailable until the checks pass.",
  ] : [`Attached rules: ${source.name} v${source.version}; interpretation checked for this revision.`]),
    ...(clientChecks.length ? [`Client integration still unverified: ${clientChecks.join(", ")}. Check these during client setup before customer use.`] : []),
    ...(assigned.some(item => item.passages.some(isDeferredSourceReadback))
      ? ["Independent source readback remains unverified for each applicable execution. Perform and retain that separate observation after the change; a receipt or completed business review does not prove it."] : []),
    ...(assigned.some(item => item.passages.some(isDeferredSourceCounterMaintenance))
      ? ["Source-counter maintenance relies on the exact current source-owner operating contract. Independent external-writer and production assurance remain unverified; the owner must keep all writers within that contract. This review grants no execution permission."] : []),
    ...[...new Set(assigned.flatMap(item => item.passages.flatMap(p => {
      const obligation = deferredReviewObligation(p);
      return obligation?.family === "receipt_setup" ? [obligation.requirement] : [];
    })))].map(mode => `Receipt requirement: ${mode}. Receipt/execution setup pending: review this exact mode through execution setup. No receipt, provisioning or independent observation is established by BUSINESS review.`),
    ...(assigned.some((item) => item.passages.some((passage) => passage.deployment_prerequisite === "runner_execution_setup"))
      ? [location === "active" ? "Execution reviews remain separate. This BUSINESS review does not establish current writer or worker readiness or authorize a new execution. Existing execution settings and receipt history are unchanged."
        : "Execution setup pending: dedicated writer review, separate execution permission and worker startup. Continue to these checks after authority review; automatic completion is not yet enabled."] : []),
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
